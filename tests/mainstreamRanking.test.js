'use strict';

/**
 * Unit tests for MainstreamRankingService and its wiring into the catalog
 * comparator.
 *
 * Fully offline and deterministic: no provider, no cache, no clock beyond
 * `Date.now()` for relative kickoff offsets.
 */

const {
  TIER,
  getMatchTier,
  isLowerDivisionFixture,
  hasMainstreamSource,
  explainMatch,
  MAINSTREAM_SOURCE_IDS
} = require('../src/services/MainstreamRankingService');

const { compareCatalogMatches } = require('../src/catalog');

// ── Fixture builders ────────────────────────────────────────────────────────

const MINUTE = 60 * 1000;
const ago = (ms) => String(Date.now() - ms);
const ahead = (ms) => String(Date.now() + ms);

const match = (overrides = {}) => ({
  id: overrides.id || 'test-id',
  title: overrides.title || 'Team A vs Team B',
  category: overrides.category || 'football',
  league: 'league' in overrides ? overrides.league : '',
  date: 'date' in overrides ? overrides.date : ago(30 * MINUTE),
  popular: overrides.popular || '0',
  sources: 'sources' in overrides ? overrides.sources : [{ source: 'daddylive', id: 'x' }],
  ...('team1' in overrides ? { team1: overrides.team1 } : {}),
  ...('team2' in overrides ? { team2: overrides.team2 } : {})
});

const liveOnce = (o) => match({ ...o, date: ago(30 * MINUTE) });

// ── Classifier ──────────────────────────────────────────────────────────────

describe('getMatchTier - mainstream signals', () => {
  it('promotes a top-tier league', () => {
    const m = liveOnce({ title: 'Real Betis vs Villarreal', league: 'La Liga' });
    expect(getMatchTier(m)).toBe(TIER.MAINSTREAM);
    expect(explainMatch(m)).toBe('top-tier-competition');
  });

  it('promotes a globally famous club even without a league label', () => {
    const m = liveOnce({ title: 'Fulham vs Manchester United', league: '' });
    expect(getMatchTier(m)).toBe(TIER.MAINSTREAM);
  });

  it('promotes a Streamed.pk source', () => {
    const m = liveOnce({
      title: 'Some Unlabelled Fixture',
      league: '',
      sources: [{ source: 'streamedpk', id: 'spk_1' }]
    });
    expect(getMatchTier(m)).toBe(TIER.MAINSTREAM);
    expect(explainMatch(m)).toBe('mainstream-source');
  });

  it('promotes a major-league category by construction', () => {
    const m = liveOnce({ title: 'Team A vs Team B', category: 'basketball', league: '' });
    expect(getMatchTier(m)).toBe(TIER.MAINSTREAM);
  });
});

describe('getMatchTier - demotion', () => {
  it('demotes an explicit second division', () => {
    const m = liveOnce({ title: 'Real Zaragoza vs Sporting Gijon', league: 'La Liga 2' });
    expect(getMatchTier(m)).toBe(TIER.MINOR);
    expect(isLowerDivisionFixture(m)).toBe(true);
  });

  it('demotes other second tiers across the big leagues', () => {
    const cases = [
      { title: 'X vs Y', league: 'Serie B' },
      { title: 'X vs Y', league: 'Ligue 2' },
      { title: 'X vs Y', league: '2. Bundesliga' },
      { title: 'X vs Y', league: 'EFL League One' },
      { title: 'X vs Y', league: 'Segunda Division' }
    ];
    for (const c of cases) {
      expect(getMatchTier(liveOnce(c))).toBe(TIER.MINOR);
    }
  });

  it('demotes reserve / youth sides even for a famous club', () => {
    expect(getMatchTier(liveOnce({ title: 'Real Madrid Castilla vs X', league: '' }))).toBe(TIER.MINOR);
    expect(isLowerDivisionFixture(liveOnce({ title: 'Ajax Reserves vs X', league: '' }))).toBe(true);
  });

  it('does NOT promote a famous club whose fixture is a reserve side', () => {
    // The lookahead must stop "Barcelona B" inheriting Barcelona's fame.
    expect(getMatchTier(liveOnce({ title: 'Barcelona B vs X', league: '' }))).not.toBe(TIER.MAINSTREAM);
  });

  it('keeps an unambiguous lower division minor even with a Streamed.pk source', () => {
    // Regression for the user's report: Streamed.pk carries a few second-tier
    // games, and demotion must beat the source signal.
    const m = liveOnce({
      title: 'Real Zaragoza vs Sporting Gijon',
      league: 'La Liga 2',
      sources: [{ source: 'streamedpk', id: 'spk_2' }]
    });
    expect(hasMainstreamSource(m)).toBe(true);
    expect(getMatchTier(m)).toBe(TIER.MINOR);
    expect(explainMatch(m)).toBe('lower-division-marker');
  });

  it('does not misread a global competition named "Championship" as a second tier', () => {
    const m = liveOnce({ title: 'World Rally Championship 2026', category: 'motorsport', league: '' });
    expect(isLowerDivisionFixture(m)).toBe(false);
    expect(getMatchTier(m)).toBe(TIER.MAINSTREAM);
  });

  it('does not demote a US top-tier league that shares a lower-division name', () => {
    // "National League" is English tier 5 but a TOP-tier name in US baseball.
    const m = liveOnce({
      title: 'New York Mets vs Philadelphia Phillies',
      category: 'baseball',
      league: 'MLB National League',
      sources: [{ source: 'streamedpk', id: 'spk_3' }]
    });
    expect(isLowerDivisionFixture(m)).toBe(false);
    expect(getMatchTier(m)).toBe(TIER.MAINSTREAM);
  });
});

