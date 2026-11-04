'use strict';

const CronService = require('../src/services/CronService');
const container = require('../src/container');
const { prewarmMatch } = require('../src/streams');

describe('Cluster Worker Deduplication & Batch Prewarming', () => {
  const origNodeAppInstance = process.env.NODE_APP_INSTANCE;
  const origPmId = process.env.pm_id;

  afterEach(() => {
    if (origNodeAppInstance !== undefined) {
      process.env.NODE_APP_INSTANCE = origNodeAppInstance;
    } else {
      delete process.env.NODE_APP_INSTANCE;
    }
    if (origPmId !== undefined) {
      process.env.pm_id = origPmId;
    } else {
      delete process.env.pm_id;
    }
  });

  describe('CronService.ensureFresh worker deduplication', () => {
    let mockCacheService;
    let cronService;

    beforeEach(() => {
      mockCacheService = {
        isStale: jest.fn().mockReturnValue(true),
      };
      cronService = new CronService({
        matchAggregator: {},
        streamResolveCache: {},
        cacheService: mockCacheService,
      });
      cronService.runSync = jest.fn().mockResolvedValue(true);
    });

    test('Primary worker (NODE_APP_INSTANCE=0) triggers background re-sync', () => {
      process.env.NODE_APP_INSTANCE = '0';
      cronService.ensureFresh();
      expect(cronService.runSync).toHaveBeenCalledTimes(1);
    });

    test('Single-instance/standalone (NODE_APP_INSTANCE=undefined) triggers background re-sync', () => {
      delete process.env.NODE_APP_INSTANCE;
      delete process.env.pm_id;
      cronService.ensureFresh();
      expect(cronService.runSync).toHaveBeenCalledTimes(1);
    });

    test('Secondary worker (NODE_APP_INSTANCE=1) returns immediately and does NOT re-sync', () => {
      process.env.NODE_APP_INSTANCE = '1';
      cronService.ensureFresh();
      expect(cronService.runSync).not.toHaveBeenCalled();
    });

    // pm_id is NOT a worker index. PM2 hands a fresh, ever-increasing value to
    // every worker a zero-downtime reload spawns, which is why requiring
    // pm_id === '0' silently disabled the SWR re-sync after the first reload.
    // In fork mode NODE_APP_INSTANCE is absent and pm_id still describes a
    // single process, so it must keep refreshing.
    test('a non-zero pm_id without NODE_APP_INSTANCE still counts as primary', () => {
      delete process.env.NODE_APP_INSTANCE;
      process.env.pm_id = '7';
      cronService.ensureFresh();
      expect(cronService.runSync).toHaveBeenCalledTimes(1);
    });

    test('Primary worker via pm_id=0 triggers background re-sync', () => {
      delete process.env.NODE_APP_INSTANCE;
      process.env.pm_id = '0';
      cronService.ensureFresh();
      expect(cronService.runSync).toHaveBeenCalledTimes(1);
    });

    test('Other non-primary worker (NODE_APP_INSTANCE=2) returns immediately and does NOT re-sync', () => {
      process.env.NODE_APP_INSTANCE = '2';
      cronService.ensureFresh();
      expect(cronService.runSync).not.toHaveBeenCalled();
    });

    test('Does not re-sync if cache is not stale', () => {
      delete process.env.NODE_APP_INSTANCE;
      mockCacheService.isStale.mockReturnValue(false);
      cronService.ensureFresh();
      expect(cronService.runSync).not.toHaveBeenCalled();
    });

    test('Does not re-sync if already syncing', () => {
      delete process.env.NODE_APP_INSTANCE;
      cronService.syncing = true;
      cronService.ensureFresh();
      expect(cronService.runSync).not.toHaveBeenCalled();
    });
  });

  describe('prewarmMatch batching', () => {
    test('Warms sources in batches of 3 at a time without exceeding concurrency limit', async () => {
      const resolveCache = container.resolve('streamResolveCache');
      const origGet = resolveCache.get.bind(resolveCache);
      const origGetOrCreate = resolveCache.getOrCreate.bind(resolveCache);

      let currentConcurrency = 0;
      let maxConcurrency = 0;
      const executedKeys = [];

      jest.spyOn(resolveCache, 'get').mockReturnValue(null);
      jest.spyOn(resolveCache, 'getOrCreate').mockImplementation(async (key, fn) => {
        currentConcurrency++;
        if (currentConcurrency > maxConcurrency) {
          maxConcurrency = currentConcurrency;
        }
        executedKeys.push(key);
        // Small delay to simulate async resolution
        await new Promise((r) => setTimeout(r, 25));
        currentConcurrency--;
        return [];
      });

      try {
        const mockMatch = {
          id: 'test_match_batching',
          // Non-skipped providers only: the prewarm skip list
          // (PREWARM_SKIP_PROVIDERS) excludes the heavy embed family, so these
          // fixtures use prewarmable providers to test batching itself.
          sources: [
            { id: 's1', source: 'daddylive', name: 'Feed 1' },
            { id: 's2', source: 'timstreams', name: 'Feed 2' },
            { id: 's3', source: 'streamsports99', name: 'Feed 3' },
            { id: 's4', source: 'cdnlive', name: 'Feed 4' },
            { id: 's5', source: 'livetv', name: 'Feed 5' },
            { id: 's6', source: 'damitv', name: 'Feed 6' },
            { id: 's7', source: 'replayzone', name: 'Feed 7' },
          ],
        };

        await prewarmMatch(mockMatch, null);

        // All 7 sources should have been warmed
        expect(executedKeys.length).toBe(7);
        // At no time should concurrency exceed batch size 3
        expect(maxConcurrency).toBeLessThanOrEqual(3);
      } finally {
        resolveCache.get.mockRestore ? resolveCache.get.mockRestore() : (resolveCache.get = origGet);
        resolveCache.getOrCreate.mockRestore ? resolveCache.getOrCreate.mockRestore() : (resolveCache.getOrCreate = origGetOrCreate);
      }
    });

    test('bounds aggregate prewarming across concurrent matches and drops excess backlog', async () => {
      const resolveCache = container.resolve('streamResolveCache');
      const origGet = resolveCache.get.bind(resolveCache);
      const origGetOrCreate = resolveCache.getOrCreate.bind(resolveCache);

      let currentConcurrency = 0;
      let maxConcurrency = 0;
      const executedKeys = [];
      jest.spyOn(resolveCache, 'get').mockReturnValue(null);
      jest.spyOn(resolveCache, 'getOrCreate').mockImplementation(async (key) => {
        currentConcurrency++;
        maxConcurrency = Math.max(maxConcurrency, currentConcurrency);
        executedKeys.push(key);
        await new Promise((r) => setTimeout(r, 15));
        currentConcurrency--;
        return [];
      });

      const makeMatch = (id) => ({
        id,
        sources: [
          { id: 's1', source: 'daddylive', name: 'Feed 1' },
          { id: 's2', source: 'timstreams', name: 'Feed 2' },
          { id: 's3', source: 'streamsports99', name: 'Feed 3' },
          { id: 's4', source: 'cdnlive', name: 'Feed 4' },
        ],
      });

      try {
        await Promise.all([
          prewarmMatch(makeMatch('concurrent_1'), null),
          prewarmMatch(makeMatch('concurrent_2'), null),
          prewarmMatch(makeMatch('concurrent_3'), null),
          prewarmMatch(makeMatch('concurrent_4'), null),
          prewarmMatch(makeMatch('concurrent_5'), null),
        ]);

        // Two active matches × the existing per-match batch size of three.
        expect(maxConcurrency).toBeLessThanOrEqual(6);
        // Two active plus two queued matches are processed; the fifth is dropped.
        expect(executedKeys).toHaveLength(16);
      } finally {
        resolveCache.get.mockRestore ? resolveCache.get.mockRestore() : (resolveCache.get = origGet);
        resolveCache.getOrCreate.mockRestore ? resolveCache.getOrCreate.mockRestore() : (resolveCache.getOrCreate = origGetOrCreate);
      }
    });

    test('Skips heavy embed-family providers during prewarm (PREWARM_SKIP_PROVIDERS)', async () => {
      const resolveCache = container.resolve('streamResolveCache');
      const origGet = resolveCache.get.bind(resolveCache);
      const origGetOrCreate = resolveCache.getOrCreate.bind(resolveCache);

      jest.spyOn(resolveCache, 'get').mockReturnValue(null);
      const getOrCreateSpy = jest.spyOn(resolveCache, 'getOrCreate').mockResolvedValue([]);

      try {
        const mockMatch = {
          id: 'test_skip_heavy',
          sources: [
            { id: 'h1', source: 'admin', name: 'StreamedPk admin' },
            { id: 'h2', source: 'delta', name: 'StreamedPk delta' },
            { id: 'h3', source: 'ppvst', name: 'PpvSt' },
            { id: 'h4', source: 'watchfooty', name: 'WatchFooty' },
            { id: 'k1', source: 'daddylive', name: 'Feed 1' },
          ],
        };

        await prewarmMatch(mockMatch, null);
        // Only the prewarmable (non-heavy) source should have been minted
        expect(getOrCreateSpy).toHaveBeenCalledTimes(1);
        expect(getOrCreateSpy.mock.calls[0][0]).toContain('daddylive');
      } finally {
        resolveCache.get.mockRestore ? resolveCache.get.mockRestore() : (resolveCache.get = origGet);
        resolveCache.getOrCreate.mockRestore ? resolveCache.getOrCreate.mockRestore() : (resolveCache.getOrCreate = origGetOrCreate);
      }
    });

    test('Gracefully handles prewarmMatch with null opts, null match, or empty sources', async () => {
      await expect(prewarmMatch(null, null)).resolves.not.toThrow();
      await expect(prewarmMatch({ sources: [] }, null)).resolves.not.toThrow();

      const resolveCache = container.resolve('streamResolveCache');
      const origGet = resolveCache.get.bind(resolveCache);
      const origGetOrCreate = resolveCache.getOrCreate.bind(resolveCache);

      jest.spyOn(resolveCache, 'get').mockReturnValue(null);
      jest.spyOn(resolveCache, 'getOrCreate').mockResolvedValue([]);

      try {
        const mockMatch = {
          id: 'test_null_opts',
          sources: [{ id: 's1', source: 'daddylive', name: 'Feed 1' }],
        };
        // Explicit null opts
        await expect(prewarmMatch(mockMatch, null, 1, null)).resolves.not.toThrow();
      } finally {
        resolveCache.get.mockRestore ? resolveCache.get.mockRestore() : (resolveCache.get = origGet);
        resolveCache.getOrCreate.mockRestore ? resolveCache.getOrCreate.mockRestore() : (resolveCache.getOrCreate = origGetOrCreate);
      }
    });

    test('Skips sources already in cache during batch prewarming', async () => {
      const resolveCache = container.resolve('streamResolveCache');
      const origGet = resolveCache.get.bind(resolveCache);
      const origGetOrCreate = resolveCache.getOrCreate.bind(resolveCache);

      // s1 is already cached, s2 is not
      jest.spyOn(resolveCache, 'get').mockImplementation((key) => {
        if (key.includes('s1')) return [{ url: 'https://cached.stream/live.m3u8' }];
        return null;
      });
      const getOrCreateSpy = jest.spyOn(resolveCache, 'getOrCreate').mockResolvedValue([]);

      try {
        const mockMatch = {
          id: 'test_cached_skip',
          sources: [
            { id: 's1', source: 'daddylive', name: 'Feed 1' },
            { id: 's2', source: 'timstreams', name: 'Feed 2' },
          ],
        };

        await prewarmMatch(mockMatch, null);
        // Only s2 should have called getOrCreate
        expect(getOrCreateSpy).toHaveBeenCalledTimes(1);
        expect(getOrCreateSpy.mock.calls[0][0]).toContain('s2');
      } finally {
        resolveCache.get.mockRestore ? resolveCache.get.mockRestore() : (resolveCache.get = origGet);
        resolveCache.getOrCreate.mockRestore ? resolveCache.getOrCreate.mockRestore() : (resolveCache.getOrCreate = origGetOrCreate);
      }
    });
  });
});
