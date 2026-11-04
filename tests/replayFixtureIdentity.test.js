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

  // All seventeen title/date contradictions retained in the fresh real cache.
  test.each([
    ['Clermont Auvergne v Racing 92', '31 May', '2026-05-14', '2026-05-31'],
    ['Toulon v Bordeaux Begles', '31 May', '2026-05-14', '2026-05-31'],
    ['Montpellier v Pau', '30 May', '2026-05-14', '2026-05-30'],
    ['Montauban v La Rochelle', '30 May', '2026-05-14', '2026-05-30'],
    ['La Rochelle v Toulouse', '17 May', '2026-05-14', '2026-05-17'],
    ['Castres Olympique v Montpellier', '16 May', '2026-05-14', '2026-05-16'],
    ['Pau v Clermont', '16 May', '2026-05-14', '2026-05-16'],
    ['Racing 92 v Toulon', '16 May', '2026-05-14', '2026-05-16'],
    ['Stade Francais v Lyon', '9 May', '2026-05-14', '2026-05-09'],
    ['Racing 92 v La Rochelle', '10 May', '2026-05-14', '2026-05-10'],
    ['Toulon v Toulouse', '9 May', '2026-05-14', '2026-05-09'],
    ['Bayonne v Bordeaux Begles', '9 May', '2026-05-14', '2026-05-09'],
    ['Pau v Castres Olympique', '9 May', '2026-05-14', '2026-05-09'],
    ['Perpignan v La Rochelle', '25 April', '2026-04-14', '2026-04-25'],
    ['Lyon v Castres Olympique', '25 April', '2026-04-14', '2026-04-25'],
    ['Montauban v Racing 92', '25 April', '2026-04-14', '2026-04-25'],
    ['Toulouse v Clermont', '26 April', '2026-04-14', '2026-04-26']
  ])('fresh calendar replay date agrees with its title claim: %s %s', async (teams, day, wrongDate, expected) => {
    const [saved] = await aggregate([replay('rz_top14',
      `${teams} - Rugby Full Match Replay - Top 14 - ${day} 2026`, wrongDate, 'replayzone',
      { category: 'rugby', league: 'Top 14' })]);
    expect(saved.date).toBe(expected);
    expect(JSON.parse(saved._replayIdentityClaims)[0][1]).toBe(Date.parse(expected));
  });

  test.each([
    ['rz_brisbane', 'Brisbane Lions v Carlton Blues - Full Match Replay - 8, May 2026 - AFL', 'replayzone', '2026-05-08'],
    ['mlb_game3', 'Los Angeles Dodgers vs New York Yankees World Series Game 3 Full Game Replay Oct 28, 2024 MLB', 'mlblive', '2024-10-28'],
    ['mlb_game2', 'New York Yankees vs Los Angeles Dodgers World Series Game 2 Full Game Replay Oct 26, 2024 MLB', 'mlblive', '2024-10-26'],
    ['mlb_2023', 'Arizona Diamondbacks vs Texas Rangers Game 2 Full Game Replay Oct 28, 2023 MLB World Series', 'mlblive', '2023-10-28'],
    ['rz_abbreviated', 'Chicago Cubs vs Atlanta Braves Full Game Replay Oct. 28, 2026', 'replayzone', '2026-10-28'],
    ['rz_dayfirst', 'Chicago Cubs vs Atlanta Braves Full Game Replay 28, Oct. 2026', 'replayzone', '2026-10-28']
  ])('recovers bounded textual date forms before retention: %s', async (id, title, provider, expected) => {
    const row = replay(id, title, '', provider);
    const claim = new MatchAggregator({})._precompute(row).replayClaims[0];
    expect(claim.time).toBe(Date.parse(expected));
    expect(claim.dayOnly).toBe(true);
    const saved = await aggregate([row]);
    if (expected < '2025-11-01') expect(saved).toEqual([]);
    else expect(saved[0].date).toBe(expected);
  });

  test.each(['February 30, 2026', '29 Feb. 2026', '11/12/2026', 'Octoberfest 15, 2026', 'Oct 28, 20260'])
  ('does not promote invalid or ambiguous title dates into evidence: %s', text => {
    const row = replay('rz_unknown', `Chicago Cubs vs Atlanta Braves - ${text}`, '', 'replayzone');
    expect(new MatchAggregator({})._precompute(row).replayClaims[0].time).toBe(0);
  });

  test('a precise UTC kickoff retains its time across a different local title day', async () => {
    const date = '2026-10-16T02:00:00Z';
    const [saved] = await aggregate([replay('livetv_precise',
      'Houston Rockets vs Oklahoma City Thunder - NBA Preseason - October 15, 2026', date)]);
    expect(saved.date).toBe(date);
    expect(JSON.parse(saved._replayIdentityClaims)[0].slice(1, 3)).toEqual([Date.parse(date), false]);
  });

  test.each([false, true])('cached replay constraints retain their existing date anchor (multiple=%s)', async multiple => {
    const row = replay('rz_cached',
      'Houston Rockets vs Oklahoma City Thunder - NBA Preseason - October 14, 2026', '2026-10-15', 'replayzone');
    const claims = [['replayzone', Date.parse('2026-10-15'), true, '', row.id]];
    if (multiple) claims.push(['livetv', Date.parse('2026-10-16T02:00:00Z'), false, '', 'livetv_cached']);
    row._replayIdentityClaims = JSON.stringify(claims);
    const [saved] = await aggregate([], JSON.parse(JSON.stringify([row])));
    expect(saved.date).toBe('2026-10-15');
    expect(saved._replayIdentityClaims).toBe(JSON.stringify(claims));
  });

  test.each([
    ['HSG Wetzlar vs MT Melsungen', 'Handball Bundesliga'],
    ['ThSV Eisenach vs Füchse Berlin', 'Handball Bundesliga'],
    ['VfL Gummersbach vs HBW Balingen-Weilstetten', 'Handball Bundesliga'],
    ['HSG Nordhorn-Lingen vs Dessau-Roßlauer HV', 'Handball 2. Bundesliga'],
    ['VfL Lübeck-Schwartau vs VfL Eintracht Hagen', 'Handball 2. Bundesliga'],
    ['SC DHfK Leipzig vs TV 05/07 Hüttenberg', 'Handball 2. Bundesliga']
  ])('explicit handball league uses the supported other category: %s', async (title, league) => {
    const [saved] = await aggregate([replay('dlv_handball', title, String(Date.now()), 'daddylive',
      { category: 'football', league, status: 'live' })]);
    expect(saved.category).toBe('other');
  });

  test.each(['football', 'other'])('explicit handball stays separate from same-club %s listings', async category => {
    const title = 'HSG Wetzlar vs MT Melsungen';
    const handball = replay('dlv_handball', title, String(Date.now()), 'daddylive',
      { category: 'football', league: 'Handball Bundesliga', status: 'live' });
    const differentSport = { ...handball, id: 'dlv_other', category, league: 'Bundesliga', aliasIds: [handball.id],
      sources: [{ source: 'offline-fixtures', id: 'other-sport' }] };
    const agg = new MatchAggregator({});
    expect(agg.isSameEvent(handball, differentSport)).toBe(false);
    expect(agg.isSameEvent(differentSport, handball)).toBe(false);
    expect(await aggregate([handball, differentSport])).toHaveLength(2);
  });

  test('explicit handball evidence survives cache reuse without extra sport metadata', async () => {
    const title = 'HSG Wetzlar vs MT Melsungen';
    const handball = replay('dlv_handball', title, '2026-10-31', 'replayzone',
      { category: 'football', league: 'Handball Bundesliga' });
    const first = await aggregate([handball]);
    expect(first[0].category).toBe('other');
    const second = await aggregate([
      replay('rz_unknown_sport', title, '2026-10-31', 'replayzone', { category: 'other', league: '' }),
      replay('rz_same_handball', title, '2026-10-31', 'replayzone', { category: 'other', league: 'Handball Bundesliga' })
    ], JSON.parse(JSON.stringify(first)));
    expect(second).toHaveLength(2);
    expect(second.find(row => row.id === 'dlv_handball').sources).toHaveLength(2);
    expect(second.find(row => row.id === 'rz_unknown_sport').sources).toHaveLength(1);
  });

  test('explicit handball league does not relabel continuous channels', async () => {
    const channel = replay('dlv_ch_187_sport', 'Sport 1', '', 'daddylive',
      { category: 'networks', league: 'Handball Bundesliga', status: '' });
    const [saved] = await aggregate([channel]);
    expect(saved.category).toBe('networks');
    expect(new MatchAggregator({}).isSameEvent(saved, { ...saved, league: '' })).toBe(true);
  });

  test.each(['Canada. CFL', 'Canadian Football League'])('explicit %s uses the supported American football category', async league => {
    const [saved] = await aggregate([replay('livetv_montreal-saskatchewan-20261012',
      'Montreal vs Saskatchewan - Canada. CFL', '2026-10-12T18:00:00Z', 'livetv', {category: 'other', league})]);
    expect(saved.category).toBe('american_football');
  });

  test('an unqualified CFL token does not invent a sport category', async () => {
    const [saved] = await aggregate([replay('livetv_generic', 'Example vs Other', '2026-10-12T18:00:00Z', 'livetv',
      {category: 'other', league: 'CFL'})]);
    expect(saved.category).toBe('other');
  });
});
