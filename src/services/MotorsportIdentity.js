'use strict';

const { parseTimezone } = require('../timezone');

function foldMotorsportText(s) {
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

// Every non-'other' branch of extractMotorsportSeriesT requires one of these
// keywords in the title or league, so their absence proves the result is
// 'other' and the regex battery can be skipped.
const MOTORSPORT_KEYWORD_RE = /formula|nascar|xfinity|truck|indy|indianapolis|moto|superbike|wsbk|wrc|rally|dtm|prix|cup|\bf[- ]?[1-4]\b/i;

function extractMotorsportSeries(title, league = '') {
  return extractMotorsportSeriesT(
    foldMotorsportText(title || '').toLowerCase(),
    foldMotorsportText(league || '').toLowerCase()
  );
}

// t / l are already folded AND lowercased by the caller.
function extractMotorsportSeriesT(t, l) {
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

function _matchExplicitSessionT(s) {
  if (!s) return null;

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

  // 7. Numbered Qualifying (Q1, Q2, Q3) then generic Qualifying
  if (/\bq\s*1\b|\bquali(?:fying)?\s*1\b/i.test(s)) return 'q1';
  if (/\bq\s*2\b|\bquali(?:fying)?\s*2\b/i.test(s)) return 'q2';
  if (/\bq\s*3\b|\bquali(?:fying)?\s*3\b/i.test(s)) return 'q3';
  if (/\bqualifying\b|\bshootout\b|\bpole\s*position\b|\bquali\b/i.test(s)) {
    return 'qualifying';
  }

  // 8. Generic Practice
  if (/\b(?:free\s*)?practice\b/i.test(s)) {
    return 'practice';
  }

  // 9. Explicit Race (not pre/post/sprint)
  if (/\brace\b/i.test(s)) {
    return 'race';
  }

  return null;
}

function extractMotorsportSession(title) {
  if (!title) return 'race';
  return extractMotorsportSessionT(foldMotorsportText(title).toLowerCase());
}

// Existing classifier contract: omitted session defaults to 'race' for replay/legacy guards.
function extractMotorsportSessionT(s) {
  return _matchExplicitSessionT(s) || 'race';
}

// Season-independent circuit / Grand Prix / locale aliases -> canonical venue key.
// Distinct circuits in the same country (e.g. Monza / Imola / Mugello / Misano,
// Catalunya / Jerez / Aragon / Valencia) remain separate keys.
const VENUE_ALIAS_RULES = [
  [/\blusail\b|\blosail\b|\bqatar\b/i, 'qatar'],
  [/\bricardo\s*tormo\b|\bcheste\b|\bcomunitat\s*valenciana\b|\bcomunidad\s*valenciana\b|\bvalencian?\b/i, 'valencia'],
  [/\bsakhir\b|\bbahrain\b/i, 'bahrain'],
  [/\bjeddah\b|\bsaudi\s*arabia\b|\bsaudi\b/i, 'saudi_arabia'],
  [/\balbert\s*park\b|\bmelbourne\b|\baustralia(?:n)?\b/i, 'australia'],
  [/\bsuzuka\b|\bjapan(?:ese)?\b/i, 'japan'],
  [/\bshanghai\b|\bchina\b|\bchinese\b/i, 'china'],
  [/\bmiami\b/i, 'miami'],
  [/\bimola\b|\bemilia\s*romagna\b/i, 'imola'],
  [/\bmonaco\b|\bmonte\s*carlo\b/i, 'monaco'],
  [/\bmontreal\b|\bgilles\s*villeneuve\b|\bcanad(?:a|ian)\b/i, 'canada'],
  [/\bcatalunya\b|\bcatalonia\b|\bmontmelo\b|\bbarcelona\b/i, 'catalunya'],
  [/\bjerez\b/i, 'jerez'],
  [/\baragon\b|\bmotorland\b/i, 'aragon'],
  [/\bspain\b|\bspanish\b|\bespana\b/i, 'spain'],
  [/\bred\s*bull\s*ring\b|\bspielberg\b|\baustria(?:n)?\b|\bstyria\b/i, 'austria'],
  [/\bsilverstone\b|\bgreat\s*britain\b|\bbritish\b/i, 'britain'],
  [/\bhungaroring\b|\bhungar(?:y|ian)\b|\bbudapest\b/i, 'hungary'],
  [/\bspa[\s-]*francorchamps\b|\bbelgi(?:um|an)\b/i, 'belgium'],
  [/\bzandvoort\b/i, 'zandvoort'],
  [/\bassen\b|\bdutch\s*tt\b/i, 'assen'],
  [/\bdutch\b|\bnetherlands\b/i, 'netherlands'],
  [/\bmonza\b/i, 'monza'],
  [/\bmugello\b/i, 'mugello'],
  [/\bmisano\b|\bsan\s*marino\b/i, 'misano'],
  [/\bbaku\b|\bazerbaijan\b/i, 'azerbaijan'],
  [/\bmarina\s*bay\b|\bsingapore\b/i, 'singapore'],
  [/\baustin\b|\bcota\b|\bcircuit\s*of\s*the\s*americas\b|\bamericas\b/i, 'americas'],
  [/\bmexico\s*city\b|\bhermanos\s*rodriguez\b|\bmexic(?:o|an)\b/i, 'mexico'],
  [/\binterlagos\b|\bsao\s*paulo\b|\bbrazil(?:ian)?\b/i, 'brazil'],
  [/\blas\s*vegas\b/i, 'las_vegas'],
  [/\byas\s*marina\b|\babu\s*dhabi\b/i, 'abu_dhabi'],
  [/\bportimao\b|\balgarve\b|\bportug(?:al|uese)\b/i, 'portugal'],
  [/\ble\s*mans\b|\bfran(?:ce|ch)\b/i, 'france'],
  [/\bsachsenring\b|\bgerman(?:y)?\b/i, 'germany'],
  [/\bsepang\b|\bmalaysia(?:n)?\b/i, 'malaysia'],
  [/\bmandalika\b|\bindonesia(?:n)?\b/i, 'indonesia'],
  [/\bphillip\s*island\b/i, 'phillip_island'],
  [/\bburiram\b|\bchang\b|\bthailand\b|\bthai\b/i, 'thailand'],
  [/\bmotegi\b/i, 'motegi'],
  [/\btermas\s*de\s*rio\s*hondo\b|\bargentin(?:a|e)\b/i, 'argentina'],
  [/\bbrno\b|\bczech\b/i, 'czech']
];

const VENUE_STRIP_PATTERNS = [
  /\bf1\s*academy\b|\bformula\s*(?:one|two|three|four|1|2|3|4|e)\b|\bformula-e\b|\be-prix\b|\beprix\b|\bformulaone\b|\bf[- ]?[1-4]\b/gi,
  /\bmotogp\b|\bmoto\s*[23]\b|\bnascar\b|\bxfinity\b|\bcraftsman\s*truck\b|\btruck\s*series\b|\bcup\s*series\b|\bindycar\b|\bwsbk\b|\bworld\s*superbike\b|\bsuperbike\b|\bwrc\b|\bworld\s*rally\b|\brally\b|\bdtm\b/gi,
  /\b(?:1st|2nd|3rd|4th|first|second|third|fourth)\s*(?:free\s*)?practice\b|\b(?:free\s*)?practice\s*[1-4]?\b|\bfp\s*[1-4]\b/gi,
  /\bsprint\s*(?:shootout|qualifying|race)\b|\bsq\s*[1-3]?\b|\bsprint\b/gi,
  /\bq\s*[1-3]\b|\bquali(?:fying)?\s*[1-3]?\b|\bshootout\b|\bpole\s*position\b/gi,
  /\b(?:pre|post)[\s-]*race\b|\bmain\s*race\b|\bfeature\s*race\b|\brace\b/gi,
  /\b(?:season|year)\s*in\s*review\b|\bseason\s*review\b|\bpaddock(?:\s*uncut)?\b|\bpreview\b|\bpress\s*conference\b|\bchequered\s*flag\b|\bafter\s*the\s*flag\b/gi,
  /\b(?:test|testing|shakedown)\b|\bday[\s-]?[1-4]\b/gi,
  /\bgrand\s*prix\b|\bgran\s*premio\b|\bgrande\s*premio\b|\bgrosser\s*preis\b|\bgp\b/gi,
  /\b(?:world\s*)?championship\b|\bround\s*\d*\b|\bairways\b|\baramco\b|\brolex\b|\bheineken\b|\bcrypto\s*com\b|\bmsc\s*cruises\b|\blenovo\b|\bpirelli\b|\btag\s*heuer\b|\betihad\b|\bpetronas\b/gi,
  /\b(?:live|stream|replay|full|show|hd|fhd|uhd|4k)\b/gi,
  /\b(?:the|of|de|la|del|las|los|in|at|on|and)\b/gi,
  /\b20[2-3]\d\b|\b\d{1,2}\b/g
];

function extractMotorsportVenueKey(title) {
  if (!title) return null;
  const folded = foldMotorsportText(title).toLowerCase();

  let cleaned = folded;
  for (const pat of VENUE_STRIP_PATTERNS) {
    cleaned = cleaned.replace(pat, ' ');
  }
  cleaned = cleaned.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;

  const matchedCanonical = new Set();
  for (const [re, key] of VENUE_ALIAS_RULES) {
    if (re.test(cleaned)) {
      matchedCanonical.add(key);
    }
  }

  if (matchedCanonical.size > 1) {
    return null;
  }
  if (matchedCanonical.size === 1) {
    return matchedCanonical.values().next().value;
  }

  if (cleaned.length < 3) return null;
  return cleaned;
}

const DATE_ONLY_RE = /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2},?\s+[a-z]{3,9}\.?,?\s+\d{4})$/i;
const HAS_TIME_COMPONENT_RE = /\d{1,2}:\d{2}/;

