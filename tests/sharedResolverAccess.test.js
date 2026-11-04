'use strict';
const StreamResolveCache = require('../src/services/StreamResolveCache');

let oldShared, oldFetch;
beforeEach(() => {
  oldShared = process.env.RESOLVE_CACHE_SHARED; oldFetch = global.fetch;
  process.env.RESOLVE_CACHE_SHARED = 'true';
  global.fetch = jest.fn(() => { throw new Error('unverified network access'); });
});
afterEach(() => {
  global.fetch = oldFetch;
  if (oldShared === undefined) delete process.env.RESOLVE_CACHE_SHARED; else process.env.RESOLVE_CACHE_SHARED = oldShared;
});

test('an unavailable adapter preserves local caching and sends no shared-cache traffic', async () => {
  const sharedResolver = { available: () => false, request: jest.fn() };
  const cache = new StreamResolveCache({ sharedResolver });
  const mint = jest.fn(async () => [{ url: 'https://example.test/private' }]);
  expect(await cache.getOrCreate('damitv:m:s', mint)).toHaveLength(1);
  expect(await cache.getOrCreate('damitv:m:s', mint)).toHaveLength(1);
  cache.noteFailure('damitv:m:s'); cache.pruneEnded([]);
  expect(mint).toHaveBeenCalledTimes(1);
  expect(sharedResolver.request).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('revoking availability after a claim prevents the later shared write', async () => {
  let available = true;
  const request = jest.fn(async url => ({ ok: true, json: async () => String(url).includes('claim=1')
    ? { ok: true, ownerToken: 'fixture' } : { status: 'miss' } }));
  const cache = new StreamResolveCache({ sharedResolver: { available: () => available, request } });
  const result = await cache.getOrCreate('damitv:m:s', async () => {
    available = false;
    return [{ url: 'https://example.test/private' }];
  });
  expect(result).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('a malformed adapter fails closed rather than falling back to raw fetch', async () => {
  const cache = new StreamResolveCache({ sharedResolver: { available: () => true } });
  expect(await cache.getOrCreate('damitv:m:s', async () => [])).toEqual([]);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('a conflict during a shared read aborts it and continues with the local cache', async () => {
  const controller = new AbortController();
  let conflicted = false, started;
  const readStarted = new Promise(resolve => { started = resolve; });
  const request = jest.fn((_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    started();
  }));
  const cache = new StreamResolveCache({
    sharedResolver: { available: () => true, request },
    resolverConflictState: { hasConflict: () => conflicted, signal: () => controller.signal }
  });
  const mint = jest.fn(async () => [{ url: 'https://example.test/private' }]);
  const result = cache.getOrCreate('damitv:m:s', mint);
  await readStarted;
  conflicted = true;
  controller.abort();
  expect(await result).toHaveLength(1);
  expect(await cache.getOrCreate('damitv:m:s', mint)).toHaveLength(1);
  expect(mint).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('ignores a late shared hit when the adapter ignores conflict cancellation', async () => {
  const controller = new AbortController();
  let conflict = false, finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const request = jest.fn(() => new Promise(resolve => { finish = resolve; started(); }));
  const cache = new StreamResolveCache({ sharedResolver: { available: () => true, request },
    resolverConflictState: { hasConflict: () => conflict, signal: () => controller.signal } });
  const mint = jest.fn(async () => [{ url: 'https://local.example/stream' }]);
  const pending = cache.getOrCreate('damitv:late:source', mint);
  await ready;
  conflict = true;
  controller.abort();
  finish({ ok: true, json: async () => ({ status: 'ok', streams: [{ url: 'https://foreign.example/stream' }], ttlMs: 30000 }) });
  expect(await pending).toEqual([{ url: 'https://local.example/stream' }]);
  expect(mint).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('does not invoke an adapter when the conflict signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = jest.fn();
  // Exercise the boundary independently: even inconsistent state reporting
  // must not send a request once the signal has been revoked.
  const cache = new StreamResolveCache({ sharedResolver: { available: () => true, request },
    resolverConflictState: { hasConflict: () => false, signal: () => controller.signal } });
  const mint = jest.fn(async () => [{ url: 'https://local.example/stream' }]);
  expect(await cache.getOrCreate('damitv:aborted:source', mint)).toEqual([{ url: 'https://local.example/stream' }]);
  expect(request).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});
