'use strict';

const MatchAggregator = require('../src/services/MatchAggregator');
const CacheService = require('../src/services/CacheService');

const NOW = Date.UTC(2026, 10, 4, 12);
const HOUR = 3600000;
const fixture = (id, overrides = {}) => ({
  id, title: 'Arsenal vs Chelsea', category: 'football', date: String(NOW + HOUR),
  sources: [{ source: 'streamedpk', id: `feed-${id}` }], ...overrides,
});
const rescued = (id, source, overrides = {}) => fixture(id, {
  sources: [{ source, id: `previous-${id}` }], ...overrides,
});
const hasSource = (row, source) => row.sources.some((s) => s.source === source);

// Exercise real cache writes, index rebuilding and canonical lookup without
// constructing a disk-backed cache or reading/writing a cache file.
function memoryCache(previous) {
  const cache = Object.create(CacheService.prototype);
  Object.assign(cache, { cachedMatches: previous, rev: 0 });
  cache._ensureLoaded = () => {};
  cache._saveDiskCache = () => {};
  cache._rebuildIndices();
  return cache;
}

async function sync(previous, fresh, provider = 'daddylive', extraProvider = { lastScheduleOk: false }) {
  const cache = memoryCache(previous);
  const aggregator = new MatchAggregator({ cacheService: cache });
  aggregator.providers = [
    { sourceName: 'streamedpk', getMatches: async () => fresh },
    { sourceName: provider, getMatches: async () => [], ...extraProvider },
  ];
  await aggregator.syncMatches();
  return cache;
}

