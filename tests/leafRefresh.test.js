const MatchAggregator = require('../src/services/MatchAggregator');
const CronService = require('../src/services/CronService');
const StreamResolveCache = require('../src/services/StreamResolveCache');

// Leaf-only source refresh: a provider-scoped backfill that must never create
// new match cards, never touch other providers, and must evict the resolved
// stream lists of the matches it changed.

function makeCacheService(matches) {
  return {
    matches,
    setCalls: 0,
    getMatchesReadOnly() { return this.matches; },
    setMatches(next) { this.matches = next; this.setCalls++; }
  };
}

function makeLeafProvider(matches) {
  return {
    name: 'Leaf',
    sourceName: 'leaf',
    configured: true,
    getMatches: jest.fn().mockResolvedValue(matches)
  };
}

function leafMatch(overrides = {}) {
  return {
    id: 'leaf_football-galatasaray-stuttgart-20760',
    aliasIds: ['streamed:football-galatasaray-stuttgart-20760', 'football-galatasaray-stuttgart-20760'],
    title: 'Galatasaray vs Stuttgart',
    category: 'football',
    date: '0',
    status: 'live',
    sources: [{ source: 'leaf', id: 'streamed:football-galatasaray-stuttgart-20760', name: 'Galatasaray vs Stuttgart' }],
    ...overrides
  };
}

function existingMatch() {
  return {
    id: 'dlv_169_galatasaray-vs-stuttgart',
    aliasIds: ['leaf_football-galatasaray-stuttgart-20760'],
    title: 'Galatasaray vs. VfB Stuttgart',
    category: 'football',
    date: '1793729100000',
    status: 'live',
    sources: [{ source: 'daddylive', id: 'dlv_169_galatasaray-vs-stuttgart', name: 'DaddyLive' }]
  };
}

describe('Leaf-only source refresh', () => {
  test('backfills the leaf source onto an existing match and merges alias ids', async () => {
    const cacheService = makeCacheService([existingMatch()]);
    const aggregator = new MatchAggregator({ leafProvider: makeLeafProvider([leafMatch()]), cacheService });

    const result = await aggregator.refreshProviderSources('leaf');

    expect(result.fetched).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.added).toBe(1);
    expect(result.changedMatchIds).toEqual(['dlv_169_galatasaray-vs-stuttgart']);

    const updated = cacheService.matches.find((m) => m.id === 'dlv_169_galatasaray-vs-stuttgart');
    expect(updated.sources.map((s) => s.source)).toEqual(['daddylive', 'leaf']);
    expect(updated.sources[1].id).toBe('streamed:football-galatasaray-stuttgart-20760');
    expect(updated.aliasIds).toContain('streamed:football-galatasaray-stuttgart-20760');
    expect(cacheService.setCalls).toBe(1);
  });

  test('is idempotent: a second run adds nothing and does not rewrite the cache', async () => {
    const cacheService = makeCacheService([existingMatch()]);
    const aggregator = new MatchAggregator({ leafProvider: makeLeafProvider([leafMatch()]), cacheService });

    await aggregator.refreshProviderSources('leaf');
    const callsAfterFirst = cacheService.setCalls;
    const snapshot = JSON.stringify(cacheService.matches);

    const second = await aggregator.refreshProviderSources('leaf');

    expect(second.added).toBe(0);
    expect(cacheService.setCalls).toBe(callsAfterFirst);
    expect(JSON.stringify(cacheService.matches)).toBe(snapshot);
  });

  test('does not create a new match card when no counterpart exists', async () => {
    const cacheService = makeCacheService([existingMatch()]);
    const aggregator = new MatchAggregator({
      leafProvider: makeLeafProvider([
        leafMatch({
          id: 'leaf_football-unrelated-fixture-20760',
          aliasIds: ['streamed:football-unrelated-fixture-20760'],
          title: 'Unrelated vs Fixture',
          sources: [{ source: 'leaf', id: 'streamed:football-unrelated-fixture-20760', name: 'Unrelated vs Fixture' }]
        })
      ]),
      cacheService
    });

    const result = await aggregator.refreshProviderSources('leaf');

    expect(result.matched).toBe(0);
    expect(result.added).toBe(0);
    expect(cacheService.matches).toHaveLength(1);
    expect(cacheService.setCalls).toBe(0);
  });

  test('leaves the cache untouched when the provider returns nothing', async () => {
    const cacheService = makeCacheService([existingMatch()]);
    const aggregator = new MatchAggregator({ leafProvider: makeLeafProvider([]), cacheService });

    const result = await aggregator.refreshProviderSources('leaf');

    expect(result.fetched).toBe(0);
    expect(cacheService.setCalls).toBe(0);
  });

  test('skips a provider that has marked itself unconfigured', async () => {
    const cacheService = makeCacheService([existingMatch()]);
    const provider = makeLeafProvider([leafMatch()]);
    provider.configured = false;
    const aggregator = new MatchAggregator({ leafProvider: provider, cacheService });

    const result = await aggregator.refreshProviderSources('leaf');

    expect(result.fetched).toBe(0);
    expect(provider.getMatches).not.toHaveBeenCalled();
  });
});

