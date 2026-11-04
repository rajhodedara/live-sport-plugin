'use strict';
const { EventEmitter } = require('node:events');
const { createIsolatedNativePoolCandidate: createPool } = require('../src/services/IsolatedNativePoolCandidate');
const { configuredSlots, killTrackedChildren } = require('../src/services/IsolatedNativePoolCandidate');
const createIsolatedNativePoolCandidate = options => createPool({ admissionWaitMs: 0, ...options });
const { createSharedOutboundFetch } = require('../src/services/SharedOutboundFetch');

function fakeChild() {
  const child = new EventEmitter();
  child.send = jest.fn((_message, callback) => callback());
  child.kill = jest.fn();
  return child;
}

test('slot configuration defaults to four and accepts at most eight', () => {
  expect(configuredSlots('6')).toBe(6); expect(configuredSlots('9')).toBe(4);
  expect(configuredSlots('')).toBe(4); expect(() => createPool({ maxSlots: 9 })).toThrow(RangeError);
});

test('exit cleanup requests termination of tracked children', async () => {
  const child = fakeChild(), pool = createPool({ maxSlots: 1, spawn: () => child });
  const pending = pool.fetch('https://cdn.example.org/').catch(error => error);
  killTrackedChildren(); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  child.emit('exit', 1); await pending; await pool.close();
});

test('timeout kills the child and holds capacity until exit is observed', async () => {
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, spawn: () => child });
  const pending = pool.fetch('https://damitv.st/', { timeoutMs: 30, profile: 'vanilla', proxyUrl: 'socks5://127.0.0.1:40000' });
  expect(child.send.mock.calls[0][0].options).toMatchObject({ profile: 'vanilla', proxyUrl: 'socks5://127.0.0.1:40000' });
  await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(pool.occupied).toBe(1);
  await expect(pool.fetch('https://damitv.st/')).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
  child.emit('exit', 1); expect(pool.occupied).toBe(0);
  pool.close();
});

test('a buffered response remains available after the child is terminated', async () => {
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, spawn: () => child });
  const pending = pool.fetch('https://cdn.example.org/');
  child.emit('message', { type: 'result', status: 200, url: 'https://cdn.example.org/', headers: [['content-type', 'text/plain']], bytes: Buffer.from('fixture') });
  const response = await pending;
  expect(await response.text()).toBe('fixture');
  expect(pool.occupied).toBe(1);
  child.emit('exit', 0);
  expect(pool.occupied).toBe(0); pool.close();
});

test('fetch remains callable when detached from its pool object', async () => {
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, spawn: () => child });
  const fetch = pool.fetch;
  const pending = fetch('https://cdn.example.org/');
  child.emit('message', { type: 'result', status: 200, url: 'https://cdn.example.org/', headers: [], bytes: Buffer.from('fixture') });
  expect(await (await pending).text()).toBe('fixture');
  child.emit('exit', 0);
  await pool.close();
});

test('caller cancellation does not pass its signal into IPC or free capacity early', async () => {
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, spawn: () => child });
  const controller = new AbortController();
  const pending = pool.fetch('https://cdn.example.org/', { signal: controller.signal });
  expect(child.send.mock.calls[0][0].options.signal).toBeUndefined();
  controller.abort(new Error('stop'));
  await expect(pending).rejects.toThrow('stop');
  expect(pool.occupied).toBe(1);
  child.emit('exit', 1); expect(pool.occupied).toBe(0); pool.close();
});

test('a child exit without a response fails the caller and frees its capacity', async () => {
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, spawn: () => child });
  const pending = pool.fetch('https://cdn.example.org/');
  child.emit('exit', 1);
  await expect(pending).rejects.toMatchObject({ code: 'ERR_NATIVE_CHILD_EXIT' });
  expect(pool.occupied).toBe(0); pool.close();
});

test('exit followed by close releases a slot only once', async () => {
  const children = [];
  const pool = createIsolatedNativePoolCandidate({ maxSlots: 1, admissionWaitMs: 1000, spawn: () => {
    const child = fakeChild(); children.push(child); return child;
  } });
  const first = pool.fetch('https://example.org/').catch(error => error);
  const second = pool.fetch('https://example.org/').catch(error => error);
  children[0].emit('exit', 1);
  await first;
  await Promise.resolve();
  expect(children).toHaveLength(2);
  children[0].emit('close', 1);
  expect(pool.occupied).toBe(1);
  children[1].emit('exit', 1);
  await second;
  expect(pool.occupied).toBe(0);
  await pool.close();
});