describe('carry-forward through aggregation and cache identity mapping', () => {
  let oldMax;
  beforeEach(() => {
    oldMax = process.env.CARRY_FORWARD_MAX;
    delete process.env.CARRY_FORWARD_MAX;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    if (oldMax === undefined) delete process.env.CARRY_FORWARD_MAX;
    else process.env.CARRY_FORWARD_MAX = oldMax;
    jest.restoreAllMocks();
  });

  test('backfills a compatible exact canonical daddylive source without mutating the previous snapshot', async () => {
    const previous = rescued('canonical-fixture', 'daddylive');
    Object.freeze(previous.sources[0]);
    Object.freeze(previous.sources);
    Object.freeze(previous);
    const cache = await sync(Object.freeze([previous]), [fixture(previous.id)], 'daddylive');
    expect(cache.cachedMatches).toHaveLength(1);
    const mapped = cache.findMatch(previous.id);
    expect(hasSource(mapped, 'daddylive')).toBe(true);
    expect(hasSource(mapped, 'streamedpk')).toBe(true);
    expect(previous.sources).toEqual([{ source: 'daddylive', id: `previous-${previous.id}` }]);
  });

  test('backfills a unique renamed alias during partial DaddyLive schedule failure without adding a second card', async () => {
    const previous = rescued('old-canonical', 'daddylive', { aliasIds: ['same-fixture'] });
    const fresh = fixture('strong-canonical', { aliasIds: ['same-fixture'] });
    const channel = fixture('dlv_ch_control', {
      title: 'Sky Sports Main Event', category: 'networks', date: '0',
      sources: [{ source: 'daddylive', id: 'control-channel' }],
    });
    const cache = await sync([previous], [fresh], 'daddylive', {
      lastScheduleOk: false, getMatches: async () => [channel],
    });
    expect(cache.cachedMatches).toHaveLength(2);
    expect(hasSource(cache.findMatch(fresh.id), 'daddylive')).toBe(true);
    expect(cache.cachedMatches.some((row) => row.id === previous.id)).toBe(false);
    expect(cache.findMatch('same-fixture').id).toBe(fresh.id);
  });

  test('does not choose between strong fixtures sharing one legacy ID or resurrect that legacy canonical card', async () => {
    const previous = rescued('legacy-fixture', 'daddylive');
    const first = fixture('strong-first', { aliasIds: [previous.id] });
    const second = fixture('strong-second', { title: 'Celtic vs Rangers', aliasIds: [previous.id] });
    const cache = await sync([previous], [first, second]);
    expect(cache.cachedMatches).toHaveLength(2);
    for (const row of [first, second]) expect(hasSource(cache.findMatch(row.id), 'daddylive')).toBe(false);
    expect(cache.cachedMatches.some((row) => row.id === previous.id)).toBe(false);
  });

  test('a later row alias cannot overwrite a compatible canonical target', async () => {
    const previous = rescued('canonical-fixture', 'daddylive');
    const canonical = fixture(previous.id);
    const aliasOnly = fixture('other-canonical', { title: 'Celtic vs Rangers', aliasIds: [previous.id] });
    const cache = await sync([previous], [canonical, aliasOnly]);
    expect(hasSource(cache.findMatch(canonical.id), 'daddylive')).toBe(true);
    expect(hasSource(cache.findMatch(aliasOnly.id), 'daddylive')).toBe(false);
  });

  test('rejects disagreeing alias targets instead of taking the first match', async () => {
    const previous = rescued('old-canonical', 'daddylive', { aliasIds: ['first-alias', 'second-alias'] });
    const first = fixture('strong-first', { aliasIds: ['first-alias'] });
    const second = fixture('strong-second', { title: 'Celtic vs Rangers', aliasIds: ['second-alias'] });
    const cache = await sync([previous], [first, second]);
    expect(cache.cachedMatches).toHaveLength(2);
    for (const row of cache.cachedMatches) expect(hasSource(row, 'daddylive')).toBe(false);
  });

  test('an alias shared by previous meetings cannot transfer whichever source was listed first', async () => {
    const previous = [
      rescued('previous-first', 'daddylive', { aliasIds: ['shared-alias'] }),
      rescued('previous-second', 'daddylive', { title: 'Celtic vs Rangers', aliasIds: ['shared-alias'] }),
    ];
    const fresh = fixture('fresh-canonical', { aliasIds: ['shared-alias'] });
    const cache = await sync(previous, [fresh]);
    expect(cache.cachedMatches).toHaveLength(1);
    expect(hasSource(cache.findMatch(fresh.id), 'daddylive')).toBe(false);
  });

  test.each([
    ['different teams', { title: 'Celtic vs Rangers' }],
    ['different dated meeting', { date: String(NOW + 30 * HOUR) }],
    ['channel instead of fixture', { title: 'Arsenal vs Chelsea', category: 'networks', date: '0' }],
  ])('a reused canonical ID cannot bypass %s evidence', async (_description, overrides) => {
    const previous = rescued('reused-canonical', 'daddylive');
    const fresh = fixture(previous.id, overrides);
    const cache = await sync([previous], [fresh]);
    expect(cache.cachedMatches).toHaveLength(1);
    expect(hasSource(cache.findMatch(fresh.id), 'daddylive')).toBe(false);
  });

  test.each([
    ['expired', String(NOW - 25 * HOUR)],
    ['undated non-channel', '0'],
    ['invalid date', 'not-a-date'],
  ])('source backfill cannot revive an %s previous fixture', async (_description, date) => {
    const previous = rescued('same-canonical', 'daddylive', { date });
    const fresh = fixture(previous.id);
    const cache = await sync([previous], [fresh]);
    expect(cache.cachedMatches).toHaveLength(1);
    expect(hasSource(cache.findMatch(fresh.id), 'daddylive')).toBe(false);
  });

  test('keeps eligible standalone fixtures and evergreen channels inside the existing rescue cap', async () => {
    process.env.CARRY_FORWARD_MAX = '2';
    const previous = [
      rescued('past-eligible', 'daddylive', { date: String(NOW - 20 * HOUR) }),
      rescued('live-eligible', 'daddylive', { date: String(NOW - HOUR) }),
      rescued('cdn_ch_control', 'daddylive', { title: 'Daddylive TV', category: 'networks', date: '0' }),
      rescued('expired-fixture', 'daddylive', { date: String(NOW - 25 * HOUR) }),
    ];
    const cache = await sync(previous, [fixture('healthy-control', { title: 'Celtic vs Rangers' })]);
    const carriedIds = cache.cachedMatches.filter((row) => hasSource(row, 'daddylive')).map((row) => row.id);
    expect(carriedIds).toEqual(['live-eligible', 'cdn_ch_control']);
  });

  test('source backfills consume the same rescue budget as standalone rows', async () => {
    process.env.CARRY_FORWARD_MAX = '1';
    const previous = [
      rescued('exact-fixture', 'daddylive'),
      rescued('standalone-later', 'daddylive', { title: 'Celtic vs Rangers', date: String(NOW + 2 * HOUR) }),
    ];
    const cache = await sync(previous, [fixture('exact-fixture')]);
    expect(cache.cachedMatches).toHaveLength(1);
    expect(hasSource(cache.findMatch('exact-fixture'), 'daddylive')).toBe(true);
  });
});
