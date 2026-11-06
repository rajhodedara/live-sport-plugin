'use strict';

// Real CronService and source cache; mint callbacks are in memory only.
const CronService = require('../src/services/CronService');
const StreamResolveCache = require('../src/services/StreamResolveCache');

function localCache() {
  return new StreamResolveCache({ sharedResolver: {
    available: () => false,
    request: () => { throw new Error('Unexpected shared resolver request'); }
  } });
}

function cached(cache, source, id, status = 'ok', matchId = 'live') {
  const key = StreamResolveCache.resolveKey({ source, id }, matchId);
  const rows = status === 'ok' ? [{ url: `https://cdn.fixture.test/${source}/${id}.m3u8` }] : [];
  const entry = cache._set(key, source, matchId, rows, status, 60000);
  return { key, entry, rows };
}

function cronWith(cache, touchedIds = ['live']) {
  return new CronService({
    streamResolveCache: cache,
    matchAggregator: { buildLiveOverlay: async () => ({ ok: true, fetched: 1, matched: 1, map: new Map() }) },
    liveOverlayService: { setOverlay: () => ({ changed: true, revision: 1,
      touchedIds, addedIds: touchedIds, removedIds: [] }) }
  });
}

describe('Leaf overlay cache invalidation scope', () => {
  let instance, log;
  beforeEach(() => {
    instance = process.env.NODE_APP_INSTANCE;
    process.env.NODE_APP_INSTANCE = '0';
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    if (instance === undefined) delete process.env.NODE_APP_INSTANCE;
    else process.env.NODE_APP_INSTANCE = instance;
    log.mockRestore();
  });

  test('a Leaf refresh preserves every other provider and its learned TTL', async () => {
    const cache = localCache();
    const leaf = cached(cache, 'leaf', 'old-live');
    const ppv = cached(cache, 'ppvst', 'high-quality');
    const tim = cached(cache, 'timstreams', 'temporarily-missing', 'failed');
    const deferred = cached(cache, 'scorezone', 'waiting', 'deferred');
    const similarlyNamed = cached(cache, 'leafish', 'independent-provider');
    const otherFixture = cached(cache, 'leaf', 'another-live', 'ok', 'other');
    cache.ttl.set('ppvst', 120000);
    cache.ttl.set('timstreams', 180000);

    const result = await cronWith(cache).refreshLiveOverlay();

    expect(result.changed).toBe(true);
    expect(cache.entries.has(leaf.key)).toBe(false);
    expect(leaf.entry.invalidated).toBe(true);
    for (const untouched of [ppv, tim, deferred, similarlyNamed, otherFixture]) {
      expect(cache.entries.get(untouched.key)).toBe(untouched.entry);
    }
    expect(cache.get(ppv.key)).toEqual(ppv.rows);
    expect(cache.stats().learnedTtls).toEqual({ ppvst: 120000, timstreams: 180000 });
    expect(cache.stats().evictions).toBe(1);
  });

  test('only Leaf entries for the exact touched fixture are removed', () => {
    const cache = localCache();
    const leaf = cached(cache, 'leaf', 'one');
    const anotherLeaf = cached(cache, 'leaf', 'two', 'failed');
    const anotherFixture = cached(cache, 'leaf', 'one', 'ok', 'live-other');
    const ppv = cached(cache, 'ppvst', 'one');

    expect(cronWith(cache)._invalidateOverlayMatch('live')).toBe(2);
    expect(cache.entries.has(leaf.key)).toBe(false);
    expect(cache.entries.has(anotherLeaf.key)).toBe(false);
    expect(cache.entries.get(anotherFixture.key)).toBe(anotherFixture.entry);
    expect(cache.entries.get(ppv.key)).toBe(ppv.entry);
    expect(cache.stats().evictions).toBe(2);
  });

  test('a Leaf change leaves pending PPV and TimStreams single-flight work intact', async () => {
    const cache = localCache();
    cached(cache, 'leaf', 'old-live');
    const jobs = ['ppvst', 'timstreams'].map(source => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const key = StreamResolveCache.resolveKey({ source, id: 'pending' }, 'live');
      const mint = jest.fn(() => gate);
      const result = cache.getOrCreate(key, mint);
      return { key, mint, result, release, operation: cache.pendingOperations.get(key), flight: cache.inFlight.get(key) };
    });
    await Promise.resolve();

    await cronWith(cache).refreshLiveOverlay();

    for (const job of jobs) {
      expect(cache.pendingOperations.get(job.key)).toBe(job.operation);
      expect(job.operation.pruned).toBe(false);
      expect(cache.inFlight.get(job.key)).toBe(job.flight);
      expect(job.mint).toHaveBeenCalledTimes(1);
      job.release([{ url: `https://cdn.fixture.test/${job.key.split(':')[0]}/live.m3u8` }]);
    }
    for (const job of jobs) {
      expect(await job.result).toHaveLength(1);
      expect(await cache.getOrCreate(job.key, job.mint)).toHaveLength(1);
      expect(job.mint).toHaveBeenCalledTimes(1);
    }
    expect(cache.inFlight.size).toBe(0);
    expect(cache.pendingOperations.size).toBe(0);
  });

  test('ended-fixture pruning still removes all providers and fences their pending work', async () => {
    const cache = localCache();
    const ended = ['leaf', 'ppvst', 'timstreams', 'scorezone'].map(source => cached(cache, source, 'old', 'ok', 'ended'));
    const active = cached(cache, 'ppvst', 'still-live', 'ok', 'active');
    const channel = cached(cache, 'ppvst', 'channel', 'ok', '__channel__');
    let release;
    const pending = cache.getOrCreate('timstreams:ended:pending', () => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();

    cronWith(cache).pruneStreamCache([{ id: 'active' }]);

    for (const entry of ended) expect(cache.entries.has(entry.key)).toBe(false);
    expect(cache.entries.get(active.key)).toBe(active.entry);
    expect(cache.entries.get(channel.key)).toBe(channel.entry);
    expect(cache.pendingOperations.get('timstreams:ended:pending').pruned).toBe(true);
    release([{ url: 'https://cdn.fixture.test/ended/stale.m3u8' }]);
    expect(await pending).toEqual([]);
    expect(cache.entries.has('timstreams:ended:pending')).toBe(false);
  });
});