test('four timed-out children block a fifth until an exit allows replacement', async () => {
  const children = [], pool = createIsolatedNativePoolCandidate({ spawn: () => { const child = fakeChild(); children.push(child); return child; } });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const requests = controllers.map(controller => pool.fetch('https://damitv.st/', { signal: controller.signal }).catch(error => error));
  controllers.forEach(controller => controller.abort(new Error('deadline')));
  await Promise.all(requests);
  expect(pool.occupied).toBe(4);
  await expect(pool.fetch('https://damitv.st/')).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
  children[0].emit('exit', 1);
  const replacement = pool.fetch('https://damitv.st/', { profile: 'vanilla', proxyUrl: 'socks5://127.0.0.1:40000' });
  expect(children).toHaveLength(5);
  expect(children[4].send.mock.calls[0][0].options.proxyUrl).toBe('socks5://127.0.0.1:40000');
  children[4].emit('message', { type: 'result', status: 200, url: 'https://damitv.st/', headers: [], bytes: Buffer.from('ok') });
  expect(await (await replacement).text()).toBe('ok');
  children.slice(1).forEach(child => child.emit('exit', 0));
  expect(pool.occupied).toBe(0); pool.close();
});

test.each([
  [{ code: 'ERR_OUTBOUND_BLOCKED', kind: 'Error', isFatal: true }, 'ERR_OUTBOUND_BLOCKED'],
  [{ code: 'ERR_NATIVE_CHILD', kind: 'TypeError' }, 'ERR_NATIVE_CHILD']
])('child rejection preserves non-retryable policy without leaking a native message', async (failure, expectedCode) => {
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, spawn: () => child });
  const fallback = jest.fn(), delay = jest.fn();
  const fetch = createSharedOutboundFetch({ nativeFetch: (url, options) => pool.fetch(url, options), fallbackFetch: fallback, delay });
  const pending = fetch('https://cdn.example.org/');
  child.emit('message', { type: 'result', error: { ...failure, message: 'secret-url-or-credential' } });
  let caught;
  try { await pending; } catch (error) { caught = error; }
  expect(caught.code).toBe(expectedCode);
  if (failure.kind === 'TypeError') expect(caught).toBeInstanceOf(TypeError);
  if (failure.code === 'ERR_OUTBOUND_BLOCKED') expect(caught).toMatchObject({ isFatal: true, statusCode: 403 });
  expect(String(caught)).not.toContain('secret-url-or-credential');
  expect(fallback).not.toHaveBeenCalled(); expect(delay).not.toHaveBeenCalled();
  child.emit('exit', 1); pool.close();
});

test('copies headers to IPC and excludes unrelated nonserializable options', async () => {
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, spawn: () => child });
  const pending = pool.fetch('https://cdn.example.org/', { headers: new Headers({ 'x-test': 'fixture' }), unrelated: () => {} });
  expect(child.send.mock.calls[0][0].options).toMatchObject({ headers: [['x-test', 'fixture']] });
  expect(child.send.mock.calls[0][0].options.unrelated).toBeUndefined();
  child.emit('message', { type: 'result', status: 200, url: 'https://cdn.example.org/', headers: [], bytes: Buffer.from('ok') });
  await pending; child.emit('exit', 0); pool.close();
});

test('shutdown waits for observed child exit and rejects new requests', async () => {
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, spawn: () => child });
  const pending = pool.fetch('https://cdn.example.org/').catch(error => error);
  let finished = false;
  const closing = pool.close().then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  await expect(pool.fetch('https://cdn.example.org/')).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_CLOSED' });
  child.emit('exit', 1);
  expect(await pending).toMatchObject({ code: 'ERR_NATIVE_CHILD_EXIT' });
  await closing;
  expect(finished).toBe(true); expect(pool.occupied).toBe(0);
});

test('a spawn failure reporting close without exit returns its capacity', async () => {
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, spawn: () => child });
  const pending = pool.fetch('https://cdn.example.org/');
  child.emit('error', new Error('spawn failure'));
  await expect(pending).rejects.toMatchObject({ code: 'ERR_NATIVE_UNAVAILABLE' });
  expect(pool.occupied).toBe(1);
  child.emit('close', -1);
  expect(pool.occupied).toBe(0);
  await pool.close();
});

