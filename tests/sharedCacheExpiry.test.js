
// These tests explicitly exercise the unauthenticated TCP compatibility mode.
const legacyTrustBeforeTests = process.env.RESOLVER_TRUST_LEGACY_TCP;
beforeAll(() => { process.env.RESOLVER_TRUST_LEGACY_TCP = 'true'; });
afterAll(() => {
  if (legacyTrustBeforeTests === undefined) delete process.env.RESOLVER_TRUST_LEGACY_TCP;
  else process.env.RESOLVER_TRUST_LEGACY_TCP = legacyTrustBeforeTests;
});
const StreamResolveCache = require('../src/services/StreamResolveCache');

describe('Shared cache expiry and pruning', () => {
  const originalFetch = global.fetch;
  const originalShared = process.env.RESOLVE_CACHE_SHARED;
  beforeEach(() => { process.env.RESOLVE_CACHE_SHARED = 'true'; });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalShared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
    else process.env.RESOLVE_CACHE_SHARED = originalShared;
  });

  test.each(['ok', 'failed'])('retries when a shared %s result expires before receipt', async status => {
    global.fetch = jest.fn(async (url, opts = {}) => ({ ok: true, json: async () =>
      opts.method === 'POST' || url.includes('claim=1') ? { ok: true } : {
        status, streams: [{ url: 'https://cdn.example/stale.m3u8' }], expiresAt: Date.now() - 1,
      } }));
    const cache = new StreamResolveCache();
    const mint = jest.fn(async () => [{ url: 'https://cdn.example/fresh.m3u8' }]);
    expect(await cache.getOrCreate('provider:match:source', mint)).toEqual([
      { url: 'https://cdn.example/fresh.m3u8' },
    ]);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls.some(([url]) => url.includes('claim=1'))).toBe(true);
  });

  test.each([undefined, 0, 'bad', Infinity])('does not adopt an invalid expiry (%s)', expiresAt => {
    const cache = new StreamResolveCache();
    cache._adoptRemote('provider:match:source', {
      status: 'ok', streams: [{ url: 'https://cdn.example/stale.m3u8' }], expiresAt,
    });
    expect(cache.get('provider:match:source')).toBeNull();
  });

  test('an entry is expired exactly at its expiry time', () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const cache = new StreamResolveCache();
      cache._set('provider:match:source', 'provider', 'match', [{ url: 'live' }], 'ok', 0);
      expect(cache.get('provider:match:source')).toBeNull();
    } finally { spy.mockRestore(); }
  });

  test('an empty active match set also prunes L2, preserving local evergreen channels', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const cache = new StreamResolveCache();
    cache._set('provider:ended:source', 'provider', 'ended', [{ url: 'ended' }], 'ok', 60000);
    cache._set('provider:__channel__:source', 'provider', '__channel__', [{ url: 'channel' }], 'ok', 60000);
    cache.pruneEnded([]);
    expect(cache.get('provider:ended:source')).toBeNull();
    expect(cache.get('provider:__channel__:source')).toEqual([{ url: 'channel' }]);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/cache/prune'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ activeIds: [] }) }));
    await Promise.resolve();
  });
});
