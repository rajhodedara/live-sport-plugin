'use strict';

// Even a mistaken omission of dependency injection must not launch a process.
jest.mock('child_process', () => ({
  spawn: jest.fn(() => { throw new Error('Unexpected real child spawn'); }),
}));

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createOwnedResolverFixture } = require('./fixtures/ownedResolverFixture');

const BASE = 'http://127.0.0.1:7099';
const EMPTY_STATS = { entries: 0, ok: 0, failed: 0, claims: 0 };

function response(body, status = 200, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: jest.fn(name => name.toLowerCase() === 'content-type' ? contentType : null) },
    json: jest.fn(async () => body),
  };
}

function mockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.finishExit = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  child.finishClose = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('close', code, signal);
  };
  child.kill = jest.fn(signal => {
    child.finishExit(null, signal);
    child.finishClose(null, signal);
    return true;
  });
  return child;
}

function setup(overrides = {}) {
  const child = mockChild();
  const spawn = jest.fn(() => child);
  const fetch = jest.fn(async url => response(url.endsWith('/api/health')
    ? { ok: true, uptime: 1 }
    : EMPTY_STATS));
  const env = { KEEP_ME: 'unchanged' };
  const options = {
    port: 7099,
    serverPath: '/fixture/server.js',
    spawn,
    fetch,
    env,
    startupTimeoutMs: 50,
    requestTimeoutMs: 20,
    cleanupTimeoutMs: 10,
    ...overrides,
  };
  const fixture = createOwnedResolverFixture(options);
  return { fixture, child, spawn: options.spawn, fetch: options.fetch, env: options.env };
}