describe('getMatchTier - robustness', () => {
  it('is NEUTRAL when there is no signal', () => {
    const m = liveOnce({ title: 'Local Team vs Other Team', league: '', category: 'football' });
    expect(getMatchTier(m)).toBe(TIER.NEUTRAL);
    expect(explainMatch(m)).toBe('no-signal');
  });

  it('tolerates missing league, sources and date', () => {
    expect(getMatchTier({ title: 'A vs B', category: 'football' })).toBe(TIER.NEUTRAL);
    expect(getMatchTier({ title: 'A vs B', category: 'football', league: undefined, sources: undefined, date: undefined })).toBe(TIER.NEUTRAL);
    expect(() => getMatchTier({})).not.toThrow();
    expect(getMatchTier(null)).toBe(TIER.NEUTRAL);
    expect(getMatchTier(undefined)).toBe(TIER.NEUTRAL);
  });

  it('accepts an object-shaped or missing league without throwing', () => {
    expect(() => getMatchTier(liveOnce({ title: 'A vs B', league: { name: 'La Liga' } }))).not.toThrow();
  });

  it('exposes the mainstream source set as data', () => {
    expect(MAINSTREAM_SOURCE_IDS.has('streamedpk')).toBe(true);
  });
});

// ── Sport-specific feeder leagues ───────────────────────────────────────────

describe('getMatchTier - sport-specific lower tiers', () => {
  it('demotes minor-league hockey inside the hockey category', () => {
    expect(getMatchTier(liveOnce({ title: 'Omaha Lancers vs Madison Capitols', category: 'hockey', league: 'USHL' }))).toBe(TIER.MINOR);
    expect(getMatchTier(liveOnce({ title: 'Toronto Marlies vs Utica Comets', category: 'hockey', league: 'AHL' }))).toBe(TIER.MINOR);
  });

  it('keeps a top-tier hockey league mainstream', () => {
    expect(getMatchTier(liveOnce({ title: 'Boston Bruins vs Washington Capitals', category: 'hockey', league: 'NHL' }))).toBe(TIER.MAINSTREAM);
  });

  it('demotes the NBA development league but keeps the NBA mainstream', () => {
    expect(getMatchTier(liveOnce({ title: 'X vs Y', category: 'basketball', league: 'NBA G League' }))).toBe(TIER.MINOR);
    expect(getMatchTier(liveOnce({ title: 'Indiana Fever vs Washington Mystics', category: 'basketball', league: 'WNBA' }))).toBe(TIER.MAINSTREAM);
  });

  it('demotes minor-league baseball but keeps MLB mainstream', () => {
    expect(getMatchTier(liveOnce({ title: 'X vs Y', category: 'baseball', league: 'MiLB Triple A' }))).toBe(TIER.MINOR);
    expect(getMatchTier(liveOnce({ title: 'San Diego Padres vs Miami Marlins', category: 'baseball', league: 'MLB' }))).toBe(TIER.MAINSTREAM);
  });

  it('demotes alternate pro football leagues but keeps the NFL mainstream', () => {
    expect(getMatchTier(liveOnce({ title: 'X vs Y', category: 'american_football', league: 'XFL' }))).toBe(TIER.MINOR);
    expect(getMatchTier(liveOnce({ title: 'Dallas Cowboys vs Washington Commanders', category: 'american_football', league: 'NFL' }))).toBe(TIER.MAINSTREAM);
  });

  it('demotes tennis challengers but keeps the main tour mainstream', () => {
    expect(getMatchTier(liveOnce({ title: 'X vs Y', category: 'tennis', league: 'ATP Challenger' }))).toBe(TIER.MINOR);
    expect(getMatchTier(liveOnce({ title: 'Diego Duran vs Jaime Faria', category: 'tennis', league: 'Davis Cup' }))).toBe(TIER.MAINSTREAM);
  });

  it('does not let a sport-specific marker leak into another sport', () => {
    // "League One" is a hockey-agnostic global marker, but "AHL" must not
    // demote a football fixture, and "G League" must not demote hockey.
    expect(getMatchTier(liveOnce({ title: 'A vs B', category: 'football', league: 'AHL' }))).not.toBe(TIER.MINOR);
    expect(getMatchTier(liveOnce({ title: 'A vs B', category: 'hockey', league: 'G League' }))).not.toBe(TIER.MINOR);
  });

  it('leaves a sport with no marker list at its previous behaviour', () => {
    // Rugby is not in SPORT_SECONDARY_MARKERS, so a domestic league stays neutral.
    expect(getMatchTier(liveOnce({ title: 'Taranaki vs Southland', category: 'rugby', league: 'National Provincial Championship' }))).toBe(TIER.NEUTRAL);
  });
});

