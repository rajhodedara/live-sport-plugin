'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadChild(fetch, connected = false) {
  let receive, disconnect;
  const send = jest.fn(), exit = jest.fn();
  const processStub = { connected, once: (event, listener) => { if (event === 'message') receive = listener; if (event === 'disconnect') disconnect = listener; }, send, exit };
  const createNativeGuardedFetch = jest.fn(() => ({ fetch }));
  const source = fs.readFileSync(path.join(__dirname, '../src/services/isolated-native-child.cjs'), 'utf8');
  vm.runInNewContext(source, { process: processStub, Buffer, TypeError, RangeError, performance,
    require: name => { if (name !== './NativeGuardedFetch') throw Error('unexpected import'); return { createNativeGuardedFetch }; } });
  return { receive, disconnect, exit, send, createNativeGuardedFetch };
}

test('child passes proxy settings to the guarded transport and returns a buffered result', async () => {
  const fetch = jest.fn(async () => ({ status: 200, url: 'https://damitv.st/', headers: new Headers({ 'content-type': 'text/plain' }),
    arrayBuffer: async () => Uint8Array.from(Buffer.from('fixture')).buffer, bodyTruncated: false }));
  const child = loadChild(fetch), options = { proxyUrl: 'socks5://127.0.0.1:40000', profile: 'vanilla' };
  await child.receive({ url: 'https://damitv.st/', options });
  expect(child.createNativeGuardedFetch).toHaveBeenCalledWith({ maxSlots: 1 });
  expect(fetch).toHaveBeenCalledWith('https://damitv.st/', options);
  expect(child.send.mock.calls[0][0]).toMatchObject({ type: 'result', status: 200, bytes: Buffer.from('fixture') });
});

test('opt-in receipt event precedes the normal result and contains no request data', async () => {
  const child = loadChild(async () => ({ status: 200, url: 'https://private.test/', headers: new Headers(),
    arrayBuffer: async () => Uint8Array.from(Buffer.from('ok')).buffer }), true);
  await child.receive({ diagnostic: true, url: 'https://private.test/secret', options: {} });
  expect(child.send.mock.calls[0][0]).toEqual({ type: 'diagnostic', phase: 'request_received' });
  expect(child.send.mock.calls[1][0].type).toBe('result');
  expect(child.send.mock.calls[1][0].diagnosticSnapshot).toEqual({ attempted: 1, pending: 1, failed: 0, backpressure: 0 });
  expect(JSON.stringify(child.send.mock.calls[0][0])).not.toMatch(/private|secret/);
});

test('send false is backpressure and a failed callback is reported separately', async () => {
  const child = loadChild(async () => ({ status: 200, url: 'https://example.test/', headers: new Headers(),
    arrayBuffer: async () => new Uint8Array().buffer }), true);
  child.send.mockImplementation((message, callback) => {
    if (message.type === 'diagnostic') { callback(new Error('ipc')); return false; }
    return true;
  });
  await child.receive({ diagnostic: true, url: 'https://example.test/', options: {} });
  expect(child.send.mock.calls[1][0].diagnosticSnapshot).toEqual({ attempted: 1, pending: 0, failed: 1, backpressure: 1 });
});

test('child exits when its supervisor IPC disconnects', () => {
  const child = loadChild(jest.fn());
  child.disconnect();
  expect(child.exit).toHaveBeenCalledWith(1);
  expect(child.createNativeGuardedFetch).not.toHaveBeenCalled();
});

test('watchdog requests termination when the supervisor disappears', () => {
  let poll, lifetime;
  const kill = jest.fn((pid, signal) => { if (pid === 123 && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  const processStub = { ppid: 123, pid: 456, kill, once: jest.fn(), exit: jest.fn() };
  const source = fs.readFileSync(path.join(__dirname, '../src/services/isolated-native-child.cjs'), 'utf8');
  vm.runInNewContext(source, { process: processStub, Buffer, TypeError, RangeError,
    setInterval: fn => { poll = fn; return { unref() {} }; }, setTimeout: fn => { lifetime = fn; return { unref() {} }; },
    require: () => ({ createNativeGuardedFetch: jest.fn() }) });
  poll(); expect(kill).toHaveBeenCalledWith(456, 'SIGKILL');
  kill.mockClear(); lifetime(); expect(kill).toHaveBeenCalledWith(456, 'SIGKILL');
});

test('child serializes error policy without transmitting exception details', async () => {
  const failure = Object.assign(new TypeError('secret credential or URL'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true });
  const child = loadChild(async () => { throw failure; });
  await child.receive({ url: 'https://cdn.example.org/', options: {} });
  const message = child.send.mock.calls[0][0];
  expect(message.error).toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED', kind: 'TypeError', isFatal: true });
  expect(JSON.stringify(message)).not.toContain('secret');
});
