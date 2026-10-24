const StreamResolveCache = require('../src/services/StreamResolveCache');
const { resolveKey, prewarmMatch } = require('../src/streams');
const CronService = require('../src/services/CronService');

describe('Prewarm Resolve Key and Cache Warmth Verification', () => {
  describe('Canonical resolveKey Construction', () => {
    test('Constructs canonical key for simple provider sources', () => {
      const src = { source: 'daddylive', id: 'ch_60' };
      expect(resolveKey(src, 'match_100')).toBe('daddylive:match_100:ch_60');
      expect(StreamResolveCache.resolveKey(src, 'match_100')).toBe('daddylive:match_100:ch_60');
    });

    test('Constructs canonical key with streamSource subKey (e.g. StreamedPkProvider)', () => {
      const src = {
        source: 'streamedpk',
        id: 'alpha_stream',
        streamSource: 'embed69'
      };
      expect(resolveKey(src, 'match_100')).toBe('streamedpk:match_100:alpha_stream:embed69');
      expect(StreamResolveCache.resolveKey(src, 'match_100')).toBe('streamedpk:match_100:alpha_stream:embed69');
    });

    test('Constructs canonical key with both streamSource and streamId', () => {
      const src = {
        source: 'streamedpk',
        id: 'alpha_stream',
        streamSource: 'embed69',
        streamId: 'variant_2'
      };
      expect(resolveKey(src, 'match_100')).toBe('streamedpk:match_100:alpha_stream:embed69:variant_2');
      expect(StreamResolveCache.resolveKey(src, 'match_100')).toBe('streamedpk:match_100:alpha_stream:embed69:variant_2');
    });

    test('Accepts match object with .id or matchId string interchangeably', () => {
      const src = { source: 'leaf', id: 'feed_1' };
      const matchObj = { id: 'fixture_99', title: 'Arsenal vs Chelsea' };
      expect(resolveKey(src, matchObj)).toBe('leaf:fixture_99:feed_1');
      expect(resolveKey(src, 'fixture_99')).toBe('leaf:fixture_99:feed_1');
    });

    test('Gracefully handles missing or empty source', () => {
      expect(resolveKey(null, 'match_1')).toBe('');
      expect(resolveKey(undefined, 'match_1')).toBe('');
    });
  });

  describe('StreamResolveCache has(), isResolved(), and getRemainingTtl()', () => {
    let cache;

    beforeEach(() => {
      cache = new StreamResolveCache({ defaultTtlMs: 60000 });
    });

    test('has() returns true only for fresh positive entries', () => {
      const key = 'daddylive:m1:ch_60';
      expect(cache.has(key)).toBe(false);

      // Set positive entry
      cache._set(key, 'daddylive', 'm1', [{ url: 'https://cdn.example/live.m3u8' }], 'ok', 60000);
      expect(cache.has(key)).toBe(true);

      // Set failed entry
      const failedKey = 'vavoo:m1:s1';
      cache._set(failedKey, 'vavoo', 'm1', [], 'failed', 60000);
      expect(cache.has(failedKey)).toBe(false);
      expect(cache.isResolved(failedKey)).toBe(true);
    });

    test('has() and isResolved() return false for expired entries', () => {
      const key = 'ppvst:m1:s1';
      cache._set(key, 'ppvst', 'm1', [{ url: 'https://cdn.example/live.m3u8' }], 'ok', -1000); // expired
      expect(cache.has(key)).toBe(false);
      expect(cache.isResolved(key)).toBe(false);
    });

    test('getRemainingTtl() returns correct remaining duration', () => {
      const key = 'daddylive:m1:ch_60';
      expect(cache.getRemainingTtl(key)).toBe(0);

      cache._set(key, 'daddylive', 'm1', [{ url: 'https://cdn.example/live.m3u8' }], 'ok', 50000);
      const remaining = cache.getRemainingTtl(key);
      expect(remaining).toBeGreaterThan(40000);
      expect(remaining).toBeLessThanOrEqual(50000);
    });
  });

  describe('CronService.prewarmPopular Warmth Detection with subKey and Master Switch', () => {
    let cronService;
    let mockCacheService;
    let streamResolveCache;

    beforeEach(() => {
      delete process.env.PREWARM_MAX_MATCHES;
      process.env.PREWARM_SKIP_PROVIDERS = ''; // Allow all providers for testing
      streamResolveCache = new StreamResolveCache({ defaultTtlMs: 300000 });
      mockCacheService = {
        getMatches: jest.fn()
      };
      cronService = new CronService({
        matchAggregator: {},
        streamResolveCache,
        cacheService: mockCacheService,
        providerHealthService: {}
      });
    });

    afterEach(() => {
      delete process.env.PREWARM_MAX_MATCHES;
      delete process.env.PREWARM_SKIP_PROVIDERS;
    });

    test('PREWARM_MAX_MATCHES=0 bails out immediately without querying catalog', async () => {
      process.env.PREWARM_MAX_MATCHES = '0';
      await cronService.prewarmPopular();
      expect(mockCacheService.getMatches).not.toHaveBeenCalled();
    });

    test('Correctly identifies StreamedPk sources with streamSource subKeys as warm in resolveCache', async () => {
      const match = {
        id: 'match_spk_live',
        title: 'Man City vs Liverpool',
        category: 'football',
        status: 'live',
        popular: '1',
        date: String(Date.now() - 10000),
        sources: [
          {
            id: 'stream_101',
            source: 'streamedpk',
            streamSource: 'embed69',
            streamId: '1'
          }
        ]
      };

      mockCacheService.getMatches.mockReturnValue([match]);

      // Before caching: match is cold
      // Warm key construction matches resolveKey
      const expectedKey = resolveKey(match.sources[0], match.id);
      expect(expectedKey).toBe('streamedpk:match_spk_live:stream_101:embed69:1');

      // Pre-warm the cache using the exact subKey
      streamResolveCache._set(expectedKey, 'streamedpk', match.id, [{ url: 'https://cdn.example/spk.m3u8' }], 'ok', 300000);

      const streamsMod = require('../src/streams');
      const prewarmSpy = jest.spyOn(streamsMod, 'prewarmMatch').mockResolvedValue();

      try {
        await cronService.prewarmPopular();
        // Since the source is warm under the canonical subKey, it should be skipped
        expect(prewarmSpy).not.toHaveBeenCalled();
      } finally {
        prewarmSpy.mockRestore();
      }
    });

    test('Prewarms cold matches when sources are not in cache', async () => {
      const match = {
        id: 'match_cold_live',
        title: 'Lakers vs Warriors',
        category: 'basketball',
        status: 'live',
        popular: '1',
        date: String(Date.now() - 10000),
        sources: [
          {
            id: 'stream_202',
            source: 'streamedpk',
            streamSource: 'admin'
          }
        ]
      };

      mockCacheService.getMatches.mockReturnValue([match]);

      const streamsMod = require('../src/streams');
      const prewarmSpy = jest.spyOn(streamsMod, 'prewarmMatch').mockResolvedValue();

      try {
        await cronService.prewarmPopular();
        // Match was cold, prewarmMatch must be called
        expect(prewarmSpy).toHaveBeenCalledTimes(1);
        expect(prewarmSpy).toHaveBeenCalledWith(match, null, Number.MAX_SAFE_INTEGER);
      } finally {
        prewarmSpy.mockRestore();
      }
    });

    test('Priority sources (daddylive, ppvst, leaf) skip prewarming once resolved', async () => {
      const match = {
        id: 'match_priority_live',
        title: 'Real Madrid vs Barcelona',
        category: 'football',
        status: 'live',
        popular: '1',
        date: String(Date.now() - 10000),
        sources: [
          { id: 'ch_60', source: 'daddylive' },
          { id: 'feed_1', source: 'leaf' }
        ]
      };

      mockCacheService.getMatches.mockReturnValue([match]);

      // Populate cache for both priority sources
      streamResolveCache._set(resolveKey(match.sources[0], match.id), 'daddylive', match.id, [{ url: 'https://cdn.example/dlv.m3u8' }], 'ok', 300000);
      streamResolveCache._set(resolveKey(match.sources[1], match.id), 'leaf', match.id, [{ url: 'https://cdn.example/leaf.m3u8' }], 'ok', 300000);

      const streamsMod = require('../src/streams');
      const prewarmSpy = jest.spyOn(streamsMod, 'prewarmMatch').mockResolvedValue();

      try {
        await cronService.prewarmPopular();
        // Both priority sources are warm, should skip prewarm
        expect(prewarmSpy).not.toHaveBeenCalled();
      } finally {
        prewarmSpy.mockRestore();
      }
    });
  });
});