test('synchronous spawn failures do not leak sensitive error details or consume capacity', async () => {
  const pool = createIsolatedNativePoolCandidate({ spawn: () => { throw new Error('secret path'); } });
  let failure;
  try { await pool.fetch('https://cdn.example.org/'); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'ERR_NATIVE_UNAVAILABLE' });
  expect(String(failure)).not.toContain('secret path');
  expect(pool.occupied).toBe(0); await pool.close();
});

test('capacity reports a stable slot and phase without URLs or proxy credentials', async () => {
  let clock = 1000;
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, now: () => clock, spawn: () => child });
  const controller = new AbortController();
  const pending = pool.fetch('https://cdn.example.org/private?token=secret', {
    signal: controller.signal, profile: 'vanilla', proxyUrl: 'socks5://user:password@127.0.0.1:40000', diagnosticOwner: 'manifest'
  }).catch(error => error);
  const capacity = async () => { try { await pool.fetch('https://other.example.org/'); } catch (failure) { return failure.capacityDiagnostic; } };
  clock += 250;
  const running = await capacity();
  expect(running.slots[0]).toMatchObject({ slotId: 1, phase: 'running', ageMs: 250, profile: 'vanilla', egress: 'proxy', owner: 'manifest' });
  controller.abort(new Error('stop')); await pending;
  clock += 100;
  const terminating = await capacity();
  expect(terminating.slots[0]).toMatchObject({ slotId: 1, phase: 'terminating', ageMs: 350 });
  expect(JSON.stringify(terminating)).not.toMatch(/secret|password|127\.0\.0\.1|cdn\.example/);
  child.emit('exit', 1); await pool.close();
});

test('DamitTV proxy egress survives the shared policy and a 403 never falls back directly', async () => {
  const child = fakeChild(), pool = createIsolatedNativePoolCandidate({ maxSlots: 1, spawn: () => child });
  const fallbackFetch = jest.fn();
  const fetch = createSharedOutboundFetch({ nativeFetch: (url, options) => pool.fetch(url, options), fallbackFetch });
  const pending = fetch('https://damitv.st/', { proxyUrl: 'socks5://127.0.0.1:40000', attempts: 1 });
  expect(child.send.mock.calls[0][0].options).toMatchObject({ proxyUrl: 'socks5://127.0.0.1:40000', profile: 'vanilla' });
  child.emit('message', { type: 'result', status: 403, url: 'https://damitv.st/', headers: [], bytes: Buffer.from('fixture') });
  expect((await pending).status).toBe(403);
  expect(fallbackFetch).not.toHaveBeenCalled();
  child.emit('exit', 0); await pool.close();
});

test('queued proxy work is admitted before direct work when a child exits', async () => {
  const children = [], pool = createPool({ maxSlots: 1, admissionWaitMs: 500, maxWaiters: 4,
    spawn: () => { const child = fakeChild(); children.push(child); return child; } });
  const first = pool.fetch('https://first.example.org/');
  const direct = pool.fetch('https://direct.example.org/');
  const proxy = pool.fetch('https://damitv.st/', { profile: 'vanilla', proxyUrl: 'socks5://127.0.0.1:40000' });
  expect(children).toHaveLength(1);
  children[0].emit('message', { type: 'result', status: 200, url: 'https://first.example.org/', headers: [], bytes: Buffer.from('1') });
  await first; children[0].emit('exit', 0); await Promise.resolve();
  expect(children).toHaveLength(2);
  expect(children[1].send.mock.calls[0][0]).toMatchObject({ url: 'https://damitv.st/', options: { proxyUrl: 'socks5://127.0.0.1:40000' } });
  children[1].emit('message', { type: 'result', status: 200, url: 'https://damitv.st/', headers: [], bytes: Buffer.from('2') });
  await proxy; children[1].emit('exit', 0); await Promise.resolve();
  expect(children).toHaveLength(3);
  expect(children[2].send.mock.calls[0][0].url).toBe('https://direct.example.org/');
  children[2].emit('message', { type: 'result', status: 200, url: 'https://direct.example.org/', headers: [], bytes: Buffer.from('3') });
  await direct; children[2].emit('exit', 0); await pool.close();
});

