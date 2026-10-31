
// These tests explicitly exercise the unauthenticated TCP compatibility mode.
const legacyTrustBeforeTests = process.env.RESOLVER_TRUST_LEGACY_TCP;
beforeAll(() => { process.env.RESOLVER_TRUST_LEGACY_TCP = 'true'; });
afterAll(() => {
  if (legacyTrustBeforeTests === undefined) delete process.env.RESOLVER_TRUST_LEGACY_TCP;
  else process.env.RESOLVER_TRUST_LEGACY_TCP = legacyTrustBeforeTests;
});
const StreamResolveCache = require('../src/services/StreamResolveCache');

describe('StreamResolveCache local single-flight', () => {
  const originalShared = process.env.RESOLVE_CACHE_SHARED;
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalShared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
    else process.env.RESOLVE_CACHE_SHARED = originalShared;
  });

  test('concurrent requests deduplicate before shared-cache I/O, even when L2 fails', async () => {
    process.env.RESOLVE_CACHE_SHARED = 'true';
    global.fetch = jest.fn(async () => ({ ok: false }));
    const cache = new StreamResolveCache();
    const mint = jest.fn(async () => [{ url: 'https://cdn.example/live.m3u8' }]);
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      cache.getOrCreate('provider:match:source', mint)));
    expect(mint).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    for (const result of results) expect(result[0].url).toBe('https://cdn.example/live.m3u8');
    expect(cache.stats().inFlight).toBe(0);
    expect(cache.stats().misses).toBe(1);
  });

  test('a synchronous mint failure releases single-flight and negative-caches the result', async () => {
    process.env.RESOLVE_CACHE_SHARED = 'false';
    const cache = new StreamResolveCache();
    const mint = jest.fn(() => { throw new Error('provider unavailable'); });
    await expect(cache.getOrCreate('provider:match:source', mint)).resolves.toEqual([]);
    expect(cache.stats().inFlight).toBe(0);
    await expect(cache.getOrCreate('provider:match:source', mint)).resolves.toEqual([]);
    expect(mint).toHaveBeenCalledTimes(1);
    // Expire the negative cache: the next request must be able to retry.
    cache.entries.get('provider:match:source').expiresAt = 0;
    await cache.getOrCreate('provider:match:source', mint);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(cache.stats().inFlight).toBe(0);
  });
});
