'use strict';

const MatchAggregator = require('../src/services/MatchAggregator');

// Derived from the November 1 real-provider cache. Source IDs are synthetic;
// these tests exercise only in-memory aggregation, with no provider I/O.
const replay = (id, title, date, provider = 'livetv', extra = {}) => ({
  id, title, date, category: 'basketball', league: 'WNBA', status: 'finished',
  sources: [{ source: provider, id: `source-${id}` }], ...extra
});
const wnba = (id, date) => replay(id,
  'Golden State Valkyries (W) vs Atlanta Dream (W) - WNBA', date);

async function aggregate(rows, previous = [], fresh = false) {
  let saved;
  const aggregator = new MatchAggregator({
    cacheService: { getMatchesReadOnly: () => previous, setMatches: value => { saved = value; } },
    yamlProviders: [{ sourceName: 'offline-fixtures', getMatches: async () => rows }]
  });
  if (previous.length && !fresh) aggregator.lastReplaySync = Date.now();
  await aggregator.syncMatches();
  return saved;
}

describe('replay fixture identity from the real-provider catalog', () => {
  let log, warn, now;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T13:16:47Z'));
  });
  afterEach(() => { log.mockRestore(); warn.mockRestore(); now.mockRestore(); });

  test.each([false, true])('different NBA Finals games remain separate, including reused IDs (reverse=%s)', reverse => {
    const a = replay('bv_reused',
      'New York Knicks vs San Antonio Spurs - NBA Finals - Game 5 - Full Game Replay - June 13, 2026',
      '2026-06-13T00:00:00Z', 'basketballvideo', { league: 'NBA Finals' });
    const b = replay('bv_reused',
      'San Antonio Spurs vs New York Knicks - NBA Finals - Game 4 - Full Game Replay - June 10, 2026',
      '2026-06-10T00:00:00Z', 'basketballvideo', { league: 'NBA Finals' });
    const agg = new MatchAggregator({});
    expect(agg.isSameEvent(...(reverse ? [b, a] : [a, b]))).toBe(false);
  });

  test('precise LiveTV rematches do not merge or move the comparison date', async () => {
    const rows = await aggregate([
      wnba('livetv_wnba_20261101', '2026-11-01T01:00:00Z'),
      wnba('livetv_wnba_20261029', '2026-10-29T01:00:00Z'),
      wnba('livetv_wnba_20261027', '2026-10-27T01:00:00Z')
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.sources.length)).toEqual([1, 1, 1]);
  });

  test('explicit game numbers constrain reused IDs even when dates agree', () => {
    const a = replay('bv_same-id', 'New York Knicks vs San Antonio Spurs - NBA Finals Game 5',
      '2026-06-13', 'basketballvideo', { league: 'NBA Finals' });
    const b = { ...a, title: 'New York Knicks vs San Antonio Spurs - NBA Finals Game 4' };
    const agg = new MatchAggregator({});
    expect(agg.isSameEvent(a, b)).toBe(false);
    expect(agg.isSameEvent(b, a)).toBe(false);
  });

  test('same-team date-only replays on consecutive days remain separate', () => {
    const agg = new MatchAggregator({});
    const a = replay('rz_day-one', 'Chicago Cubs vs Atlanta Braves', '2026-09-14', 'replayzone', { category: 'baseball', league: 'MLB' });
    const b = replay('rz_day-two', a.title, '2026-09-15', 'replayzone', { category: 'baseball', league: 'MLB' });
    expect(agg.isSameEvent(a, b)).toBe(false);
    expect(agg.isSameEvent(b, a)).toBe(false);
  });

  test.each([false, true])('retains the documented local replay day / UTC kickoff conversion (reverse=%s)', reverse => {
    const a = replay('bv_same-game',
      'Oklahoma City Thunder vs Houston Rockets - NBA Preseason - Full Game Replay - October 15, 2026',
      String(Date.parse('2026-10-15T00:00:00Z')), 'basketballvideo', { league: 'NBA Preseason' });
    const b = replay('livetv_same-game_20261016', 'Houston Rockets vs Oklahoma City Thunder - NBA Preseason',
      '2026-10-16T02:00:00Z', 'livetv', { league: 'NBA Preseason' });
    expect(new MatchAggregator({}).isSameEvent(...(reverse ? [b, a] : [a, b]))).toBe(true);
  });

  test.each([false, true])('a coarse replay day cannot bridge two precise rematches (coarseFirst=%s)', async coarseFirst => {
    const a = wnba('livetv_first', '2026-10-16T02:00:00Z');
    const coarse = replay('bv_local-day',
      'Golden State Valkyries vs Atlanta Dream - WNBA - Full Game Replay - October 15, 2026',
      '2026-10-15T00:00:00Z', 'basketballvideo');
    const b = wnba('livetv_second', '2026-10-15T02:00:00Z');
    const rows = await aggregate(coarseFirst ? [coarse, a, b] : [a, coarse, b]);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === b.id).sources.map(source => source.id)).toEqual([`source-${b.id}`]);
  });

  test('an ambiguous coarse day does not select the first precise fixture', async () => {
    const a = wnba('livetv_first', '2026-10-16T02:00:00Z');
    const b = wnba('livetv_second', '2026-10-15T02:00:00Z');
    const coarse = replay('bv_local-day',
      'Golden State Valkyries vs Atlanta Dream - WNBA - Full Game Replay - October 15, 2026',
      '2026-10-15T00:00:00Z', 'basketballvideo');
    const rows = await aggregate([a, b, coarse]);
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.sources.length)).toEqual([1, 1, 1]);
  });

  test('ambiguity includes a fixture whose team identities come from metadata', async () => {
    const a = wnba('livetv_first', '2026-10-16T02:00:00Z');
    const b = replay('livetv_second', 'Championship Finals', '2026-10-15T02:00:00Z', 'livetv', {
      team1: { name: 'Golden State Valkyries (W)' }, team2: { name: 'Atlanta Dream (W)' }
    });
    const coarse = replay('bv_local-day',
      'Golden State Valkyries vs Atlanta Dream - WNBA - Full Game Replay - October 15, 2026',
      '2026-10-15T00:00:00Z', 'basketballvideo');
    expect(await aggregate([a, b, coarse])).toHaveLength(3);
  });

  test('precise constraints survive a coarse-first JSON cache round trip', async () => {
    const coarse = replay('bv_local-day',
      'Golden State Valkyries vs Atlanta Dream - WNBA - Full Game Replay - October 15, 2026',
      '2026-10-15T00:00:00Z', 'basketballvideo');
    const first = await aggregate([coarse, wnba('livetv_first', '2026-10-16T02:00:00Z')]);
    expect(first).toHaveLength(1);
    const second = await aggregate([wnba('livetv_second', '2026-10-15T02:00:00Z')], JSON.parse(JSON.stringify(first)));
    expect(second).toHaveLength(2);
  });

  test('a display-date fallback never becomes an event date after cache reuse', async () => {
    const unknown = replay('bv_unknown', 'Golden State Valkyries vs Atlanta Dream - WNBA', '', 'basketballvideo');
    const first = await aggregate([unknown]);
    const second = await aggregate([wnba('livetv_today', `${first[0].date}T02:00:00Z`)], JSON.parse(JSON.stringify(first)));
    expect(second).toHaveLength(2);
  });

  test('an expired replay refresh does not recover a display date as fixture evidence', async () => {
    const unknown = replay('bv_unknown', 'Golden State Valkyries vs Atlanta Dream - WNBA', '', 'basketballvideo');
    const first = await aggregate([unknown]);
    const second = await aggregate([
      // A fresh scrape must not retain the private claims attached during the
      // first aggregation. Using a spread of `unknown` would hide this bug.
      replay('bv_unknown', 'Golden State Valkyries vs Atlanta Dream - WNBA', '', 'basketballvideo'),
      wnba('livetv_today', `${first[0].date}T02:00:00Z`)
    ], JSON.parse(JSON.stringify(first)), true);
    expect(second).toHaveLength(2);
    expect(second.find(row => row.id === 'livetv_today').sources).toHaveLength(1);
  });

  test('dateless replays cannot attach to a dated same-team fixture through fuzzy matching', () => {
    const known = wnba('livetv_known', '2026-10-29T01:00:00Z');
    const unknown = replay('bv_unknown', 'Golden State Valkyries vs Atlanta Dream - WNBA', '', 'basketballvideo');
    const agg = new MatchAggregator({});
    expect(agg.isSameEvent(unknown, known)).toBe(false);
    expect(agg.isSameEvent(known, unknown)).toBe(false);
    expect(agg.isSameEvent(unknown, { ...unknown })).toBe(true);
  });

  test('a strict title date can identify a replay with a missing metadata date', () => {
    const known = wnba('livetv_known', '2026-10-16T02:00:00Z');
    const datedTitle = replay('bv_missing-date',
      'Golden State Valkyries vs Atlanta Dream - WNBA - Full Game Replay - October 15, 2026', '', 'basketballvideo');
    expect(new MatchAggregator({}).isSameEvent(datedTitle, known)).toBe(true);
  });
});
