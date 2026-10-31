// ─── Fuzzy Match Helpers ────────────────────────────────────────────────────

// How long past kickoff a replay archive session is retained in the
// aggregated cache. Bounds replay list growth while preserving the full annual season.
const REPLAY_RETENTION_DAYS = 365;

const STOP_WORDS = new Set([
  'the', 'and', 'vs', 'v', 'live', 'stream', 'fc', 'cf', 'sc', 'united', 'city',
  'real', 'sport', 'sports', 'club', 'de', 'la', 'women', 'men', 'u19', 'u20',
  'u21', 'u23', 'full', 'match', 'replay', 'game', 'hd'
]);

const { parseTimezone } = require('../timezone');
const ChannelIdentityService = require('./ChannelIdentityService');
const MatchEntity = require('../domain/MatchEntity');

/**
 * Parses a provider-supplied match date into epoch milliseconds.
 *
 * Providers are inconsistent: most send a numeric epoch (as number or numeric
 * string), but ReplayZone sends ISO date strings ("2026-09-14"). A plain
 * Number() cast turns those into NaN, which the caller then coerces to 0 -
 * silently disabling the date-window guard in _sameEventPre. That guard is what
 * stops the same fixture on different days from merging, so losing it merges
 * unrelated events (observed: a "Chicago Cubs @ Atlanta Braves" replay from May
 * merged into the September Cubs vs Braves fixture, attaching replay streams to
 * a live/upcoming listing).
 *
 * Parsing goes through the shared timezone parser rather than raw Date.parse.
 * Date.parse resolves an unqualified string such as "2026-09-14T20:00:00.000"
 * in the HOST zone, so the merge guard disagreed with the display path
 * (getKickoff) whenever the server was not on UTC - a silent multi-hour skew on
 * the merge window. The shared parser treats unqualified input as UTC, keeping
 * both paths consistent and host-independent.
 */
function _parseEventDate(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isNaN(n) && Number.isFinite(n) && n > 0) return n;
  const str = String(raw).trim();
  if (!str || /^0+$/.test(str)) return 0;
  const parsed = parseTimezone(str, 'UTC');
  if (parsed && !Number.isNaN(parsed) && parsed > 0) return parsed;
  // Last resort for non-ISO shapes (e.g. "September 14, 2026").
  const fallback = Date.parse(str);
  return Number.isNaN(fallback) ? 0 : fallback;
}

/**
 * Strips diacritics and maps non-combining Latin characters to plain ASCII
 * so international team spellings (e.g. "Lech Poznań" vs "Lech Poznan",
 * "Beşiktaş" vs "Besiktas", "Ferencváros" vs "Ferencvaros") merge reliably.
 */
function _foldText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[đĐ]/g, 'dj')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[łŁ]/g, 'l')
    .replace(/[øØ]/g, 'o')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .replace(/[ß]/g, 'ss')
    .replace(/[ðÐ]/g, 'd')
    .replace(/[þÞ]/g, 'th');
}

/**
 * Normalizes team/event names by collapsing well-known multi-word clubs and
 * popular abbreviations into single collision-safe compound tokens so that
 * Jaccard / subset matching cannot accidentally merge different teams that share
 * a single word (e.g. "Inter Milan" vs "AC Milan" both contain "milan").
 *
 * ORDER MATTERS: more specific aliases (inter miami, inter turku) must come
 * before the bare-"inter" rule, otherwise "Inter Miami" would compound to
 * "intermilan" and collide with Inter Milan.
 */
