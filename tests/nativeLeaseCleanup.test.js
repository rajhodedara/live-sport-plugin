'use strict';

const { createNativeGuardedFetch } = require('../src/services/NativeGuardedFetch');
const { createNativeExclusiveSlot } = require('../src/services/NativeExclusiveSlot');

function fixturePool(fetch, configurations = []) {
  return createNativeGuardedFetch({ maxSlots: 1,
    slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async config => {
      configurations.push(config);
      return { busy: false, run: (_url, operation) => operation({ fetch }), close: async () => {} };
    }
  });
}

test('a 403 consumes the body and releases the slot before a proxy request', async () => {
  const configs = [], fetch = jest.fn()
    .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
    .mockResolvedValueOnce(new Response('fixture'));
  const pool = fixturePool(fetch, configs);
  try {
    expect((await pool.fetch('https://cdn.example.org/')).status).toBe(403);
    expect(pool.stats.busy).toBe(0);
    expect(await (await pool.fetch('https://damitv.st/', {
      profile: 'vanilla', proxyUrl: 'socks5://127.0.0.1:40000'
    })).text()).toBe('fixture');
    expect(configs[1]).toMatchObject({ profile: 'vanilla', proxyUrl: 'socks5://127.0.0.1:40000' });
    expect(pool.stats.busy).toBe(0);
  } finally { await pool.close(); }
});

test('a body read failure cancels the stream and releases the reservation', async () => {
  const cancel = jest.fn(), releaseLock = jest.fn();
  const responseBody = { getReader: () => ({ read: async () => { throw Error('fixture read failure'); }, releaseLock }), cancel };
  const fetch = jest.fn().mockResolvedValueOnce({ status: 200, headers: {}, body: responseBody })
    .mockResolvedValueOnce(new Response('recovered'));
  const pool = fixturePool(fetch);
  try {
    await expect(pool.fetch('https://cdn.example.org/')).rejects.toThrow('fixture read failure');
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pool.stats.busy).toBe(0);
    expect(await (await pool.fetch('https://cdn.example.org/')).text()).toBe('recovered');
  } finally { await pool.close(); }
});

test('reads the response body getter once', async () => {
  const body = new Response('fixture').body;
  const getBody = jest.fn(() => body);
  const pool = fixturePool(async () => ({ status: 200, headers: {}, get body() { return getBody(); } }));
  try {
    expect(await (await pool.fetch('https://cdn.example.org/')).text()).toBe('fixture');
    expect(getBody).toHaveBeenCalledTimes(1);
  } finally { await pool.close(); }
});

test('a timed-out native operation remains isolated until it actually settles', async () => {
  let finish, started;
  const running = new Promise(resolve => { started = resolve; });
  const native = { fetch: jest.fn(() => { started(); return new Promise(resolve => { finish = resolve; }); }) };
  const closeConnections = jest.fn();
  const slot = createNativeExclusiveSlot(native, closeConnections);
  const pending = slot.run(client => client.fetch(), { timeoutMs: 30 });
  await running;
  await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(closeConnections).toHaveBeenCalled();
  expect(slot.busy).toBe(true);
  await expect(slot.run(() => Promise.resolve())).rejects.toMatchObject({ code: 'ERR_NATIVE_SLOT_BUSY' });
  finish('done');
  await slot.whenIdle();
  expect(slot.busy).toBe(false);
  await expect(slot.run(() => Promise.resolve('recovered'))).resolves.toBe('recovered');
  slot.dispose();
});

test('a stalled operation emits one sanitized warning after cancellation', async () => {
  let finish, started;
  const running = new Promise(resolve => { started = resolve; });
  const warn = jest.fn();
  const slot = createNativeExclusiveSlot({}, () => {}, { staleWarningMs: 10, warn });
  const pending = slot.run(() => { started(); return new Promise(resolve => { finish = resolve; }); }, { timeoutMs: 20 });
  await running;
  await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toMatch(/remains active/);
  expect(JSON.parse(warn.mock.calls[0][1]).ageMs).toBeGreaterThanOrEqual(20);
  finish(); await slot.whenIdle(); slot.dispose();
});

test('timeout aborts a stalled native response and permits reuse only after its read settles', async () => {
  let rejectRead, started;
  const reading = new Promise(resolve => { started = resolve; });
  const abort = jest.fn(() => rejectRead(new Error('native response aborted')));
  const body = {
    getReader: () => ({ read: () => { started(); return new Promise((_, reject) => { rejectRead = reject; }); }, releaseLock() {} }),
    cancel: jest.fn()
  };
  const native = { fetch: jest.fn().mockResolvedValueOnce({ status: 200, headers: {}, body, abort })
    .mockResolvedValueOnce(new Response('recovered')) };
  const exclusive = createNativeExclusiveSlot(native, () => {});
  const pool = createNativeGuardedFetch({ maxSlots: 1, slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => ({ get busy() { return exclusive.busy; },
      run: (_url, operation, options) => exclusive.run(operation, options),
      close: async () => { await exclusive.whenIdle(); exclusive.dispose(); } }) });
  try {
    const pending = pool.fetch('https://cdn.example.org/', { timeoutMs: 100 });
    await reading;
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await exclusive.whenIdle();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(pool.stats.busy).toBe(0);
    expect(await (await pool.fetch('https://cdn.example.org/')).text()).toBe('recovered');
  } finally { await pool.close(); }
});

test('a native response arriving after timeout is aborted before its body is accessed', async () => {
  let resolveFetch, started;
  const running = new Promise(resolve => { started = resolve; });
  const abort = jest.fn(), getBody = jest.fn();
  const native = { fetch: () => { started(); return new Promise(resolve => { resolveFetch = resolve; }); } };
  const exclusive = createNativeExclusiveSlot(native, () => {});
  const pool = createNativeGuardedFetch({ maxSlots: 1, slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => ({ get busy() { return exclusive.busy; },
      run: (_url, operation, options) => exclusive.run(operation, options),
      close: async () => { await exclusive.whenIdle(); exclusive.dispose(); } }) });
  try {
    const pending = pool.fetch('https://cdn.example.org/', { timeoutMs: 50 });
    await running;
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(pool.stats.busy).toBe(1);
    resolveFetch({ status: 200, headers: {}, abort, get body() { return getBody(); } });
    await exclusive.whenIdle();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(getBody).not.toHaveBeenCalled();
    expect(pool.stats.busy).toBe(0);
  } finally { await pool.close(); }
});
