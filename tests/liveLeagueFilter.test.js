const {
  parseLiveLeagues,
  matchesLiveLeague,
  normalizeLeagueName,
  LIVE_LEAGUE_GROUPS,
} = require('../src/services/LiveLeagueFilter');

describe('LiveLeagueFilter', () => {
  describe('normalizeLeagueName', () => {
    test('folds case and accents, removes punctuation, collapses whitespace', () => {
      expect(normalizeLeagueName('  COPA   do Brasil  ')).toBe('copa do brasil');
      expect(normalizeLeagueName('Brasileirão Série A')).toBe('brasileirao serie a');
      expect(normalizeLeagueName("Copa d'Été, Série A")).toBe('copa d ete serie a');
      expect(normalizeLeagueName('2. Bundesliga')).toBe('2 bundesliga');
      expect(normalizeLeagueName('LaLiga 2')).toBe('laliga 2');
    });
  });

  describe('parseLiveLeagues', () => {
    test('returns null for omitted or structurally invalid values', () => {
      expect(parseLiveLeagues(undefined)).toBeNull();
      expect(parseLiveLeagues(null)).toBeNull();
      expect(parseLiveLeagues('')).toBeNull();
      expect(parseLiveLeagues(123)).toBeNull();
      expect(parseLiveLeagues(true)).toBeNull();
      expect(parseLiveLeagues([])).toBeNull();
      expect(parseLiveLeagues('invalid')).toBeNull();
      expect(parseLiveLeagues({})).toBeNull();
    });

    test('preserves deliberate empty selection', () => {
      const parsed = parseLiveLeagues({ ids: [], custom: [], other: false });
      expect(parsed).toEqual({ ids: [], custom: [], other: false });
    });

    test('sanitizes valid IDs and ignores unknown IDs', () => {
      const parsed = parseLiveLeagues({
        ids: ['epl', 'unknown-league', 'la-liga', 'epl'],
        other: true,
      });
      expect(parsed.ids).toEqual(['epl', 'la-liga']);
      expect(parsed.other).toBe(true);
      expect(parsed.custom).toEqual([]);
    });

    test('sanitizes custom names: trims, dedupes, limits to 12 names of 60 chars', () => {
      const longName = 'a'.repeat(70);
      const parsed = parseLiveLeagues({
        ids: ['epl'],
        custom: [
          '  Copa do Brasil  ',
          'copa do brasil', // duplicate when normalized
          '   ', // empty when normalized
          longName, // should truncate or reject (> 60 chars)
          'Premier League', // duplicates curated label -> rejected
          'EPL', // duplicates curated alias -> rejected
          'Custom League 1',
          'Custom League 2',
        ],
        other: false,
      });
      expect(parsed.ids).toEqual(['epl']);
      expect(parsed.custom).toContain('Copa do Brasil');
      expect(parsed.custom).not.toContain('Premier League');
      expect(parsed.custom).not.toContain('EPL');
      // duplicate 'copa do brasil' ignored
      const normalizedCustom = parsed.custom.map(c => normalizeLeagueName(c));
      const uniqueNormalized = new Set(normalizedCustom);
      expect(normalizedCustom.length).toBe(uniqueNormalized.size);
      // verify max 12
      const many = Array.from({ length: 20 }, (_, i) => `Custom Cup ${i}`);
      const parsedMany = parseLiveLeagues({ ids: [], custom: many, other: false });
      expect(parsedMany.custom.length).toBeLessThanOrEqual(12);
    });
  });

  describe('matchesLiveLeague', () => {
    // 1. Football, English Premier League | epl | included
    test('Football, English Premier League with epl selected is included', () => {
      const selection = parseLiveLeagues({ ids: ['epl'], custom: [], other: false });
      const fixture = { category: 'football', league: 'English Premier League', title: 'Liverpool vs Chelsea' };
      expect(matchesLiveLeague(fixture, selection)).toBe(true);
    });

    // 2. Football, Tanzanian Premier League | epl | excluded
    test('Football, Tanzanian Premier League with epl selected is excluded', () => {
      const selection = parseLiveLeagues({ ids: ['epl'], custom: [], other: false });
      const fixture = { category: 'football', league: 'Tanzanian Premier League', title: 'Simba vs Yanga' };
      expect(matchesLiveLeague(fixture, selection)).toBe(false);
    });

    // 3. Football, LaLiga 2 | la-liga | excluded
    test('Football, LaLiga 2 with la-liga selected is excluded', () => {
      const selection = parseLiveLeagues({ ids: ['la-liga'], custom: [], other: false });
      const fixture = { category: 'football', league: 'LaLiga 2', title: 'Real Oviedo vs Sporting Gijon' };
      expect(matchesLiveLeague(fixture, selection)).toBe(false);
    });

    // 4. Basketball, WNBA | nba | excluded
    test('Basketball, WNBA with nba selected is excluded', () => {
      const selection = parseLiveLeagues({ ids: ['nba'], custom: [], other: false });
      const fixture = { category: 'basketball', league: 'WNBA', title: 'Aces vs Liberty' };
      expect(matchesLiveLeague(fixture, selection)).toBe(false);
    });

    // 5. Basketball, NBA Playoffs | nba | included
    test('Basketball, NBA Playoffs with nba selected is included', () => {
      const selection = parseLiveLeagues({ ids: ['nba'], custom: [], other: false });
      const fixture = { category: 'basketball', league: 'NBA Playoffs', title: 'Celtics vs Pacers' };
      expect(matchesLiveLeague(fixture, selection)).toBe(true);
    });

    // 6. Football, missing league, UEFA Champions League: Arsenal vs Inter | ucl | included
    test('Football, missing league, UEFA Champions League: Arsenal vs Inter with ucl selected is included', () => {
      const selection = parseLiveLeagues({ ids: ['ucl'], custom: [], other: false });
      const fixture = { category: 'football', league: '', title: 'UEFA Champions League: Arsenal vs Inter' };
      expect(matchesLiveLeague(fixture, selection)).toBe(true);
    });

    // 7. Football, missing league, Arsenal vs Inter | ucl | excluded
    test('Football, missing league, Arsenal vs Inter with ucl selected is excluded', () => {
      const selection = parseLiveLeagues({ ids: ['ucl'], custom: [], other: false });
      const fixture = { category: 'football', league: '', title: 'Arsenal vs Inter' };
      expect(matchesLiveLeague(fixture, selection)).toBe(false);
    });

    // 8. Football, UEFA Europa League, title containing UEFA Champions League: | ucl | excluded
    test('Football, UEFA Europa League, title containing UEFA Champions League: with ucl selected is excluded', () => {
      const selection = parseLiveLeagues({ ids: ['ucl'], custom: [], other: false });
      const fixture = { category: 'football', league: 'UEFA Europa League', title: 'UEFA Champions League: Roma vs Ajax' };
      expect(matchesLiveLeague(fixture, selection)).toBe(false);
    });

    // 9. Football, Copa do Brasil | custom '  COPA do Brasil  ' | included
    test('Football, Copa do Brasil with custom "  COPA do Brasil  " is included', () => {
      const selection = parseLiveLeagues({ ids: [], custom: ['  COPA do Brasil  '], other: false });
      const fixture = { category: 'football', league: 'Copa do Brasil', title: 'Flamengo vs Corinthians' };
      expect(matchesLiveLeague(fixture, selection)).toBe(true);
    });

    // 10. Football, Copa do Brasil U20 | custom 'Copa do Brasil' | excluded
    test('Football, Copa do Brasil U20 with custom "Copa do Brasil" is excluded', () => {
      const selection = parseLiveLeagues({ ids: [], custom: ['Copa do Brasil'], other: false });
      const fixture = { category: 'football', league: 'Copa do Brasil U20', title: 'Flamengo U20 vs Corinthians U20' };
      expect(matchesLiveLeague(fixture, selection)).toBe(false);
    });

    // 11. Basketball, NBA | Other only | excluded
    test('Basketball, NBA with Other only is excluded (known curated competition)', () => {
      const selection = parseLiveLeagues({ ids: [], custom: [], other: true });
      const fixture = { category: 'basketball', league: 'NBA', title: 'Lakers vs Warriors' };
      expect(matchesLiveLeague(fixture, selection)).toBe(false);
    });

    // 12. Football, unknown league or no competition label | Other only | included
    test('Football, unknown league or no competition label with Other only is included', () => {
      const selection = parseLiveLeagues({ ids: [], custom: [], other: true });
      const fixtureUnknown = { category: 'football', league: 'Mongolian National League', title: 'FC Ulaanbaatar vs SP Falcons' };
      expect(matchesLiveLeague(fixtureUnknown, selection)).toBe(true);

      const fixtureNoLabel = { category: 'football', league: '', title: 'Team A vs Team B' };
      expect(matchesLiveLeague(fixtureNoLabel, selection)).toBe(true);
    });

    // 13. Selection omitted, structurally invalid, or explicitly empty | any fixture
    test('Selection omitted or invalid includes any fixture; explicit empty excludes', () => {
      const fixture = { category: 'football', league: 'English Premier League', title: 'Liverpool vs Chelsea' };
      expect(matchesLiveLeague(fixture, null)).toBe(true);
      expect(matchesLiveLeague(fixture, undefined)).toBe(true);

      const emptySelection = parseLiveLeagues({ ids: [], custom: [], other: false });
      expect(matchesLiveLeague(fixture, emptySelection)).toBe(false);
    });

    test('consults title after final spaced dash when league is missing or generic sport', () => {
      const selection = parseLiveLeagues({ ids: ['ucl'], custom: [], other: false });
      const fixtureDashed = { category: 'football', league: 'Football', title: 'Arsenal vs Inter - UEFA Champions League' };
      expect(matchesLiveLeague(fixtureDashed, selection)).toBe(true);
    });

    test('college category requires sport-specific alias', () => {
      const nflSelection = parseLiveLeagues({ ids: ['college-football'], custom: [], other: false });
      // Category is college, league has College Football -> matches college-football
      const fixtureNcaaFb = { category: 'college', league: 'NCAA Football', title: 'Alabama vs Georgia' };
      expect(matchesLiveLeague(fixtureNcaaFb, nflSelection)).toBe(true);

      // Generic "College" without sport-specific alias does not match
      const fixtureGeneric = { category: 'college', league: 'College', title: 'School A vs School B' };
      expect(matchesLiveLeague(fixtureGeneric, nflSelection)).toBe(false);
    });

    test('removed or unchecked custom names can still appear through Other', () => {
      const selection = parseLiveLeagues({ ids: [], custom: [], other: true });
      const fixtureCustom = { category: 'football', league: 'Some Custom Cup', title: 'Team A vs Team B' };
      expect(matchesLiveLeague(fixtureCustom, selection)).toBe(true);
    });
  });

  describe('LIVE_LEAGUE_GROUPS registry', () => {
    test('contains all 12 groups with stable IDs', () => {
      expect(LIVE_LEAGUE_GROUPS).toBeDefined();
      expect(LIVE_LEAGUE_GROUPS.length).toBe(12);

      const allIds = LIVE_LEAGUE_GROUPS.flatMap(g => g.options.map(o => o.id));
      expect(new Set(allIds).size).toBe(allIds.length); // all IDs unique

      // Check pinned IDs
      expect(allIds).toContain('epl');
      expect(allIds).toContain('la-liga');
      expect(allIds).toContain('nba');
      expect(allIds).toContain('ucl');
    });
  });
});
