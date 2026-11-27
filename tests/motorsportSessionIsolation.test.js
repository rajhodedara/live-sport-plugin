'use strict';

const MatchAggregator = require('../src/services/MatchAggregator');
const CacheService = require('../src/services/CacheService');
const MatchEntity = require('../src/domain/MatchEntity');
const { getScheduledMotorsportClaim } = require('../src/services/MotorsportIdentity');

describe('Motorsport Session & Series Deduplication Isolation Suite', () => {
  let agg;

  beforeEach(() => {
    agg = new MatchAggregator({});
  });

  describe('Session Classifier (_extractMotorsportSession)', () => {
    test('correctly identifies practice sessions (FP1, FP2, FP3, FP4)', () => {
      expect(agg._extractMotorsportSession('1st Practice - F1 2026 - Singapore Grand Prix Full Race Replay')).toBe('p1');
      expect(agg._extractMotorsportSession('FP1 - Bahrain Grand Prix')).toBe('p1');
      expect(agg._extractMotorsportSession('Free Practice 1 - Monaco GP')).toBe('p1');

      expect(agg._extractMotorsportSession('2nd Practice - F1 2026 - Singapore Grand Prix Full Race Replay')).toBe('p2');
      expect(agg._extractMotorsportSession('FP2 - Bahrain Grand Prix')).toBe('p2');

      expect(agg._extractMotorsportSession('3rd Practice - F1 2026 - Azerbaijan Grand Prix - Full Race Replay')).toBe('p3');
      expect(agg._extractMotorsportSession('FP3 - Japanese Grand Prix')).toBe('p3');

      expect(agg._extractMotorsportSession('4th Practice - Indianapolis 500')).toBe('p4');
      expect(agg._extractMotorsportSession('FP4 - Indy 500')).toBe('p4');
    });

    test('correctly identifies qualifying and sprint sessions', () => {
      expect(agg._extractMotorsportSession('Qualifying - F1 2026 - Singapore Grand Prix Full Race Replay')).toBe('qualifying');
      expect(agg._extractMotorsportSession('F1 Shootout - Austrian Grand Prix')).toBe('qualifying');

      expect(agg._extractMotorsportSession('Sprint Qualifying - F1 2026 - Singapore Grand Prix Full Race Replay')).toBe('sprint_qualifying');
      expect(agg._extractMotorsportSession('Sprint Shootout - Qatar GP')).toBe('sprint_qualifying');

      expect(agg._extractMotorsportSession('SPRINT - F1 2026 - Singapore Grand Prix - Full Race Replay')).toBe('sprint');
      expect(agg._extractMotorsportSession('Sprint Race - Austrian Grand Prix')).toBe('sprint');
    });

    test('correctly identifies main race, testing days, reviews, and shows', () => {
      expect(agg._extractMotorsportSession('RACE - F1 2026 - Singapore Grand Prix - Full Race Replay')).toBe('race');
      expect(agg._extractMotorsportSession('Formula 1 Singapore Grand Prix 2026 Race Replay')).toBe('race');

      expect(agg._extractMotorsportSession('Barcelona Shakedown Day 4 - F1 2026 - Full Show Replay')).toBe('day_4');
      expect(agg._extractMotorsportSession('Bahrain Pre-Season 2nd Test - Day 3 - F1 2026')).toBe('day_3');
      expect(agg._extractMotorsportSession('Bahrain Pre-Season 1st Test - Day 2')).toBe('day_2');
      expect(agg._extractMotorsportSession('Bahrain Pre-Season 1st Test - Day 1')).toBe('day_1');

      expect(agg._extractMotorsportSession('F1 2025 Season Review - Sky Sports F1 Full Show Replay')).toBe('season_review');
      expect(agg._extractMotorsportSession('Pre Race - F1 2026 - Singapore Grand Prix - Full Replay')).toBe('pre_race');
      expect(agg._extractMotorsportSession('Post-Race Reaction - Singapore GP')).toBe('post_race');
    });
  });

  describe('Series Classifier (_extractMotorsportSeries)', () => {
    test('correctly disambiguates distinct motorsport series', () => {
      expect(agg._extractMotorsportSeries('RACE - F1 2026 - Singapore Grand Prix')).toBe('f1');
      expect(agg._extractMotorsportSeries('Formula 1 Bahrain Grand Prix 2026')).toBe('f1');

      expect(agg._extractMotorsportSeries('Formula 2 Italian Grand Prix - Full Race Replay 2026 - F2 Championship')).toBe('f2');
      expect(agg._extractMotorsportSeries('F2 Championship Monza Sprint')).toBe('f2');

      expect(agg._extractMotorsportSeries('Formula 3 British Grand Prix Full Race Replay 2026 F3 Championship')).toBe('f3');
      expect(agg._extractMotorsportSeries('F3 Championship Silverstone')).toBe('f3');

      expect(agg._extractMotorsportSeries('F1 Academy Dutch Grand Prix - Full Race Replay 2026 - Formula 4')).toBe('f4');
      expect(agg._extractMotorsportSeries('Formula 4 Italian Championship')).toBe('f4');

      expect(agg._extractMotorsportSeries('Monaco ePrix - Formula E Full Race Replay')).toBe('fe');
      expect(agg._extractMotorsportSeries('NASCAR Wurth 400 Full Race Replay - May 3, 2026')).toBe('nascar');
      expect(agg._extractMotorsportSeries('IndyCar The 110th Indianapolis 500 - Full Race Replay')).toBe('indycar');
      expect(agg._extractMotorsportSeries('MotoGP - Grand Prix of Austria 2026 - Full Race Replay')).toBe('motogp');
      expect(agg._extractMotorsportSeries('WSBK Australia Race One & Two Full Race Replay')).toBe('wsbk');
      expect(agg._extractMotorsportSeries('WRC Rally Finland - Full Race Replay')).toBe('wrc');
      expect(agg._extractMotorsportSeries('DTM Circuit Zandvoort - Full Race Replay')).toBe('dtm');
    });

    test('falls back to league metadata when title does not explicitly contain series name', () => {
      expect(agg._extractMotorsportSeries('Singapore Grand Prix - Race', 'Formula 1')).toBe('f1');
      expect(agg._extractMotorsportSeries('Grand Prix of Austria', 'MotoGP')).toBe('motogp');
      expect(agg._extractMotorsportSeries('Enjoy Illinois 300', 'NASCAR')).toBe('nascar');
    });
  });

  describe('Session Collision Guard (Different Sessions Never Merge)', () => {
    const venueDate = '2026-10-10';

    test('F1 Practice 1 vs Practice 2 never merges', () => {
      const p1 = { id: 'rz_fp1', title: '1st Practice - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '1' }] };
      const p2 = { id: 'rz_fp2', title: '2nd Practice - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '2' }] };
      expect(agg.isSameEvent(p1, p2)).toBe(false);
    });

    test('F1 Practice 2 vs Practice 3 never merges', () => {
      const p2 = { id: 'rz_fp2', title: '2nd Practice - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '2' }] };
      const p3 = { id: 'rz_fp3', title: '3rd Practice - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '3' }] };
      expect(agg.isSameEvent(p2, p3)).toBe(false);
    });

    test('F1 Practice 3 vs Qualifying never merges', () => {
      const p3 = { id: 'rz_fp3', title: '3rd Practice - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '3' }] };
      const q = { id: 'rz_quali', title: 'Qualifying - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '4' }] };
      expect(agg.isSameEvent(p3, q)).toBe(false);
    });

    test('F1 Qualifying vs Main Race never merges', () => {
      const q = { id: 'rz_quali', title: 'Qualifying - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '4' }] };
      const r = { id: 'rz_race', title: 'RACE - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '5' }] };
      expect(agg.isSameEvent(q, r)).toBe(false);
    });

    test('F1 Sprint vs Main Race never merges', () => {
      const s = { id: 'rz_sprint', title: 'Sprint - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '6' }] };
      const r = { id: 'rz_race', title: 'RACE - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '5' }] };
      expect(agg.isSameEvent(s, r)).toBe(false);
    });

    test('F1 Sprint Qualifying vs Sprint Race never merges', () => {
      const sq = { id: 'rz_sq', title: 'Sprint Qualifying - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '7' }] };
      const s = { id: 'rz_sprint', title: 'Sprint - F1 2026 - Singapore Grand Prix Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '6' }] };
      expect(agg.isSameEvent(sq, s)).toBe(false);
    });

    test('Testing Day 1 vs Testing Day 2 never merges', () => {
      const d1 = { id: 'rz_d1', title: 'Bahrain Pre-Season 1st Test - Day 1 - F1 2026', date: '2026-02-11', category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '8' }] };
      const d2 = { id: 'rz_d2', title: 'Bahrain Pre-Season 1st Test - Day 2 - F1 2026', date: '2026-02-12', category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '9' }] };
      expect(agg.isSameEvent(d1, d2)).toBe(false);
    });
  });

  describe('Series Collision Guard (Different Series Never Merge)', () => {
    const venueDate = '2026-09-06';

    test('F1 Italian Grand Prix vs F2 Italian Grand Prix at same venue/date never merges', () => {
      const f1 = { id: 'rz_f1_monza', title: 'RACE - F1 2026 - Italian Grand Prix - Full Race Replay', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '1' }] };
      const f2 = { id: 'rz_f2_monza', title: 'Formula 2 Italian Grand Prix - Full Race Replay 2026 - F2 Championship', date: venueDate, category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '2' }] };
      expect(agg.isSameEvent(f1, f2)).toBe(false);
    });

    test('F1 British Grand Prix vs F3 British Grand Prix never merges', () => {
      const f1 = { id: 'rz_f1_silverstone', title: 'RACE - F1 2026 - British Grand Prix - Full Race Replay', date: '2026-07-05', category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '3' }] };
      const f3 = { id: 'rz_f3_silverstone', title: 'Formula 3 British Grand Prix Full Race Replay 2026 F3 Championship', date: '2026-07-05', category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '4' }] };
      expect(agg.isSameEvent(f1, f3)).toBe(false);
    });

    test('F1 Dutch Grand Prix vs F1 Academy (F4) Dutch Grand Prix never merges', () => {
      const f1 = { id: 'rz_f1_zandvoort', title: 'RACE - F1 2026 - Dutch Grand Prix - Full Race Replay', date: '2026-08-23', category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '5' }] };
      const f4 = { id: 'rz_f4_zandvoort', title: 'F1 Academy Dutch Grand Prix - Full Race Replay 2026 - Formula 4', date: '2026-08-23', category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '6' }] };
      expect(agg.isSameEvent(f1, f4)).toBe(false);
    });

    test('F1 Grand Prix vs NASCAR race on same date never merges', () => {
      const f1 = { id: 'rz_f1_miami', title: 'RACE - F1 2026 - Miami Grand Prix - Full Race Replay', date: '2026-05-03', category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '7' }] };
      const nascar = { id: 'rz_nascar_wurth', title: 'NASCAR Wurth 400 Full Race Replay - May 3, 2026', date: '2026-05-03', category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '8' }] };
      expect(agg.isSameEvent(f1, nascar)).toBe(false);
    });

    test('MotoGP vs NASCAR never merges', () => {
      const motogp = { id: 'rz_motogp', title: 'MotoGP - Grand Prix of Austria 2026 - Full Race Replay', date: '2026-08-16', category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '9' }] };
      const nascar = { id: 'rz_nascar', title: 'NASCAR Cook Out 400 - Full Race Replay - August 15, 2026', date: '2026-08-15', category: 'motorsport', status: 'finished', sources: [{ source: 'replayzone', id: '10' }] };
      expect(agg.isSameEvent(motogp, nascar)).toBe(false);
    });
  });

  describe('Legitimate Same-Session Multi-Provider Merging', () => {
    test('same F1 session from ReplayZone and FullRaces merges cleanly', () => {
      const rz = {
        id: 'rz_race---f1-2026---singapore-grand-prix-full-race-replay-october-11--2026-formula-1-323032362d31302d3131',
        title: 'RACE - F1 2026 - Singapore Grand Prix Full Race Replay October 11, 2026 Formula 1',
        category: 'motorsport',
        date: '2026-10-11',
        status: 'finished',
        sources: [{ source: 'replayzone', id: 'https://ok.ru/videoembed/12345', name: 'Server 1 (OK)', type: 'iframe' }]
      };
      const fr = {
        id: 'fr_race-f1-2026-singapore-grand-prix-full-race-replay-october-11-2026-formula-1',
        title: 'Formula 1 Singapore Grand Prix 2026 Race Replay',
        category: 'motorsport',
        date: '2026-10-11',
        status: 'finished',
        sources: [{ source: 'fullraces', id: 'https://fullraces.com/singapore', name: 'FullRaces', type: 'fullraces' }]
      };

      expect(agg.isSameEvent(rz, fr)).toBe(true);
      expect(agg.isSameEvent(fr, rz)).toBe(true);
    });

    test('same F1 Qualifying session from two providers within 24h merges cleanly', () => {
      const p1 = {
        id: 'rz_qualifying_bahrain',
        title: 'Qualifying - F1 2026 - Bahrain Grand Prix Full Race Replay',
        category: 'motorsport',
        date: '2026-10-03',
        status: 'finished',
        sources: [{ source: 'replayzone', id: 's1' }]
      };
      const p2 = {
        id: 'fr_qualifying_bahrain',
        title: 'Formula 1 Bahrain Grand Prix 2026 Qualifying Replay',
        category: 'motorsport',
        date: '2026-10-03',
        status: 'finished',
        sources: [{ source: 'fullraces', id: 's2' }]
      };

      expect(agg.isSameEvent(p1, p2)).toBe(true);
    });
  });

  describe('idIndex Candidate Verification Guard', () => {
    test('rejects idIndex candidate merge when alias belongs to a different session', async () => {
      // Simulates the corrupted disk cache where Barcelona shakedown had swallowed Singapore GP race ID
      const mockMatches = [
        {
          id: 'rz_barcelona_day_4',
          title: 'Barcelona Shakedown Day 4 - F1 2026 - Full Show Replay January 29, 2026',
          category: 'motorsport',
          date: '2026-01-29',
          status: 'finished',
          aliasIds: ['rz_singapore_race'],
          sources: [{ source: 'replayzone', id: 's1', url: 'u1' }]
        },
        {
          id: 'rz_singapore_race',
          title: 'RACE - F1 2026 - Singapore Grand Prix Full Race Replay October 11, 2026 Formula 1',
          category: 'motorsport',
          date: '2026-10-11',
          status: 'finished',
          sources: [{ source: 'replayzone', id: 's2', url: 'u2' }]
        }
      ];

      let saved = [];
      const mockCacheService = {
        getMatches: () => [],
        setMatches: (m) => { saved = m; }
      };

      agg = new MatchAggregator({ cacheService: mockCacheService });
      agg.providers = [{ sourceName: 'replayzone', getMatches: async () => mockMatches }];

      const results = await agg.syncMatches();
      // Must produce 2 separate events, NOT 1 swallowed event
      expect(results.length).toBe(2);
      const singapore = results.find(m => m.id === 'rz_singapore_race');
      expect(singapore).toBeDefined();
      expect(singapore.title).toContain('Singapore Grand Prix');
    });

    test('rejects idIndex candidate merge when date difference exceeds 48 hours', async () => {
      const mockMatches = [
        {
          id: 'rz_race_1',
          title: 'RACE - F1 2026 - Australian Grand Prix Full Race Replay',
          category: 'motorsport',
          date: '2026-03-15',
          status: 'finished',
          aliasIds: ['rz_race_2'],
          sources: [{ source: 'replayzone', id: 's1', url: 'u1' }]
        },
        {
          id: 'rz_race_2',
          title: 'RACE - F1 2026 - Australian Grand Prix Full Race Replay',
          category: 'motorsport',
          date: '2026-04-15', // 1 month later
          status: 'finished',
          sources: [{ source: 'replayzone', id: 's2', url: 'u2' }]
        }
      ];

      let saved = [];
      const mockCacheService = {
        getMatches: () => [],
        setMatches: (m) => { saved = m; }
      };

      agg = new MatchAggregator({ cacheService: mockCacheService });
      agg.providers = [{ sourceName: 'replayzone', getMatches: async () => mockMatches }];

      const results = await agg.syncMatches();
      expect(results.length).toBe(2);
    });
  });

  describe('Date-0 / Missing Date Safety Guard', () => {
    test('undated Season Review cannot merge with dated race session', () => {
      const review = {
        id: 'rz_review',
        title: 'F1 2025 Season Review - Sky Sports F1 Full Show Replay',
        category: 'motorsport',
        date: '', // date = 0
        status: 'finished',
        sources: [{ source: 'replayzone', id: 's1' }]
      };
      const race = {
        id: 'rz_singapore',
        title: 'RACE - F1 2025 - Singapore Grand Prix Full Race Replay October 5, 2025 Formula 1',
        category: 'motorsport',
        date: '2025-10-05',
        status: 'finished',
        sources: [{ source: 'replayzone', id: 's2' }]
      };

      expect(agg.isSameEvent(review, race)).toBe(false);
      expect(agg.isSameEvent(race, review)).toBe(false);
    });

    test('date-0 events only merge on exact normalized title match', () => {
      const a = {
        id: 'rz_1',
        title: 'Formula 1 Testing Day 1',
        category: 'motorsport',
        date: 0,
        status: 'finished',
        sources: [{ source: 'replayzone', id: 's1' }]
      };
      const b = {
        id: 'fr_1',
        title: 'Formula 1 Testing Day 1',
        category: 'motorsport',
        date: '',
        status: 'finished',
        sources: [{ source: 'fullraces', id: 's2' }]
      };
      const c = {
        id: 'rz_2',
        title: 'Formula 1 Testing Day 2',
        category: 'motorsport',
        date: 0,
        status: 'finished',
        sources: [{ source: 'replayzone', id: 's3' }]
      };

      expect(agg.isSameEvent(a, b)).toBe(true);
      expect(agg.isSameEvent(a, c)).toBe(false);
    });
  });

  describe('Dual-Team Extraction & Title Overwrite Guard', () => {
    test('motorsport titles are never parsed as dual-team fixtures', () => {
      const pre1 = agg._precompute({ title: 'NASCAR Wurth 400 Full Race Replay - May 3, 2026', category: 'motorsport' });
      expect(pre1.teams).toBeNull();

      const pre2 = agg._precompute({ title: 'RACE - F1 2026 - Miami Grand Prix - Full Race Replay', category: 'motorsport' });
      expect(pre2.teams).toBeNull();
    });

    test('incoming motorsport title cannot overwrite existing Grand Prix title', async () => {
      const mockMatches = [
        {
          id: 'rz_f1_miami',
          title: 'RACE - F1 2026 - Miami Grand Prix - Full Race Replay - May 3, 2026 - Formula 1',
          category: 'motorsport',
          date: '2026-05-03',
          status: 'finished',
          sources: [{ source: 'replayzone', id: 's1', url: 'u1' }]
        },
        {
          id: 'rz_f1_miami_mirror',
          title: 'Miami Grand Prix 2026 F1 Race Replay',
          category: 'motorsport',
          date: '2026-05-03',
          status: 'finished',
          sources: [{ source: 'fullraces', id: 's2', url: 'u2' }]
        }
      ];

      let saved = [];
      const mockCacheService = {
        getMatches: () => [],
        setMatches: (m) => { saved = m; }
      };

      agg = new MatchAggregator({ cacheService: mockCacheService });
      agg.providers = [{ sourceName: 'replayzone', getMatches: async () => mockMatches }];

      const results = await agg.syncMatches();
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('RACE - F1 2026 - Miami Grand Prix - Full Race Replay - May 3, 2026 - Formula 1');
      expect(results[0].sources.length).toBe(2);
    });
  });

  describe('Scheduled Motorsport Claim Extraction (MotorsportIdentity)', () => {
    test('extracts observed F1 Qatar pair claims with shared venueKey and f1 series', () => {
      const kickoffIso = '2026-11-27T13:30:00Z';
      const expectedMs = Date.parse(kickoffIso);

      const withSession = getScheduledMotorsportClaim({
        title: 'Formula 1 Qatar Airways Qatar Grand Prix - Practice 1',
        league: 'Formula 1',
        category: 'motorsport',
        date: kickoffIso
      });
      const withoutSession = getScheduledMotorsportClaim({
        title: 'Formula 1 Qatar Grand Prix',
        league: 'Formula 1',
        category: 'motorsport',
        date: kickoffIso
      });

      expect(withSession).toEqual({
        series: 'f1',
        session: 'p1',
        venueKey: 'qatar',
        kickoffMs: expectedMs
      });
      expect(withoutSession).toEqual({
        series: 'f1',
        session: null,
        venueKey: 'qatar',
        kickoffMs: expectedMs
      });
    });

    test('extracts observed MotoGP Valencia pair claims with complementary series and session', () => {
      const kickoffIso = '2026-11-27T09:45:00Z';
      const expectedMs = Date.parse(kickoffIso);

      const cdnRow = getScheduledMotorsportClaim({
        title: 'Ricardo Tormo FP1',
        league: '',
        category: 'motorsport',
        date: kickoffIso
      });
      const sportzxRow = getScheduledMotorsportClaim({
        title: 'Gran Premio de la Comunitat Valenciana',
        league: 'MotoGP',
        category: 'motorsport',
        date: kickoffIso
      });

      expect(cdnRow).toEqual({
        series: null,
        session: 'p1',
        venueKey: 'valencia',
        kickoffMs: expectedMs
      });
      expect(sportzxRow).toEqual({
        series: 'motogp',
        session: null,
        venueKey: 'valencia',
        kickoffMs: expectedMs
      });
      expect(cdnRow.venueKey).toBe(sportzxRow.venueKey);
    });

    test('distinguishes explicit race, q1, q2, sprint qualifying and sprint', () => {
      const ts = '2026-11-28T14:00:00Z';
      expect(getScheduledMotorsportClaim({ title: 'Formula 1 Qatar Grand Prix - Race', category: 'motorsport', date: ts }).session).toBe('race');
      expect(getScheduledMotorsportClaim({ title: 'MotoGP Valencia Q1', category: 'motorsport', date: ts }).session).toBe('q1');
      expect(getScheduledMotorsportClaim({ title: 'MotoGP Valencia Q2', category: 'motorsport', date: ts }).session).toBe('q2');
      expect(getScheduledMotorsportClaim({ title: 'F1 Qatar Sprint Qualifying', category: 'motorsport', date: ts }).session).toBe('sprint_qualifying');
      expect(getScheduledMotorsportClaim({ title: 'F1 Qatar Sprint', category: 'motorsport', date: ts }).session).toBe('sprint');
    });

    test('normalizes venue aliases, unaliased consistent circuits, and rejects venue-less or generic-only titles', () => {
      const ts = '2026-11-27T13:30:00Z';
      const lusail = getScheduledMotorsportClaim({ title: 'F1 Lusail Grand Prix', category: 'motorsport', date: ts });
      const qatar = getScheduledMotorsportClaim({ title: 'Formula 1 Qatar Grand Prix', category: 'motorsport', date: ts });
      expect(lusail.venueKey).toBeTruthy();
      expect(lusail.venueKey).toBe(qatar.venueKey);

      const ricardo = getScheduledMotorsportClaim({ title: 'Ricardo Tormo FP1', category: 'motorsport', date: ts });
      const comunitat = getScheduledMotorsportClaim({ title: 'Comunitat Valenciana MotoGP', category: 'motorsport', date: ts });
      expect(ricardo.venueKey).toBeTruthy();
      expect(ricardo.venueKey).toBe(comunitat.venueKey);

      const unaliasedA = getScheduledMotorsportClaim({ title: 'IndyCar Barber Motorsports Park Practice 1', category: 'motorsport', date: ts });
      const unaliasedB = getScheduledMotorsportClaim({ title: 'IndyCar Barber Motorsports Park', category: 'motorsport', date: ts });
      expect(unaliasedA.venueKey).toBeTruthy();
      expect(unaliasedA.venueKey).toBe(unaliasedB.venueKey);

      const noVenue = getScheduledMotorsportClaim({ title: 'Formula 1 - Free Practice', category: 'motorsport', date: ts });
      expect(noVenue.venueKey).toBeNull();

      const genericOnlyA = getScheduledMotorsportClaim({ title: 'Grand Prix Race', category: 'motorsport', date: ts });
      const genericOnlyB = getScheduledMotorsportClaim({ title: 'Grand Prix Qualifying', category: 'motorsport', date: ts });
      expect(genericOnlyA.venueKey).toBeNull();
      expect(genericOnlyB.venueKey).toBeNull();
    });

    test('enforces start-time provenance: rejects missing, synthetic, and date-only; accepts explicit timezone offsets', () => {
      expect(getScheduledMotorsportClaim({ title: 'F1 Qatar FP1', category: 'motorsport', date: '' }).kickoffMs).toBeNull();
      expect(getScheduledMotorsportClaim({ title: 'F1 Qatar FP1', category: 'motorsport', date: 0 }).kickoffMs).toBeNull();

      const syntheticEntity = new MatchEntity({
        id: 'cdn_synth',
        title: 'F1 Qatar FP1',
        category: 'motorsport',
        timestamp: Date.parse('2026-11-27T13:30:00Z'),
        kickoffVerified: false
      });
      expect(getScheduledMotorsportClaim(syntheticEntity).kickoffMs).toBeNull();

      const dateOnlyRaw = getScheduledMotorsportClaim({ title: 'F1 Qatar FP1', category: 'motorsport', date: '2026-11-27' });
      expect(dateOnlyRaw.kickoffMs).toBeNull();

      const dateOnlyEntity = new MatchEntity({
        id: 'cdn_dateonly',
        title: 'F1 Qatar FP1',
        category: 'motorsport',
        date: '2026-11-27'
      });
      expect(getScheduledMotorsportClaim(dateOnlyEntity).kickoffMs).toBeNull();

      const tzOffset = getScheduledMotorsportClaim({
        title: 'F1 Qatar FP1',
        category: 'motorsport',
        date: '2026-11-27T16:30:00+03:00'
      });
      expect(tzOffset.kickoffMs).toBe(Date.parse('2026-11-27T13:30:00Z'));
    });
  });

  describe('Full-Sync Motorsport Session Reconciliation (syncMatches)', () => {
    const runSyncWithProviders = async (providerSets, prevMatches = []) => {
      let saved = [];
      const cacheService = new CacheService();
      cacheService.lastDiskMtime = Date.now() + 100000;
      cacheService.cachedMatches = prevMatches;
      const origSetMatches = cacheService.setMatches.bind(cacheService);
      cacheService.setMatches = (m) => {
        saved = m;
        origSetMatches(m);
      };

      const aggregator = new MatchAggregator({ cacheService });
      aggregator.providers = providerSets.map(({ sourceName, matches, lastScheduleOk }) => ({
        sourceName,
        lastScheduleOk,
        getMatches: async () => matches
      }));
      const results = await aggregator.syncMatches();
      return { results, saved, cacheService };
    };

    const futureIso = (offsetHours = 24) => new Date(Date.now() + offsetHours * 3600 * 1000).toISOString();

    test('merges observed F1 Qatar pair in both provider orders, keeps session title and resolves both IDs', async () => {
      const kickoff = futureIso(20);
      const cdnQatar = new MatchEntity({
        id: 'cdn_qatar_fp1',
        title: 'Formula 1 Qatar Airways Qatar Grand Prix - Practice 1',
        category: 'motorsport',
        league: 'Formula 1',
        timestamp: kickoff,
        sources: [{ source: 'cdnlive', id: 'cdn_q1' }]
      });
      const sportzxQatar = new MatchEntity({
        id: 'sportzx_qatar',
        title: 'Formula 1 Qatar Grand Prix',
        category: 'motorsport',
        league: 'Formula 1',
        timestamp: kickoff,
        sources: [{ source: 'sportzx', id: 'szx_q1' }]
      });

      for (const order of [
        [{ sourceName: 'cdnlive', matches: [cdnQatar] }, { sourceName: 'sportzx', matches: [sportzxQatar] }],
        [{ sourceName: 'sportzx', matches: [sportzxQatar] }, { sourceName: 'cdnlive', matches: [cdnQatar] }]
      ]) {
        const { results, cacheService } = await runSyncWithProviders(order);
        expect(results.length).toBe(1);
        expect(results[0].sources.map(s => s.source).sort()).toEqual(['cdnlive', 'sportzx']);
        expect(results[0].title).toMatch(/Practice 1/i);
        expect(cacheService.findMatch('cdn_qatar_fp1')?.id).toBe(results[0].id);
        expect(cacheService.findMatch('sportzx_qatar')?.id).toBe(results[0].id);
      }
    });

    test('merges observed MotoGP Valencia pair in both provider orders, keeps FP1 title and resolves both IDs', async () => {
      const kickoff = futureIso(22);
      const cdnValencia = new MatchEntity({
        id: 'cdn_valencia_fp1',
        title: 'Ricardo Tormo FP1',
        category: 'motorsport',
        league: '',
        timestamp: kickoff,
        sources: [{ source: 'cdnlive', id: 'cdn_v1' }]
      });
      const sportzxValencia = new MatchEntity({
        id: 'sportzx_valencia',
        title: 'Gran Premio de la Comunitat Valenciana',
        category: 'motorsport',
        league: 'MotoGP',
        timestamp: kickoff,
        sources: [{ source: 'sportzx', id: 'szx_v1' }]
      });

      for (const order of [
        [{ sourceName: 'cdnlive', matches: [cdnValencia] }, { sourceName: 'sportzx', matches: [sportzxValencia] }],
        [{ sourceName: 'sportzx', matches: [sportzxValencia] }, { sourceName: 'cdnlive', matches: [cdnValencia] }]
      ]) {
        const { results, cacheService } = await runSyncWithProviders(order);
        expect(results.length).toBe(1);
        expect(results[0].sources.map(s => s.source).sort()).toEqual(['cdnlive', 'sportzx']);
        expect(results[0].title).toMatch(/FP1/i);
        expect(cacheService.findMatch('cdn_valencia_fp1')?.id).toBe(results[0].id);
        expect(cacheService.findMatch('sportzx_valencia')?.id).toBe(results[0].id);
      }
    });

    test('generalizes to future weekend with different venue, providers, and date', async () => {
      const kickoff = futureIso(48);
      const p1 = new MatchEntity({
        id: 'dlv_suzuka',
        title: 'Formula 1 Japanese Grand Prix',
        category: 'motorsport',
        league: 'Formula 1',
        timestamp: kickoff,
        sources: [{ source: 'daddylive', id: 'dlv_1' }]
      });
      const p2 = new MatchEntity({
        id: 'pit_suzuka_q',
        title: 'Suzuka Qualifying',
        category: 'motorsport',
        league: '',
        timestamp: kickoff,
        sources: [{ source: 'pitsport', id: 'pit_1' }]
      });

      const { results, cacheService } = await runSyncWithProviders([
        { sourceName: 'daddylive', matches: [p1] },
        { sourceName: 'pitsport', matches: [p2] }
      ]);
      expect(results.length).toBe(1);
      expect(results[0].sources.map(s => s.source).sort()).toEqual(['daddylive', 'pitsport']);
      expect(results[0].title).toMatch(/Qualifying/i);
      expect(cacheService.findMatch('dlv_suzuka')?.id).toBe(results[0].id);
      expect(cacheService.findMatch('pit_suzuka_q')?.id).toBe(results[0].id);
    });

    test('warm cache with old split cards does not reintroduce stale split cards or transfer unverified rows', async () => {
      const kickoffMs = Date.now() + 20 * 3600 * 1000;
      const oldSplitCache = [
        {
          id: 'cdn_qatar_fp1',
          title: 'Formula 1 Qatar Airways Qatar Grand Prix - Practice 1',
          category: 'motorsport',
          date: String(kickoffMs), // old cache row without kickoffVerified
          sources: [{ source: 'cdnlive', id: 'cdn_q1' }]
        },
        {
          id: 'dlv_qatar_nosession',
          title: 'Formula 1 Qatar Grand Prix',
          category: 'motorsport',
          date: String(kickoffMs), // old cache row without kickoffVerified or session
          sources: [{ source: 'daddylive', id: 'dlv_q1' }]
        }
      ];

      const freshCdn = new MatchEntity({
        id: 'cdn_qatar_fp1',
        title: 'Formula 1 Qatar Airways Qatar Grand Prix - Practice 1',
        category: 'motorsport',
        league: 'Formula 1',
        timestamp: kickoffMs,
        sources: [{ source: 'cdnlive', id: 'cdn_q1' }]
      });
      const freshSportzx = new MatchEntity({
        id: 'sportzx_qatar',
        title: 'Formula 1 Qatar Grand Prix',
        category: 'motorsport',
        league: 'Formula 1',
        timestamp: kickoffMs,
        sources: [{ source: 'sportzx', id: 'szx_q1' }]
      });

      const { results } = await runSyncWithProviders([
        { sourceName: 'cdnlive', matches: [freshCdn] },
        { sourceName: 'sportzx', matches: [freshSportzx] },
        { sourceName: 'daddylive', matches: [], lastScheduleOk: false }
      ], oldSplitCache);

      // Fresh pair merges into 1 card; old unverified daddylive row (different session) must NOT merge onto p1
      const p1Cards = results.filter(m => m.id === 'cdn_qatar_fp1' || (m.aliasIds || []).includes('cdn_qatar_fp1'));
      expect(p1Cards.length).toBe(1);
      expect(p1Cards[0].sources.map(s => s.source).sort()).toEqual(['cdnlive', 'sportzx']);
    });

    test('keeps MotoGP vs Moto2 vs Moto3, FP1 vs FP2, Race vs FP1, Q1 vs Q2, and Sprint vs Qualifying separate', async () => {
      const t1 = futureIso(24);
      const t2 = futureIso(26);
      const rows = [
        new MatchEntity({ id: 'm_gp', title: 'MotoGP Valencia FP1', category: 'motorsport', timestamp: t1, sources: [{ source: 'cdnlive', id: '1' }] }),
        new MatchEntity({ id: 'm_2', title: 'Moto2 Valencia FP1', category: 'motorsport', timestamp: t1, sources: [{ source: 'sportzx', id: '2' }] }),
        new MatchEntity({ id: 'm_3', title: 'Moto3 Valencia FP1', category: 'motorsport', timestamp: t1, sources: [{ source: 'daddylive', id: '3' }] }),
        new MatchEntity({ id: 'f1_fp2', title: 'F1 Qatar FP2', category: 'motorsport', timestamp: t2, sources: [{ source: 'cdnlive', id: '4' }] }),
        new MatchEntity({ id: 'f1_race', title: 'F1 Qatar Grand Prix Race', category: 'motorsport', timestamp: t2, sources: [{ source: 'sportzx', id: '5' }] }),
        new MatchEntity({ id: 'f1_q1', title: 'F1 Qatar Q1', category: 'motorsport', timestamp: futureIso(30), sources: [{ source: 'cdnlive', id: '6' }] }),
        new MatchEntity({ id: 'f1_q2', title: 'F1 Qatar Q2', category: 'motorsport', timestamp: futureIso(30), sources: [{ source: 'sportzx', id: '7' }] }),
        new MatchEntity({ id: 'f1_sprint', title: 'F1 Qatar Sprint', category: 'motorsport', timestamp: futureIso(34), sources: [{ source: 'daddylive', id: '8' }] }),
        new MatchEntity({ id: 'f1_qual', title: 'F1 Qatar Qualifying', category: 'motorsport', timestamp: futureIso(34), sources: [{ source: 'pitsport', id: '9' }] })
      ];

      const { results } = await runSyncWithProviders([{ sourceName: 'mixed', matches: rows }]);
      expect(results.length).toBe(rows.length);
    });

    test('blocks three-row partial bridge in any provider order', async () => {
      const kickoff = futureIso(24);
      const partialSession = new MatchEntity({
        id: 'p_sess',
        title: 'Ricardo Tormo FP1',
        category: 'motorsport',
        timestamp: kickoff,
        sources: [{ source: 'cdnlive', id: '1' }]
      });
      const partialSeries = new MatchEntity({
        id: 'p_ser',
        title: 'Gran Premio de la Comunitat Valenciana',
        category: 'motorsport',
        league: 'MotoGP',
        timestamp: kickoff,
        sources: [{ source: 'sportzx', id: '2' }]
      });
      const conflictThird = new MatchEntity({
        id: 'p_conf',
        title: 'Moto2 Valencia FP1',
        category: 'motorsport',
        timestamp: kickoff,
        sources: [{ source: 'daddylive', id: '3' }]
      });

      for (const order of [
        [
          { sourceName: 'cdnlive', matches: [partialSession] },
          { sourceName: 'sportzx', matches: [partialSeries] },
          { sourceName: 'daddylive', matches: [conflictThird] }
        ],
        [
          { sourceName: 'daddylive', matches: [conflictThird] },
          { sourceName: 'sportzx', matches: [partialSeries] },
          { sourceName: 'cdnlive', matches: [partialSession] }
        ]
      ]) {
        const { results } = await runSyncWithProviders(order);
        const mergedWithBoth = results.find(m =>
          m.sources.some(s => s.source === 'cdnlive') && m.sources.some(s => s.source === 'sportzx')
        );
        expect(mergedWithBoth).toBeUndefined();
      }
    });

    test('rejects unequal timestamps, different venues, incomplete evidence, synthetic/date-only starts, and conflicting ID/alias hits', async () => {
      const t1 = futureIso(24);
      const t2 = futureIso(25);
      const dateOnly = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

      const { results } = await runSyncWithProviders([
        {
          sourceName: 'cdnlive',
          matches: [
            new MatchEntity({ id: 'unequal_1', title: 'F1 Qatar FP1', category: 'motorsport', timestamp: t1, sources: [{ source: 'cdnlive', id: '1' }] }),
            new MatchEntity({ id: 'diff_venue_1', title: 'F1 Suzuka FP1', category: 'motorsport', timestamp: t1, sources: [{ source: 'cdnlive', id: '2' }] }),
            new MatchEntity({ id: 'incomplete_1', title: 'Silverstone FP1', category: 'motorsport', timestamp: futureIso(40), sources: [{ source: 'cdnlive', id: '3' }] }),
            new MatchEntity({ id: 'synth_1', title: 'F1 Bahrain FP1', category: 'motorsport', timestamp: Date.parse(t1), kickoffVerified: false, sources: [{ source: 'cdnlive', id: '4' }] }),
            new MatchEntity({ id: 'dateonly_1', title: 'F1 Monaco FP1', category: 'motorsport', date: dateOnly, sources: [{ source: 'cdnlive', id: '5' }] }),
            new MatchEntity({ id: 'alias_conflict_1', title: 'F1 Monza FP1', category: 'motorsport', timestamp: futureIso(50), aliasIds: ['alias_conflict_2'], sources: [{ source: 'cdnlive', id: '6' }] })
          ]
        },
        {
          sourceName: 'sportzx',
          matches: [
            new MatchEntity({ id: 'unequal_2', title: 'Formula 1 Qatar Grand Prix', category: 'motorsport', timestamp: t2, sources: [{ source: 'sportzx', id: '7' }] }),
            new MatchEntity({ id: 'diff_venue_2', title: 'Formula 1 Baku Grand Prix', category: 'motorsport', timestamp: t1, sources: [{ source: 'sportzx', id: '8' }] }),
            new MatchEntity({ id: 'incomplete_2', title: 'Silverstone Grand Prix', category: 'motorsport', timestamp: futureIso(40), sources: [{ source: 'sportzx', id: '9' }] }),
            new MatchEntity({ id: 'synth_2', title: 'Formula 1 Bahrain Grand Prix', category: 'motorsport', timestamp: t1, sources: [{ source: 'sportzx', id: '10' }] }),
            new MatchEntity({ id: 'dateonly_2', title: 'Formula 1 Monaco Grand Prix', category: 'motorsport', date: dateOnly, sources: [{ source: 'sportzx', id: '11' }] }),
            new MatchEntity({ id: 'alias_conflict_2', title: 'F1 Monza FP2', category: 'motorsport', timestamp: futureIso(50), sources: [{ source: 'sportzx', id: '12' }] })
          ]
        }
      ]);

      expect(results.length).toBe(12);
    });

    test('generalizes across a full future 2027 multi-series, multi-timezone weekend without cross-session leakage', async () => {
      // Suzuka 2027 F1 weekend: JST (+09:00) vs UTC (Z)
      const suzukaFp1Utc = '2027-04-02T02:30:00Z';
      const suzukaFp1Jst = '2027-04-02T11:30:00+09:00';
      const suzukaFp2Utc = '2027-04-02T06:00:00Z';
      const suzukaQualiUtc = '2027-04-03T06:00:00Z';
      const suzukaRaceUtc = '2027-04-04T05:00:00Z';

      // Mugello 2027 MotoGP / Moto2 / Moto3 weekend (different kickoffs)
      const mugelloMotoGpQ = '2027-06-19T08:50:00Z';
      const mugelloMoto3Q = '2027-06-19T10:50:00Z';
      const mugelloMoto2Q = '2027-06-19T11:45:00Z';

      // Unaliased circuit: Barber Motorsports Park (IndyCar 2027)
      const barberFp1 = '2027-05-01T15:00:00Z';

      const { results, cacheService } = await runSyncWithProviders([
        {
          sourceName: 'cdnlive',
          matches: [
            new MatchEntity({ id: 'cdn_suz_fp1', title: 'Suzuka FP1', category: 'motorsport', timestamp: suzukaFp1Jst, sources: [{ source: 'cdnlive', id: 'c1' }] }),
            new MatchEntity({ id: 'cdn_suz_fp2', title: 'Suzuka FP2', category: 'motorsport', timestamp: suzukaFp2Utc, sources: [{ source: 'cdnlive', id: 'c2' }] }),
            new MatchEntity({ id: 'cdn_mug_gp', title: 'Mugello Qualifying', category: 'motorsport', timestamp: mugelloMotoGpQ, sources: [{ source: 'cdnlive', id: 'c3' }] }),
            new MatchEntity({ id: 'cdn_mug_m3', title: 'Moto3 Mugello Qualifying', category: 'motorsport', timestamp: mugelloMoto3Q, sources: [{ source: 'cdnlive', id: 'c4' }] }),
            new MatchEntity({ id: 'cdn_barber', title: 'Barber Motorsports Park Practice 1', category: 'motorsport', timestamp: barberFp1, sources: [{ source: 'cdnlive', id: 'c5' }] })
          ]
        },
        {
          sourceName: 'sportzx',
          matches: [
            new MatchEntity({ id: 'szx_suz_fp1', title: 'Formula 1 Japanese Grand Prix', category: 'motorsport', league: 'Formula 1', timestamp: suzukaFp1Utc, sources: [{ source: 'sportzx', id: 's1' }] }),
            new MatchEntity({ id: 'szx_suz_q', title: 'Formula 1 Japanese Grand Prix Qualifying', category: 'motorsport', league: 'Formula 1', timestamp: suzukaQualiUtc, sources: [{ source: 'sportzx', id: 's2' }] }),
            new MatchEntity({ id: 'szx_suz_r', title: 'Formula 1 Japanese Grand Prix - Race', category: 'motorsport', league: 'Formula 1', timestamp: suzukaRaceUtc, sources: [{ source: 'sportzx', id: 's3' }] }),
            new MatchEntity({ id: 'szx_mug_gp', title: 'Gran Premio d\'Italia Mugello', category: 'motorsport', league: 'MotoGP', timestamp: mugelloMotoGpQ, sources: [{ source: 'sportzx', id: 's4' }] }),
            new MatchEntity({ id: 'szx_mug_m2', title: 'Moto2 Mugello Qualifying', category: 'motorsport', timestamp: mugelloMoto2Q, sources: [{ source: 'sportzx', id: 's5' }] }),
            new MatchEntity({ id: 'szx_barber', title: 'IndyCar Barber Motorsports Park', category: 'motorsport', league: 'IndyCar', timestamp: barberFp1, sources: [{ source: 'sportzx', id: 's6' }] })
          ]
        }
      ]);

      // 8 distinct sessions total:
      // 1. Suzuka FP1 (merged: cdnlive + sportzx)
      // 2. Suzuka FP2 (cdnlive)
      // 3. Suzuka Qualifying (sportzx)
      // 4. Suzuka Race (sportzx)
      // 5. Mugello MotoGP Qualifying (merged: cdnlive + sportzx)
      // 6. Mugello Moto3 Qualifying (cdnlive)
      // 7. Mugello Moto2 Qualifying (sportzx)
      // 8. Barber Motorsports Park Practice 1 (merged: cdnlive + sportzx)
      expect(results.length).toBe(8);

      const suzFp1Card = cacheService.findMatch('szx_suz_fp1');
      expect(suzFp1Card).not.toBeNull();
      expect(suzFp1Card.id).toBe(cacheService.findMatch('cdn_suz_fp1')?.id);
      expect(suzFp1Card.sources.map(s => s.source).sort()).toEqual(['cdnlive', 'sportzx']);
      expect(suzFp1Card.title).toMatch(/FP1/i);

      const mugGpCard = cacheService.findMatch('szx_mug_gp');
      expect(mugGpCard).not.toBeNull();
      expect(mugGpCard.id).toBe(cacheService.findMatch('cdn_mug_gp')?.id);
      expect(mugGpCard.sources.map(s => s.source).sort()).toEqual(['cdnlive', 'sportzx']);
      expect(mugGpCard.title).toMatch(/Qualifying/i);

      const barberCard = cacheService.findMatch('szx_barber');
      expect(barberCard).not.toBeNull();
      expect(barberCard.id).toBe(cacheService.findMatch('cdn_barber')?.id);
      expect(barberCard.sources.map(s => s.source).sort()).toEqual(['cdnlive', 'sportzx']);
      expect(barberCard.title).toMatch(/Practice 1/i);
    });

    test('merges third provider with explicit series/session and slight kickoff offset into resolved Valencia FP1 card', async () => {
      const kickoff = futureIso(22);
      const offsetKickoff = new Date(Date.parse(kickoff) + 15 * 60 * 1000).toISOString();

      const cdn = new MatchEntity({
        id: 'cdn_2568496',
        title: 'Valencia Free Practice 1',
        category: 'motorsport',
        timestamp: kickoff,
        sources: [{ source: 'cdnlive', id: '2568496' }]
      });
      const sportzx = new MatchEntity({
        id: 'sportzx_valencia_gp',
        title: 'Gran Premio de la Comunitat Valenciana',
        category: 'motorsport',
        league: 'MotoGP',
        timestamp: kickoff,
        sources: [{ source: 'sportzx', id: 'szx_v1' }]
      });
      const daddylive = new MatchEntity({
        id: 'dlv_valencia_fp1',
        title: 'Round 22 | Valencia Practice 1',
        category: 'motorsport',
        league: '️ MotoGP',
        timestamp: offsetKickoff,
        sources: [{ source: 'daddylive', id: 'dlv_v1' }]
      });

      const { results } = await runSyncWithProviders([
        { sourceName: 'cdnlive', matches: [cdn] },
        { sourceName: 'sportzx', matches: [sportzx] },
        { sourceName: 'daddylive', matches: [daddylive] }
      ]);

      expect(results.length).toBe(1);
      expect(results[0].sources.map(s => s.source).sort()).toEqual(['cdnlive', 'daddylive', 'sportzx']);
    });
  });
});
