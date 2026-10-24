const StreamResolveCache = require('../src/services/StreamResolveCache');

describe('Worker ownership protocol', () => {
  const originalFetch = global.fetch;
  const originalShared = process.env.RESOLVE_CACHE_SHARED;
  beforeEach(() => { process.env.RESOLVE_CACHE_SHARED = 'true'; });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalShared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
    else process.env.RESOLVE_CACHE_SHARED = originalShared;
  });
  function resolver(ownerToken) {
    global.fetch = jest.fn(async (url, opts = {}) => ({ ok: true, json: async () =>
      url.includes('claim=1') ? { ok: true, ...(ownerToken ? { ownerToken } : {}) }
        : opts.method ? { ok: true } : { status: 'miss' } }));
  }

  test('requests ownership and includes the returned token in shared writes', async () => {
    resolver('owner-a');
    const cache = new StreamResolveCache();
    expect(await cache.getOrCreate('provider:match:source', async () => [{ url: 'live' }])).toEqual([{ url: 'live' }]);
    expect(global.fetch.mock.calls.some(([url]) => url.includes('claim=1&fenced=1'))).toBe(true);
    const post = global.fetch.mock.calls.find(([, opts]) => opts.method === 'POST');
    expect(JSON.parse(post[1].body).ownerToken).toBe('owner-a');
  });

  test('provider exceptions release only the returned owner token', async () => {
    const ownerToken = 'owner:A/+=';
    resolver(ownerToken);
    const cache = new StreamResolveCache();
    expect(await cache.getOrCreate('provider:match:source', async () => { throw new Error('unavailable'); })).toEqual([]);
    const release = global.fetch.mock.calls.find(([, opts]) => opts.method === 'DELETE');
    expect(new URL(release[0]).searchParams.get('ownerToken')).toBe(ownerToken);
  });

  test.each(['streams', 'error'])('older resolvers without owner tokens use local-only publication (%s)', async outcome => {
    resolver(undefined);
    const cache = new StreamResolveCache();
    const result = await cache.getOrCreate('provider:match:source', async () => {
      if (outcome === 'error') throw new Error('unavailable');
      return [{ url: 'live' }];
    });
    expect(result).toEqual(outcome === 'streams' ? [{ url: 'live' }] : []);
    expect(global.fetch.mock.calls.filter(([, opts]) => ['POST', 'DELETE'].includes(opts.method))).toHaveLength(0);
  });
});
