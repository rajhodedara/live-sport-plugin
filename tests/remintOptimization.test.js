const { asValue } = require('awilix');
const container = require('../src/container');
const { attemptRemint, remintCache, mintInFlight, MAX_REMINT_CACHE_ENTRIES } = require('../src/remint');
const streams = require('../src/streams');

describe('Remint Optimization & Zero-Clone In-Flight Coalescing', () => {
  let originalCacheService;
  let getMatchesSpy;
  let findMatchSpy;
  let resolveSourceSpy;

  const mockMatch = {
    id: 'streamedpk_123',
    title: 'Test Match',
    sources: [
      { id: '456', streamId: '456', name: 'Stream 1' }
    ]
  };

  beforeEach(() => {
    originalCacheService = container.resolve('cacheService');

    getMatchesSpy = jest.fn(() => [mockMatch]);
    findMatchSpy = jest.fn((id) => (id === 'streamedpk_123' ? mockMatch : null));

    container.register({
      cacheService: asValue({
        getMatches: getMatchesSpy,
        findMatch: findMatchSpy,
      })
    });

    resolveSourceSpy = jest.spyOn(streams, 'resolveSource').mockImplementation(async () => [
      { url: 'https://edge.stream.test/rtmp/stream/fresh_token/1/playlist.m3u8' }
    ]);

    remintCache.clear();
    mintInFlight.clear();
  });

  afterEach(() => {
    container.register({
      cacheService: asValue(originalCacheService)
    });
    if (resolveSourceSpy) resolveSourceSpy.mockRestore();
    remintCache.clear();
    mintInFlight.clear();
  });

  test('attemptRemint uses O(1) findMatch and never invokes full-clone getMatches()', async () => {
    const rck = 'streamedpk:streamedpk_123:456';
    const heldUrl = 'https://edge.stream.test/rtmp/stream/old_token/1/playlist.m3u8';

    const fresh = await attemptRemint(rck, heldUrl);

    expect(findMatchSpy).toHaveBeenCalledWith('streamedpk_123');
    expect(getMatchesSpy).not.toHaveBeenCalled();
    expect(fresh).toContain('fresh_token');
  });

  test('attemptRemint single-flights concurrent requests for the same rck', async () => {
    const rck = 'streamedpk:streamedpk_123:456';
    const heldUrl = 'https://edge.stream.test/rtmp/stream/old_token/1/playlist.m3u8';

    // Delay resolveSource to simulate real network delay
    let resolvePromise;
    resolveSourceSpy.mockImplementation(() => new Promise((resolve) => {
      resolvePromise = resolve;
    }));

    // Trigger two concurrent remint attempts
    const p1 = attemptRemint(rck, heldUrl);
    const p2 = attemptRemint(rck, heldUrl);

    expect(mintInFlight.has(rck)).toBe(true);

    // Release upstream response
    resolvePromise([
      { url: 'https://edge.stream.test/rtmp/stream/coalesced_token/1/playlist.m3u8' }
    ]);

    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res1).toBe(res2);
    expect(res1).toContain('coalesced_token');
    // resolveSource should have been called only once despite 2 concurrent requests
    expect(resolveSourceSpy).toHaveBeenCalledTimes(1);
    expect(mintInFlight.has(rck)).toBe(false);
  });

  test('remintCache bounds maximum entries and evicts oldest on overflow', () => {
    // Fill remintCache to capacity
    for (let i = 0; i < MAX_REMINT_CACHE_ENTRIES; i++) {
      remintCache.set(`key_${i}`, { freshUrl: `http://test/${i}`, expiresAt: Date.now() + 60000 });
    }
    expect(remintCache.size).toBe(MAX_REMINT_CACHE_ENTRIES);

    // Adding one more item should evict key_0
    remintCache.set('overflow_key', { freshUrl: 'http://test/overflow', expiresAt: Date.now() + 60000 });
    expect(remintCache.size).toBe(MAX_REMINT_CACHE_ENTRIES);
    expect(remintCache.has('key_0')).toBe(false);
    expect(remintCache.has('overflow_key')).toBe(true);
  });
});
