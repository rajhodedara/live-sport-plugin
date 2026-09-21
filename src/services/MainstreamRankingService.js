'use strict';

/**
 * MainstreamRankingService
 *
 * Answers one question, offline and deterministically: "is this event a
 * mainstream fixture, a minor / lower-division fixture, or neither?"
 *
 * Why this exists: `popular` cannot separate the two. Streamed.pk flags ~76 of
 * its ~98 events as `popular: true`, and it exposes no `league` field at all,
 * so a second-division fixture and a Champions League tie arrive looking
 * identical to the catalog comparator. The catalog therefore needs a signal of
 * its own, derived from the text the providers already give us.
 *
 * The classifier is pure: no I/O, no clock, no randomness, no dependencies. It
 * only reads `league`, `title`, `team1.name`, `team2.name`, `category` and
 * `sources`. Every keyword list below is data, so extending the classifier is a
 * one-line edit rather than a code change.
 *
 * Three tiers, lower sorts first:
 *   MAINSTREAM (0) - top-tier competition / globally famous club / mainline
 *                    source / category that is major-league by construction
 *   NEUTRAL    (1) - no signal either way; leave the existing ordering alone
 *   MINOR      (2) - explicit lower-division, reserve/youth or regional marker
 *
 * MINOR deliberately beats MAINSTREAM for the same event: Streamed.pk does
 * carry a handful of second-tier fixtures, and a merged event can pick up a
 * Streamed.pk stream while its `league` still says "La Liga 2".
 */

// Lower tier value = higher priority in the comparator.
const TIER = Object.freeze({
  MAINSTREAM: 0,
  NEUTRAL: 1,
  MINOR: 2
});

/**
 * Folds provider text into a canonical comparison form:
 *   - diacritics stripped ("Série B" -> "serie b", "Atlético" -> "atletico")
 *   - lower-cased
 *   - every run of non-alphanumerics collapsed to a single space
 *
 * Using an accent-free, punctuation-free form means each pattern only has to be
 * written once. "2. Bundesliga", "U-21" and "LaLiga Hypermotion" all become
 * plain space-separated words before matching.
 */
