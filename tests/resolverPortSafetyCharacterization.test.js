'use strict';

// Characterizes the current defect using a mocked fetch; no listener or
// network is created. It is not a regression test for the desired behavior.
const StreamResolveCache = require('../src/services/StreamResolveCache');

test('an unverified cache endpoint can receive a generated stream and its hints', async () => {
  const originalFetch = global.fetch, originalShared = process.env.RESOLVE_CACHE_SHARED;
  const originalPort = process.env.RESOLVER_PORT;
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
    expect(post).toBeDefined();
    expect(JSON.parse(post.body).streams[0]).toMatchObject({ url: 'https://example.test/private',
      behaviorHints: { proxyHeaders: { request: { Authorization: 'fixture-credential' } } } });
  } finally {
    global.fetch = originalFetch;
    if (originalShared === undefined) delete process.env.RESOLVE_CACHE_SHARED; else process.env.RESOLVE_CACHE_SHARED = originalShared;
    if (originalPort === undefined) delete process.env.RESOLVER_PORT; else process.env.RESOLVER_PORT = originalPort;
  }
});
