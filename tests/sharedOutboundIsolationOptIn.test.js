'use strict';

const previous = process.env.GUARDED_NATIVE_ISOLATION;
afterEach(() => {
  if (previous === undefined) delete process.env.GUARDED_NATIVE_ISOLATION;
  else process.env.GUARDED_NATIVE_ISOLATION = previous;
  jest.resetModules(); jest.dontMock('../src/services/NativeGuardedFetch');
  jest.dontMock('../src/services/IsolatedNativePoolCandidate');
});

test.each([['true', true], ['false', false], ['', false]])('isolation setting %s selects only the expected transport', async (setting, isolated) => {
  process.env.GUARDED_NATIVE_ISOLATION = setting;
  const response = { status: 200, text: async () => 'fixture' };
  const normal = { fetch: jest.fn(async () => response), close: jest.fn(async () => {}) };
  const candidate = { fetch: jest.fn(async () => response), close: jest.fn(async () => {}) };
  const createNormal = jest.fn(() => normal), createCandidate = jest.fn(() => candidate);
  jest.doMock('../src/services/NativeGuardedFetch', () => ({ createNativeGuardedFetch: createNormal }));
  jest.doMock('../src/services/IsolatedNativePoolCandidate', () => ({ createIsolatedNativePoolCandidate: createCandidate }));
  const shared = require('../src/services/SharedOutboundFetch');
  try {
    expect((await shared.fetchSharedOutbound('https://cdn.example.org/', { attempts: 1 })).status).toBe(200);
    expect(createCandidate).toHaveBeenCalledTimes(isolated ? 1 : 0);
    expect(createNormal).toHaveBeenCalledTimes(isolated ? 0 : 1);
  } finally { await shared.closeSharedOutbound(); }
});

test('a closing pool is not replaced before its children exit', async () => {
  process.env.GUARDED_NATIVE_ISOLATION = 'true';
  let finishClose, isClosing = false;
  const pool = { fetch: jest.fn(async () => {
    if (isClosing) throw Object.assign(new Error('closed'), { code: 'ERR_NATIVE_POOL_CLOSED' });
    return { status: 200 };
  }), close: jest.fn(() => { isClosing = true; return new Promise(resolve => { finishClose = resolve; }); }) };
  const create = jest.fn(() => pool);
  jest.doMock('../src/services/IsolatedNativePoolCandidate', () => ({ createIsolatedNativePoolCandidate: create }));
  const shared = require('../src/services/SharedOutboundFetch');
  await shared.fetchSharedOutbound('https://cdn.example.org/', { attempts: 1 });
  const closing = shared.closeSharedOutbound();
  await expect(shared.fetchSharedOutbound('https://cdn.example.org/', { attempts: 1 })).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_CLOSED' });
  expect(create).toHaveBeenCalledTimes(1);
  finishClose(); await closing;
});
