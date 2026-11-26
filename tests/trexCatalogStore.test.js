'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeCatalogFile, openDatabase } = require('../src/services/TrexCatalogDb');
const { TrexCatalogStore } = require('../src/services/TrexCatalogStore');

const METAS = [
  { id: 'trex:nba-bulls', name: 'NBA TEAM| CHICAGO BULLS', type: 'tv' },
  { id: 'trex:sky-uk', name: 'UK| SKY SPORTS CRICKET FHD', type: 'tv' },
  { id: 'trex:sky-ie', name: 'IE| SKY SPORTS CRICKET HD', type: 'tv' },
  { id: 'trex:willow', name: 'CA| WILLOW CRICKET HD', type: 'tv' }
];

describe('TrexCatalogStore', () => {
  let dir;
  let dbPath;
  let stores;

  function openStore(opts) {
    const store = new TrexCatalogStore(opts);
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    stores = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-store-'));
    dbPath = path.join(dir, 'trex_catalog.sqlite');
    writeCatalogFile(dbPath, METAS, { generatedAt: '2026-11-24T00:00:00.000Z', source: 'test' });
  });

  afterEach(() => {
    for (const store of stores) store.close();
    stores = [];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('resolves a fixture team to its team channel', () => {
    const store = openStore({ dbPath });
    expect(store.isReady()).toBe(true);

    const hits = store.findTeam('Chicago Bulls');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'trex:nba-bulls', group: 'NBA TEAM', league: 'nba' });
    expect(store.findTeam('Bulls')).toEqual([]);
  });

  test('resolves broadcaster labels and prefers the requested country', () => {
    const store = openStore({ dbPath });

    expect(store.findChannel('Sky Sports Cricket HD')[0].group).toBe('UK');
    expect(store.findChannel('Sky Sports Cricket HD', { countryCode: 'IE' })[0].group).toBe('IE');
    expect(store.findChannel('Willow Cricket')[0]).toMatchObject({ id: 'trex:willow', name: 'CA| WILLOW CRICKET HD' });
    expect(store.findChannel('No Such Channel')).toEqual([]);
  });

  test('reports not ready for a missing or corrupt database without throwing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const missing = openStore({ dbPath: path.join(dir, 'nope.sqlite') });
      expect(missing.isReady()).toBe(false);
      expect(missing.findTeam('Chicago Bulls')).toEqual([]);

      const corruptPath = path.join(dir, 'corrupt.sqlite');
      fs.writeFileSync(corruptPath, 'not sqlite');
      const corrupt = openStore({ dbPath: corruptPath });
      expect(corrupt.isReady()).toBe(false);
      expect(corrupt.findChannel('Sky Sports Cricket')).toEqual([]);

      const unset = openStore({ dbPath: '' });
      expect(unset.isReady()).toBe(false);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[TrexCatalogStore] not ready:'));
    } finally {
      warn.mockRestore();
    }
  });

  test('reports catalog stats', () => {
    const store = openStore({ dbPath });
    expect(store.stats()).toMatchObject({ rows: 4, teams: 1, channels: 3, generatedAt: '2026-11-24T00:00:00.000Z' });
  });

  test('finds event rows across kinds, aliases and home/away order', () => {
    const names = [
      'Live | Mavericks vs. Nuggets | all',
      'CA (SN+ 010) | Dallas @ Denver (2026-11-24 22:00:00)',
      'Live | DENVER NUGGETS - DALLAS MAVERICKS | NBA',
      'LIVE | DEN - NUGGETS VS DAL - MAVERICKS | US: NBA PASS PPV 3',
      'US (Peacock 006) | Celtics vs. Wizards (2026-11-24 19:00:10)',
      'NHL | 01 - 8pm Golden Knights @ Oilers',
      'LIVE | NHL EDMONTON - VEGAS | Wed 25 Nov 03:00 EET (FI) | 8K EXCLUSIVE | FI: VIAPLAY PPV 27',
      'Live | Nuggets vs. Suns',
      'Live | Mavericks vs. Suns • Bulls vs. Nuggets',
      'Denver Nuggets vs Dallas Mavericks @ Nov 17 10:00 PM :NBA  03',
      'Live | Dallas Stars vs Denver Nuggets',
      'NBA | Dallas vs Los Angeles',
      'Hockey: Dallas @ Denver (2026-11-24 22:00:00)'
    ];
    writeCatalogFile(dbPath, names.map((name, i) => ({ id: String(i), name })));
    const store = openStore({ dbPath });
    const query = (team1, team2, category = 'basketball', date = '2026-11-25T03:00:00Z') => store.findEvents({
      team1: {name: team1}, team2, category, date
    }).map(r => r.id).sort();
    expect(query('Dallas Mavericks', 'Denver Nuggets')).toEqual(['0', '1', '2', '3']);
    expect(query('Boston Celtics', 'Washington Wizards')).toEqual(['4']);
    expect(query('Vegas Golden Knights', 'Edmonton Oilers', 'hockey', '2026-11-25T01:00:00Z')).toEqual(['5', '6']);
    expect(query('Dallas Mavericks', 'Los Angeles Lakers')).toEqual([]);

    const db = openDatabase(dbPath);
    try {
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT channel_id FROM event_pairs WHERE pair_key = ?').all('x');
      expect(plan.map(x => x.detail).join(' ')).toMatch(/SEARCH event_pairs USING/i);
      expect(() => require('../src/services/TrexCatalogDb').replaceCatalog(db, [{id:'x',name:'Jazz vs. Suns'}, null])).toThrow();
      expect(query('Vegas Golden Knights', 'Edmonton Oilers', 'hockey', '2026-11-25T01:00:00Z')).toEqual(['5', '6']);
      db.exec('DROP TABLE event_pairs');
      expect(query('Dallas Mavericks', 'Denver Nuggets')).toEqual([]);
      expect(store.isReady()).toBe(true);
    } finally { db.close(); }
  });

  test('a reader keeps the previous catalog while a refresh transaction is open', () => {
    const store = openStore({ dbPath });
    expect(store.isReady()).toBe(true);
    expect(store.findTeam('Chicago Bulls')[0].id).toBe('trex:nba-bulls');

    const writer = openDatabase(dbPath);
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('INSERT INTO channels (id, name, grp, kind, league, tier) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('trex:nba-bulls-4k', 'NBA TEAM| CHICAGO BULLS 4K', 'NBA TEAM', 'team', 'nba');
    writer.prepare('INSERT INTO channel_keys (norm_key, channel_id, score) VALUES (?, ?, ?)')
      .run('chicago bulls', 'trex:nba-bulls-4k', 9999);

    expect(store.findTeam('Chicago Bulls')[0].id).toBe('trex:nba-bulls');

    writer.exec('COMMIT');
    writer.close();

    expect(store.findTeam('Chicago Bulls')[0].id).toBe('trex:nba-bulls-4k');
  });

  test('matches soccer events and team channels while blocking squad and same-city leaks', () => {
    const soccerMetas = [
      { id: 'tv:inter', name: 'UA| INTER' },
      { id: 'team:inter', name: 'SERIE A| INTER MILAN' },
      { id: 'team:ac-milan', name: 'SERIE A| AC MILAN' },
      { id: 'team:bolton', name: 'CHAMP | Bolton Wanderers' },
      { id: 'ev:x-br', name: 'NEXT | INTER DE MILÃO X STUTTGART | Wed 25 Nov 17:45 -02 (BR) | 8K EXCLUSIVE | BR: MAX PPV 9' },
      { id: 'ev:x-pt', name: 'Next | Sabah x Barcelona | UEFA Champions League | 2026-11-25 | 17:45 (GMT) | 8K EXCLUSIVE | PT: DAZN PPV 27' },
      { id: 'tv:hunter-x', name: 'PRIME| HUNTER X HUNTER ᴿᴬᵂ' },
      { id: 'ev:stan-bullet', name: 'AU (STAN 52) |  • Everton v Liverpool  Premier League Matchweek 12 2026/2027 (2026-11-29 22:50:50)' },
      { id: 'ev:goal-rush', name: 'AU (STAN 57) | Goal Rush: Sunderland v Tottenham Hotspur • 30 Nov  Premier League 2026/2027 (2026-11-30 00:55:50)' },
      { id: 'ev:stan-sunderland', name: 'AU (STAN 61) | Sunderland v Tottenham Hotspur  Premier League Matchweek 12 2026/2027 (2026-11-30 00:55:50)' },
      { id: 'ev:viaplay', name: 'NEXT | CHAMPIONSHIP BOLTON - WEST BROM | Wed 25 Nov 20:35 CET (DK) | 8K EXCLUSIVE | DK: VIAPLAY PPV 57' },
      { id: 'ev:psf', name: 'PSF04 | 15:00 Arsenal vs Manchester City' },
      { id: 'ev:bodo', name: 'AU (STAN 02) | Bodø / Glimt v LASK  UEFA Champions League Matchday 5 2026/2027 (2026-11-25 04:40:50)' },
      { id: 'ev:mls', name: '(Apple) (MLS) 027 |  Portland vs. Dallas  (2026-11-28 22:10:00)' },
      { id: 'ev:u19', name: 'Football: Arsenal U19 vs Dortmund U19 @ Nov 24 13:55 :Tv2Play NO  02' },
      { id: 'ev:senior-ars', name: 'US (Paramount 004) | Arsenal vs. Dortmund (2026-11-24 15:00:05)' },
      { id: 'ev:lafc', name: 'End | St. Louis CITY SC vs. Los Angeles Football Club | all | 24-11-2026 | 00:00 (GMT) | 8K EXCLUSIVE | CA: SOCCER PPV 2' },
      { id: 'ev:nba-ppv', name: 'Live | Mavericks vs. Nuggets | all | 8K EXCLUSIVE | US: SOCCER PPV 93' }
    ];
    writeCatalogFile(dbPath, soccerMetas);
    const store = openStore({ dbPath });

    // findTeam ignores non-team TV channels (`UA| INTER`) and finds `SERIE A| INTER MILAN`.
    expect(store.findTeam('Inter').map(r => r.id)).toEqual(['team:inter']);
    expect(store.findTeam('Internazionale').map(r => r.id)).toEqual(['team:inter']);
    expect(store.findTeam('AC Milan').map(r => r.id)).toEqual(['team:ac-milan']);
    expect(store.findTeam('Bolton').map(r => r.id)).toEqual(['team:bolton']);

    const idsFor = (team1, team2, league, date) =>
      store.findEvents({ team1, team2, category: 'football', league, date }).map(r => r.id).sort();

    expect(idsFor('Internazionale', 'VfB Stuttgart', 'UCL', '2026-11-25T19:45:00Z')).toEqual(['ev:x-br']);
    expect(idsFor('Sabah FK', 'Barcelona', 'UCL', '2026-11-25T17:45:00Z')).toEqual(['ev:x-pt']);
    expect(idsFor('Everton', 'Liverpool', 'EPL', '2026-11-29T13:30:00Z')).toEqual(['ev:stan-bullet']);
    expect(idsFor('Sunderland', 'Tottenham Hotspur', 'EPL', '2026-11-29T14:00:00Z')).toEqual(['ev:stan-sunderland']);
    expect(idsFor('Bolton Wanderers', 'West Bromwich Albion', 'Championship', '2026-11-25T19:45:00Z')).toEqual(['ev:viaplay']);
    expect(idsFor('Arsenal', 'Manchester City', 'EPL', '2026-11-29T15:00:00Z')).toEqual(['ev:psf']);
    expect(idsFor('Bodoe/Glimt', 'LASK Linz', 'UCL', '2026-11-24T17:45:00Z')).toEqual(['ev:bodo']);
    expect(idsFor('Portland Timbers', 'FC Dallas', 'MLS', '2026-11-29T00:10:00Z')).toEqual(['ev:mls']);

    // Guard against U19 <-> senior leaks, same-city collisions, and NBA mislabeled into SOCCER PPV.
    expect(idsFor('Arsenal U19', 'Borussia Dortmund U19', 'UEFA Youth League', '2026-11-24T13:00:00Z')).toEqual(['ev:u19']);
    expect(idsFor('Arsenal', 'Borussia Dortmund', 'UEFA Champions League', '2026-11-24T20:00:00Z')).toEqual(['ev:senior-ars']);
    expect(idsFor('Manchester United', 'Manchester City', 'EPL', '2026-11-29T15:00:00Z')).toEqual([]);
    expect(idsFor('St. Louis City', 'LA Galaxy', 'MLS', '2026-11-24T20:00:00Z')).toEqual([]);
    expect(idsFor('Hunter', 'Hunter', 'Other', null)).toEqual([]);
    expect(store.findEvents({
      team1: 'Dallas Mavericks', team2: 'Denver Nuggets', category: 'basketball', league: 'NBA', date: '2026-11-25T03:00:00Z'
    }).map(r => r.id)).toEqual(['ev:nba-ppv']);
  });

  test('strips anchored schedule wrappers from event_pairs keys and validates zoned ET and weekday-only kickoffs', () => {
    const scheduleMetas = [
      { id: '1949763', name: 'US (ESPN+ 149) | Utah Mammoth vs. Minnesota Wild Nov 25 7:30PM ET (2026-11-25 19:30:00)' },
      { id: '1949760', name: 'US (ESPN+ 152) | Utah Mammoth vs. Minnesota Wild Nov 25 7:30PM ET (2026-11-25 19:30:15)' },
      { id: '836296', name: 'NFL  | 01 - WED 8pm Packers at Rams' },
      { id: '202', name: 'US (ESPN+ 202) | Football: NFL Football: 2026 Week 12 Green Bay Packers vs. Los Angeles Rams (NFL Football: 2026 Week 12 Green Bay Packers vs. Los Angeles Rams) (2026-11-26 00:30:00)' },
      { id: 'nba:uta-min', name: 'NBA | UTA vs MIN (2026-11-25 19:30:00)' },
      { id: 'nba:utah-minn', name: 'NBA | Utah vs. Minnesota (2026-11-25 19:30:00)' },
      { id: 'nhl:multi-bullet', name: 'Live | Utah Mammoth vs. Minnesota Wild \u2022 Oilers vs. Flames (2026-11-25 19:30:00)' },
      { id: 'nhl:multi-pipe', name: 'NHL | Utah Mammoth vs. Minnesota Wild | Oilers vs. Flames' },
      { id: 'city:bare', name: 'Live | Utah vs. Minnesota' }
    ];
    writeCatalogFile(dbPath, scheduleMetas);
    const store = openStore({ dbPath });

    const db = openDatabase(dbPath, { readOnly: true });
    try {
      const pairsFor = (key) => db
        .prepare('SELECT channel_id FROM event_pairs WHERE pair_key = ? ORDER BY channel_id')
        .all(key)
        .map((row) => row.channel_id);

      expect(pairsFor('minnesota wild|utah mammoth')).toEqual(['1949760', '1949763']);
      expect(pairsFor('packers|rams')).toEqual(['836296']);
      expect(pairsFor('green bay packers|los angeles rams')).toEqual(['202']);
      expect(db.prepare('SELECT kind FROM channels WHERE id = ?').get('836296')).toEqual({ kind: 'linear' });
    } finally {
      db.close();
    }

    const utahQuery = (date) => store.findEvents({
      team1: 'Utah Mammoth', team2: 'Minnesota Wild', category: 'hockey', league: 'NHL', date
    }).map((r) => r.id);
    const ramsQuery = (date) => store.findEvents({
      team1: 'Green Bay Packers', team2: 'Los Angeles Rams', category: 'american football', league: 'NFL', date
    }).map((r) => r.id);

    const utahIds = utahQuery('2026-11-26T01:00:00Z');
    const ramsIds = ramsQuery('2026-11-26T01:00:00Z');
    expect(utahIds).toEqual(expect.arrayContaining(['1949763', '1949760']));
    expect(utahIds).not.toContain('nba:uta-min');
    expect(utahIds).not.toContain('nba:utah-minn');
    expect(utahIds).not.toContain('nhl:multi-bullet');
    expect(utahIds).not.toContain('nhl:multi-pipe');
    expect(utahIds).not.toContain('city:bare');
    expect(ramsIds).toContain('836296');
    expect(ramsIds).toContain('202');

    // Negative date checks: December 3 and same calendar date beyond 6h tolerance.
    expect(utahQuery('2026-12-03T01:00:00Z')).toEqual([]);
    expect(utahQuery('2026-11-26T12:00:00Z')).toEqual([]);
    expect(utahQuery('2026-11-25T12:00:00Z')).toEqual([]);
    expect(ramsQuery('2026-12-03T20:00:00Z')).toEqual([]);
    expect(ramsQuery('2026-11-25T01:00:00Z')).not.toContain('836296');
  });

  test('interprets ET across DST and preserves untimed reused label and city-only guards', () => {
    const extraMetas = [
      { id: 'nhl:summer-et', name: 'US (ESPN+ 155) | Utah Mammoth vs. Minnesota Wild Jul 15 7:30PM ET (2026-07-15 19:30:00)' },
      { id: 'nhl:reused-untimed', name: 'Live | Utah Mammoth vs. Minnesota Wild | all' },
      { id: 'city:wed-bare', name: 'Live | WED 8pm Utah vs. Minnesota' },
      { id: 'efl:wednesday', name: 'UK | Sheffield Wednesday vs. Leeds United' }
    ];
    writeCatalogFile(dbPath, extraMetas);
    const store = openStore({ dbPath });

    // July 15 7:30PM ET uses EDT (UTC-4) = 2026-07-15T23:30:00Z.
    const summerHits = store.findEvents({
      team1: 'Utah Mammoth', team2: 'Minnesota Wild', category: 'hockey', league: 'NHL', date: '2026-07-16T01:00:00Z'
    }).map((r) => r.id).sort();
    expect(summerHits).toEqual(['nhl:reused-untimed', 'nhl:summer-et']);

    const outOfWindowHits = store.findEvents({
      team1: 'Utah Mammoth', team2: 'Minnesota Wild', category: 'hockey', league: 'NHL', date: '2026-07-16T06:00:00Z'
    }).map((r) => r.id);
    expect(outOfWindowHits).toEqual(['nhl:reused-untimed']);

    // Sheffield Wednesday must not be parsed as a Wednesday schedule marker.
    expect(store.findEvents({
      team1: 'Sheffield Wednesday', team2: 'Leeds United', category: 'football', league: 'Championship', date: '2026-11-26T20:00:00Z'
    }).map((r) => r.id)).toEqual(['efl:wednesday']);

    // Bare city-only weekday label without a matching sport stays blocked even on Wednesday ET.
    expect(store.findEvents({
      team1: 'Utah Mammoth', team2: 'Minnesota Wild', category: 'hockey', league: 'NHL', date: '2026-11-26T01:00:00Z'
    }).map((r) => r.id)).toEqual(['nhl:reused-untimed']);
  });
});
