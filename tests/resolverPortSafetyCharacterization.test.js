'use strict';

// Default-denial regression using mocked fetch; no listener or network exists.
const StreamResolveCache = require('../src/services/StreamResolveCache');

test('an unverified TCP cache endpoint receives no generated stream or hints by default', async () => {
  const originalFetch = global.fetch, originalShared = process.env.RESOLVE_CACHE_SHARED;
  const originalPort = process.env.RESOLVER_PORT;
  const originalTrust = process.env.RESOLVER_TRUST_LEGACY_TCP;
  delete process.env.RESOLVER_TRUST_LEGACY_TCP;
  process.env.RESOLVE_CACHE_SHARED = 'true';
  process.env.RESOLVER_PORT = '7004';
  const seen = [];
  global.fetch = jest.fn(async (url, options = {}) => {
    seen.push({ url, method: options.method || 'GET', body: options.body });
    const value = options.method === 'POST' ? { ok: true } :
      String(url).includes('claim=1') ? { ok: true, ownerToken: 'fixture-token' } : { status: 'miss' };
    return { ok: true, json: async () => value };
  });
  try {
    const cache = new StreamResolveCache();
    await cache.getOrCreate('damitv:fixture:source', async () => [{ url: 'https://example.test/private',
      behaviorHints: { proxyHeaders: { request: { Authorization: 'fixture-credential' } } } }]);
    const post = seen.find(call => call.method === 'POST');
    expect(post).toBeUndefined();
    expect(seen).toEqual([]);
  } finally {
    global.fetch = originalFetch;
    if (originalShared === undefined) delete process.env.RESOLVE_CACHE_SHARED; else process.env.RESOLVE_CACHE_SHARED = originalShared;
    if (originalPort === undefined) delete process.env.RESOLVER_PORT; else process.env.RESOLVER_PORT = originalPort;
    if (originalTrust === undefined) delete process.env.RESOLVER_TRUST_LEGACY_TCP; else process.env.RESOLVER_TRUST_LEGACY_TCP = originalTrust;
  }
});