test('queued catalog work is admitted ahead of ordinary direct work', async () => {
  const children = [], pool = createPool({ maxSlots: 1, admissionWaitMs: 500,
    spawn: () => { const child = fakeChild(); children.push(child); return child; } });
  const first = pool.fetch('https://first.example.org/');
  const direct = pool.fetch('https://ordinary.example.org/');
  const catalog = pool.fetch('https://api.ppv.st/', { diagnosticOwner: 'catalog' });
  children[0].emit('message', { type: 'result', status: 200, url: 'https://first.example.org/', headers: [], bytes: Buffer.from('ok') });
  await first; children[0].emit('exit', 0); await Promise.resolve();
  expect(children[1].send.mock.calls[0][0]).toMatchObject({ url: 'https://api.ppv.st/', options: { diagnosticOwner: 'catalog' } });
  children[1].emit('message', { type: 'result', status: 200, url: 'https://api.ppv.st/', headers: [], bytes: Buffer.from('ok') });
  await catalog; children[1].emit('exit', 0); await Promise.resolve();
  children[2].emit('message', { type: 'result', status: 200, url: 'https://ordinary.example.org/', headers: [], bytes: Buffer.from('ok') });
  await direct; children[2].emit('exit', 0); await pool.close();
});

test('queued cancellation never spawns a child and frees queue space', async () => {
  const children = [], pool = createPool({ maxSlots: 1, admissionWaitMs: 500, maxWaiters: 2,
    spawn: () => { const child = fakeChild(); children.push(child); return child; } });
  const first = pool.fetch('https://first.example.org/'), controller = new AbortController();
  const queued = pool.fetch('https://second.example.org/', { signal: controller.signal });
  controller.abort(new Error('viewer left'));
  await expect(queued).rejects.toThrow('viewer left');
  expect(children).toHaveLength(1);
  children[0].emit('message', { type: 'result', status: 200, url: 'https://first.example.org/', headers: [], bytes: Buffer.from('1') });
  await first; children[0].emit('exit', 0); await Promise.resolve();
  expect(children).toHaveLength(1); await pool.close();
});

test('admission wait is bounded and counts toward the request deadline', async () => {
  const child = fakeChild(), pool = createPool({ maxSlots: 1, admissionWaitMs: 30, spawn: () => child });
  const first = pool.fetch('https://first.example.org/');
  await expect(pool.fetch('https://second.example.org/', { timeoutMs: 200 })).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
  await expect(pool.fetch('https://second.example.org/', { timeoutMs: 10 })).rejects.toMatchObject({ name: 'TimeoutError' });
  child.emit('message', { type: 'result', status: 200, url: 'https://first.example.org/', headers: [], bytes: Buffer.from('1') });
  await first; child.emit('exit', 0); await pool.close();
});

test('shutdown rejects queued requests while still waiting for child exit', async () => {
  const child = fakeChild(), pool = createPool({ maxSlots: 1, admissionWaitMs: 500, spawn: () => child });
  const first = pool.fetch('https://first.example.org/').catch(error => error);
  const queued = pool.fetch('https://second.example.org/');
  const closing = pool.close();
  await expect(queued).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_CLOSED' });
  child.emit('exit', 1); await first; await closing;
});

test('bounded direct queue leaves room for proxy admission', async () => {
  const child = fakeChild(), pool = createPool({ maxSlots: 1, admissionWaitMs: 500, maxWaiters: 4, spawn: () => child });
  const first = pool.fetch('https://first.example.org/').catch(error => error);
  const direct = Array.from({ length: 3 }, () => pool.fetch('https://direct.example.org/').catch(error => error));
  await expect(pool.fetch('https://overflow.example.org/')).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
  const proxy = pool.fetch('https://damitv.st/', { proxyUrl: 'socks5://127.0.0.1:40000' }).catch(error => error);
  await expect(pool.fetch('https://overflow.example.org/', { proxyUrl: 'socks5://127.0.0.1:40000' })).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
  const closing = pool.close(); child.emit('exit', 1);
  await Promise.all([first, ...direct, proxy]); await closing;
});

test('child receives the remaining deadline after admission waiting', async () => {
  const children = [], pool = createPool({ maxSlots: 1, admissionWaitMs: 500,
    spawn: () => { const child = fakeChild(); children.push(child); return child; } });
  const first = pool.fetch('https://first.example.org/');
  const queued = pool.fetch('https://second.example.org/', { timeoutMs: 500 });
  await new Promise(resolve => setTimeout(resolve, 25));
  children[0].emit('message', { type: 'result', status: 200, url: 'https://first.example.org/', headers: [], bytes: Buffer.from('ok') });
  await first; children[0].emit('exit', 0); await Promise.resolve();
  expect(children[1].send.mock.calls[0][0].options.timeoutMs).toBeLessThan(500);
  children[1].emit('message', { type: 'result', status: 200, url: 'https://second.example.org/', headers: [], bytes: Buffer.from('ok') });
  await queued; children[1].emit('exit', 0); await pool.close();
});
