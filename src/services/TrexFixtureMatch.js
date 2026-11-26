'use strict';

const { normalizeName, entryScore } = require('./TrexCatalogKeys');
const { parseTimezone } = require('../timezone');

// City and franchise are interchangeable in North American pro fixture labels.
// Only expand known city prefixes; arbitrary first/last words of team names
// (especially university names) are not reliable identities.
const MARKETS = ('golden state|new york|new jersey|los angeles|la|las vegas|oklahoma city|san antonio|' +
  'san jose|st louis|saint louis|tampa bay|new orleans|minnesota|utah|dallas|denver|boston|washington|vegas|' +
  'edmonton|chicago|detroit|cleveland|philadelphia|pittsburgh|atlanta|miami|memphis|toronto|' +
  'vancouver|winnipeg|calgary|montreal|ottawa|anaheim|buffalo|colorado|columbus|carolina|' +
  'florida|nashville|seattle|brooklyn|milwaukee|phoenix|houston|portland|indiana|orlando|' +
  'charlotte|sacramento|new england|baltimore|cincinnati|green bay|jacksonville|kansas city|' +
  'san francisco|tennessee|arizona|texas|salt lake|austin').split('|');
const SHARED_MARKETS = new Set(['new york', 'los angeles', 'la']);
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
const WEEKDAYS = Object.freeze({
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6
});
const DAY = 86_400_000;
const ZONES = {
  utc: 0, gmt: 0, cet: 1, cest: 2, eet: 2, eest: 3,
  est: -5, edt: -4, cst: -6, cdt: -5, mst: -7, mdt: -6, pst: -8, pdt: -7
};
const IANA_ZONES = Object.freeze({
  et: 'America/New_York',
  ct: 'America/Chicago',
  mt: 'America/Denver',
  pt: 'America/Los_Angeles'
});

