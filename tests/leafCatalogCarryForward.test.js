'use strict';

// Real aggregation with in-memory catalog/provider fixtures only.
const MatchAggregator = require('../src/services/MatchAggregator');

const NOW = Date.UTC(2026, 10, 6, 12);
const HOUR = 3600000;
const fixture = (id, source = 'streamedpk', overrides = {}) => ({
  id, aliasIds: [], title: 'Arsenal vs Chelsea', category: 'football',
  date: String(NOW + HOUR), sources: [{ source, id: `feed-${id}` }], ...overrides,
});
const hasSource = (row, source) => row.sources.some((entry) => entry.source === source);

async function sync(previous, lastCatalogOk, { freshLeaf = [], fresh = [fixture('same-event')], daddyLiveProvider } = {}) {
  const cache = {
    getMatchesReadOnly: () => previous,
    setMatches: jest.fn(),
  };
  const aggregator = new MatchAggregator({ cacheService: cache });
  aggregator.providers = [
    { sourceName: 'streamedpk', getMatches: jest.fn(async () => fresh) },
    { sourceName: 'leaf', lastCatalogOk, getMatches: jest.fn(async () => freshLeaf) },
    ...(daddyLiveProvider ? [daddyLiveProvider] : []),
  ];
  const rows = await aggregator.syncMatches();
  expect(cache.setMatches).toHaveBeenCalledWith(rows);
  return rows;
}

let oldMax;
beforeEach(() => {
  oldMax = process.env.CARRY_FORWARD_MAX;
  delete process.env.CARRY_FORWARD_MAX;
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('Unexpected network request'); });
});
afterEach(() => {
  expect(global.fetch).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  if (oldMax === undefined) delete process.env.CARRY_FORWARD_MAX;
  else process.env.CARRY_FORWARD_MAX = oldMax;
});

test.each([
  ['healthy empty', true, false],
  ['failed', false, true],
  ['unknown', null, true],
  ['legacy unspecified', undefined, true],
])('%s Leaf catalog decides whether previous Leaf sources survive', async (_label, health, retained) => {
  const previous = fixture('same-event', 'leaf');
  const before = JSON.stringify(previous);
  const rows = await sync([previous], health);

  expect(rows).toHaveLength(1);
  expect(hasSource(rows[0], 'streamedpk')).toBe(true);
  expect(hasSource(rows[0], 'leaf')).toBe(retained);
  expect(JSON.stringify(previous)).toBe(before);
});

test.each([true, false])('Leaf health %s remains authoritative when some fresh Leaf fixtures exist', async health => {
  const freshLeaf = [fixture('new-leaf-event', 'leaf', { title: 'Celtic vs Rangers' })];
  const rows = await sync([fixture('same-event', 'leaf')], health, { freshLeaf });

  expect(rows).toHaveLength(2);
  expect(hasSource(rows.find(row => row.id === 'new-leaf-event'), 'leaf')).toBe(true);
  expect(hasSource(rows.find(row => row.id === 'same-event'), 'leaf')).toBe(!health);
});

test('failed Leaf catalogs retain existing expiry and carry-budget limits', async () => {
  process.env.CARRY_FORWARD_MAX = '1';
  const previous = [
    fixture('expired', 'leaf', { date: String(NOW - 25 * HOUR) }),
    fixture('later', 'leaf', { date: String(NOW + 4 * HOUR) }),
    fixture('sooner', 'leaf', { date: String(NOW + 2 * HOUR) }),
  ];
  const rows = await sync(previous, false, {
    fresh: [fixture('healthy-control', 'streamedpk', { title: 'Celtic vs Rangers' })],
  });

  expect(rows.filter(row => hasSource(row, 'leaf')).map(row => row.id)).toEqual(['sooner']);
});

test('failed Leaf catalogs cannot transfer a source onto a reused ID for different teams', async () => {
  const rows = await sync([fixture('same-event', 'leaf')], false, {
    fresh: [fixture('same-event', 'streamedpk', { title: 'Celtic vs Rangers' })],
  });

  expect(rows).toHaveLength(1);
  expect(hasSource(rows[0], 'leaf')).toBe(false);
});

test('healthy Leaf emptiness leaves DaddyLive schedule carryforward unchanged', async () => {
  const previous = fixture('same-event', 'daddylive');
  previous.sources.push({ source: 'leaf', id: 'old-leaf-feed' });
  const daddyLiveProvider = {
    sourceName: 'daddylive', lastScheduleOk: false,
    getMatches: jest.fn(async () => [fixture('dlv_ch_control', 'daddylive', {
      title: 'Sky Sports Main Event', category: 'networks', date: '0',
    })]),
  };
  const rows = await sync([previous], true, { daddyLiveProvider });
  const match = rows.find(row => row.id === 'same-event');

  expect(hasSource(match, 'daddylive')).toBe(true);
  expect(hasSource(match, 'leaf')).toBe(false);
});