function resolveVerifiedKickoffMs(match) {
  if (!match) return null;
  if (match.kickoffVerified === false) return null;

  const raw = match.date;
  if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') return null;

  if (match.kickoffVerified === true) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = parseTimezone(String(raw).trim(), 'UTC');
    return (parsed && parsed > 0) ? parsed : null;
  }

  // Without explicit kickoffVerified=true, only accept self-evidently
  // time-specific date strings (never bare epochs or date-only strings).
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || DATE_ONLY_RE.test(trimmed) || !HAS_TIME_COMPONENT_RE.test(trimmed)) {
    return null;
  }
  const parsed = parseTimezone(trimmed, 'UTC');
  return (parsed && parsed > 0) ? parsed : null;
}

function getScheduledMotorsportClaim(match, foldedTitle, foldedLeague) {
  const titleLower = foldedTitle !== undefined
    ? foldedTitle
    : foldMotorsportText(match && match.title ? match.title : '').toLowerCase();
  const leagueLower = foldedLeague !== undefined
    ? foldedLeague
    : foldMotorsportText(match && match.league ? match.league : '').toLowerCase();

  const rawSeries = (MOTORSPORT_KEYWORD_RE.test(`${titleLower} ${leagueLower}`))
    ? extractMotorsportSeriesT(titleLower, leagueLower)
    : 'other';
  const series = rawSeries === 'other' ? null : rawSeries;
  const session = _matchExplicitSessionT(titleLower);
  const venueKey = extractMotorsportVenueKey(titleLower);
  const kickoffMs = resolveVerifiedKickoffMs(match);

  return { series, session, venueKey, kickoffMs };
}

module.exports = {
  MOTORSPORT_KEYWORD_RE,
  DATE_ONLY_RE,
  HAS_TIME_COMPONENT_RE,
  foldMotorsportText,
  extractMotorsportSeries,
  extractMotorsportSeriesT,
  extractMotorsportSession,
  extractMotorsportSessionT,
  extractMotorsportVenueKey,
  resolveVerifiedKickoffMs,
  getScheduledMotorsportClaim
};
