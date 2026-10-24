const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

// Evaluate the actual manager in isolation: never spawn, kill or probe a real process.
function fixture(worker = '0') {
  const requests = [];
  const timers = [];
  const children = [];
  const shutdown = jest.fn();
  const execSync = jest.fn();
  const spawn = jest.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = jest.fn(() => { child.killed = true; });
    children.push(child);
    return child;
  });
  const http = { get: jest.fn((url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = jest.fn();
    requests.push({ req, callback, url, options });
    return req;
  }) };
  const processMock = new EventEmitter();
  Object.assign(processMock, {
    env: { NODE_APP_INSTANCE: worker }, platform: 'linux',
    cwd: () => '/fixture', exit: jest.fn()
  });
  const context = {
    module: { exports: {} }, __dirname: '/fixture/src', process: processMock,
    console: { log: jest.fn(), error: jest.fn() },
    setTimeout: (fn, delay) => {
      const timer = { fn, delay, unref: jest.fn(), cleared: false };
      timers.push(timer); return timer;
    },
    clearTimeout: timer => { timer.cleared = true; },
    require: name => {
      if (name === 'path') return path;
      if (name === 'http') return http;
      if (name === 'child_process') return { spawn, execSync };
      if (name === 'fs') return { existsSync: () => true, statSync: () => ({ isFile: () => true }) };
      if (name === './container') return { resolve: () => ({ shutdown }) };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/resolverManager.js'), 'utf8'), context);
  return { ...context.module.exports, requests, timers, children, spawn, execSync, shutdown, processMock };
}
async function tick() { await Promise.resolve(); await Promise.resolve(); }
async function failedProbe(f, start = 0) {
  f.requests[start].req.emit('error', new Error('fixture connection refused'));
  f.requests[start + 1].req.emit('error', new Error('fixture fallback refused'));
  await tick();
}

describe('resolver shutdown across asynchronous health checks', () => {
  test('does not spawn or kill ports after shutdown during failed initial probe', async () => {
    const f = fixture();
    f.shutdownResolver(); await failedProbe(f);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.execSync).not.toHaveBeenCalled();
    expect(f.timers).toHaveLength(0);
  });
  test('does not spawn after a timed-out probe resolves during shutdown', async () => {
    const f = fixture(); f.shutdownResolver();
    f.requests[0].req.emit('timeout'); await tick();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.execSync).not.toHaveBeenCalled();
  });
  test('multiple pending starts cannot create children after shutdown', async () => {
    const f = fixture(); const pending = f.spawnResolver();
    f.shutdownResolver();
    // Initial requests occupy 0 and 1; their fallback requests occupy 2 and 3.
    f.requests[0].req.emit('error', new Error('refused'));
    f.requests[1].req.emit('error', new Error('refused'));
    f.requests[2].req.emit('error', new Error('refused'));
    f.requests[3].req.emit('error', new Error('refused'));
    await pending; await tick();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.execSync).not.toHaveBeenCalled();
  });
  test('shutdown while a scheduled restart probes prevents a replacement child', async () => {
    const f = fixture(); await failedProbe(f);
    f.children[0].emit('exit', 1, null);
    const restart = f.timers.find(t => t.delay === 2000);
    const pending = restart.fn();
    f.shutdownResolver(); await failedProbe(f, 2); await pending;
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.execSync).toHaveBeenCalledTimes(1);
  });
  test('healthy response during shutdown does not create a child', async () => {
    const f = fixture(); f.shutdownResolver();
    const resume = jest.fn(); f.requests[0].callback({ resume, statusCode: 200 });
    await tick(); expect(resume).toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  });
  test('normal failed health check starts the primary worker child', async () => {
    const f = fixture(); await failedProbe(f);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn.mock.calls[0][2].env.HOST).toBe('127.0.0.1');
    expect(f.timers.some(t => t.delay === 60000)).toBe(true);
    f.shutdownResolver(); expect(f.children[0].kill).toHaveBeenCalledWith('SIGKILL');
  });
  test('healthy existing resolver remains reused', async () => {
    const f = fixture(); f.requests[0].callback({ resume() {}, statusCode: 200 });
    await tick(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.execSync).not.toHaveBeenCalled();
  });
  test('secondary worker never starts a child', async () => {
    const f = fixture('1'); await failedProbe(f);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.execSync).not.toHaveBeenCalled();
  });
  test('shutdown is idempotent and a queued restart cannot probe again', async () => {
    const f = fixture(); await failedProbe(f);
    f.children[0].emit('exit', 1, null);
    f.shutdownResolver(); f.shutdownResolver();
    await f.timers.find(t => t.delay === 2000).fn();
    expect(f.requests).toHaveLength(2); expect(f.shutdown).toHaveBeenCalledTimes(1);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });
  test('live child shutdown kills once, clears stability timer and prevents restart', async () => {
    const f = fixture(); await failedProbe(f);
    f.shutdownResolver(); f.shutdownResolver(); f.children[0].emit('exit', 0, 'SIGKILL');
    expect(f.children[0].kill).toHaveBeenCalledTimes(1);
    expect(f.shutdown).toHaveBeenCalledTimes(1);
    expect(f.timers.every(t => t.cleared)).toBe(true);
    const count = f.requests.length; await f.spawnResolver(); expect(f.requests).toHaveLength(count);
  });
});
