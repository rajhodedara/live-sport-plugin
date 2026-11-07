'use strict';

// No upstream calls or disk cache writes: exercise the real provider, catalog
// merger and cache index with completely controlled data.
const PitSportProvider = require('../src/providers/PitSportProvider');
const MatchAggregator = require('../src/services/MatchAggregator');
const CacheService = require('../src/services/CacheService');
const ProviderHealthService = require('../src/services/ProviderHealthService');

const NOW = Date.UTC(2026, 10, 6, 16);
const HOUR = 3600000;
const pit = (id, overrides = {}) => ({
  id, title: 'Arsenal vs Chelsea', category: 'football', date: String(NOW + HOUR),
  sources: [{ source: 'pitsport', id: '102750' }], ...overrides
});
const control = (id, overrides = {}) => ({
  id, title: 'Arsenal vs Chelsea', category: 'football', date: String(NOW + HOUR),
  sources: [{ source: 'streamedpk', id: 'upstream-good' }], ...overrides
});
const contains = (row, source) => Boolean(row?.sources?.some(s => s.source === source));

function inMemoryCache(previous) {
  const cache = Object.create(CacheService.prototype);
  Object.assign(cache, { cachedMatches: previous, rev: 0 });
  cache._ensureLoaded = () => {};
  cache._saveDiskCache = () => {};
  cache._rebuildIndices();
  return cache;
}

async function sync(previous, fresh, pitProvider) {
  const cache = inMemoryCache(previous);
  const aggregator = new MatchAggregator({ cacheService: cache });
  aggregator.providers = [
    { sourceName: 'streamedpk', getMatches: async () => fresh },
    pitProvider
  ];
  await aggregator.syncMatches();
  return cache;
}

describe('PitSport schedule failure versus legitimate empty catalog', () => {
  let spy;
  beforeEach(() => {
    spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { spy.mockRestore(); jest.restoreAllMocks(); });

  test.each([429, 503])('HTTP %i leaves the catalog in degraded state', async status => {
    const provider = new PitSportProvider();
    provider.proxyFetch = jest.fn().mockResolvedValue({ ok: false, status });
    expect(await provider.getMatches()).toEqual([]);
    expect(provider.lastScheduleOk).toBe(false);
    const health = new ProviderHealthService();
    health.recordResult(provider, { matches: [] });
    expect(health.snapshot().providers[0]).toMatchObject({ state: 'degraded', scheduleOk: false });
  });

  test('transport exception and malformed schema also report degraded', async () => {
    const provider = new PitSportProvider();
    provider.proxyFetch = jest.fn().mockRejectedValue(new Error('connection lost'));
    expect(await provider.getMatches()).toEqual([]);
    expect(provider.lastScheduleOk).toBe(false);
    provider.proxyFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { broken: true } }) });
    expect(await provider.getMatches()).toEqual([]);
    expect(provider.lastScheduleOk).toBe(false);
  });

  test('a valid empty home schedule is not an outage', async () => {
    const provider = new PitSportProvider();
    provider.proxyFetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ data: { live: [], upcoming: [], carousel: [] } })
    });
    expect(await provider.getMatches()).toEqual([]);
    expect(provider.lastScheduleOk).toBe(true);
    const health = new ProviderHealthService();
    health.recordResult(provider, { matches: [] });
    expect(health.snapshot().providers[0]).toMatchObject({ state: 'empty', scheduleOk: true });
  });
});

describe('PitSport bounded carry-forward in the real catalog merger', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const provider = (scheduleOk = false, matches = []) => ({
    sourceName: 'pitsport',
    lastScheduleOk: scheduleOk,
    getMatches: async function () { this.lastScheduleOk = scheduleOk; return matches; }
  });

  test('failed PitSport catalog restores eligible standalone events, not a blank four-hour snapshot', async () => {
    const old = pit('pitsport-fixture', { title: 'Celtic vs Rangers' });
    const next = control('healthy-control', { title: 'Arsenal vs Chelsea' });
    const cache = await sync([old], [next], provider(false));
    expect(contains(cache.findMatch('pitsport-fixture'), 'pitsport')).toBe(true);
    expect(contains(cache.findMatch('healthy-control'), 'streamedpk')).toBe(true);
  });

  test('failed PitSport catalog backfills a compatible existing fixture without creating a duplicate', async () => {
    const id = 'same-canonical-id';
    const cache = await sync([pit(id)], [control(id)], provider(false));
    expect(cache.cachedMatches).toHaveLength(1);
    expect(contains(cache.findMatch(id), 'pitsport')).toBe(true);
    expect(contains(cache.findMatch(id), 'streamedpk')).toBe(true);
  });

  test('legitimately empty PitSport catalog does not resurrect removed fixtures', async () => {
    const cache = await sync([pit('formerly-listed', { title: 'Celtic vs Rangers' })],
      [control('healthy-control')], provider(true));
    expect(cache.findMatch('formerly-listed')).toBeNull();
    expect(cache.cachedMatches).toHaveLength(1);
  });

  test('expired prior fixture is not kept, even during a true outage', async () => {
    const cache = await sync([pit('expired-pit', {
      date: String(NOW - 26 * HOUR), title: 'Celtic vs Rangers'
    })], [control('healthy-control')], provider(false));
    expect(cache.findMatch('expired-pit')).toBeNull();
  });

  test('a healthy fresh PitSport response does not carry stale old entries', async () => {
    const cache = await sync([pit('old-pit', { title: 'Celtic vs Rangers' })],
      [control('healthy-control')], provider(true, [pit('new-pit', { title: 'Liverpool vs Arsenal' })]));
    expect(cache.findMatch('old-pit')).toBeNull();
    expect(contains(cache.findMatch('new-pit'), 'pitsport')).toBe(true);
  });
});
