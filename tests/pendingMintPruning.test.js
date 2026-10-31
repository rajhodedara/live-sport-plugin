const StreamResolveCache = require('../src/services/StreamResolveCache');
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe('Pruning pending stream resolutions', () => {
  const originalShared = process.env.RESOLVE_CACHE_SHARED;
  const originalFetch = global.fetch;
  const originalTrust = process.env.RESOLVER_TRUST_LEGACY_TCP;
  beforeEach(() => { process.env.RESOLVE_CACHE_SHARED = 'false'; });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalTrust === undefined) delete process.env.RESOLVER_TRUST_LEGACY_TCP;
    else process.env.RESOLVER_TRUST_LEGACY_TCP = originalTrust;
    if (originalShared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
    else process.env.RESOLVE_CACHE_SHARED = originalShared;
  });

  test.each(['streams', 'empty', 'error'])('a pruned pending mint cannot repopulate the cache (%s)', async outcome => {
    const cache = new StreamResolveCache();
    const work = deferred();
    const mint = jest.fn(() => work.promise);
    const response = cache.getOrCreate('provider:ended:source', mint);
    await Promise.resolve();
    expect(mint).toHaveBeenCalledTimes(1);
    cache.pruneEnded([]);
    if (outcome === 'error') work.reject(new Error('late failure'));
    else work.resolve(outcome === 'empty' ? [] : [{ url: 'https://cdn.example/late.m3u8' }]);
    expect(await response).toEqual([]);
    expect(cache.entries.has('provider:ended:source')).toBe(false);
    expect(cache.stats().inFlight).toBe(0);
    expect(cache.pendingOperations.size).toBe(0);
  });

  test('active matches and evergreen channels keep their pending results', async () => {
    const cache = new StreamResolveCache();
    const active = deferred(), channel = deferred();
    const a = cache.getOrCreate('provider:active:source', () => active.promise);
    const c = cache.getOrCreate('provider:__channel__:source', () => channel.promise);
    await Promise.resolve();
    cache.pruneEnded(['active']);
    active.resolve([{ url: 'active' }]);
    channel.resolve([{ url: 'channel' }]);
    expect(await a).toEqual([{ url: 'active' }]);
    expect(await c).toEqual([{ url: 'channel' }]);
  });

  test('late shared-cache lookup cannot restore a locally pruned match', async () => {
    process.env.RESOLVE_CACHE_SHARED = 'true';
    process.env.RESOLVER_TRUST_LEGACY_TCP = 'true'; // Explicit mocked TCP compatibility scenario.
    const lookup = deferred();
    global.fetch = jest.fn((url, opts = {}) => opts.method === 'POST'
      ? Promise.resolve({ ok: true, json: async () => ({ ok: true }) }) : lookup.promise);
    const cache = new StreamResolveCache();
    const mint = jest.fn(async () => [{ url: 'should-not-mint' }]);
    const response = cache.getOrCreate('provider:ended:source', mint);
    await Promise.resolve();
    cache.pruneEnded([]);
    lookup.resolve({ ok: true, json: async () => ({ status: 'ok', streams: [{ url: 'stale' }], expiresAt: Date.now() + 60000 }) });
    expect(await response).toEqual([]);
    expect(cache.entries.has('provider:ended:source')).toBe(false);
    expect(mint).not.toHaveBeenCalled();
  });

  test('a locally pruned result is not written through to the shared cache', async () => {
    process.env.RESOLVE_CACHE_SHARED = 'true';
    process.env.RESOLVER_TRUST_LEGACY_TCP = 'true'; // Explicit mocked TCP compatibility scenario.
    global.fetch = jest.fn(async (url, opts = {}) => ({ ok: true, json: async () =>
      opts.method === 'POST' || url.includes('claim=1') ? { ok: true } : { status: 'miss' } }));
    const cache = new StreamResolveCache();
    const work = deferred(), started = deferred();
    const response = cache.getOrCreate('provider:ended:source', () => {
      started.resolve(); return work.promise;
    });
    await started.promise;
    cache.pruneEnded([]);
    work.resolve([{ url: 'late' }]);
    expect(await response).toEqual([]);
    const writes = global.fetch.mock.calls.filter(([url, opts]) => opts.method === 'POST' && !url.endsWith('/prune'));
    expect(writes).toHaveLength(0);
  });

  test('a later new resolution for the same key is allowed after the discarded mint finishes', async () => {
    const cache = new StreamResolveCache();
    const work = deferred();
    const first = cache.getOrCreate('provider:ended:source', () => work.promise);
    await Promise.resolve();
    cache.pruneEnded([]);
    work.resolve([{ url: 'old' }]);
    await first;
    expect(await cache.getOrCreate('provider:ended:source', async () => [{ url: 'new' }])).toEqual([{ url: 'new' }]);
  });
});