function fold(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Top-tier competitions. Matched against league + title + team names after
 * folding, e.g. "UEFA Champions League" -> "uefa champions league".
 *
 * Every entry here is a competition whose presence means the fixture is a
 * mainstream one, world-wide. Note that a *lower* division of the same
 * competition belongs in LOWER_DIVISION_MARKERS instead, and that list wins -
 * so "Bundesliga" here plus "2 Bundesliga" there resolves to minor, and
 * "La Liga" here plus "La Liga 2" there resolves to minor too.
 */
const TOP_TIER_COMPETITIONS = [
  // Football - European club competitions
  /\bpremier league\b/, /\bpremiership\b/, /\bchampions league\b/, /\beuropa league\b/,
  /\bconference league\b/, /\bclub world cup\b/,
  // Football - top domestic leagues
  /\bla liga\b/, /\blaliga\b/, /\bprimera division\b/, /\bserie a\b/, /\bbundesliga\b/,
  /\bligue 1\b/, /\beredivisie\b/, /\bprimeira liga\b/, /\bcampeonato brasileiro\b/,
  /\bbrasileirao\b/, /\bliga mx\b/, /\bmls\b/, /\bmajor league soccer\b/,
  /\bsaudi pro league\b/, /\bsuper lig\b/, /\bindian super league\b/,
  // Football - continental / international
  /\blibertadores\b/, /\bcopa libertadores\b/, /\bcopa america\b/, /\bworld cup\b/,
  /\beuropean championship\b/, /\bnations league\b/, /\bafcon\b/,
  /\bafrica cup of nations\b/, /\bfa cup\b/, /\bcopa del rey\b/,
  // North American major leagues
  /\bnba\b/, /\bnfl\b/, /\bmlb\b/, /\bnhl\b/, /\bwnba\b/, /\bncaa\b/,
  // Combat sports
  /\bufc\b/,
  // Motorsport / global events
  /\bformula 1\b/, /\bf1\b/, /\bmotogp\b/, /\bgrand prix\b/, /\bworld championship\b/,
  // Tennis majors / Olympics
  /\bwimbledon\b/, /\bus open\b/, /\baustralian open\b/, /\bfrench open\b/, /\bolympic\b/,
  // International team events from other sports
  /\bdavis cup\b/, /\bbillie jean king cup\b/, /\btop 14\b/, /\bsix nations\b/
];

/**
 * Globally famous clubs. Deliberately football-first: that is where the
 * mainstream / lower-division confusion lives, and the major US leagues are
 * already covered wholesale by MAJOR_LEAGUE_CATEGORIES below.
 *
 * Matched on a word boundary against league + title + both team names, with a
 * guard that refuses reserve sides ("Barcelona B", "Real Madrid Castilla",
 * "Ajax Reserves") - the club name is famous but the fixture is not.
 */
const FAMOUS_CLUBS = [
  // Spain
  'real madrid', 'barcelona', 'atletico madrid', 'atletico de madrid', 'sevilla',
  'real betis', 'valencia', 'villarreal', 'athletic bilbao', 'real sociedad',
  // England
  'manchester united', 'manchester city', 'man utd', 'man city', 'liverpool',
  'arsenal', 'chelsea', 'tottenham', 'spurs', 'newcastle united', 'aston villa',
  'everton', 'west ham', 'leeds united', 'nottingham forest',
  // Italy
  'juventus', 'inter milan', 'inter', 'ac milan', 'milan', 'napoli', 'roma', 'lazio',
  // Germany
  'bayern munich', 'bayern', 'borussia dortmund', 'dortmund', 'rb leipzig', 'bayer leverkusen',
  // France
  'psg', 'paris saint germain', 'marseille', 'monaco', 'lyon',
  // Netherlands / Portugal
  'ajax', 'psv', 'feyenoord', 'benfica', 'porto', 'sporting cp', 'sporting lisbon',
  // Turkey / Scotland
  'galatasaray', 'fenerbahce', 'besiktas', 'celtic', 'rangers',
  // Middle East / Americas / MLS
  'al hilal', 'al nassr', 'al ittihad', 'boca juniors', 'river plate', 'flamengo',
  'palmeiras', 'corinthians', 'santos', 'sao paulo', 'gremio', 'inter miami', 'la galaxy'
];

/**
 * Sources that carry mainstream fixtures. Streamed.pk is the only provider the
 * user identified as supplying them; DaddyLive and StreamSports99 mix
 * mainstream with local content, so they are judged on league/title instead.
 */
const MAINSTREAM_SOURCE_IDS = new Set(['streamedpk']);

/**
 * Categories that are major-league by construction: the overwhelming majority
 * of events in these categories are top-tier, and there is no meaningful
 * "second division of the NBA" for a lower-tier event to hide in. Categories
 * with a real lower tier (football, tennis, cricket, ...) are deliberately
 * absent so that minor events in them stay NEUTRAL rather than being promoted.
 *
 * These categories also switch off the competition-name demotion below, because
 * names like "National League" / "American League" are TOP-tier labels in US
 * baseball - the exact opposite of the English fifth tier of the same name.
 */
const MAJOR_LEAGUE_CATEGORIES = new Set([
  'american_football', 'baseball', 'basketball', 'hockey', 'mma', 'motorsport', 'college'
]);

/**
 * Unambiguous lower-division / minor-competition markers: naming any of these
 * means the fixture is not mainstream, full stop.
 *
 * Grouped by the country whose league pyramid the marker comes from. Skipped
 * entirely for MAJOR_LEAGUE_CATEGORIES (see above) so US "leagues" are safe.
 */
const LOWER_DIVISION_MARKERS = [
  // England / EFL
  /\befl league one\b/, /\bleague one\b/, /\bleague two\b/, /\bleague 1\b/, /\bleague 2\b/,
  /\bnational league\b/, /\bvanarama\b/, /\bconference north\b/, /\bconference south\b/,
  // Spain
  /\bla liga 2\b/, /\blaliga 2\b/, /\bliga 2\b/, /\bsmartbank\b/, /\bhypermotion\b/,
  /\bsegunda\b/, /\bprimera federacion\b/, /\bprimera rfef\b/, /\brfef\b/, /\btercera\b/,
  /\bdivision de honor\b/,
  // Italy
  /\bserie b\b/, /\bserie c\b/, /\bserie d\b/, /\bserie a2\b/,
  // France
  /\bligue 2\b/, /\bligue 3\b/, /\bnational 2\b/, /\bnational 3\b/,
  // Germany
  /\b2 bundesliga\b/, /\bbundesliga 2\b/, /\bzweite bundesliga\b/, /\b3 liga\b/,
  /\bregionalliga\b/, /\boberliga\b/,
  // Netherlands / Portugal
  /\beerste divisie\b/, /\bkeuken kampioen\b/, /\bsegunda liga\b/, /\bliga portugal 2\b/,
  // Asia / Oceania
  /\bj2 league\b/, /\bj3 league\b/, /\bjfl\b/, /\bk league 2\b/, /\bchina league one\b/,
  /\bchina league two\b/, /\bi league\b/,
  // Americas
  /\busl\b/, /\bmls next pro\b/, /\bnisa\b/, /\bprimera b nacional\b/, /\bprimera nacional\b/,
  /\bprimera b\b/, /\bfederal a\b/,
  // Regional / amateur
  /\bregional\b/, /\bdistrict\b/, /\bcounty league\b/, /\bstate league\b/, /\bamateur\b/,
  /\bsemi pro\b/, /\bsunday league\b/
];

/**
 * Sport-specific SECOND-TIER markers: competitions that are unambiguously a
 * feeder / minor / junior tier *within their own sport*, but whose names are
 * too short or too sport-specific to live in the global lists above.
 *
 * Keyed by normalized category, so a marker only ever applies inside its own
 * sport - "League One" in football and "NISA" in soccer cannot collide with a
 * same-named competition elsewhere.
 *
 * Checked BEFORE the MAJOR_LEAGUE_CATEGORIES gate below, which is what lets
 * hockey / baseball / basketball have a feeder tier while their top flight
 * stays mainstream by category.
 *
 * Deliberately conservative: only clearly-below-top-tier competitions belong
 * here (minor / junior / development leagues), never merely "smaller" top
 * flights - so KHL, SHL and Liiga are intentionally absent. A sport missing
 * from this map simply keeps the previous behaviour.
 */
const SPORT_SECONDARY_MARKERS = {
  // Below the NHL: AHL/ECHL are the pro minors, OHL/QMJHL/WHL/USHL/NAHL junior.
  hockey: [
    /\bahl\b/, /\bechl\b/, /\bohl\b/, /\bqmjhl\b/, /\bwhl\b/, /\bushl\b/, /\bnahl\b/
  ],
  // Below MLB: affiliated minor-league ball.
  baseball: [
    /\bminor league\b/, /\bmilb\b/, /\btriple a\b/, /\bdouble a\b/, /\bhigh a\b/, /\bsingle a\b/
  ],
  // Below the NFL: alternate and developmental pro leagues.
  american_football: [
    /\bcfl\b/, /\bxfl\b/, /\bufl\b/, /\barena football\b/
  ],
  // Below the NBA: the development league.
  basketball: [
    /\bg league\b/, /\bnba g league\b/
  ],
  // Below the ATP/WTA main tours.
  tennis: [
    /\bchallenger\b/, /\bitf\b/
  ]
};

/**
 * Reserve / youth / academy markers. These demote in EVERY category, including
 * the major US leagues, because an affiliate or academy side is never the
 * mainstream fixture regardless of sport.
 */
const RESERVE_YOUTH_MARKERS = [
  /\bu 21\b/, /\bu21\b/, /\bu 20\b/, /\bu20\b/, /\bu 19\b/, /\bu19\b/, /\bu 18\b/, /\bu18\b/,
  /\bu 23\b/, /\bu23\b/, /\byouth\b/, /\bacademy\b/, /\breserves?\b/, /\bcastilla\b/,
  /\bprimavera\b/, /\bb team\b/
];

/**
 * Ambiguous markers - true lower-division names that also occur inside
 * mainstream event names. "Championship" is the English second tier, but it is
 * also in "World Rally Championship" and "European Championship".
 *
 * These only demote when the text carries no global-competition marker
 * (GLOBAL_COMPETITION_MARKERS below).
 */
const AMBIGUOUS_LOWER_DIVISION_MARKERS = [
  /\bchampionship\b/
];

/**
 * Phrases that prove an event is a world-level competition, which cancels the
 * ambiguous markers above. Checked only for the ambiguous list - an
 * unambiguous marker like "League One" or "Segunda" always demotes.
 */
const GLOBAL_COMPETITION_MARKERS = [
  /\bworld\b/, /\beurop/, /\beuro\b/, /\bgrand prix\b/, /\bolympic\b/, /\bnational\b/,
  /\bcontinental\b/
];

/** Reserve / B / youth suffixes that invalidate a famous-club match. */
const RESERVE_SUFFIXES = ['b', 'ii', 'iii', 'reserves', 'reserve', 'youth', 'academy', 'castilla'];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Single pattern for every famous club, with a negative lookahead for reserve
 * sides. Built once at load time; note it is not global, so `test()` carries no
 * lastIndex state and repeated calls are stable.
 */
const FAMOUS_CLUB_PATTERN = new RegExp(
  `\\b(?:${FAMOUS_CLUBS.map(escapeRegExp).join('|').replace(/\s+/g, '\\s+')})\\b` +
  `(?!\\s+(?:${RESERVE_SUFFIXES.join('|')})\\b)`,
  'i'
);

function matchesAny(patterns, text) {
  if (!text) return false;
  return patterns.some(pattern => pattern.test(text));
}

/**
 * Folds the fields a provider can classify an event with into one haystack.
 * Team names are included because providers frequently omit `league` but do
 * name the clubs.
 */
function buildHaystack(match) {
  const team1 = match.team1 && match.team1.name ? match.team1.name : '';
  const team2 = match.team2 && match.team2.name ? match.team2.name : '';
  return [
    fold(match.league),
    fold(match.title),
    fold(team1),
    fold(team2)
  ].filter(Boolean).join(' ');
}

/**
 * Explicit demotion signal, independent of any mainstream signal.
 * True when the event names a lower division, a reserve/youth side or a
 * regional competition.
 */
function isLowerDivisionFixture(match) {
  if (!match || typeof match !== 'object') return false;
  const haystack = buildHaystack(match);
  if (!haystack) return false;

  // Reserve / youth / academy sides are never the mainstream fixture.
  if (matchesAny(RESERVE_YOUTH_MARKERS, haystack)) return true;

  // Sport-specific feeder / lower-tier competitions. Checked before the
  // major-league gate so feeder leagues inside a major-league sport demote
  // while that sport's top flight stays mainstream.
  const categoryKey = String((match && match.category) || '').toLowerCase().trim();
  const sportMarkers = SPORT_SECONDARY_MARKERS[categoryKey];
  if (sportMarkers && matchesAny(sportMarkers, haystack)) return true;

  // Competition-name markers only apply outside the US major leagues, where
  // "National League" / "American League" are top-tier labels rather than
  // lower-division ones.
  if (!isMajorLeagueCategory(match)) {
    if (matchesAny(LOWER_DIVISION_MARKERS, haystack)) return true;
    // A global event name wins over the ambiguous markers, so that
    // "World Rally Championship" is not mistaken for the English second tier.
    if (!matchesAny(GLOBAL_COMPETITION_MARKERS, haystack) &&
        matchesAny(AMBIGUOUS_LOWER_DIVISION_MARKERS, haystack)) {
      return true;
    }
  }

  return false;
}

/** True when the event streams from a source known to carry mainstream fixtures. */
function hasMainstreamSource(match) {
  if (!match || !Array.isArray(match.sources)) return false;
  return match.sources.some(s => s && MAINSTREAM_SOURCE_IDS.has(String(s.source || '').toLowerCase()));
}

/** True when the category is a major league by construction. */
function isMajorLeagueCategory(match) {
  if (!match || !match.category) return false;
  return MAJOR_LEAGUE_CATEGORIES.has(String(match.category).toLowerCase().trim());
}

/**
 * Classifies a match into a TIER. Missing / malformed fields are tolerated and
 * simply produce no signal, so an incomplete event is NEUTRAL rather than
 * mis-ranked.
 *
 * Demotion is evaluated first and unconditionally: a lower-division event stays
 * MINOR even when it has a Streamed.pk source or a famous club in the title.
 */
function getMatchTier(match) {
  if (!match || typeof match !== 'object') return TIER.NEUTRAL;

  const haystack = buildHaystack(match);
  if (haystack && isLowerDivisionFixture(match)) return TIER.MINOR;

  if (hasMainstreamSource(match)) return TIER.MAINSTREAM;
  if (matchesAny(TOP_TIER_COMPETITIONS, haystack)) return TIER.MAINSTREAM;
  if (haystack && FAMOUS_CLUB_PATTERN.test(haystack)) return TIER.MAINSTREAM;
  if (isMajorLeagueCategory(match)) return TIER.MAINSTREAM;

  return TIER.NEUTRAL;
}

/** Short human-readable reason for the tier, for logging and debugging. */
function explainMatch(match) {
  if (!match || typeof match !== 'object') return 'not-a-match';
  const haystack = buildHaystack(match);
  if (haystack && isLowerDivisionFixture(match)) return 'lower-division-marker';
  if (hasMainstreamSource(match)) return 'mainstream-source';
  if (matchesAny(TOP_TIER_COMPETITIONS, haystack)) return 'top-tier-competition';
  if (haystack && FAMOUS_CLUB_PATTERN.test(haystack)) return 'famous-club';
  if (isMajorLeagueCategory(match)) return 'major-league-category';
  return 'no-signal';
}

module.exports = {
  TIER,
  getMatchTier,
  isLowerDivisionFixture,
  hasMainstreamSource,
  isMajorLeagueCategory,
  explainMatch,
  // Exported for inspection and tests. The pattern lists are not global
  // regexes, so calling `.test()` on them is side-effect free.
  TOP_TIER_COMPETITIONS,
  FAMOUS_CLUBS,
  MAJOR_LEAGUE_CATEGORIES,
  MAINSTREAM_SOURCE_IDS,
  LOWER_DIVISION_MARKERS,
  RESERVE_YOUTH_MARKERS,
  SPORT_SECONDARY_MARKERS,
  AMBIGUOUS_LOWER_DIVISION_MARKERS,
  GLOBAL_COMPETITION_MARKERS
};
