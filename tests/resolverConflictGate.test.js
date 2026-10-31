
// These tests explicitly exercise the unauthenticated TCP compatibility mode.
const legacyTrustBeforeTests = process.env.RESOLVER_TRUST_LEGACY_TCP;
beforeAll(() => { process.env.RESOLVER_TRUST_LEGACY_TCP = 'true'; });
afterAll(() => {
  if (legacyTrustBeforeTests === undefined) delete process.env.RESOLVER_TRUST_LEGACY_TCP;
  else process.env.RESOLVER_TRUST_LEGACY_TCP = legacyTrustBeforeTests;
});
'use strict';
const { createResolverConflictGate } = require('../src/services/ResolverConflictGate');
const StreamResolveCache = require('../src/services/StreamResolveCache');

test('proxy gate rejects a conflict without dispatching the request', () => {
  const gate = createResolverConflictGate({ hasConflict: () => true });
  const send = jest.fn(), res = { status: jest.fn(() => ({ send })) }, next = jest.fn();
  gate({ url: '/private' }, res, next);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(send).toHaveBeenCalledWith('Internal stream resolver unavailable.');
  expect(next).not.toHaveBeenCalled();
});

test('proxy gate preserves normal routing and fails closed if the state cannot be read', () => {
  const next = jest.fn();
  createResolverConflictGate({ hasConflict: () => false })({}, {}, next);
  expect(next).toHaveBeenCalledTimes(1);
  const res = { status: jest.fn(() => ({ send: jest.fn() })) };
  createResolverConflictGate({ hasConflict: () => { throw new Error('state'); } })({}, res, next);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(next).toHaveBeenCalledTimes(1);
});

test('cache switches to local operation after this worker observes a conflict', async () => {
  const oldFetch = global.fetch, oldShared = process.env.RESOLVE_CACHE_SHARED;
  let conflict = false;
  process.env.RESOLVE_CACHE_SHARED = 'true';
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: 'miss' }) }));
  const cache = new StreamResolveCache({ resolverConflictState: { hasConflict: () => conflict } });
  try {
    await cache.getOrCreate('damitv:first:source', async () => []);
    expect(global.fetch).toHaveBeenCalled();
    global.fetch.mockClear();
    conflict = true;
    expect(await cache.getOrCreate('damitv:second:source', async () => [{ url: 'https://example.test/' }])).toHaveLength(1);
    cache.noteFailure('damitv:second:source'); cache.pruneEnded([]);
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    global.fetch = oldFetch;
    if (oldShared === undefined) delete process.env.RESOLVE_CACHE_SHARED; else process.env.RESOLVE_CACHE_SHARED = oldShared;
  }
});

test('in-flight shared-cache fetch receives cancellation on observed conflict', async () => {
  const oldFetch = global.fetch, oldShared = process.env.RESOLVE_CACHE_SHARED;
  const controller = new AbortController();
  let conflict = false, started;
  const ready = new Promise(resolve => { started = resolve; });
  process.env.RESOLVE_CACHE_SHARED = 'true';
  global.fetch = jest.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    started(options.signal);
  }));
  const cache = new StreamResolveCache({ resolverConflictState: {
    hasConflict: () => conflict, signal: () => controller.signal
  } });
  try {
    const pending = cache.getOrCreate('damitv:fixture:s', async () => [{ url: 'https://example.test/' }]);
    const requestSignal = await ready;
    conflict = true;
    controller.abort(new DOMException('Conflict', 'AbortError'));
    expect(await pending).toHaveLength(1);
    expect(requestSignal.aborted).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  } finally {
    global.fetch = oldFetch;
    if (oldShared === undefined) delete process.env.RESOLVE_CACHE_SHARED; else process.env.RESOLVE_CACHE_SHARED = oldShared;
  }
});