// ── Comparator (real exported function) ─────────────────────────────────────

describe('compareCatalogMatches - ordering contract', () => {
  it('puts a mainstream fixture above a lower-division fixture', () => {
    const mainstream = liveOnce({ title: 'Real Madrid vs Barcelona', league: 'La Liga' });
    const local = liveOnce({ title: 'Real Zaragoza vs Sporting Gijon', league: 'La Liga 2' });

    const sorted = [local, mainstream].sort((a, b) => compareCatalogMatches(a, b, false));
    expect(sorted[0].title).toBe('Real Madrid vs Barcelona');
  });

  it('ranks the mainstream tier ABOVE the popular flag', () => {
    // Decisive key-order test: the minor fixture is popular='1' and the
    // mainstream one is popular='0'. Tier must win.
    const mainstream = liveOnce({ title: 'Real Madrid vs Barcelona', league: 'La Liga', popular: '0' });
    const local = liveOnce({ title: 'Real Zaragoza vs Sporting Gijon', league: 'La Liga 2', popular: '1' });

    const sorted = [local, mainstream].sort((a, b) => compareCatalogMatches(a, b, false));
    expect(sorted[0].title).toBe('Real Madrid vs Barcelona');
    expect(sorted[0].popular).toBe('0');
  });

  it('keeps a real fixture above a 24/7 network', () => {
    const network = match({
      title: 'Willow Cricket',
      category: 'networks',
      date: '',
      popular: '1',
      sources: [{ source: 'cdnlive', id: '1' }]
    });
    const fixture = liveOnce({ title: 'Fulham vs Manchester United', league: 'Premier League', popular: '0' });

    const sorted = [network, fixture].sort((a, b) => compareCatalogMatches(a, b, false));
    expect(sorted[0].title).toBe('Fulham vs Manchester United');
  });

  it('still puts live before upcoming', () => {
    const live = liveOnce({ title: 'Real Madrid vs Barcelona', league: 'La Liga' });
    const upcoming = match({ title: 'Arsenal vs Chelsea', league: 'Premier League', date: ahead(60 * MINUTE) });

    const sorted = [upcoming, live].sort((a, b) => compareCatalogMatches(a, b, false));
    expect(sorted[0].title).toBe('Real Madrid vs Barcelona');
  });

  it('still falls through to popular within the same tier', () => {
    const popular = liveOnce({ title: 'Real Madrid vs Barcelona', league: 'La Liga', popular: '1' });
    const notPopular = liveOnce({ title: 'Sevilla vs Valencia', league: 'La Liga', popular: '0' });

    const sorted = [notPopular, popular].sort((a, b) => compareCatalogMatches(a, b, false));
    expect(sorted[0].popular).toBe('1');
  });

  it('orders upcoming within the same tier by nearest kickoff first', () => {
    const sooner = match({ title: 'Arsenal vs Chelsea', league: 'Premier League', date: ahead(30 * MINUTE) });
    const later = match({ title: 'Liverpool vs Everton', league: 'Premier League', date: ahead(180 * MINUTE) });

    const sorted = [later, sooner].sort((a, b) => compareCatalogMatches(a, b, false));
    expect(sorted[0].title).toBe('Arsenal vs Chelsea');
  });

  it('does not throw on missing league, sources or date', () => {
    const a = { id: 'a', title: 'Alpha vs Beta', category: 'football' };
    const b = { id: 'b', title: 'Gamma vs Delta', category: 'football', league: undefined, sources: undefined, date: undefined };
    expect(() => [a, b].sort((x, y) => compareCatalogMatches(x, y, false))).not.toThrow();
  });
});