// Hoisted to module scope: _compoundify runs up to ~6x per _precompute row
// (title, extracted teams, fallback teams), and rebuilding this table per call
// allocated ~180 objects (90 RegExp + 90 pair arrays) each time — millions of
// short-lived allocations per sync. String.replace with a /g regex always
// starts at index 0, so shared instances carry no cross-call state.
const COMPOUND_ALIASES = [
    // Motorsport — Formula 1 / F1 must come FIRST so the "1" never becomes a
    // stray digit that blocks e.g. "Formula 1 Azerbaijan GP" from merging with
    // "Azerbaijan Grand Prix". "GP" also normalised to "grandprix" to help
    // track-event titles collapse regardless of whether GP is spelled out.
    [/\bformula\s*(?:one|1)\b|\bf[- ]?1\b/g, 'formulaone'],
    [/\bformula\s*(?:two|2)\b|\bf[- ]?2\b/g, 'formulatwo'],
    [/\bformula\s*(?:three|3)\b|\bf[- ]?3\b/g, 'formulathree'],
    [/\bformula\s*(?:four|4)\b|\bf[- ]?4\b/g, 'formulafour'],
    [/\bformula\s*e\b|\bformula-e\b/g, 'formulae'],
    [/\bgrand\s*prix\b|\bgp\b/g, 'grandprix'],
    // Football (Soccer)
    [/\bman(chester)?\s*utd\b|\bmanchester\s*united\b/g, 'manchesterunited'],
    [/\bman\.?\s+united\b/g, 'manchesterunited'], // "Man United" / "Man. United" (gap found by A/B testing)
    [/\bman(chester)?\s*city\b/g, 'manchestercity'],
    [/\bspurs\b|\btottenham(\s*hotspur)?\b/g, 'tottenham'],
    [/\bwolves\b|\bwolverhampton(\s*wanderers)?\b/g, 'wolverhampton'],
    [/\bpsg\b|\bparis[\s\-–—]*(saint|st)[\s\-–—]*germain\b/g, 'psg'],
    [/\bbayern(\s*m[uü]nchen)?\b|\bbayern\s*munich\b/g, 'bayernmunich'],
    [/\batl(etico)?\s*madrid\b/g, 'atleticomadrid'],
    [/\breal\s*madrid\b|\br\s*madrid\b/g, 'realmadrid'],
    // Basketball Milano (must precede generic Milan rule)
    [/\bolimpia\s*milan[o]?\b/g, 'olimpiamilano'],
    // Baseball (MLB)
    [/\bred\s*sox\b/g, 'redsox'],
    [/\bwhite\s*sox\b/g, 'whitesox'],
    [/\bblue\s*jays\b/g, 'bluejays'],
    [/\bd[- ]?backs\b|\bdiamondbacks\b/g, 'diamondbacks'],
    // inter variants must precede the bare-inter rule below
    [/\binter\s*miami\b/g, 'intermiami'],
    [/\binter\s*turku\b/g, 'interturku'],
    [/\binter(\s*milan)?\b|\binternazionale\b/g, 'intermilan'],
    [/\b(ac\s*)?milan\b/g, 'acmilan'],
    [/\bolympique\s*(de\s*)?lyonn?ais\b|\blyon\b/g, 'lyon'],
    [/\bolympique\s*(de\s*)?marseille\b|\bmarseille\b/g, 'marseille'],
    [/\bsparta\s*prah[ae]\b|\bsparta\s*prague\b/g, 'spartaprague'],
    [/\bslavia\s*prah[ae]\b|\bslavia\s*prague\b/g, 'slaviaprague'],
    [/\baz(\s*alkmaar)?\b/g, 'azalkmaar'],
    [/\bhapoel\s*be['’]?er(\s*sheva)?\b/g, 'hapoelbeersheva'],
    [/\brb\s*salzburg\b|\bred\s*bull\s*salzburg\b|\bsalzburg\b/g, 'salzburg'],
    [/\bsporting\s*gijon\b/g, 'sportinggijon'],
    [/\bsporting\s*(?:cp|clube\s*de\s*portugal|lisbon)\b/g, 'sportingcp'],
    [/\bathletic\s*(club|bilbao)\b/g, 'athleticbilbao'],
    [/\bbayer(\s*04)?\s*leverkusen\b/g, 'bayerleverkusen'],
    [/\bborussia\s*m[oö]nchengladbach\b|\bm['’]?gladbach\b/g, 'monchengladbach'],
    [/\bpsv(\s*eindhoven)?\b/g, 'psveindhoven'],
    [/\bfeyenoord(\s*rotterdam)?\b/g, 'feyenoord'],
    [/\b(red\s*star(\s*belgrade)?|crvena\s*zvezda)\b/g, 'crvenazvezda'],
    [/\bshakhtar(\s*donetsk)?\b/g, 'shakhtardonetsk'],
    [/\bdynamo\s*k[yi]ev\b/g, 'dynamokyiv'],
    [/\bborussia\s*dortmund\b|\bbvb\b|\bdortmund\b/g, 'borussiadortmund'],
    [/\brb\s*leipzig\b/g, 'rbleipzig'],
    [/\baston\s*villa\b/g, 'astonvilla'],
    [/\bwest\s*ham(\s*united)?\b/g, 'westham'],
    [/\bcrystal\s*palace\b/g, 'crystalpalace'],
    [/\bnewcastle(\s*united)?\b/g, 'newcastle'],
    [/\bnottingham\s*forest\b|\bnott(?:s|m)\s+forest\b/g, 'nottinghamforest'],
    [/\bleicester(\s*city)?\b/g, 'leicestercity'],
    [/\bsheff(?:ield)?\s*(?:utd|united)\b/g, 'sheffieldunited'],
    [/\bbe(?:in\s*sport|\s*in)\b/g, 'beinsport'],
    [/\bal[\s\-]nassr\b/g, 'alnassr'],
    [/\bal[\s\-]hilal\b/g, 'alhilal'],
    [/\bal[\s\-]ahly\b/g, 'alahly'],
    [/\bboca\s*juniors\b|\bca\s*boca\b/g, 'bocajuniors'],
    // American Football
    // College
    [/\bbyu\b|\bbrigham\s*young(\s*cougars)?\b/g, 'byu'],
    [/\bucf\b|\bcentral\s*florida(\s*knights)?\b/g, 'ucf'],
    [/\busc\b|\bsouthern\s*california(\s*trojans)?\b/g, 'usc'],
    [/\blsu\b|\blouisiana\s*state(\s*tigers)?\b/g, 'lsu'],
    [/\bsmu\b|\bsouthern\s*methodist(\s*mustangs)?\b/g, 'smu'],
    [/\btcu\b|\btexas\s*christian(\s*horned\s*frogs)?\b/g, 'tcu'],
    // NFL
    [/\bkansas\s*city\s*chiefs\b|\bkc\s*chiefs\b|\bchiefs\b/g, 'kansascitychiefs'],
    [/\bseattle\s*seahawks\b|\bseahawks\b/g, 'seattleseahawks'],
    [/\bsan\s*francisco\s*49ers\b|\bniners\b|\b49ers\b/g, 'sf49ers'],
    [/\bdallas\s*cowboys\b|\bcowboys\b/g, 'dallascowboys'],
    [/\bphiladelphia\s*eagles\b|\beagles\b/g, 'philadelphiaeagles'],
    [/\bgreen\s*bay\s*packers\b|\bpackers\b/g, 'greenbaypacker'],
    [/\bcincinatti\s*bengals\b|\bbengals\b/g, 'cincinnatibengals'],
    [/\bpittsburgh\s*steelers\b|\bsteelers\b/g, 'pittsburghsteelers'],
    // Cricket Channels
    [/\bwillow(?:\s*2)?(?:\s*cricket)?\b/gi, 'willowcricket'],
    [/\bfox\s*cricket\b/gi, 'foxcricket'],
    // Basketball — NBL (Australia) teams
    [/\bperth\s*wildcats\b/g, 'perthwildcat'],
    [/\badelaide\s*36ers\b/g, 'adelaide36er'],
    [/\bmelbourne\s*united\b/g, 'melbourneunited'],
    [/\bsydney\s*kings\b/g, 'sydneyking'],
    [/\bbrisbane\s*bullets?\b/g, 'brisbanebullet'],
    [/\bnz\s*breakers?\b|\bnew\s*zealand\s*breakers?\b/g, 'nzbreaker'],
    [/\bsouth\s*east\s*melbourne\s*phoenix\b|\bse\s*melbourne\b/g, 'semelbournephoenix'],
    [/\btasmania\s*jackjumpers?\b/g, 'tasmaniajackjumper'],
    [/\bcairns\s*taipans?\b/g, 'cairnstaispan'],
    [/\bilawarra\s*hawks?\b/g, 'ilawarrahawk'],
    // NBA teams
    [/\bny\s*knicks\b|\bnew\s*york\s*knicks\b|\bknicks\b/g, 'nyknicks'],
    [/\bboston\s*celtics\b|\bceltics\b/g, 'bostonceltics'],
    [/\bla\s*lakers\b|\blakers\b|\blos\s*angeles\s*lakers\b/g, 'lalakers'],
    [/\bgolden\s*state\s*warriors\b|\bwarriors\b/g, 'gswarriors'],
    [/\bchicago\s*bulls\b|\bbulls\b/g, 'chicagobulls'],
    [/\bmiami\s*heat\b|\bheat\b/g, 'miamiheat'],
    [/\bdenver\s*nuggets\b|\bnuggets\b/g, 'denvernuggets'],
    [/\bmilwaukee\s*bucks\b|\bbucks\b/g, 'milwaukeebucks'],
    // Vietnamese clubs / cities
    [/\bha\s*noi\b/g, 'hanoi'],
    [/\bho\s*chi\s*minh\b/g, 'hochiminh'],
    [/\bda\s*nang\b/g, 'danang'],
    [/\bthe\s*cong\b/g, 'thecong'],
    [/\bnam\s*dinh\b/g, 'namdinh'],
    [/\bbinh\s*duong\b|\bbihn\s*duong\b/g, 'binhduong'],
];

function _compoundify(t) {
  return _compoundifyF(_foldText(t));
}

// Pre-folded variants: callers that already ran _foldText on the input skip
// the redundant NFKD cascade. The fold is idempotent, so results are identical
// to the folding versions. _tokenizeF additionally assumes lowercase input
// (any _compoundifyF output qualifies — the [^a-z0-9] strip below would drop
// uppercase letters, exactly as the original did on such inputs).
function _stripNoiseF(t) {
  if (!t) return '';
  return t
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(live|stream|streaming|free|hd|fhd|4k|hq|web|online|tv|match|fixture|round|week|day|game|league|cup|tournament|season|fc|cf|sc|cd|ca|afc|fk|sk|bk|rsc|vfb|tsv|tsg)\b/gi, ' ');
}

function _stripNoise(t) {
  return _stripNoiseF(_foldText(t));
}

function _compoundifyF(t) {
  let r = t.toLowerCase();
  for (const [regex, rep] of COMPOUND_ALIASES) r = r.replace(regex, rep);
  return r;
}

function _tokenizeF(t) {
  return t.replace(/[^a-z0-9]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2)
    .map(w => (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w); // naive singular: newells->newell, sports->sport
}

function _tokenize(t) {
  return _tokenizeF(_foldText(t));
}

/**
 * Determine if two team-name strings refer to the same club.
 * Single compound tokens (e.g. "manchestercity") require exact equality so
 * different compounds cannot accidentally match via substring.
 */
function _teamsSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return true;
  const at = a.split(' ').filter(w => w.length > 2);
  const bt = b.split(' ').filter(w => w.length > 2);
  if (at.length === 0 || bt.length === 0) return false;
  if (at.length === 1 && bt.length === 1) return at[0] === bt[0];
  const sa = new Set(at), sb = new Set(bt);
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  const minLen = Math.min(sa.size, sb.size);
  return minLen > 0 && (common / minLen) >= 0.7;
}

const COUNTRY_CANONICAL = {
  'uk': 'united kingdom',
  'gb': 'united kingdom',
  'great britain': 'united kingdom',
  'england': 'united kingdom',
  'united kingdom': 'united kingdom',
  'us': 'united states',
  'usa': 'united states',
  'united states': 'united states',
  'de': 'germany',
  'ger': 'germany',
  'deutschland': 'germany',
  'germany': 'germany',
  'fr': 'france',
  'fra': 'france',
  'france': 'france',
  'es': 'spain',
  'esp': 'spain',
  'spain': 'spain',
  'it': 'italy',
  'ita': 'italy',
  'italy': 'italy',
  'tr': 'turkey',
  'tur': 'turkey',
  'turkey': 'turkey',
  'pl': 'poland',
  'pol': 'poland',
  'polska': 'poland',
  'poland': 'poland',
  'pt': 'portugal',
  'por': 'portugal',
  'portugal': 'portugal',
  'nl': 'netherlands',
  'ned': 'netherlands',
  'holland': 'netherlands',
  'netherlands': 'netherlands',
  'ar': 'arabia',
  'arabic': 'arabia',
  'arabia': 'arabia'
};

function _normalizeCountry(c) {
  if (!c) return '';
  const s = String(c).toLowerCase().trim();
  return COUNTRY_CANONICAL[s] || s;
}

const MOTORSPORT_GENERICS = new Set([
  'grandprix', 'gp', 'formulaone', 'formulatwo', 'formulathree', 'formulafour', 'formulae',
  'f1', 'f2', 'f3', 'f4', 'fe', 'motogp', 'moto2', 'moto3', 'nascar', 'xfinity', 'indycar', 'wsbk', 'wrc', 'dtm', 'rally', 'superbike',
  'race', 'sunday', 'saturday', 'friday', 'thursday', 'wednesday', 'tuesday', 'monday',
  'practice', 'qualifying', 'sprint', 'championship', 'world', 'cup',
  'full', 'replay', 'show', 'season', 'review', 'series', 'day',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
]);

// Every non-'other' branch of _extractMotorsportSeriesT requires one of these
// keywords in the title or league, so their absence proves the result is
// 'other' and the ~40-regex battery can be skipped. False positives are
// harmless (they only run the full classifier).
const MOTORSPORT_KEYWORD_RE = /formula|nascar|xfinity|truck|indy|indianapolis|moto|superbike|wsbk|wrc|rally|dtm|prix|cup|\bf[- ]?[1-4]\b/i;

function _extractMotorsportSeries(title, league = '') {
  return _extractMotorsportSeriesT(_foldText(title || '').toLowerCase(), _foldText(league || '').toLowerCase());
}

// t / l are already folded AND lowercased by the caller.
function _extractMotorsportSeriesT(t, l) {
  const matchSeries = (str) => {
    if (!str) return null;
    if (/\bf1\s*academy\b|\bformula\s*4\b|\bf4\b/i.test(str)) return 'f4';
    if (/\bformula\s*e\b|\bformula-e\b|\be-prix\b|\beprix\b/i.test(str)) return 'fe';
    if (/\bformula\s*(?:two|2)\b|\bf[- ]?2\b/i.test(str)) return 'f2';
    if (/\bformula\s*(?:three|3)\b|\bf[- ]?3\b/i.test(str)) return 'f3';
    if (/\bformula\s*(?:one|1)\b|\bf[- ]?1\b|\bformulaone\b/i.test(str)) return 'f1';
    if (/\bnascar\s*xfinity\b|\bxfinity\s*series\b|\bxfinity\b/i.test(str)) return 'nascar_xfinity';
    if (/\bnascar\s*craftsman\s*truck\b|\bcraftsman\s*truck\b|\btruck\s*series\b|\bnascar\s*truck\b/i.test(str)) return 'nascar_truck';
    if (/\bnascar\b|\bcup\s*series\b|\bmonster\s*energy\s*cup\b|\bsprint\s*cup\b/i.test(str)) return 'nascar';
    if (/\bindycar\b|\bindy\s*500\b|\bindianapolis\s*500\b/i.test(str)) return 'indycar';
    if (/\bmoto\s*2\b|\bmoto2\b/i.test(str)) return 'moto2';
    if (/\bmoto\s*3\b|\bmoto3\b/i.test(str)) return 'moto3';
    if (/\bmotogp\b/i.test(str)) return 'motogp';
    if (/\bwsbk\b|\bworld\s*superbike\b|\bsuperbike\b/i.test(str)) return 'wsbk';
    if (/\bwrc\b|\bworld\s*rally\b/i.test(str)) return 'wrc';
    if (/\bdtm\b/i.test(str)) return 'dtm';
    return null;
  };

  const fromTitle = matchSeries(t);
  if (fromTitle) return fromTitle;
  const fromLeague = matchSeries(l);
  if (fromLeague) return fromLeague;

  if (/\brally\b/i.test(t) || /\brally\b/i.test(l)) return 'wrc';

  return 'other';
}

function _extractMotorsportSession(title) {
  if (!title) return 'race';
  return _extractMotorsportSessionT(_foldText(title).toLowerCase());
}

// s is already folded AND lowercased by the caller.
function _extractMotorsportSessionT(s) {
  if (!s) return 'race';

  // 1. Season Review
  if (/\b(?:season|year)\s*in\s*review\b|\bseason\s*review\b/i.test(s)) {
    return 'season_review';
  }

  // 2. Pre / Post race / Shows / Media
  if (/\bpre[\s-]race\b|\bthe\s*f1\s*show\b|\bf1\s*show\b|\bpaddock\s*uncut\b|\bpaddock\b|\bpreview\b|\bpress\s*conference\b/i.test(s)) {
    return 'pre_race';
  }
  if (/\bpost[\s-]race\b|\bchequered\s*flag\b|\bafter\s*the\s*flag\b/i.test(s)) {
    return 'post_race';
  }

  // 3. Testing & Shakedown days
  const isTestingOrShakedown = /\b(?:test|testing|shakedown)\b/i.test(s);
  const dayMatch = s.match(/\bday[\s-]?([1-4])\b/i);
  if (dayMatch && (isTestingOrShakedown || !/\b(?:practice|qualifying|sprint|race)\b/i.test(s))) {
    return `day_${dayMatch[1]}`;
  }
  if (isTestingOrShakedown) {
    return 'testing';
  }

  // 4. Practice sessions (FP1 - FP4)
  if (/\b(?:1st|first)\s*(?:free\s*)?practice\b|\b(?:free\s*)?practice\s*1\b|\bfp\s*1\b/i.test(s)) return 'p1';
  if (/\b(?:2nd|second)\s*(?:free\s*)?practice\b|\b(?:free\s*)?practice\s*2\b|\bfp\s*2\b/i.test(s)) return 'p2';
  if (/\b(?:3rd|third)\s*(?:free\s*)?practice\b|\b(?:free\s*)?practice\s*3\b|\bfp\s*3\b/i.test(s)) return 'p3';
  if (/\b(?:4th|fourth)\s*(?:free\s*)?practice\b|\b(?:free\s*)?practice\s*4\b|\bfp\s*4\b/i.test(s)) return 'p4';

  // 5. Sprint Qualifying / Shootout
  if (/\bsprint\s*(?:shootout|qualifying)\b|\bsq\s*[1-3]?\b/i.test(s)) {
    return 'sprint_qualifying';
  }

  // 6. Sprint (Race)
  if (/\bsprint(?:\s*race)?\b/i.test(s)) {
    return 'sprint';
  }

  // 7. Qualifying
  if (/\bqualifying\b|\bshootout\b|\bpole\s*position\b/i.test(s)) {
    return 'qualifying';
  }

  // 8. Generic Practice
  if (/\b(?:free\s*)?practice\b/i.test(s)) {
    return 'practice';
  }

  // 9. Main Race (Default for motorsport events)
  return 'race';
}

/**
 * Try to split a match title into [team1, team2] using common separators.
 * Returns null if the title doesn't look like a "team1 vs team2" fixture.
 */
function _tryExtractTeams(title, precomputedSeries) {
  if (!title) return null;
  // `title` arrives pre-folded from _precompute; the F-variants below skip the
  // redundant folds the old chain paid 3x per call.
  const clean = _compoundifyF(_stripNoiseF(title));
  // Return null for motorsport events so race titles are never parsed as dual-team fixtures
  const series = precomputedSeries !== undefined ? precomputedSeries : _extractMotorsportSeries(title);
  if (series !== 'other' || /\b(?:grandprix|formulaone|formulatwo|formulathree|formulafour|formulae|motogp|nascar|indycar|wsbk|wrc|dtm|rally|practice|qualifying|sprint)\b/i.test(clean)) {
    return null;
  }
  const parts = clean.split(/\s(?:vs?\.?|@|[-–—])\s/i);
  if (parts.length === 2) {
    return [_tokenizeF(parts[0]).join(' '), _tokenizeF(parts[1]).join(' ')];
  }
  const extracted = extractTeamsFromTitle(title);
  if (extracted && extracted.length === 2) {
    return [
      _tokenizeF(_compoundifyF(_stripNoiseF(_foldText(extracted[0])))).join(' '),
      _tokenizeF(_compoundifyF(_stripNoiseF(_foldText(extracted[1])))).join(' ')
    ];
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────

const { extractTeamsFromTitle } = require('./TeamNameExtractor');

// Identity key mirroring the merge loop's 7-field source equality (source, id,
// streamSource, streamId, group, channelName, name — deliberately NOT url),
// joined with a byte that cannot occur in provider display fields.
const sourceIdentityKey = (s) => [
  s.source || '', s.id || '', s.streamSource || '', s.streamId || '',
  s.group || '', s.channelName || '', s.name || ''
].join('\u0000');

class MatchAggregator {
  constructor({ timStreamsProvider, watchFootyProvider, cdnLiveProvider, streamSports99Provider, streamedPkProvider, cacheService, yamlProviders, replayzoneProvider, daddyLiveProvider, teamLogoService, liveTvProvider, damiTvProvider, ppvStProvider, soccerFullProvider, basketballVideoProvider, nflVideoProvider, skTechProvider, fullRacesProvider, hockeyReplaysProvider, mlbLiveProvider, vavooProvider, ak47LiveProvider, leafProvider, providerHealthService, broadcasterMatchService } = {}) {
    this.providers = [timStreamsProvider, streamedPkProvider, watchFootyProvider, cdnLiveProvider, ...(yamlProviders || []), replayzoneProvider, ...(liveTvProvider ? [liveTvProvider] : []), ...(daddyLiveProvider ? [daddyLiveProvider] : []), ...(damiTvProvider ? [damiTvProvider] : []), ...(ppvStProvider ? [ppvStProvider] : []), ...(soccerFullProvider ? [soccerFullProvider] : []), ...(basketballVideoProvider ? [basketballVideoProvider] : []), ...(nflVideoProvider ? [nflVideoProvider] : []), ...(skTechProvider ? [skTechProvider] : []), ...(fullRacesProvider ? [fullRacesProvider] : []), ...(hockeyReplaysProvider ? [hockeyReplaysProvider] : []), ...(mlbLiveProvider ? [mlbLiveProvider] : []), ...(vavooProvider ? [vavooProvider] : []), ...(ak47LiveProvider ? [ak47LiveProvider] : []), ...(leafProvider ? [leafProvider] : [])];
    this.streamSports99Provider = streamSports99Provider;
    this.cacheService = cacheService;
    this.teamLogoService = teamLogoService;
    this.providerHealthService = providerHealthService;
    this.vavooProvider = vavooProvider;
    this.broadcasterMatchService = broadcasterMatchService;
    if (this.providerHealthService) this.providerHealthService.registerProviders(this.providers);
  }

  _extractMotorsportSeries(title, league) {
    return _extractMotorsportSeries(title, league);
  }

  _extractMotorsportSession(title) {
    return _extractMotorsportSession(title);
  }

  /**
   * Enriches live fixtures with top-quality 1080p Vavoo broadcast sources
   * by cross-referencing broadcaster channel names (from DaddyLive etc.)
   * with Vavoo's indexed live channels.
   *
   * @param {Array<Object>} matches
   */
  _enrichMatchesWithBroadcasters(matches) {
    if (!this.broadcasterMatchService || !Array.isArray(matches)) return;
    if (this.vavooProvider && typeof this.vavooProvider.isEnabled === 'function' && !this.vavooProvider.isEnabled()) {
      return;
    }

    let enrichedCount = 0;
    for (const match of matches) {
      if (!match || !Array.isArray(match.sources) || match.sources.length === 0) continue;
      // Do not inject into 24/7 channels or VOD replays
      if (match.category === 'networks' || match.rawCategory === '24/7 TV Channels' || String(match.id || '').includes('_ch_')) continue;
      if (match.isReplay || (match.id && (match.id.startsWith('rz_') || match.id.startsWith('bv_') || match.id.startsWith('nfl_') || match.id.startsWith('sf_') || match.id.startsWith('fr_') || match.id.startsWith('hr_')))) continue;

      // Extract candidate broadcaster names from all sources
      const candidateNames = [];
      for (const src of match.sources) {
        if (!src) continue;
        const candidateName = src.channelName || src.channel_name || src.channel;
        if (candidateName && typeof candidateName === 'string' && candidateName.trim()) {
          candidateNames.push(candidateName.trim());
        }
      }

      // Check if this fixture has specific event/overflow channels (e.g., Canal+ Live 3, Canal+ Extra 2)
      const hasCanalOverflow = candidateNames.some(c => /canal\+?\s*(live|extra)\s*\d+/i.test(c));
      const hasMovistarOverflow = candidateNames.some(c => /movistar\s*(liga|deportes|campeones)\s*\d+/i.test(c));

      // If specific overflow channels exist, prune any linear channels that were mistakenly added
      if (hasCanalOverflow) {
        match.sources = match.sources.filter(s => {
          if (s && s.source === 'vavoo') {
            const chName = String(s.channelName || '').toLowerCase();
            if (chName.includes('canal') && (chName.includes('sport') || chName.includes('premiere')) && !chName.includes('live') && !chName.includes('extra')) {
              return false;
            }
          }
          return true;
        });
      }

      const existingVavooUrls = new Set(
        match.sources
          .filter(s => s && s.source === 'vavoo')
          .map(s => s.id)
      );

      // Prioritize numbered event feeds and filter out conflicting generic network channels
      const prioritizedCandidates = candidateNames.filter(c => {
        if (hasCanalOverflow && /canal\+?\s*(sport|premiere?)/i.test(c) && !/(live|extra)/i.test(c)) {
          return false;
        }
        if (hasMovistarOverflow && /movistar\s*(plus|\+)/i.test(c) && !/(liga|deportes|campeones)/i.test(c)) {
          return false;
        }
        return true;
      });

      let injectedForThisMatch = 0;

      for (const candidateName of prioritizedCandidates) {
        const vavooSource = this.broadcasterMatchService.createVavooSource(candidateName);
        if (vavooSource && vavooSource.id && !existingVavooUrls.has(vavooSource.id)) {
          existingVavooUrls.add(vavooSource.id);
          match.sources.push(vavooSource);
          injectedForThisMatch++;
          if (injectedForThisMatch >= 8) break; // Allow up to 8 broadcast feeds per match across regions
        }
      }

      if (injectedForThisMatch > 0) {
        enrichedCount++;
      }
    }

    if (enrichedCount > 0) {
      console.log(`[MatchAggregator] Injected Vavoo 1080p broadcast feeds into ${enrichedCount} live fixture(s).`);
    }
  }

  /**
   * Precompute everything isSameEvent needs ONCE per match. The merge loop is
   * O(N^2) in pair comparisons; doing the regex-heavy normalization here instead
   * of inside every comparison removes ~50x of repeated work on large catalogs.
   */
  _precompute(e) {
    const id = e && e.id != null ? String(e.id) : '';
    const isChannel = Boolean(
      (e && (e.category === 'networks' || e.rawCategory === '24/7 TV Channels' || String(e.id || '').includes('_ch_'))) ||
      id.startsWith('dlv_ch_') || id.startsWith('cdn_ch_') || id.startsWith('sktech_ch_') || id.startsWith('vavoo_ch_')
    );
    const title = e && e.title ? _foldText(e.title) : '';
    // Fold the title ONCE and thread the folded + lowercased forms through
    // the whole pipeline. The old chain re-ran the NFKD/diacritic cascade
    // 6-11x per row (stripNoise, compoundify, tokenize, motorsport checks and
    // team extraction each folded their input again); the fold is idempotent,
    // so single-fold results are identical.
    const titleLower = title ? title.toLowerCase() : '';
    const leagueLower = e && e.league ? _foldText(e.league).toLowerCase() : '';
    const normalized = _compoundifyF(_stripNoiseF(title));

    // Motorsport detection: when the category is definitively not motorsport
    // AND neither title nor league carries any motorsport keyword, the series
    // classifier provably answers 'other' (every non-'other' branch requires
    // one of MOTORSPORT_KEYWORD_RE's tokens), so the battery is skipped.
    const catNorm = this._normalizeCategory(e && e.category);
    const motorsportSeries = isChannel ? 'other'
      : ((catNorm === 'motorsport' || MOTORSPORT_KEYWORD_RE.test(`${titleLower} ${leagueLower}`))
          ? _extractMotorsportSeriesT(titleLower, leagueLower)
          : 'other');
    const isMotorsport = !isChannel && (catNorm === 'motorsport' || motorsportSeries !== 'other');
    const extractedTeams = (isMotorsport || isChannel) ? null : _tryExtractTeams(title, motorsportSeries);
    const fallbackTeams = (!extractedTeams && !isMotorsport && !isChannel && e && e.team1 && e.team2 && e.team1.name && e.team2.name)
      ? [
          _tokenizeF(_compoundifyF(_stripNoiseF(_foldText(e.team1.name)))).join(' '),
          _tokenizeF(_compoundifyF(_stripNoiseF(_foldText(e.team2.name)))).join(' ')
        ]
      : null;

    let rawCategory = e && e.category ? String(e.category) : '';
    if (rawCategory === 'football' && /\b(?:euroleague|eurocup|fiba|eurobasket|adriatic league|b1\.league)\b/i.test(`${title} ${e && e.league || ''}`)) {
      rawCategory = 'basketball';
      if (e) e.category = 'basketball';
    }

    let channelIdentityKey = (e && e.channelIdentityKey) ? e.channelIdentityKey : null;
    let channelNumber = (e && e.channelNumber !== undefined && e.channelNumber !== null) ? e.channelNumber : null;
    let canonicalTitle = (e && e.canonicalTitle) ? e.canonicalTitle : null;

    if (isChannel && (!channelIdentityKey || !canonicalTitle)) {
      const parsed = ChannelIdentityService.parseChannel(title, { group: e && (e.group || e.league) });
      if (!channelIdentityKey) channelIdentityKey = parsed.identityKey;
      if (channelNumber === null) channelNumber = parsed.channelNumber;
      if (!canonicalTitle) canonicalTitle = parsed.canonicalTitle;
    }

    return {
      id,
      category: rawCategory,
      date: _parseEventDate(e && e.date),
      teams: extractedTeams || fallbackTeams,
      tokens: new Set(_tokenizeF(normalized).filter(w => { const n = Number(w); return !(n >= 2000 && n <= 2100); })),
      norm: normalized.replace(/\s+/g, ' ').trim(),
      motorsportSeries,
      // Session is only ever read when BOTH sides of a comparison are
      // motorsport (_sameEventPre guard 3b), so non-motorsport rows carry the
      // placeholder and skip the session regex battery as well.
      motorsportSession: (isChannel || !isMotorsport) ? 'race' : _extractMotorsportSessionT(titleLower),
      // Extract digits from the NORMALIZED form so compound tokens like
      // "formulaone" don't leave a stray "1". Strip 4-digit calendar years
      // and day numbers following month names (e.g. October 15) so date
      // metadata does not act as a channel-number collision blocker.
      digits: isChannel ? '' : (normalized
        .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/gi, ' ')
        .match(/\d+/g) || [])
        .filter(d => { const n = Number(d); return !(n >= 2000 && n <= 2100); })
        .sort()
        .join(','),
      status: e && e.status ? String(e.status) : '',
      isReplay: !isChannel && ((e && e.status === 'finished') || id.startsWith('rz_') || id.startsWith('bv_') || id.startsWith('nfl_') || id.startsWith('sf_') || id.startsWith('livetv_') || id.startsWith('fr_') || id.startsWith('hr_')),
      isChannel,
      channelIdentityKey,
      channelNumber,
      canonicalTitle,
      league: e && e.league ? String(e.league).toLowerCase().trim() : '',
      group: (e && e.sources && e.sources[0] && (e.sources[0].group || e.sources[0].country))
        ? String(e.sources[0].group || e.sources[0].country).toLowerCase().trim()
        : (e && e.group ? String(e.group).toLowerCase().trim() : '')
    };
  }

  /**
   * Merge decision on precomputed matches. Same decision tree as before, with
   * two fixes found by A/B testing against the real catalog:
   *   - "Man United" style alias gap (same match, two catalog names)
   *   - channel-like titles (no team-vs-team parse) collapsing under a loose
   *     Jaccard rule ("Sky Sports F1" + "Sky Sports Main Event" merged;
   *     "US Open Court 13" + "Court 7" merged)
   */
  _normalizeCategory(c) {
    if (!c) return c;
    const lc = c.toLowerCase();
    if (['nbl', 'nba', 'wnba', 'euroleague', 'eurocup', 'fiba', 'ncaa_basketball'].includes(lc)) return 'basketball';
    if (['nfl', 'ncaa', 'cfl', 'college'].includes(lc)) return 'american_football';
    if (['nrl', 'super_league', 'afl', 'rugby_league', 'rugby_union', 'rugby15'].includes(lc)) return 'rugby';
    if (['mls', 'epl', 'la_liga', 'bundesliga', 'serie_a', 'ligue_1', 'ucl', 'uel', 'soccer', 'football'].includes(lc)) return 'football';
    if (['formula_1', 'formulaone', 'motogp', 'indycar', 'nascar'].includes(lc)) return 'motorsport';
    if (['mlb', 'npb'].includes(lc)) return 'baseball';
    if (['nhl', 'khl', 'ice hockey', 'ice_hockey', 'icehockey'].includes(lc)) return 'hockey';
    if (lc === 'networks') return 'networks';
    if (['sports', 'sport'].includes(lc)) return 'other';
    return lc;
  }

  _sameEventPre(p1, p2) {
    // 0. Static VOD Replays must NEVER merge with continuous 24/7 TV channels or live fixtures
    if ((p1.isReplay && (p2.isChannel || !p2.isReplay)) || (p2.isReplay && (p1.isChannel || !p1.isReplay))) {
      return false;
    }

    // 0b. Continuous 24/7 TV channels must NEVER merge with scheduled fixtures (and vice versa)
    if (Boolean(p1.isChannel) !== Boolean(p2.isChannel)) {
      return false;
    }

    // 0c. Continuous 24/7 TV channels: Universal Channel Identity.
    // Preserves channel numbers (e.g. Astro Cricket 1 vs 2 remain separate).
    // Aggregates regional, language, quality, and backup variants into one card.
    // Evaluated immediately to avoid fixture-specific guards (motorsport series, token length, date diffs).
    if (p1.isChannel && p2.isChannel) {
      // 1. Strict channel number protection: different numbers NEVER merge!
      if (p1.channelNumber !== p2.channelNumber) return false;

      // 2. Universal Channel Identity Key match
      if (p1.channelIdentityKey && p2.channelIdentityKey) {
        return p1.channelIdentityKey === p2.channelIdentityKey;
      }

      if (p1.norm === p2.norm) return true;
      return false;
    }

    // 1. Category mismatch guard
    // Some providers use league-specific slugs (nbl, nba, nfl, mls, nrl, afl)
    // while others use the parent sport name (basketball, american_football,
    // football, rugby). Normalise both to the parent before comparing so the
    // same fixture from two different providers isn't blocked by the guard.
    const _normalizeCategory = (c) => this._normalizeCategory(c);
    const c1 = _normalizeCategory(p1.category);
    const c2 = _normalizeCategory(p2.category);
    const isCollegeFootball = ((p1.category || '').toLowerCase() === 'college' && (c2 === 'american_football' || c2 === 'football')) ||
                              ((p2.category || '').toLowerCase() === 'college' && (c1 === 'american_football' || c1 === 'football'));
    if (c1 && c2 && c1 !== 'other' && c2 !== 'other' && c1 !== c2 && !isCollegeFootball) {
      return false;
    }

    // Motorsport cross-category guard: motorsport events must NEVER merge with non-motorsport events
    const isMoto1 = c1 === 'motorsport' || p1.motorsportSeries !== 'other';
    const isMoto2 = c2 === 'motorsport' || p2.motorsportSeries !== 'other';
    if ((isMoto1 && !isMoto2) || (!isMoto1 && isMoto2)) {
      return false;
    }

    // 2. Exact ID match
    if (p1.id && p2.id && p1.id === p2.id) return true;

    // 3. Date window & motorsport identity guards
    if (isMoto1 && isMoto2) {
      // 3a. Series isolation: different series never merge
      if (p1.motorsportSeries !== p2.motorsportSeries && p1.motorsportSeries !== 'other' && p2.motorsportSeries !== 'other') {
        return false;
      }
      // 3b. Session isolation: distinct sessions never merge
      if (p1.motorsportSession !== p2.motorsportSession) {
        return false;
      }
      // 3c. Date guard: date-0 or missing date cannot bypass date comparison
      if (!p1.date || !p2.date || p1.date <= 0 || p2.date <= 0) {
        if (p1.norm !== p2.norm) return false;
      } else if (Math.abs(p1.date - p2.date) > 48 * 3600 * 1000) {
        // Events > 48 hours apart never merge for motorsport
        return false;
      }
    } else {
      // Standard date window guard — events more than 24h apart (or 4 days for replays) are definitely different
      const maxDateDiff = (p1.isReplay && p2.isReplay) ? 345600000 : 86400000;
      if (p1.date && p2.date && Math.abs(p1.date - p2.date) > maxDateDiff) return false;
    }

    // 5. Dual-team extraction — if both titles parse as "team1 vs team2", require
    //    BOTH teams to independently fuzzy-match. (Skip for motorsport which has no teams).
    if (p1.teams && p2.teams && !isMoto1 && !isMoto2) {
      const fwd = _teamsSimilar(p1.teams[0], p2.teams[0]) && _teamsSimilar(p1.teams[1], p2.teams[1]);
      const rev = _teamsSimilar(p1.teams[0], p2.teams[1]) && _teamsSimilar(p1.teams[1], p2.teams[0]);
      return fwd || rev;
    }

    // 6. Channel-identity path — at least one title is not a team-vs-team fixture
    //    (24/7 channels, court/track numbered events, "Team Live" listings).
    if (p1.tokens.size === 0 || p2.tokens.size === 0) return false;

    // Digit signatures must agree: "beIN 1" vs "beIN 2", "Court 13" vs "Court 7"
    // are different channels/events even when the words are identical.
    if (!isMoto1 && !isMoto2) {
      if (p1.digits !== p2.digits) return false;
    }

    // 6a. One fixture + one channel-like listing: the channel-like tokens must be
    //     a subset of the fixture tokens ("Real Madrid live" ⊂ "Real Madrid vs
    //     Barcelona"). This keeps single-team listings merging with the fixture.
    if ((p1.teams || p2.teams) && !isMoto1 && !isMoto2) {
      const channel = p1.teams ? p2 : p1;
      const fixture = p1.teams ? p1 : p2;
      for (const w of channel.tokens) if (!fixture.tokens.has(w)) return false;
      return true;
    }

    if (p1.norm === p2.norm) return true;

    // 6c. Motorsport specific fallback: Formula 1, MotoGP, NASCAR, etc.
    // e.g. "RACE - F1 2026 - Singapore Grand Prix Full Race Replay" vs "Formula 1 Singapore Grand Prix 2026 Race Replay"
    if (isMoto1 && isMoto2) {
      const isGrandPrix = (t) => t.has('grandprix') || t.has('gp') || t.has('formulaone') || t.has('formulatwo') || t.has('formulathree') || t.has('formulafour') || t.has('formulae') || t.has('motogp') || t.has('moto2') || t.has('moto3') || t.has('nascar') || t.has('rally') || t.has('indycar') || t.has('dtm') || t.has('wsbk') || t.has('superbike');
      if (isGrandPrix(p1.tokens) && isGrandPrix(p2.tokens)) {
        const specificShared = [...p1.tokens].filter(x => p2.tokens.has(x) && !MOTORSPORT_GENERICS.has(x) && isNaN(x));
        if (specificShared.length >= 1) return true;
      }
      return false; // Motorsport never falls through to loose subset/Jaccard
    }

    // Subset check: if one token set is entirely contained in the other (minimum
    // 2 content tokens), the narrower title is a refinement of the broader one.
    // e.g. {"azerbaijan","grandprix"} ⊂ {"formulaone","azerbaijan","grandprix"}
    // This handles "Azerbaijan Grand Prix" vs "Formula 1 Azerbaijan Grand Prix".
    // Safety: Monaco GP and Azerbaijan GP share only "grandprix" (1 token) so
    // the minimum-2 guard keeps them separate.
    const smaller = p1.tokens.size <= p2.tokens.size ? p1 : p2;
    const larger  = p1.tokens.size <= p2.tokens.size ? p2 : p1;
    if (smaller.tokens.size >= 2) {
      let allIn = true;
      for (const w of smaller.tokens) { if (!larger.tokens.has(w)) { allIn = false; break; } }
      if (allIn) return true;
    }

    let common = 0;
    for (const w of p1.tokens) if (p2.tokens.has(w)) common++;
    const union = p1.tokens.size + p2.tokens.size - common;
    if (union > 0 && common / union >= 0.75) return true;
    return false;
  }

  /** Public API preserved: decision on raw matches (computes pre on the fly). */
  isSameEvent(e1, e2) {
    return this._sameEventPre(this._precompute(e1), this._precompute(e2));
  }

  /**
   * Merges two matching MatchEntity instances into one unified meta card.
   * Unifies sources, preserves canonical title, and ensures correct category.
   *
   * @param {MatchEntity} primary
   * @param {MatchEntity} secondary
   * @returns {MatchEntity}
   */
  mergeMatches(primary, secondary) {
    if (!primary) return secondary;
    if (!secondary) return primary;

    const p1 = this._precompute(primary);
    const p2 = this._precompute(secondary);

    const aliasIds = new Set([
      ...(primary.aliasIds || []),
      ...(secondary.aliasIds || [])
    ]);
    if (secondary.id && secondary.id !== primary.id) {
      aliasIds.add(secondary.id);
    }
    if (primary.id) {
      aliasIds.add(primary.id);
    }

    const merged = new MatchEntity({
      ...primary,
      aliasIds: Array.from(aliasIds),
      sources: [...(primary.sources || [])]
    });

    const getSourceKey = (s) => [
      s.source || '',
      s.id || '',
      s.streamSource || '',
      s.streamId || '',
      s.url || '',
      s.group || '',
      s.channelName || '',
      s.name || ''
    ].join('|');

    const existingSourceKeys = new Set(
      (merged.sources || []).map(getSourceKey)
    );

    if (Array.isArray(secondary.sources)) {
      for (const src of secondary.sources) {
        const key = getSourceKey(src);
        if (!existingSourceKeys.has(key)) {
          existingSourceKeys.add(key);
          merged.sources.push(src);
        }
      }
    }

    if (p1.isChannel || p2.isChannel) {
      merged.category = 'networks';
      const canonical = p1.canonicalTitle || p2.canonicalTitle || primary.canonicalTitle || secondary.canonicalTitle || primary.title;
      merged.title = canonical;
      merged.baseTitle = canonical;
      merged.canonicalTitle = canonical;
      merged.channelIdentityKey = p1.channelIdentityKey || p2.channelIdentityKey;
      merged.channelNumber = p1.channelNumber || p2.channelNumber;
    }

    return merged;
  }

  async _fetchProviderMatches(provider, shouldRecord = () => true) {
    const startedAt = Date.now();
    try {
      const matches = await provider.getMatches();
      if (this.providerHealthService && shouldRecord()) {
        this.providerHealthService.recordResult(provider, {
          matches,
          durationMs: Date.now() - startedAt,
        });
      }
      return matches;
    } catch (error) {
      if (this.providerHealthService && shouldRecord()) {
        this.providerHealthService.recordResult(provider, {
          matches: [],
          durationMs: Date.now() - startedAt,
          error,
        });
      }
      throw error;
    }
  }

  async syncMatches() {
    console.log('[MatchAggregator] Fetching from all providers...');
    if (this.providerHealthService) this.providerHealthService.startSync();
    const finalMatches = [];
    const finalPres = []; // precomputed identity for each accepted match
    const idIndex = new Map(); // exact ID/alias -> index in finalMatches
    // Parallel per-index Sets (source identity keys / alias ids) so merges
    // dedupe via O(1) hash lookups instead of O(S_in x S_exist) comparator
    // scans and O(A) aliasIds.includes() walks.
    const finalSourceKeySets = [];
    const finalAliasSets = [];
    const categoryBuckets = new Map(); // normalized sport category -> array of finalMatches indices

    // Index previous sync kickoff dates to resolve dateless scrapes (e.g. highfly/leaf, ak47 playlists)
    const prevDateMap = new Map();
    try {
      // Pure reads below — the read-only snapshot avoids a full-catalog clone.
      const prevMatches = (this.cacheService && typeof this.cacheService.getMatchesReadOnly === 'function')
        ? (this.cacheService.getMatchesReadOnly() || [])
        : ((this.cacheService && typeof this.cacheService.getMatches === 'function')
            ? (this.cacheService.getMatches() || [])
            : []);
      for (const pm of prevMatches) {
        if (!pm || !pm.date || pm.date === '0') continue;
        const pmDateMs = _parseEventDate(pm.date);
        if (!pmDateMs) continue;
        if (pm.id) prevDateMap.set(pm.id, String(pmDateMs));
        if (Array.isArray(pm.aliasIds)) {
          for (const aid of pm.aliasIds) if (aid) prevDateMap.set(aid, String(pmDateMs));
        }
      }
    } catch (_) {}

    // ─── HIGH PERFORMANCE DSA INDICES ──────────────────────────────────────────
    // 1. O(1) Channel Index: 24/7 channels match strictly on normalized title
    //    signature (p.norm). Indexing them eliminates ~8,000,000 unnecessary
    //    pairwise comparisons across thousands of TV channels.
    const channelNormIndex = new Map(); // p.norm -> finalMatches index

    // 2. Multi-Token Inverted Index: maps significant non-trivial title/team tokens
    //    to the set of finalMatches indices containing them. Dual-team fixtures and
    //    discrete events query this to test ONLY the candidate matches sharing
    //    at least 1-2 content words, dropping comparison time from O(N^2) to O(N).
    const tokenIndex = new Map(); // token -> Set of finalMatches indices

    // The merge scan is O(incoming x accepted). At production scale one
    // provider's rows used to land as a single ~200ms synchronous block on the
    // event loop; every HTTP request queued behind it. Process rows in small
    // chunks and yield between chunks (setImmediate lets pending I/O callbacks
    // and queued request handlers run) so no single block exceeds ~20ms.
    const MERGE_CHUNK = Number(process.env.MERGE_CHUNK_SIZE || 25);
    const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

    const processProviderMatches = async (providerMatches) => {
      if (!providerMatches || !Array.isArray(providerMatches)) return;
      for (let start = 0; start < providerMatches.length; start += MERGE_CHUNK) {
        const end = Math.min(start + MERGE_CHUNK, providerMatches.length);
        for (let r = start; r < end; r++) {
          const match = providerMatches[r];
          if (!match.id || !match.title) continue;
          if (!match.sources || !Array.isArray(match.sources) || match.sources.length === 0) continue;

          // Reconcile missing kickoff dates from previous sync cache or embedded ID timestamps
          if (!match.date || match.date === '0' || match.date === 0) {
            if (prevDateMap.has(match.id)) {
              match.date = prevDateMap.get(match.id);
            } else if (Array.isArray(match.aliasIds)) {
              for (const aid of match.aliasIds) {
                if (prevDateMap.has(aid)) {
                  match.date = prevDateMap.get(aid);
                  break;
                }
              }
            } else {
              const tsMatch = String(match.id).match(/[-_](1\d{9}|1\d{12})$/);
              if (tsMatch) {
                const tsVal = Number(tsMatch[1]);
                const epochMs = tsMatch[1].length === 10 ? tsVal * 1000 : tsVal;
                if (epochMs > 0 && Number.isFinite(epochMs)) match.date = String(epochMs);
              }
            }
          }

        const pre = this._precompute(match);
        let idx = -1;

        // 1. Fast O(1) Exact ID & Alias check with identity verification
        let candIdx = -1;
        if (match.id && idIndex.has(match.id)) {
          candIdx = idIndex.get(match.id);
        } else if (Array.isArray(match.aliasIds)) {
          for (const aid of match.aliasIds) {
            if (aid && idIndex.has(aid)) {
              candIdx = idIndex.get(aid);
              break;
            }
          }
        }
        if (candIdx !== -1) {
          if (this._sameEventPre(finalPres[candIdx], pre)) {
            idx = candIdx;
          }
        }

        // 2. Fast O(1) Channel Lookup
        // For continuous 24/7 network channels, channel identity requires universal channel identity key
        // or normalized title match (pre.norm). Lookup directly in O(1).
        if (idx === -1 && pre.isChannel) {
          let candidateIdx = -1;
          if (pre.channelIdentityKey && channelNormIndex.has(pre.channelIdentityKey)) {
            candidateIdx = channelNormIndex.get(pre.channelIdentityKey);
          } else if (pre.norm && channelNormIndex.has(pre.norm)) {
            candidateIdx = channelNormIndex.get(pre.norm);
          }
          if (candidateIdx !== -1 && this._sameEventPre(finalPres[candidateIdx], pre)) {
            idx = candidateIdx;
          }
        }

        // 3. Fast Multi-Token Inverted Index (Dual-Teams & Fixtures)
        // Two sporting events can ONLY merge if they share at least one non-trivial team/title token.
        // Intersect inverted index entries to evaluate ONLY high-probability candidate twins.
        if (idx === -1 && !pre.isChannel) {
          const candidateCounts = new Map();
          for (const tok of pre.tokens) {
            if (STOP_WORDS.has(tok) || tok.length < 3) continue;
            const set = tokenIndex.get(tok);
            if (!set) continue;
            for (const cIdx of set) {
              candidateCounts.set(cIdx, (candidateCounts.get(cIdx) || 0) + 1);
            }
          }

          if (candidateCounts.size > 0) {
            // Sort candidate matches by shared token count descending (strongest twins first)
            const sortedCandidates = Array.from(candidateCounts.entries())
              .sort((a, b) => b[1] - a[1]);

            for (const [cIdx, sharedCount] of sortedCandidates) {
              // If fixture has multiple tokens, require at least 2 shared tokens to test
              if (sharedCount < 2 && pre.tokens.size > 2) continue;
              const pCand = finalPres[cIdx];
              // Date-window early exit: events > 24 hours apart (or 4 days for replays) never merge
              const maxDateDiff = (pre.isReplay && pCand.isReplay) ? 345600000 : 86400000;
              if (pre.date && pCand.date && Math.abs(pre.date - pCand.date) > maxDateDiff) continue;
              if (this._sameEventPre(pCand, pre)) {
                idx = cIdx;
                break;
              }
            }
          }
        }

        // 4. Narrow Category Bucket Fallback
        // Handles unindexed edge-cases (single generic word titles or motorsport races without teams).
        // 24/7 continuous TV channels are indexed strictly in O(1) channelNormIndex and NEVER fall through to linear scans.
        if (idx === -1 && !pre.isChannel) {
          const c2 = this._normalizeCategory(pre.category);
          const rawCat2 = (pre.category || '').toLowerCase();
          const isCollegeFootball2 = rawCat2 === 'college' || c2 === 'american_football' || c2 === 'football';

          if (c2 === 'other' || !c2) {
            // 'other' cross-matches with date window guard
            for (let i = finalMatches.length - 1; i >= 0; i--) {
              const pCand = finalPres[i];
              if (pCand.isChannel) continue;
              const maxDateDiff = (pre.isReplay && pCand.isReplay) ? 345600000 : 86400000;
              if (pre.date && pCand.date && Math.abs(pre.date - pCand.date) > maxDateDiff) continue;
              if (this._sameEventPre(pCand, pre)) { idx = i; break; }
            }
          } else {
            const checkedIndices = new Set();
            const bucketsToCheck = [categoryBuckets.get(c2), categoryBuckets.get('other')];
            if (isCollegeFootball2) {
              bucketsToCheck.push(categoryBuckets.get('college'), categoryBuckets.get('american_football'), categoryBuckets.get('football'));
            }

            for (let bIdx = 0; bIdx < bucketsToCheck.length; bIdx++) {
              const b = bucketsToCheck[bIdx];
              if (!b) continue;
              for (let j = b.length - 1; j >= 0; j--) {
                const i = b[j];
                if (checkedIndices.has(i)) continue;
                checkedIndices.add(i);
                const pCand = finalPres[i];
                if (pCand.isChannel) continue;
                const maxDateDiff = (pre.isReplay && pCand.isReplay) ? 345600000 : 86400000;
                if (pre.date && pCand.date && Math.abs(pre.date - pCand.date) > maxDateDiff) continue;
                if (this._sameEventPre(pCand, pre)) {
                  idx = i;
                  break;
                }
              }
              if (idx !== -1) break;
            }
          }
        }

        if (idx === -1) {
          // If a standalone replay match has no date, give it today's date (YYYY-MM-DD)
          // so it sorts at the top of replays and is accessible via date filters/hubs
          if (!match.date && pre.isReplay) {
            match.date = new Date().toISOString().slice(0, 10);
            pre.date = new Date(match.date).getTime();
          }
          const newIdx = finalMatches.length;
          finalMatches.push(match);
          finalPres.push(pre);
          finalSourceKeySets.push(new Set((match.sources || []).map(sourceIdentityKey)));
          finalAliasSets.push(new Set(Array.isArray(match.aliasIds) ? match.aliasIds.filter(Boolean) : []));

          if (match.id) idIndex.set(match.id, newIdx);
          if (Array.isArray(match.aliasIds)) {
            for (const aid of match.aliasIds) if (aid) idIndex.set(aid, newIdx);
          }

          // Register in O(1) Channel Index
          if (pre.isChannel) {
            if (pre.channelIdentityKey) {
              channelNormIndex.set(pre.channelIdentityKey, newIdx);
            }
            if (pre.norm) {
              channelNormIndex.set(pre.norm, newIdx);
            }
          }

          // Register in Multi-Token Inverted Index
          if (!pre.isChannel) {
            for (const tok of pre.tokens) {
              if (STOP_WORDS.has(tok) || tok.length < 3) continue;
              if (!tokenIndex.has(tok)) tokenIndex.set(tok, new Set());
              tokenIndex.get(tok).add(newIdx);
            }
          }

          const normCat = this._normalizeCategory(match.category) || 'other';
          if (!categoryBuckets.has(normCat)) categoryBuckets.set(normCat, []);
          categoryBuckets.get(normCat).push(newIdx);

          const rawCat = (match.category || '').toLowerCase();
          if (rawCat === 'college' && normCat !== 'college') {
            if (!categoryBuckets.has('college')) categoryBuckets.set('college', []);
            categoryBuckets.get('college').push(newIdx);
          }
          continue;
        }

        const existing = finalMatches[idx];
        if (!existing.aliasIds) existing.aliasIds = [];
        const aliasSet = finalAliasSets[idx] || (finalAliasSets[idx] = new Set(existing.aliasIds));
        if (match.id && !aliasSet.has(match.id)) {
          aliasSet.add(match.id);
          existing.aliasIds.push(match.id);
          idIndex.set(match.id, idx);
        }
        if (Array.isArray(match.aliasIds)) {
          for (const aid of match.aliasIds) {
            if (aid && !aliasSet.has(aid)) {
              aliasSet.add(aid);
              existing.aliasIds.push(aid);
              idIndex.set(aid, idx);
            }
          }
        }
        if (match.sources && Array.isArray(match.sources)) {
          const keySet = finalSourceKeySets[idx] || (finalSourceKeySets[idx] = new Set(existing.sources.map(sourceIdentityKey)));
          for (const src of match.sources) {
            const key = sourceIdentityKey(src);
            if (!keySet.has(key)) {
              keySet.add(key);
              existing.sources.push(src);
            }
          }
        }
        if (match.popular === '1') existing.popular = '1';
        if (!existing.poster && match.poster && !match.poster.includes('ppvservices.st') && !match.poster.includes('unique-tournament') && !match.poster.includes('ondemand.st')) existing.poster = match.poster;
        if (!existing.logo && match.logo && !match.logo.includes('ppvservices.st') && !match.logo.includes('unique-tournament') && !match.logo.includes('ondemand.st')) existing.logo = match.logo;
        if (!existing.thumbnail_url && match.thumbnail_url && !match.thumbnail_url.includes('ppvservices.st') && !match.thumbnail_url.includes('unique-tournament') && !match.thumbnail_url.includes('ondemand.st')) existing.thumbnail_url = match.thumbnail_url;
        if (existing.category === 'networks' || match.category === 'networks') existing.poster = '';
        // Carry a live score across the merge the same way artwork is carried.
        // A later provider that reports a score wins over an earlier blank.
        if (!existing.score && match.score) existing.score = match.score;
        if (!existing.date && match.date) existing.date = match.date;
        if (!existing.background && match.background) existing.background = match.background;
        if (!existing.league && match.league) existing.league = match.league;
        if (!existing.team1 && match.team1) existing.team1 = match.team1;
        else if (existing.team1 && !existing.team1.logo && match.team1 && match.team1.logo) existing.team1.logo = match.team1.logo;
        if (!existing.team2 && match.team2) existing.team2 = match.team2;
        else if (existing.team2 && !existing.team2.logo && match.team2 && match.team2.logo) existing.team2.logo = match.team2.logo;
        if (existing.description === 'No description' && match.description && match.description !== 'No description') {
          existing.description = match.description;
        }

        // Prefer specific 'college' category if any merged source has it
        if (existing.category !== 'college' && match.category === 'college') {
          existing.category = 'college';
          finalPres[idx].category = 'college';
          if (!categoryBuckets.has('college')) categoryBuckets.set('college', []);
          categoryBuckets.get('college').push(idx);
        }

        // Reconcile kickoff date: if existing date is missing or 0, adopt incoming date.
        // Also prefer high-precision epoch ms from dedicated event providers (e.g. streamedpk)
        // over coarse dates.
        const existingDateMs = _parseEventDate(existing.date);
        const incomingDateMs = _parseEventDate(match.date);
        if ((!existingDateMs || existingDateMs <= 0) && incomingDateMs > 0) {
          existing.date = match.date;
          finalPres[idx].date = incomingDateMs;
        } else if (existingDateMs > 0 && incomingDateMs > 0 && match.sources && match.sources.some(s => s.source === 'streamedpk')) {
          existing.date = match.date;
          finalPres[idx].date = incomingDateMs;
        }

        // Canonical naming: prefer a team-vs-team fixture title over a
        // channel-like listing title, so the merged event keeps the most
        // informative name regardless of which provider arrived first.
        // Never overwrite motorsport titles with incoming secondary titles.
        if (!existing._titleIsFixture && pre.teams && pre.motorsportSeries === 'other' && existing.category !== 'motorsport') {
          existing.title = match.title;
          existing._titleIsFixture = true;
          finalPres[idx] = pre;
        } else if (pre.isChannel && finalPres[idx].isChannel) {
          existing.category = 'networks';
          const targetCanonicalTitle = existing.canonicalTitle || pre.canonicalTitle;
          if (targetCanonicalTitle) {
            existing.title = targetCanonicalTitle;
            existing.baseTitle = targetCanonicalTitle;
            existing.canonicalTitle = targetCanonicalTitle;
            existing._canonicalTitleSet = true;
          }
          if (!existing.channelIdentityKey && pre.channelIdentityKey) existing.channelIdentityKey = pre.channelIdentityKey;
          if (!existing.channelNumber && pre.channelNumber) existing.channelNumber = pre.channelNumber;
          if (pre.channelIdentityKey && !channelNormIndex.has(pre.channelIdentityKey)) {
            channelNormIndex.set(pre.channelIdentityKey, idx);
          }
          if (pre.norm && !channelNormIndex.has(pre.norm)) {
            channelNormIndex.set(pre.norm, idx);
          }
        }
        }
        if (end < providerMatches.length) await yieldToLoop();
      }
    };

    // Providers swallow their own errors and return []. A non-empty result is the
    // only reliable success signal; it keeps a total upstream outage from wiping the cache.
    let anyProviderSucceeded = false;

    // ── 12-Hour Replay Cadence ──────────────────────────────────────────────
    // Replay events (ReplayZone, LiveTV & SoccerFull archives) are static past fixtures.
    // Re-scraping mirrors and archive pages on every server restart
    // or sync burns significant CPU, network, and RAM. Reuse cached replays if they
    // were synced within the last 12 hours.
    const REPLAY_PROVIDERS = new Set(['replayzone', 'livetv', 'soccerfull', 'basketballvideo', 'nflvideo', 'fullraces', 'hockeyreplays', 'mlblive']);
    const REPLAY_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

    const previousRO = (this.cacheService && typeof this.cacheService.getMatchesReadOnly === 'function')
      ? (this.cacheService.getMatchesReadOnly() || [])
      : ((this.cacheService && typeof this.cacheService.getMatches === 'function')
          ? (this.cacheService.getMatches() || [])
          : []);

    // Cache-derived rows are merged (mutated) by the loop below and enriched
    // after the sync, so they enter as copy-on-write clones: the row plus its
    // alias/source ARRAYS and the two team objects, WITHOUT cloning each
    // source object (a sync only ever appends sources; it never mutates one).
    // This replaces the old full deep-clone of the entire catalog that
    // getMatches() performed on every sync.
    const cloneRowForSync = (m) => ({
      ...m,
      aliasIds: Array.isArray(m.aliasIds) ? [...m.aliasIds] : m.aliasIds,
      sources: Array.isArray(m.sources) ? [...m.sources] : m.sources,
      team1: (m.team1 && typeof m.team1 === 'object') ? { ...m.team1 } : m.team1,
      team2: (m.team2 && typeof m.team2 === 'object') ? { ...m.team2 } : m.team2,
    });

    // Sanitize cached replays while cloning: purge non-replay sources (e.g.
    // sktech/daddylive feeds mistakenly attached in past runs).
    const previousReplays = [];
    for (const m of previousRO) {
      if (!m || !Array.isArray(m.sources)) continue;
      const hasReplaySource = m.sources.some(s => s && REPLAY_PROVIDERS.has(s.source));
      if (!hasReplaySource) continue;
      const hasForeignSource = m.sources.some(s => s && !REPLAY_PROVIDERS.has(s.source));
      previousReplays.push(hasForeignSource
        ? { ...cloneRowForSync(m), sources: m.sources.filter(s => s && REPLAY_PROVIDERS.has(s.source)) }
        : cloneRowForSync(m));
    }

    const cachedProviderCounts = new Map();
    if (previousReplays.length > 0) {
      for (const m of previousReplays) {
        if (Array.isArray(m.sources)) {
          for (const s of m.sources) {
            if (s && s.source) {
              cachedProviderCounts.set(s.source, (cachedProviderCounts.get(s.source) || 0) + 1);
            }
          }
        }
      }
    }

    const isReplayFresh = previousReplays.length > 0 && this.lastReplaySync && (Date.now() - this.lastReplaySync < REPLAY_SYNC_INTERVAL_MS);

    if (isReplayFresh) {
      console.log(`[MatchAggregator] Reusing ${previousReplays.length} cached replay events (synced ${Math.round((Date.now() - this.lastReplaySync) / 60000)}m ago; 12h cadence).`);
      await processProviderMatches(previousReplays);
      if (this.providerHealthService) {
        for (const provider of this.providers) {
          const name = provider && (provider.sourceName || provider.name || '');
          if (!REPLAY_PROVIDERS.has(name)) continue;
          const count = cachedProviderCounts.get(name) || 0;
          if (count > 0) {
            this.providerHealthService.recordCached(provider, count, 'Fresh replay cache reused');
          }
        }
      }
      anyProviderSucceeded = true;
    } else {
      this.lastReplaySync = Date.now();
    }

    const providersToQuery = this.providers.filter(p => {
      if (!p) return false;
      const name = p.sourceName || p.name || '';
      // Only skip replay provider if it was already present in fresh cache
      if (REPLAY_PROVIDERS.has(name) && isReplayFresh && (cachedProviderCounts.get(name) || 0) > 0) {
        return false;
      }
      return true;
    });

    if (process.env.LOW_MEMORY_MODE === 'true') {
      // Memory-safe sequential fetching (Alwaysdata)
      for (const p of providersToQuery) {
        try {
          const providerMatches = await this._fetchProviderMatches(p);
          if (Array.isArray(providerMatches) && providerMatches.length > 0) anyProviderSucceeded = true;
          await processProviderMatches(providerMatches);
        } catch (err) {
          console.error(`[MatchAggregator] Provider fetch failed:`, err.message);
        }
      }
    } else {
      // Fast parallel fetching (Render / Local)
      // A provider that never settles used to hang the whole sync: allSettled waits
      // forever, CronService.syncing is only cleared in finally, and every later
      // sync (4-hourly cron and stale-while-revalidate) returns immediately at the
      // top of runSync(). Observed on production 2026-10-27: sktech never settled,
      // the sync sat in "running" for 16 h and the catalogue stayed frozen. Bound
      // each provider so one hang costs that provider's data, not the refresh.
      const configuredTimeout = Number(process.env.PROVIDER_SYNC_TIMEOUT_MS || 180000);
      const PROVIDER_SYNC_TIMEOUT_MS = Number.isFinite(configuredTimeout) ? Math.min(2147483647, Math.max(5000, configuredTimeout)) : 180000;
      const withProviderTimeout = (provider) => {
        let timer = null;
        let current = true;
        const startedAt = Date.now();
        const limit = new Promise((resolve) => {
          timer = setTimeout(() => {
            current = false;
            const name = (provider && (provider.sourceName || provider.name || provider.id)) || 'unknown';
            const error = new Error('provider sync timeout');
            console.warn('[MatchAggregator] provider ' + name + ' exceeded ' + PROVIDER_SYNC_TIMEOUT_MS + 'ms during sync; continuing without it');
            try { this.providerHealthService?.recordResult(provider, { matches: [], durationMs: Date.now() - startedAt, error }); } catch (_) {}
            resolve({ status: 'rejected', reason: error });
          }, PROVIDER_SYNC_TIMEOUT_MS);
          if (timer && typeof timer.unref === 'function') timer.unref();
        });
        const work = this._fetchProviderMatches(provider, () => current).finally(() => { if (timer) clearTimeout(timer); });
        return Promise.race([work, limit]);
      };

      const results = await Promise.allSettled(providersToQuery.map(withProviderTimeout));
      for (let index = 0; index < results.length; index++) {
        const promiseResult = results[index];
        if (promiseResult.status === 'fulfilled') {
          if (Array.isArray(promiseResult.value) && promiseResult.value.length > 0) anyProviderSucceeded = true;
          await processProviderMatches(promiseResult.value);
        } else {
          console.error(`[MatchAggregator] Provider ${index} failed:`, promiseResult.reason);
        }
      }
    }

    const now = Date.now();
    // Smart Trending Engine: Boost popular matches globally, but only if they are actually live or starting soon
    const TRENDING_KEYWORDS = ['bein', 'real madrid', 'barcelona', 'manchester', 'arsenal', 'liverpool', 'chelsea', 'bayern', 'psg', 'lakers', 'warriors', 'mcgregor', 'super bowl', 'champions league', 'el clasico', 'f1', 'formula 1', 'grand prix'];

    finalMatches.forEach(match => {
      const titleLower = match.title.toLowerCase();

      // Parse kickoff date (default to 0 if none provided, assume live)
      let kickoff = 0;
      if (match.date) {
        const parsed = Number(match.date);
        kickoff = isNaN(parsed) ? new Date(match.date).getTime() : parsed;
        if (isNaN(kickoff)) kickoff = 0;
      }
      // Allow matches to be flagged as 'Live' from 3 hours before kickoff up to 14 hours after kickoff
      const isWithinTimeWindow = kickoff === 0 || (now >= kickoff - (3 * 3600 * 1000) && now <= kickoff + (14 * 3600 * 1000));

      if (TRENDING_KEYWORDS.some(kw => titleLower.includes(kw))) {
        if (isWithinTimeWindow) {
          match.popular = '1';
        }
      }

      // GLOBAL FIX: Some providers (like Streamed.pk) flag future events as popular/live early.
      // We must override and strip the popular flag if the event is too far in the future.
      if (match.popular === '1' && kickoff > 0 && !isWithinTimeWindow) {
        match.popular = '0';
      }
    });

    // Filter out matches that have 0 sources or are already over (kickoff was > 24 hours ago)
    const activeMatches = finalMatches.filter(match => {
      if (!match.sources || !Array.isArray(match.sources) || match.sources.length === 0) {
        return false;
      }
      let kickoff = 0;
      if (match.date) {
        const parsed = Number(match.date);
        kickoff = isNaN(parsed) ? new Date(match.date).getTime() : parsed;
        if (isNaN(kickoff)) kickoff = 0;
      }
      if (kickoff === 0) return true; // Keep if we don't know the time

      // Keep matches up to 24 hours after kickoff. ReplayZone entries are
      // archive sessions rather than fixtures, so they get an explicit, bounded
      // retention window instead of an open-ended exemption.
      const expiryWindowMs = 24 * 3600 * 1000;
      const replayExpiryWindowMs = REPLAY_RETENTION_DAYS * 24 * 3600 * 1000;
      const isReplayZone = match.sources && match.sources.some(s => s.source === 'replayzone' || s.source === 'livetv' || s.source === 'soccerfull' || s.source === 'basketballvideo' || s.source === 'nflvideo' || s.source === 'fullraces');
      const windowMs = isReplayZone ? replayExpiryWindowMs : expiryWindowMs;
      return now <= kickoff + windowMs;
    });

    console.log(`[MatchAggregator] Sync complete. Merged ${activeMatches.length} active events.`);
    // ── Provider carry-forward ──────────────────────────────────────────────
    // The cache below is written whenever ANY provider succeeded, so a single
    // provider that blips silently loses every one of its rows. DaddyLive is the
    // observed case: its schedule fetch uses a hard 6s timeout, and on a loaded
    // host it intermittently times out, which used to wipe all ~700 DaddyLive
    // entries from the cache. The catalog then showed NO DaddyLive rows for the
    // whole 4h sync interval (reproduced on production: 132 dlv rows at 01:30,
    // 0 rows at 01:34 after an automatic re-sync).
    //
    // Instead of dropping them, carry forward the provider's still-valid entries
    // from the PREVIOUS cache. Bounded deliberately:
    //   - only for a provider that returned NOTHING this round (a real outage
    //     still surfaces as an outage once the carried entries age out);
    //   - only entries still inside the normal retention window, so we never
    //     resurrect finished events;
    //   - hard capped, so a long outage cannot grow the cache without limit.
    //
    // Priority ordering before the cap (DaddyLive ~914 entries; cap was 400 so
    // live/upcoming fixtures at positions 500+ were silently dropped during outages --
    // observed in production: dlv future-dated entries went 914 --> 0):
    //   0 live now          kickoff <= now <= kickoff + 14h (matches the live window)
    //   1 upcoming          kickoff > now, sorted soonest-first
    //   2 evergreen         no parseable date (24/7 channels)
    //   3 past-in-retention kickoff already passed but still inside 24h window
    // Entries within each priority tier retain their original relative order (stable sort).
    try {
      const CARRY_FORWARD_PROVIDERS = ['daddylive'];
      const CARRY_FORWARD_MAX = Number(process.env.CARRY_FORWARD_MAX || 600);
      const nowForCarry = Date.now();
      const retentionMs = 24 * 3600 * 1000;

      const usedProvider = (provider) => finalMatches.some((m) =>
        Array.isArray(m.sources) && m.sources.some((s) => s && s.source === provider));

        let previous = [];
        try {
          previous = (this.cacheService.getMatchesReadOnly ? this.cacheService.getMatchesReadOnly() : this.cacheService.getMatches()) || [];
        } catch (_) { previous = []; }
        const presentIds = new Set(activeMatches.map((m) => m && m.id).filter(Boolean));

      for (const provider of CARRY_FORWARD_PROVIDERS) {
        // 'Provider answered' is not enough to decide health: a provider can
        // return PARTIAL data and still be broken. DaddyLive is the case that
        // proved it - it always returns 24/7 channel rows, even when the
        // schedule fetch fails, so it always looked 'healthy' while every
        // fixture was being lost (observed: channels 651, fixtures 0).
        //
        // So: prefer the provider's own declaration when it publishes one.
        // A provider whose SCHEDULE broke is treated as not-answered, and its
        // previous rows are carried forward.
        const scheduleBrokeFor = (srcName) => this.providers.some((p) =>
          p && p.sourceName === srcName && p.lastScheduleOk === false);

        if (usedProvider(provider) && !scheduleBrokeFor(provider)) continue; // provider answered fully; nothing to carry

        if (scheduleBrokeFor(provider)) {
          console.warn(`[MatchAggregator] ${provider} schedule fetch failed this sync; carrying forward its previous entries.`);
        }

        // Priority is pure per-entry data: decorate once (Schwartzian transform)
        // instead of recomputing date parses and regexes inside every one of
        // the O(N log N) comparator calls.
        const _priority = (m) => {
          const rawDate = m.date;
          const isChannelOrNetwork = m.category === 'networks' || Boolean(m.isChannel) || Boolean(m.is247) || (typeof m.id === 'string' && (m.id.startsWith('cdn_ch_') || m.id.startsWith('dlv_ch_') || m.id.startsWith('sktech_ch_') || m.id.startsWith('vavoo_ch_')));
          const isEvergreen = isChannelOrNetwork && (rawDate == null || rawDate === '' || /^0+$/.test(String(rawDate).trim()));
          if (isEvergreen) return { bucket: 2, kickoff: 0 };
          const kickoff = _parseEventDate(rawDate);
          if (!kickoff) return { bucket: 3, kickoff: 0 };
          const LIVE_WINDOW_MS = 14 * 3600 * 1000;
          if (kickoff <= nowForCarry && nowForCarry <= kickoff + LIVE_WINDOW_MS) return { bucket: 0, kickoff };
          if (kickoff > nowForCarry) return { bucket: 1, kickoff };
          return { bucket: 3, kickoff };
        };

        const carried = previous.filter((m) => {
          if (!m || !m.id || presentIds.has(m.id)) return false;
          if (!Array.isArray(m.sources) || !m.sources.some((s) => s && s.source === provider)) return false;
          // Date-less rows are 24/7 channels: evergreen, always keep.
          //
          // The '0'/'00' sentinel matters: _parseEventDate('0') is NOT 0, because
          // its Date.parse fallback reads the bare string "0" as the year 2000.
          // That made a 24/7 channel look ~26 years stale and get dropped. Guard
          // the sentinel explicitly, exactly as catalog.getKickoff does, and only
          // then consult the parser.
          const rawDate = m.date;
          const isChannelOrNetwork = m.category === 'networks' || Boolean(m.isChannel) || Boolean(m.is247) || (typeof m.id === 'string' && (m.id.startsWith('cdn_ch_') || m.id.startsWith('dlv_ch_') || m.id.startsWith('sktech_ch_') || m.id.startsWith('vavoo_ch_')));
          const isEvergreen = isChannelOrNetwork && (rawDate == null || rawDate === '' || /^0+$/.test(String(rawDate).trim()));
          if (isEvergreen) return true;
          const kickoff = _parseEventDate(rawDate);
          if (!kickoff) return false; // Non-channel fixtures without a kickoff date cannot be evergreen
          return nowForCarry <= kickoff + retentionMs;
        }).map((m) => ({ m, p: _priority(m) })).sort((a, b) => {
          if (a.p.bucket !== b.p.bucket) return a.p.bucket - b.p.bucket;
          // Within bucket 1 (upcoming) sort soonest-first so the nearest
          // fixtures survive the cap; other buckets keep insertion order (0).
          if (a.p.bucket === 1) return a.p.kickoff - b.p.kickoff;
          return 0;
        }).map((d) => d.m).slice(0, CARRY_FORWARD_MAX);

        if (carried.length > 0) {
          // Clone-on-admit: carried rows are live cache objects, and the
          // backfill/enrichment passes below mutate rows in activeMatches.
          activeMatches.push(...carried.map(cloneRowForSync));
          console.warn(`[MatchAggregator] ${provider} returned nothing this sync; carried forward ${carried.length} entry(ies) from the previous cache.`);
        } else {
          console.warn(`[MatchAggregator] ${provider} returned nothing this sync and no valid entries were available to carry forward.`);
        }
        if (this.providerHealthService) this.providerHealthService.recordCarryForward(provider, carried.length);
      }
    } catch (carryErr) {
      console.error('[MatchAggregator] Provider carry-forward failed:', carryErr.message);
    }

    if (anyProviderSucceeded) {
      // Backfill competitors derived from the title before persisting. Providers
      // that publish a head-to-head title without team1/team2 (tennis singles,
      // some cup ties) were otherwise invisible to crest enrichment, so their
      // crests were never warmed and the card had no fixture shape on first
      // render. With the names present the enrichment pass below covers them and
      // the names survive into the persisted cache.
      let backfilled = 0;
      for (const m of activeMatches) {
        if (!m || (m.team1 && m.team2)) continue;
        const derived = extractTeamsFromTitle(m.title);
        if (!derived) continue;
        if (!m.team1) m.team1 = { name: derived[0] };
        if (!m.team2) m.team2 = { name: derived[1] };
        backfilled++;
      }
      if (backfilled > 0) {
        console.log(`[MatchAggregator] Derived competitors for ${backfilled} title-only fixture(s).`);
      }

      // Enrich active fixtures with high-definition 1080p Vavoo broadcast feeds
      this._enrichMatchesWithBroadcasters(activeMatches);

      this.cacheService.setMatches(activeMatches);
      if (this.providerHealthService) {
        this.providerHealthService.finishSync({ matchCount: activeMatches.length, succeeded: true });
      }

      if (this.teamLogoService) {
        // Asynchronously enrich live & upcoming matches with team badges without delaying sync
        // Previously capped at 50, so on a ~600-match catalog most fixtures never had
// their crest warmed and rendered crest-less. enrichMatch is I/O bound but runs
// concurrently and is fire-and-forget, and TeamLogoService negative-caches
// misses, so a much larger window is safe.
        // Channel/24-7 rows have no team1, so they were never warmed even though the
        // live lookup resolves most of them. Include them via their title.
        const enrichable = activeMatches.filter(m => {
          if (m.category === 'networks' || (!m.team1 && !m.team2)) return !!m.title && !m.logo;
          return (m.team1 && m.team1.name && !m.team1.logo) || !m.logo;
        }).slice(0, 600);
        // Bounded pool instead of an unbounded allSettled fan-out: 600
        // simultaneous lookups fire a burst of TLS handshakes and JSON parses
        // onto this worker right after every sync — exactly when user requests
        // are already queued. A small pool keeps the enrichment throughput
        // while capping its event-loop and socket pressure. Tune with
        // LOGO_ENRICH_CONCURRENCY if needed.
        const ENRICH_CONCURRENCY = Math.max(1, Number(process.env.LOGO_ENRICH_CONCURRENCY || 8));
        let queueCursor = 0;
        const enrichWorker = async () => {
          while (queueCursor < enrichable.length) {
            const m = enrichable[queueCursor++];
            if (!m) break;
            try { await this.teamLogoService.enrichMatch(m); } catch (_) {}
          }
        };
        Promise.all(
          Array.from({ length: Math.min(ENRICH_CONCURRENCY, enrichable.length) }, enrichWorker)
        ).catch(() => {});
      }

      return activeMatches;
    }
    if (this.providerHealthService) {
      this.providerHealthService.finishSync({ matchCount: 0, succeeded: false });
    }
    return null;
  }
}

module.exports = MatchAggregator;
module.exports._internal = { _compoundify, _stripNoise, _tokenize, _teamsSimilar, _tryExtractTeams };
