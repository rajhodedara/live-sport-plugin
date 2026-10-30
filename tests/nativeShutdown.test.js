'use strict';
const { closeNativePool, waitForChildExit } = require('../src/services/NativeShutdown');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('waits for native close confirmation', async () => {
  let finish, done = false;
  const result = closeNativePool(() => new Promise(resolve => { finish = resolve; }), 500).then(value => { done = true; return value; });
  await Promise.resolve(); expect(done).toBe(false);
  finish(); expect(await result).toBe(true);
});

test('bounds shutdown if native close never completes', async () => {
  expect(await closeNativePool(() => new Promise(() => {}), 20)).toBe(false);
});

test('reports a failed close', async () => {
  expect(await closeNativePool(() => { throw new Error('fixture'); }, 50)).toBe(false);
});

test('signal handler waits for the shared pool before exiting', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/resolverManager.js'), 'utf8');
  const section = source.slice(source.indexOf('let terminating = false;'), source.indexOf('\nmodule.exports'));
  let finish, handler;
  const close = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const processStub = { env: {}, on: (event, fn) => { if (event === 'SIGTERM') handler = fn; }, exit: jest.fn() };
  const shutdownResolver = jest.fn();
  const owned = new EventEmitter(); owned.exitCode = null; owned.signalCode = null;
  vm.runInNewContext(section, { process: processStub, console, shutdownResolver, resolverProcess: owned,
    require: name => name === './services/NativeShutdown' ? { closeNativePool, waitForChildExit } : { closeSharedOutbound: close } });
  const pending = handler();
  await Promise.resolve();
  expect(shutdownResolver).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(processStub.exit).not.toHaveBeenCalled();
  finish(); await Promise.resolve();
  expect(processStub.exit).not.toHaveBeenCalled();
  owned.emit('exit', 0); await pending;
  expect(processStub.exit).toHaveBeenCalledWith(0);
});

test('socket TLS mode waits for its resolver transport during signal shutdown', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/resolverManager.js'), 'utf8');
  const section = source.slice(source.indexOf('let terminating = false;'), source.indexOf('\nmodule.exports'));
  let finish, handler;
  const closeTransport = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const processStub = { env: { RESOLVER_TRANSPORT: 'systemd-unix-tls' },
    on: (event, fn) => { if (event === 'SIGTERM') handler = fn; }, exit: jest.fn() };
  vm.runInNewContext(section, { process: processStub, console, shutdownResolver: jest.fn(), resolverProcess: null,
    require: name => name === './services/NativeShutdown' ? { closeNativePool, waitForChildExit } :
      name === './services/ResolverTransportRuntime' ? { resolverTransport: { close: closeTransport } } : { closeSharedOutbound: async () => {} } });
  const pending = handler();
  await Promise.resolve();
  expect(closeTransport).toHaveBeenCalledTimes(1);
  expect(processStub.exit).not.toHaveBeenCalled();
  finish(); await pending;
  expect(processStub.exit).toHaveBeenCalledWith(0);
});