const MONTH_ALT = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const WEEKDAY_ALT = 'mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const ZONE_ALT = 'utc|gmt|cest|cet|eest|eet|et|est|edt|ct|cst|cdt|mt|mst|mdt|pt|pst|pdt';
const VERSUS_SEP_RE = /\s+(?:vs?\.?|versus|at|@)\s+/i;
const LEADING_SLOT_RE = /^\s*\d+\s*-\s*(?:\d{1,2}(?::\d\d)?\s*[ap]m\s*)?/i;
const LEADING_SEASON_WEEK_RE = /^\s*(?:(?:[a-z]+\s+){0,2}(?:football|basketball|hockey|baseball|soccer|nfl|nba|nhl|mlb|mls|ncaa)\s+)?(?:20\d\d(?:\/\d{2,4})?\s+)?(?:season\s+)?(?:week|matchweek|matchday|round)\s+\d{1,2}(?:\s*[-:]\s*|\s+)(?=[A-Za-z0-9#])/i;
const LEADING_WEEKDAY_TIME_RE = new RegExp(`^\\s*(?:${WEEKDAY_ALT})\\b\\.?,?\\s+(?:\\d{1,2}(?::\\d\\d)?\\s*[ap]m|\\d{1,2}:\\d\\d)(?:\\s+(?:${ZONE_ALT}))?(?:\\s*-\\s*|\\s+)(?=[A-Za-z0-9#])`, 'i');
const TRAILING_DATE_TIME_RE = new RegExp(`\\s+(?:(?:${WEEKDAY_ALT})\\.?,?\\s+)?(?:(?:${MONTH_ALT})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_ALT})\\.?)(?:,?\\s+|\\s+at\\s+)(?:\\d{1,2}(?::\\d\\d)?\\s*[ap]m|\\d{1,2}:\\d\\d)(?:\\s+(?:${ZONE_ALT}))?\\s*$`, 'i');
const TRAILING_AMPM_RE = new RegExp(`\\s+\\d{1,2}(?::\\d\\d)?\\s*[ap]m(?:\\s+(?:${ZONE_ALT}))?\\s*$`, 'i');
const TRAILING_24H_RE = new RegExp(`\\s+\\d{1,2}:\\d\\d(?:\\s*(?:${ZONE_ALT}|[ap]m))?\\s*$`, 'i');
const TIMED_ZONE_RE = new RegExp(`^[\\s|T,]*(?:(\\d{1,2})(?::(\\d\\d)(?::\\d\\d)?)?\\s*([ap]m)|(\\d{1,2}):(\\d\\d)(?::\\d\\d)?)\\s*\\(?(${ZONE_ALT}|[+-]\\d\\d(?::?\\d\\d)?)\\b`, 'i');
const WEEKDAY_TIME_RE = new RegExp(`\\b(${WEEKDAY_ALT})\\b\\.?,?\\s+(?:\\d{1,2}(?::\\d\\d)?\\s*[ap]m|\\d{1,2}:\\d\\d)(?:\\s*\\(?(${ZONE_ALT}|[+-]\\d\\d(?::?\\d\\d)?)\\b)?`, 'i');
const STANDALONE_WEEKDAY_RE = new RegExp(`^\\s*(?:\\d+\\s*-\\s*)?(${WEEKDAY_ALT})\\s*$`, 'i');

const _weekdayFormatters = new Map();

// Generic club fillers that never distinguish same-city clubs (unlike real, united, city, inter, athletic, atletico).
const CLUB_AFFIXES = new Set([
  'fc', 'cf', 'sc', 'ac', 'as', 'ss', 'us', 'rc', 'cd', 'ud', 'sd', 'fk', 'sk', 'bk',
  'if', 'sv', 'vfb', 'tsg', 'afc', 'ca', 'sa', 'aj', 'aif', 'nk', 'kaa', 'kv', 'lr', 'k',
  'csu', 'losc', 'club', 'calcio', 'de', 'del', 'la', 'asociacion', 'ogc', 'rsc', 'rb', 'fsv', 'vfl',
  '1907', '1908', '1929', '1898'
]);

const SOCCER_SYNONYMS = Object.freeze({
  'paris st germain': ['psg'],
  psg: ['paris st germain'],
  internazionale: ['inter', 'inter milan', 'inter milao', 'inter de milao'],
  inter: ['internazionale', 'inter milan', 'inter milao', 'inter de milao'],
  'inter milan': ['internazionale', 'inter', 'inter milao', 'inter de milao'],
  'inter milao': ['internazionale', 'inter', 'inter milan', 'inter de milao'],
  'inter de milao': ['internazionale', 'inter', 'inter milan', 'inter milao'],
  lask: ['lask linz'],
  'lask linz': ['lask'],
  'bayern munich': ['bayern munchen', 'bayern de munique', 'bayern'],
  'bayern munchen': ['bayern munich', 'bayern de munique', 'bayern'],
  'bayern de munique': ['bayern munich', 'bayern munchen', 'bayern'],
  bayern: ['bayern munich', 'bayern munchen', 'bayern de munique'],
  'atletico madrid': ['atl madrid', 'atletico de madrid'],
  'atl madrid': ['atletico madrid', 'atletico de madrid'],
  'atletico de madrid': ['atletico madrid', 'atl madrid'],
  'borussia dortmund': ['dortmund'],
  dortmund: ['borussia dortmund'],
  'wolverhampton wanderers': ['wolverhampton', 'wolves'],
  wolverhampton: ['wolverhampton wanderers', 'wolves'],
  'tottenham hotspur': ['tottenham', 'spurs'],
  tottenham: ['tottenham hotspur'],
  'brighton hove albion': ['brighton'],
  'west bromwich albion': ['west brom'],
  'west brom': ['west bromwich albion'],
  'bolton wanderers': ['bolton'],
  'birmingham city': ['birmingham'],
  'blackburn rovers': ['blackburn'],
  'derby county': ['derby'],
  'coventry city': ['coventry'],
  'manchester united': ['man united', 'man utd'],
  'man united': ['manchester united'],
  'manchester city': ['man city'],
  'man city': ['manchester city'],
  athletic: ['athletic bilbao'],
  'athletic bilbao': ['athletic'],
  'deportivo alaves': ['alaves'],
  alaves: ['deportivo alaves'],
  'real betis': ['betis'],
  betis: ['real betis'],
  'olympique marseille': ['marseille'],
  'olympique lyonnais': ['lyon'],
  lyon: ['olympique lyonnais'],
  'racing lens': ['lens'],
  'deportivo a coruna': ['deportivo', 'deportivo la coruna', 'deportivo la corogne'],
  'estudiantes de la plata': ['estudiantes'],
  'slavia prague': ['slavia praha', 'slavia prag', 'slavia praga'],
  'slavia praha': ['slavia prague', 'slavia prag', 'slavia praga'],
  'slavia prag': ['slavia prague', 'slavia praha', 'slavia praga'],
  'slavia praga': ['slavia prague', 'slavia praha', 'slavia prag'],
  'sparta prague': ['sparta praha', 'sparta prag', 'sparta praga'],
  'sparta praha': ['sparta prague', 'sparta prag', 'sparta praga'],
  'bodoe glimt': ['bodo glimt'],
  'bodo glimt': ['bodoe glimt'],
  'hellas verona': ['verona'],
  'iberia 1999': ['iberia tbilisi'],
  'iberia tbilisi': ['iberia 1999'],
  'universitatea craiova': ['craiova'],
  craiova: ['universitatea craiova'],
  'lincoln red imps': ['l red imps'],
  'hapoel be er': ['hapoel beer sheva'],
  'hapoel beer sheva': ['hapoel be er'],
  'red star belgrade': ['crvena zvezda'],
  'sj earthquakes': ['san jose earthquakes', 'san jose'],
  'los angeles fc': ['lafc'],
  'st louis city': ['st louis'],
  'inter miami': ['miami'],
  'real salt lake': ['salt lake'],
  'columbus crew': ['columbus'],
  'vancouver whitecaps': ['vancouver'],
  'portland timbers': ['portland'],
  'houston dynamo': ['houston'],
  'chicago fire': ['chicago'],
  'philadelphia union': ['philadelphia'],
  'new england revolution': ['new england'],
  'erzurum bb': ['erzurumspor'],
  erzurumspor: ['erzurum bb'],
  sporting: ['sporting cp']
});

const SOCCER_SEARCH_SHORT = Object.freeze({
  'bayern munich': 'bayern',
  internazionale: 'inter',
  'paris saint germain': 'psg',
  'atletico madrid': 'atletico',
  'bodo glimt': 'glimt',
  'bodoe glimt': 'glimt',
  'union st gilloise': 'gilloise',
  'red star belgrade': 'crvena'
});

function precleanTeamText(raw) {
  return String(raw || '')
    .replace(/[\u2019\u2018'`]/g, '')
    .replace(/\b[Ss]aint(?=[A-Z]|[\s._-]+[A-Za-z])[\s._-]*/g, 'st ')
    .replace(/\b[Ss][Tt]\.?(?=[\s_-]+[A-Za-z])[\s._-]*/g, 'st ')
    .replace(/\bFootball\s+Club\b/gi, 'FC')
    .replace(/([a-z]{2,})([A-Z][a-z]{2,})/g, '$1 $2');
}

function stripAffixes(norm) {
  const words = norm.split(' ').filter(w => w && !CLUB_AFFIXES.has(w));
  const stripped = words.join(' ');
  if (!stripped || SHARED_MARKETS.has(stripped)) return norm;
  return stripped;
}

function squadTag(rawOrNorm) {
  const n = normalizeName(rawOrNorm);
  const m = n.match(/\b(u\s*1[789]|u\s*2[013]|women|wfc|ladies|reserves)\b/) || n.match(/\b(ii|b)$/);
  return m ? m[1].replace(/\s+/g, '') : '';
}

function splitSquad(norm) {
  const m = norm.match(/^(.*?)\s+\b(u\s*1[789]|u\s*2[013]|women|wfc|ladies|reserves|ii|b)$/);
  if (!m) return { base: norm, squad: '' };
  return { base: m[1].trim(), squad: m[2].replace(/\s+/g, '') };
}

function identity(team) {
  const full = normalizeName(team?.name || team);
  const market = MARKETS.find(city => full.startsWith(city + ' '));
  const nickname = market ? full.slice(market.length + 1) : '';
  return { full, nickname, market };
}

function expandSoccerAliases(norm) {
  const { base, squad } = splitSquad(norm);
  const baseStripped = stripAffixes(base);
  const out = new Set([norm, squad ? `${baseStripped} ${squad}` : baseStripped]);
  for (const key of [base, baseStripped]) {
    const syns = SOCCER_SYNONYMS[key];
    if (syns) {
      for (const s of syns) out.add(squad ? `${s} ${squad}` : s);
    }
  }
  return [...out];
}

function eventSearchAliases(team, match) {
  const rawName = team?.name || team;
  const { full, nickname, market } = identity(rawName);
  if (match?.category === 'football') {
    const stripped = stripAffixes(full);
    const out = [stripped || full];
    if (Object.hasOwn(SOCCER_SEARCH_SHORT, stripped)) out.push(SOCCER_SEARCH_SHORT[stripped]);
    else if (Object.hasOwn(SOCCER_SEARCH_SHORT, full)) out.push(SOCCER_SEARCH_SHORT[full]);
    else if (market && !SHARED_MARKETS.has(market)) out.push(market);
    out.push(full);
    return [...new Set(out.filter(Boolean))];
  }
  return [...new Set([nickname, full].filter(Boolean))];
}

function fixtureAliases(team) {
  const pre = precleanTeamText(team?.name || team);
  const full = normalizeName(pre);
  const market = MARKETS.find(city => full.startsWith(city + ' '));
  const nickname = market ? full.slice(market.length + 1) : '';
  const out = new Set([full, nickname, SHARED_MARKETS.has(market) ? '' : market]);
  for (const alias of expandSoccerAliases(full)) out.add(alias);
  return [...out].filter(Boolean);
}

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

function fixturePairKeys(match) {
  const keys = new Set();
  for (const a of fixtureAliases(match?.team1)) {
    for (const b of fixtureAliases(match?.team2)) {
      if (a !== b) keys.add(pairKey(a, b));
    }
  }
  return keys;
}

function cleanSide(side) {
  // Strip scoreboard prefixes ("DEN - NUGGETS"), uncoloned leagues ("NHL EDMONTON"),
  // seeds ("#9 TENN"), and generic club affixes while preserving squad markers.
  const norm = normalizeName(
    precleanTeamText(side)
      .replace(/^[A-Z]{2,3}\s+-\s+(?=[A-Z])/i, '')
      .replace(/^(?:nba|wnba|nhl|ahl|nfl|mlb|mls|ncaa)\s+(?=[a-z])/i, '')
      .replace(/^#\d+\s+/, '')
  );
  const { base, squad } = splitSquad(norm);
  const stripped = stripAffixes(base);
  return squad ? `${stripped} ${squad}`.trim() : stripped;
}

function stripLeadingLabels(text, isEventTagged) {
  let part = text.replace(LEADING_SLOT_RE, '');
  while (/^[^:]{1,60}:\s+(?=[A-Za-z0-9#])/.test(part)) {
    const colonIdx = part.indexOf(':');
    const prefix = part.slice(0, colonIdx);
    const rest = part.slice(colonIdx + 1).trim();
    if (VERSUS_SEP_RE.test(prefix) || (isEventTagged && /\s+x\s+/i.test(prefix))) break;
    if (!VERSUS_SEP_RE.test(rest) && !(isEventTagged && /\s+x\s+/i.test(rest)) && !/\s+[-\u2013\u2014]\s+/.test(rest)) break;
    part = rest;
  }
  return part;
}

function cleanClause(rawPart, isEventTagged) {
  let part = rawPart.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').trim();
  part = stripLeadingLabels(part, isEventTagged);
  return part
    .replace(LEADING_SLOT_RE, '')
    .replace(LEADING_SEASON_WEEK_RE, '')
    .replace(LEADING_WEEKDAY_TIME_RE, '')
    .replace(/^\s*\d{1,2}:\d\d\s+(?=[A-Za-z0-9#])/, '')
    .replace(/^(?:(?:uefa\s+)?(?:champions|europa|conference|youth)\s+league|premier\s+league|championship|la\s*liga|serie\s*a|bundesliga|ligue\s*1)\s+(?=[A-Za-z#])/i, '')
    .replace(/\s+(?:(?:uefa\s+)?(?:champions|europa|conference|youth)\s+league|premier\s+league|bundesliga|la\s*liga|serie\s*a|ligue\s*1|j\.?league|a-?league)\s+(?:matchday|matchweek|round|week|\d{4}(?:\/\d{2,4})?).*$/i, '')
    .replace(/\s+@\s+(?=(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d))/i, '\u0000')
    .split('\u0000')[0]
    .replace(TRAILING_DATE_TIME_RE, '')
    .replace(TRAILING_AMPM_RE, '')
    .replace(TRAILING_24H_RE, '')
    .trim();
}

function parsePair(name) {
  // Allow a leading STAN stream bullet ("| • Everton v Liverpool"), while still
  // rejecting multi-game simulcasts ("A vs B • C vs D", ";") and ended placeholders.
  const cleanedName = String(name || '').replace(/\|\s*\u2022(?=\s*[A-Za-z0-9#])/g, '|');
  if (!cleanedName || /[;\u2022]|\b(?:end|ended|no event streaming now)\s*\|/i.test(cleanedName)) return null;
  const isEventTagged = /^\s*(?:live|next)\s*\|/i.test(cleanedName)
    || /\bstart:\s*20\d\d-|\(\s*20\d\d-\d\d-\d\d/i.test(cleanedName);
  let matched = null;
  for (const rawPart of cleanedName.split('|')) {
    const part = cleanClause(rawPart, isEventTagged);
    const hasVersus = VERSUS_SEP_RE.test(part);
    const hasX = !hasVersus && isEventTagged && /\s+x\s+/i.test(part);
    const sep = hasVersus ? VERSUS_SEP_RE : (hasX ? /\s+x\s+/i : /\s+[-\u2013\u2014]\s+/);
    const sides = part.split(sep);
    if (sides.length !== 2) continue;
    const [a, b] = sides.map(cleanSide);
    if (!a || !b || a === b || !/[a-z]/.test(a) || !/[a-z]/.test(b)) continue;
    const explicit = hasVersus || hasX;
    if (!matched) {
      matched = { a, b, explicit };
    } else if (explicit && matched.explicit && pairKey(matched.a, matched.b) !== pairKey(a, b)) {
      return null;
    } else if (explicit && !matched.explicit) {
      matched = { a, b, explicit };
    }
  }
  return matched ? { a: matched.a, b: matched.b } : null;
}

function fixtureDate(match) {
  const value = match?.date;
  const ms = Number(value) > 0 ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function weekdayFormatter(timeZone) {
  let fmt = _weekdayFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
    _weekdayFormatters.set(timeZone, fmt);
  }
  return fmt;
}

function resolveZoneMinutes(zone) {
  if (Object.hasOwn(ZONES, zone)) return ZONES[zone] * 60;
  return (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3).replace(':', '')));
}

function resolveCalendarInstant(year, month, day, hour, minute, zone) {
  if (Object.hasOwn(IANA_ZONES, zone)) {
    const wall = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return parseTimezone(wall, IANA_ZONES[zone]);
  }
  const calendar = Date.UTC(year, month - 1, day);
  return calendar + (hour * 60 + minute - resolveZoneMinutes(zone)) * 60_000;
}

function weekdayInZone(kickoff, zone) {
  if (Object.hasOwn(IANA_ZONES, zone) || zone.includes('/') || zone === 'UTC') {
    const iana = IANA_ZONES[zone] || zone;
    return WEEKDAYS[weekdayFormatter(iana).format(new Date(kickoff)).toLowerCase()];
  }
  return new Date(kickoff + resolveZoneMinutes(zone) * 60_000).getUTCDay();
}

function isInsideParens(name, index) {
  const segStart = name.lastIndexOf('|', index) + 1;
  const segEnd = name.indexOf('|', index);
  let open = 0;
  for (let i = segStart; i < index; i += 1) {
    if (name[i] === '(') open += 1;
    else if (name[i] === ')' && open > 0) open -= 1;
  }
  if (open <= 0) return false;
  const tail = segEnd === -1 ? name.slice(index) : name.slice(index, segEnd);
  return tail.includes(')');
}

function parseTimedZone(trailing, year, month, day) {
  const timed = trailing.match(TIMED_ZONE_RE);
  if (!timed) return null;
  let hour = Number(timed[1] || timed[4]);
  const minute = Number(timed[2] || timed[5] || 0);
  const meridiem = (timed[3] || '').toLowerCase();
  const zone = timed[6].toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (meridiem === 'am' && hour === 12) hour = 0;
    else if (meridiem === 'pm' && hour < 12) hour += 12;
  } else if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  const at = resolveCalendarInstant(year, month, day, hour, minute, zone);
  return Number.isFinite(at) ? at : null;
}

function extractCalendarCandidates(name, kickoff) {
  const candidates = [];
  const push = (year, month, day, index, end) => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    const inParens = isInsideParens(name, index);
    const at = parseTimedZone(name.slice(end), year, month, day);
    const zoned = at !== null;
    candidates.push({
      year,
      month,
      day,
      at,
      zoned,
      priority: (zoned ? 0 : 2) + (inParens ? 1 : 0)
    });
  };
  for (const m of name.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) {
    push(Number(m[1]), Number(m[2]), Number(m[3]), m.index, m.index + m[0].length);
  }
  for (const m of name.matchAll(/\b(\d\d)-(\d\d)-(20\d\d)\b/g)) {
    push(Number(m[3]), Number(m[2]), Number(m[1]), m.index, m.index + m[0].length);
  }
  const refYear = new Date(kickoff).getUTCFullYear();
  for (const m of name.matchAll(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/gi)) {
    const month = MONTHS.indexOf((m[2] || m[3]).toLowerCase()) + 1;
    const day = Number(m[1] || m[4]);
    const year = [refYear, refYear - 1, refYear + 1]
      .sort((a, b) => Math.abs(Date.UTC(a, month - 1, day) - kickoff) - Math.abs(Date.UTC(b, month - 1, day) - kickoff))[0];
    push(year, month, day, m.index, m.index + m[0].length);
  }
  return candidates;
}

function relevantWeekdayZones(name) {
  if (/\b(?:nfl|nba|nhl|ahl|mlb|mls|wnba|ncaa|us|usa|ca|espn\+?|peacock|fox|cbs|nbc|tsn|sn)\b/i.test(name)) {
    return ['America/New_York', 'America/Los_Angeles'];
  }
  if (/\b(?:uk|gb|ie|epl|premier\s+league|championship|efl|sky\s*sports|tnt\s*sports)\b/i.test(name)) {
    return ['Europe/London'];
  }
  if (/\b(?:de|fr|es|it|nl|pt|be|se|dk|no|fi|pl|tr|uefa|champions\s+league|bundesliga|la\s*liga|serie\s*a|ligue\s*1|viaplay|dazn)\b/i.test(name)) {
    return ['Europe/Berlin', 'Europe/Istanbul'];
  }
  if (/\b(?:au|stan|nz)\b/i.test(name)) {
    return ['Australia/Sydney'];
  }
  return ['America/New_York', 'UTC', 'Europe/London'];
}

function extractWeekdaySchedule(name) {
  const timed = name.match(WEEKDAY_TIME_RE);
  if (timed) {
    return {
      weekday: WEEKDAYS[timed[1].toLowerCase()],
      zone: timed[2] ? timed[2].toLowerCase() : ''
    };
  }
  const parts = name.split('|');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i === 0 && !/^\s*\d+\s*-/.test(part)) continue;
    const standalone = part.match(STANDALONE_WEEKDAY_RE);
    if (standalone) {
      return { weekday: WEEKDAYS[standalone[1].toLowerCase()], zone: '' };
    }
  }
  return null;
}

function dateFits(name, kickoff) {
  if (!kickoff) return true;
  const candidates = extractCalendarCandidates(name, kickoff);
  if (candidates.length) {
    candidates.sort((a, b) => a.priority - b.priority);
    const best = candidates[0];
    if (best.zoned) {
      return Math.abs(kickoff - best.at) <= 6 * 3600_000;
    }
    // Labels without a timezone may use the local broadcast day.
    const calendar = Date.UTC(best.year, best.month - 1, best.day);
    return Math.abs(Math.floor(kickoff / DAY) - calendar / DAY) <= 1;
  }
  const weekdayMatch = extractWeekdaySchedule(name);
  if (!weekdayMatch) return true;
  const zones = weekdayMatch.zone ? [weekdayMatch.zone] : relevantWeekdayZones(name);
  return zones.some((zone) => weekdayInZone(kickoff, zone) === weekdayMatch.weekday);
}

function sportOf(value, { isMatch = false } = {}) {
  // Catalog PPV channel buckets frequently mislabel basketball/hockey under "SOCCER PPV".
  const s = String(value || '').replace(/\b[a-z]+\s+ppv(?:\s+\d+)?\b/gi, '');
  if (/\b(?:nba|wnba|basketball)\b/i.test(s)) return 'basketball';
  if (/\b(?:nhl|ahl|hockey)\b/i.test(s)) return 'hockey';
  if (/\b(?:mlb|baseball)\b/i.test(s)) return 'baseball';
  if (/\b(?:nfl|ncaa\s+football|ncaaf|american[\s_]+football|college\s+football)\b/i.test(s)) return 'american football';
  if (isMatch && /^\s*football\b/i.test(s)) return 'soccer';
  if (/\b(?:soccer|epl|premier\s+league|uefa|champions\s+league|ucl|europa\s+league|uel|conference\s+league|uecl|la\s*liga|serie\s*a|bundesliga|ligue\s*1|mls|major\s+league\s+soccer|eredivisie|brasileir[a\u00e3]o|libertadores|s[u\u00fc]per\s+lig|primeira\s+liga|scottish\s+premiership)\b/i.test(s)) return 'soccer';
  return '';
}

function matchesFixture(name, match) {
  const pair = parsePair(name);
  if (!pair || !fixturePairKeys(match).has(pairKey(pair.a, pair.b))) return false;
  if (squadTag(pair.a + ' ' + pair.b) !== squadTag((match?.team1?.name || match?.team1 || '') + ' ' + (match?.team2?.name || match?.team2 || ''))) return false;
  const sport = sportOf(name);
  const category = sportOf([match.category, match.league].join(' '), { isMatch: true });
  if (sport && category && sport !== category) return false;
  const kickoff = fixtureDate(match);
  const cityOnly = MARKETS.includes(pair.a) || MARKETS.includes(pair.b);
  if (cityOnly && !(sport && sport === category) && !(kickoff && /\d[-/]\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(name))) return false;
  return dateFits(name, kickoff);
}

function eventScore(name, group) {
  const priority = /^\s*live\s*\|/i.test(name) ? 2 : /^\s*next\s*\|/i.test(name) ? 0 : 1;
  return priority * 10000 + entryScore(name, group);
}

module.exports = { eventSearchAliases, matchesFixture, parsePair, pairKey, fixturePairKeys, eventScore };