async function startReady(context) {
  const starting = context.fixture.start();
  context.child.stdout.write(`${BASE}/\n`);
  await starting;
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('rejects its own port-collision exit without contacting a foreign healthy listener', async () => {
  const { fixture, child, fetch, env } = setup();
  const failed = fixture.start().catch(error => error);
  child.stderr.write('[Resolver] Port 7099 is already in use.\n');
  child.finishExit(98);
  child.finishClose(98);

  const error = await failed;
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain('98');
  expect(error.message).toContain('already in use');
  expect(fetch).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
  expect(env).toEqual({ KEEP_ME: 'unchanged' });
});

test('accepts only the exact complete listener line from its child', async () => {
  const context = setup();
  const failed = context.fixture.start().catch(error => error);
  context.child.stdout.write(`prefix ${BASE}/\nhttp://127.0.0.1:7098/\n${BASE}/ trailing\n`);
  context.child.stdout.write('x'.repeat(10000));
  context.child.stdout.write(`${BASE}/\n`);
  await jest.advanceTimersByTimeAsync(51);

  const error = await failed;
  expect(error.message).toMatch(/never reported listening/i);
  expect(context.fetch).not.toHaveBeenCalled();
  expect(context.child.kill).toHaveBeenCalledWith('SIGTERM');
});

test('preserves the real server entrypoint and accepts a listener line split across chunks', async () => {
  const context = setup();
  const starting = context.fixture.start();
  context.child.stdout.write('http://127.0.');
  context.child.stdout.write('0.1:7099/');
  await jest.advanceTimersByTimeAsync(0);
  expect(context.fetch).not.toHaveBeenCalled();
  context.child.stdout.write('\r\n');
  await starting;

  expect(context.spawn).toHaveBeenCalledWith(process.execPath, ['/fixture/server.js'], {
    env: expect.objectContaining({ PORT: '7099', HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(context.fetch.mock.calls.map(([url]) => url)).toEqual([
    `${BASE}/api/health`, `${BASE}/api/cache-stats`,
  ]);
  await context.fixture.dispose();
});

test.each([
  ['missing uptime', { ok: true }],
  ['unsuccessful health', { ok: false, uptime: 1 }],
  ['string uptime', { ok: true, uptime: '1' }],
  ['negative uptime', { ok: true, uptime: -1 }],
  ['infinite uptime', { ok: true, uptime: Infinity }],
])('rejects HTTP 200 with %s instead of accepting an arbitrary healthy listener', async (_, health) => {
  const context = setup({ fetch: jest.fn(async () => response(health)) });
  const failed = context.fixture.start().catch(error => error);
  context.child.stdout.write(`${BASE}/\n`);

  const error = await failed;
  expect(error.message).toContain('/api/health');
  expect(error.message).toMatch(/unexpected JSON/i);
  expect(context.child.kill).toHaveBeenCalledWith('SIGTERM');
});

test('rejects a non-JSON content type even when its decoded body resembles health', async () => {
  const context = setup({ fetch: jest.fn(async () => response({ ok: true, uptime: 1 }, 200, 'text/html')) });
  const failed = context.fixture.start().catch(error => error);
  context.child.stdout.write(`${BASE}/\n`);

  const error = await failed;
  expect(error.message).toContain('/api/health');
  expect(error.message).toMatch(/content.type|application\/json/i);
});

test.each([
  ['a cache endpoint 404', response('Not found', 404), /HTTP 404/],
  ['missing cache counters', response({ ok: true }), /unexpected JSON/],
  ['string cache counters', response({ ...EMPTY_STATS, claims: '0' }), /unexpected JSON/],
  ['a nonempty foreign cache', response({ ...EMPTY_STATS, entries: 1, ok: 1 }), /unexpected JSON/],
])('rejects %s after the child reports listening', async (_, statsResponse, reason) => {
  const fetch = jest.fn(async url => url.endsWith('/api/health')
    ? response({ ok: true, uptime: 1 }) : statsResponse);
  const context = setup({ fetch });
  const failed = context.fixture.start().catch(error => error);
  context.child.stdout.write(`${BASE}/\n`);

  const error = await failed;
  expect(error.message).toContain('/api/cache-stats');
  expect(error.message).toMatch(reason);
  expect(context.child.kill).toHaveBeenCalledWith('SIGTERM');
});

test('rejects malformed JSON with the failing endpoint in its diagnostic', async () => {
  const invalid = response(null);
  invalid.json.mockRejectedValue(new SyntaxError('Unexpected token in fixture response'));
  const context = setup({ fetch: jest.fn(async () => invalid) });
  const failed = context.fixture.start().catch(error => error);
  context.child.stdout.write(`${BASE}/\n`);

  const error = await failed;
  expect(error.message).toMatch(/\/api\/health: invalid JSON/);
  expect(error.message).toContain('Unexpected token');
});

test('an owned child exit during a pending probe fails startup immediately', async () => {
  let finishHealth;
  const fetch = jest.fn(() => new Promise(resolve => { finishHealth = resolve; }));
  const context = setup({ fetch });
  const failed = context.fixture.start().catch(error => error);
  context.child.stdout.write(`${BASE}/\n`);
  await jest.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  context.child.finishExit(98);
  context.child.finishClose(98);

  const error = await failed;
  expect(error.message).toContain('98');
  finishHealth(response({ ok: true, uptime: 1 }));
  await jest.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('rejects a later child exit before another scenario can use a replacement listener', async () => {
  const context = setup();
  await startReady(context);
  expect(() => context.fixture.assertRunning()).not.toThrow();
  context.child.finishExit(0);
  context.child.finishClose(0);
  expect(() => context.fixture.assertRunning()).toThrow(/code=0/);
  await context.fixture.dispose();
  expect(context.child.kill).not.toHaveBeenCalled();
});

test('bounds a probe even when an injected fetch ignores its abort signal', async () => {
  const fetch = jest.fn(() => new Promise(() => {}));
  const context = setup({ fetch });
  const failed = context.fixture.start().catch(error => error);
  context.child.stdout.write(`${BASE}/\n`);
  await jest.advanceTimersByTimeAsync(21);

  const error = await failed;
  expect(error.message).toMatch(/\/api\/health: request timed out/);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(context.child.kill).toHaveBeenCalledWith('SIGTERM');
});

test('stop waits for close after exit, preserves test configuration, and is idempotent', async () => {
  const context = setup();
  await startReady(context);
  context.child.kill.mockImplementation(() => true);
  let settled = false;
  const stopping = context.fixture.stop().then(() => { settled = true; });
  expect(context.child.kill).toHaveBeenCalledWith('SIGTERM');
  context.child.finishExit(null, 'SIGTERM');
  await jest.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  expect(context.env.RESOLVER_PORT).toBe('7099');
  context.child.finishClose(null, 'SIGTERM');
  await stopping;
  await context.fixture.stop();
  expect(context.child.kill).toHaveBeenCalledTimes(1);
  await context.fixture.dispose();
  expect(context.env).toEqual({ KEEP_ME: 'unchanged' });
});

test('escalates only its owned child after a bounded graceful cleanup wait', async () => {
  const context = setup();
  await startReady(context);
  context.child.kill.mockImplementation(() => true);
  const stopping = context.fixture.stop();
  await jest.advanceTimersByTimeAsync(10);
  expect(context.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  context.child.finishExit(null, 'SIGKILL');
  context.child.finishClose(null, 'SIGKILL');
  await stopping;
  await context.fixture.dispose();
});

test('bounds failed cleanup and restores environment even if the child never closes', async () => {
  const context = setup();
  await startReady(context);
  context.child.kill.mockImplementation(() => true);
  const failed = context.fixture.dispose().catch(error => error);
  await jest.advanceTimersByTimeAsync(21);

  const error = await failed;
  expect(error.message).toMatch(/did not close after bounded cleanup/);
  expect(context.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  expect(context.env).toEqual({ KEEP_ME: 'unchanged' });
  context.child.finishExit(null, 'SIGKILL');
  context.child.finishClose(null, 'SIGKILL');
});

test('retains bounded stdout and stderr tails with process errors in failure diagnostics', async () => {
  const context = setup({ outputLimit: 64 });
  const failed = context.fixture.start().catch(error => error);
  context.child.stdout.write(`${'A'.repeat(1000)}\nstdout-tail\n`);
  context.child.stderr.write(`${'B'.repeat(1000)}\nstderr-tail\n`);
  context.child.emit('error', new Error('mock spawn failure'));
  context.child.finishClose(null, null);

  const error = await failed;
  expect(error.message).toContain('mock spawn failure');
  const diagnostic = context.fixture.diagnostics();
  expect(diagnostic).toContain('stdout-tail');
  expect(diagnostic).toContain('stderr-tail');
  expect(diagnostic).not.toContain('A'.repeat(65));
  expect(diagnostic).not.toContain('B'.repeat(65));
  expect(diagnostic.length).toBeLessThan(1000);
  expect(context.fetch).not.toHaveBeenCalled();
});

test('sanitizes only the child activation and TLS environment and restores parent client settings', async () => {
  const env = {
    KEEP_ME: 'unchanged', PORT: '4444', HOST: '0.0.0.0', BASE_URL: 'https://fixture.invalid',
    RESOLVER_PORT: '7004', RESOLVE_CACHE_SHARED: 'false', RESOLVER_TRUST_LEGACY_TCP: 'false',
    RESOLVER_TRANSPORT: 'systemd-unix-tls', RESOLVER_SYSTEMD_SOCKET: 'true', RESOLVER_SYSTEMD_TLS: 'true',
    LISTEN_PID: '123', LISTEN_FDS: '1', LISTEN_FDNAMES: 'resolver',
    CREDENTIALS_DIRECTORY: '/fixture/credentials', RESOLVER_CERT_DIR: '/fixture/public',
    RESOLVER_TLS_SERVERNAME: 'resolver.fixture', RESOLVER_SOCKET_PATH: '/fixture/resolver.sock',
  };
  const original = { ...env };
  const context = setup({ env });
  await startReady(context);
  const childEnv = context.spawn.mock.calls[0][2].env;
  for (const name of [
    'BASE_URL', 'RESOLVER_SYSTEMD_SOCKET', 'RESOLVER_SYSTEMD_TLS',
    'LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES', 'CREDENTIALS_DIRECTORY',
    'RESOLVER_CERT_DIR', 'RESOLVER_TLS_SERVERNAME', 'RESOLVER_SOCKET_PATH',
  ]) {
    expect(childEnv).not.toHaveProperty(name);
    expect(env[name]).toBe(original[name]);
  }
  expect(env.RESOLVER_PORT).toBe('7099');
  expect(env.RESOLVER_TRUST_LEGACY_TCP).toBe('true');
  expect(env.RESOLVER_TRANSPORT).toBeUndefined();
  expect(env.RESOLVE_CACHE_SHARED).toBeUndefined();
  expect(childEnv).toMatchObject({ PORT: '7099', HOST: '127.0.0.1', KEEP_ME: 'unchanged' });
  await context.fixture.dispose();
  expect(env).toEqual(original);
});

test('a synchronous spawn failure restores parent settings automatically', async () => {
  const env = { RESOLVER_PORT: '7004', RESOLVE_CACHE_SHARED: 'false', RESOLVER_TRANSPORT: 'invalid' };
  const original = { ...env };
  const spawn = jest.fn(() => { throw new Error('fixture spawn denied'); });
  const context = setup({ env, spawn });

  await expect(context.fixture.start()).rejects.toThrow('fixture spawn denied');
  expect(context.fetch).not.toHaveBeenCalled();
  expect(env).toEqual(original);
  await context.fixture.dispose();
  expect(env).toEqual(original);
});