describe('StreamResolveCache.invalidateMatch()', () => {
  const OLD = process.env.RESOLVE_CACHE_SHARED;

  beforeEach(() => { process.env.RESOLVE_CACHE_SHARED = 'false'; });
  afterEach(() => {
    if (OLD === undefined) delete process.env.RESOLVE_CACHE_SHARED;
    else process.env.RESOLVE_CACHE_SHARED = OLD;
  });

  test('drops every cached resolution belonging to the match and keeps others', () => {
    const cache = new StreamResolveCache();
    const key = StreamResolveCache.resolveKey({ source: 'leaf', id: 'streamed:x' }, 'dlv_1_a');
    const other = StreamResolveCache.resolveKey({ source: 'leaf', id: 'streamed:y' }, 'dlv_2_b');
    cache._set(key, 'leaf', 'dlv_1_a', [{ url: 'https://papacito.cfd/x.m3u8?ft=t' }], 'ok', 60000);
    cache._set(other, 'leaf', 'dlv_2_b', [{ url: 'https://papacito.cfd/y.m3u8?ft=t' }], 'ok', 60000);

    expect(cache.has(key)).toBe(true);
    expect(cache.invalidateMatch('dlv_1_a')).toBe(1);
    expect(cache.has(key)).toBe(false);
    expect(cache.has(other)).toBe(true);
  });

  test('is a no-op for an unknown match id', () => {
    const cache = new StreamResolveCache();
    expect(cache.invalidateMatch('missing')).toBe(0);
    expect(cache.invalidateMatch('')).toBe(0);
  });
});

describe('CronService.refreshLeafSources()', () => {
  const OLD = process.env.NODE_APP_INSTANCE;

  afterEach(() => {
    if (OLD === undefined) delete process.env.NODE_APP_INSTANCE;
    else process.env.NODE_APP_INSTANCE = OLD;
  });

  function makeCron(overrides = {}) {
    return new CronService({
      matchAggregator: {
        refreshProviderSources: jest.fn().mockResolvedValue({ changedMatchIds: ['dlv_1_a', 'dlv_2_b'] })
      },
      streamResolveCache: { invalidateMatch: jest.fn() },
      ...overrides
    });
  }

  test('invalidates the resolved cache for every match that gained a source', async () => {
    process.env.NODE_APP_INSTANCE = '0';
    const cron = makeCron();

    await cron.refreshLeafSources();

    expect(cron.matchAggregator.refreshProviderSources).toHaveBeenCalledWith('leaf');
    expect(cron.streamResolveCache.invalidateMatch.mock.calls.map((c) => c[0]))
      .toEqual(['dlv_1_a', 'dlv_2_b']);
  });

  test('does nothing on the secondary worker', async () => {
    process.env.NODE_APP_INSTANCE = '1';
    const cron = makeCron();

    await cron.refreshLeafSources();

    expect(cron.matchAggregator.refreshProviderSources).not.toHaveBeenCalled();
    expect(cron.streamResolveCache.invalidateMatch).not.toHaveBeenCalled();
  });
});
