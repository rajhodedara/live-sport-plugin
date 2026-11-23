'use strict';

/**
 * Pure key derivation and scoring for the Trex generic catalog
 * (`flix-live-tv-v2-trex`), shared by the nightly refresh job and the
 * read-only worker store.
 *
 * Every catalog name is reduced to the strings a fixture team or a
 * broadcaster label can be found under:
 *
 *   normalizeName        lowercase ASCII words
 *   channelKey           linear channel identity (`UK| SKY SPORTS CRICKET FHD` -> `sky sport cricket`)
 *   channelAliasKey      the same without a trailing qualifier (`bein sport 1 premium` -> `bein sport 1`)
 *   teamChannelKeys      every plausible order of a team channel's club name
 *   teamQueryKeys        the same for a fixture team name
 *   eventQueryTokens     the first cleaned words of a team name, for the upstream search
 *   classifyChannelKind  team | linear | event | placeholder | other
 *   entryScore           quality tier * 1000 + group priority
 *
 * The tier A/B and placeholder patterns are copies of the ones the health
 * audit tool uses: the runtime must not depend on those modules.
 */

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Folds a name to lowercase ASCII words: NFKD, diacritics stripped, every
 * run of non-alphanumerics collapsed to one space.
 *
 * Superscript modifier letters (the `ᴿᴬᵂ`, `ᴴᴰ`, `ᵁᴴᴰ` feed markers) are
 * removed first: NFKD unfolds them into plain letters, which would leave a
 * `raw` token in `SKY SPORTS ᴿᴬᵂ`.
 */
function normalizeName(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\p{Lm}+/gu, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Feed tokens
// ---------------------------------------------------------------------------

/** Quality markers and the tier each earns (8K > 4K/UHD > FHD > HD > SD). */
const QUALITY_TIERS = Object.freeze({ '8k': 6, '4k': 5, uhd: 5, fhd: 4, hd: 3, sd: 1 });

/** A name without any quality marker sits between HD and SD. */
const PLAIN_QUALITY = 2;

/** Feed-descriptive tokens stripped from every key: the quality markers plus RAW. */
const QUALITY_TOKENS = Object.freeze([...Object.keys(QUALITY_TIERS), 'raw']);

/** Resolution and frame-rate markers (`1080p`, `3840p`, `720i`, `60fps`) are stripped like quality tokens. */
const RESOLUTION_TOKEN = /^\d{3,4}[pi]$|^\d{2,3}fps$/;

const QUALITY_TOKEN_SET = new Set(QUALITY_TOKENS);

function isQualityToken(token) {
  return QUALITY_TOKEN_SET.has(token) || RESOLUTION_TOKEN.test(token);
}

/** Normalized words of a name with `sports` folded to `sport` and the feed tokens removed. */
function feedTokens(text) {
  return normalizeName(text)
    .split(' ')
    .filter(Boolean)
    .map(token => (token === 'sports' ? 'sport' : token))
    .filter(token => !isQualityToken(token));
}

/** The best quality marker in the name; a name without any marker scores PLAIN_QUALITY. */
function qualityScore(name) {
  const tokens = normalizeName(name).split(' ').filter(Boolean);
  if (tokens.length === 0) return 0;
  const tiers = tokens
    .filter(token => Object.hasOwn(QUALITY_TIERS, token))
    .map(token => QUALITY_TIERS[token]);
  return tiers.length ? Math.max(...tiers) : PLAIN_QUALITY;
}

// ---------------------------------------------------------------------------
// Channel keys
// ---------------------------------------------------------------------------

/** Bracketed and parenthesised annotations: `WOLVES [CHI]`, `SONY HD (Back-Up)`. */
const ANNOTATION = /\[[^\]]*\]|\([^)]*\)/g;

/** Drops the leading `GROUP|` token of a catalog name (`UK| SKY SPORTS` -> ` SKY SPORTS`). */
function stripGroup(name) {
  const bar = name.indexOf('|');
  return bar === -1 ? name : name.slice(bar + 1);
}

function channelKey(rawName) {
  return feedTokens(stripGroup(String(rawName || '').replace(ANNOTATION, ' '))).join(' ');
}

/** Trailing qualifiers an alias key does without: `BEIN SPORTS 1 PREMIUM` -> `bein sport 1`. */
const ALIAS_QUALIFIERS = Object.freeze(['premium', 'extra', 'plus', 'max', 'vip', 'xtra']);

function channelAliasKey(rawName) {
  const tokens = feedTokens(stripGroup(String(rawName || '').replace(ANNOTATION, ' ')));
  const last = tokens[tokens.length - 1];
  if (!last || !ALIAS_QUALIFIERS.includes(last)) return '';
  return tokens.slice(0, -1).join(' ');
}

// ---------------------------------------------------------------------------
// Team keys
// ---------------------------------------------------------------------------

/** Group prefixes of permanent team channels and the league they belong to. */
const TEAM_LEAGUES = Object.freeze({
  'nba team': 'nba',
  'nhl team': 'nhl',
  'ahl team': 'ahl',
  'nfl teams': 'nfl',
  'la liga': 'la liga',
  'serie a': 'serie a'
});

/** Club fillers that carry no identity (`Atlético de Madrid`, `Valencia CF`, `AC Milan`, `Utah Hockey Club`). */
const TEAM_STOPWORDS = Object.freeze([
  'de', 'del', 'fc', 'cf', 'ac', 'sc', 'club', 'afc', 'fk', 'sk', 'bk', 'if', 'cd', 'ud'
]);

const TEAM_STOPWORD_SET = new Set(TEAM_STOPWORDS);

/** US networks that lead an NFL entry (`NFL TEAMS| CBS BEARS CHICAGO IL`). */
const TEAM_NETWORKS = Object.freeze(['cbs', 'fox', 'nbc', 'abc', 'espn', 'prime', 'cw']);

/** A trailing US state code, written in capitals (`... CHICAGO IL`, `... WASHINGTON DC`). */
const STATE_CODE = /^[A-Z]{2}$/;

/** Multi-word cities: `NEW YORK KNICKS` and `SAINTS NEW ORLEANS` both reduce to `city + club`. */
const CITY_PHRASES = Object.freeze([
  'new york', 'new jersey', 'new orleans', 'kansas city', 'oklahoma city', 'salt lake',
  'green bay', 'st louis', 'saint louis', 'los angeles', 'san francisco', 'san diego',
  'san antonio', 'san jose', 'las vegas', 'tampa bay', 'golden state', 'fort wayne',
  'st petersburg'
]);

const CITY_SET = new Set(CITY_PHRASES);
const CITY_MAX_WORDS = Math.max(...CITY_PHRASES.map(phrase => phrase.split(' ').length));

/** Cleaned club tokens of a team name: normalized, `sports` folded, feed tokens and fillers removed. */
function identityTokens(text) {
  return feedTokens(text).filter(token => !TEAM_STOPWORD_SET.has(token));
}

/**
 * League and club tokens of a team channel. The group, bracketed codes, a
 * leading network and a trailing state code are removed; MLB clubs, which
 * carry no team group (`US| MLB CHICAGO CUBS HD`), are recognized by the
 * leading `MLB` token.
 */
function teamIdentity(rawName) {
  const stripped = String(rawName || '').replace(ANNOTATION, ' ');
  const bar = stripped.indexOf('|');
  const group = normalizeName(bar === -1 ? '' : stripped.slice(0, bar));
  const raw = (bar === -1 ? stripped : stripped.slice(bar + 1)).trim().split(/\s+/).filter(Boolean);
  if (raw.length && TEAM_NETWORKS.includes(normalizeName(raw[0]))) raw.shift();
  if (raw.length && STATE_CODE.test(raw[raw.length - 1])) raw.pop();

  const tokens = identityTokens(raw.join(' '));
  let league = Object.hasOwn(TEAM_LEAGUES, group) ? TEAM_LEAGUES[group] : '';
  if (!league && tokens[0] === 'mlb') {
    league = 'mlb';
    tokens.shift();
  }
  return { league, tokens };
}

/**
 * Every order a club name is written in. A multi-word city at the start or
 * at the end of the list yields `city + club` for each remaining token
 * (`BILLS GIANTS JETS NEW YORK`); anything else yields the name as written
 * and with its last token moved to the front (`EAST CAROLINA PIRATES`).
 */
function emitTeamKeys(tokens) {
  if (tokens.length === 0) return [];
  for (let size = Math.min(CITY_MAX_WORDS, tokens.length - 1); size >= 2; size -= 1) {
    const head = tokens.slice(0, size).join(' ');
    if (CITY_SET.has(head)) return tokens.slice(size).map(token => `${head} ${token}`);
    const tail = tokens.slice(-size).join(' ');
    if (CITY_SET.has(tail)) return tokens.slice(0, -size).map(token => `${tail} ${token}`);
  }
  const written = tokens.join(' ');
  const reversed = [tokens[tokens.length - 1], ...tokens.slice(0, -1)].join(' ');
  return reversed === written ? [written] : [written, reversed];
}

function teamChannelKeys(rawName) {
  const { league, tokens } = teamIdentity(rawName);
  if (!league) return null;
  const keys = emitTeamKeys(tokens);
  return keys.length ? { league, keys } : null;
}

function teamQueryKeys(teamName) {
  return emitTeamKeys(identityTokens(teamName));
}

/** The first three cleaned words of a team name, for the upstream `search=` query. */
function eventQueryTokens(teamName) {
  return identityTokens(teamName).slice(0, 3);
}

// ---------------------------------------------------------------------------
// Channel kinds
// ---------------------------------------------------------------------------

/** Event placeholders ("NO EVENT STREAMING NOW -| Box Office"): tested against the group before `|`. */
const PLACEHOLDER_PATTERN = /^[-\s]*NO\s+EVENT\s+STREAMING/i;

function isPlaceholderName(name) {
  const text = String(name || '');
  const bar = text.indexOf('|');
  return PLACEHOLDER_PATTERN.test((bar === -1 ? text : text.slice(0, bar)).trim());
}

// Tier A (marquee premium sports networks) and tier B (secondary and
// regional sports, leagues, live event feeds) of the health audit taxonomy.
const TIER_A_PATTERNS = [
  /\b(sky\s*sports?)\b/i,
  /\b(tnt\s*sports?|bt\s*sport)\b/i,
  /\b(espn(\s*[1-8]|[\s_-]*hd|[\s_-]*plus|\b))\b/i,
  /\b(bein\s*sports?)\b/i,
  /\b(dazn)\b/i,
  /\b(supersport|super\s*sport)\b/i,
  /\b(astro\s*cricket)\b/i,
  /\b(optus\s*sport)\b/i,
  /\b(willow\s*(?:cricket|hd)?)\b/i,
  /\b(fox\s*sports?)\b/i
];

const TIER_B_PATTERNS = [
  /\b(laliga|la\s*liga)\b/i,
  /\b(arena\s*sport)\b/i,
  /\b(premier\s*sport|hub\s*premier)\b/i,
  /\b(live\s*event|ppv|box\s*office)\b/i,
  /\b(movistar\s*(?:laliga|campeones|deportes))\b/i,
  /\b(eurosport)\b/i,
  /\b(tsn\s*[1-5]|sn\s*(?:now|one|360|east|west|pacific|ontario))\b/i,
  /\b(sport\s*tv|ziggo\s*sport|viaplay|polsat\s*sport|nova\s*sport)\b/i,
  /\b(sport|sports|event|events|football|soccer|cricket|nfl|nba|f1|formula\s*1|ufc|boxing)\b/i
];

function isSportsChannelName(name) {
  const text = String(name || '');
  return TIER_A_PATTERNS.some(pattern => pattern.test(text))
    || TIER_B_PATTERNS.some(pattern => pattern.test(text));
}

/** Per-game slots: a `Live |` / `Next |` / `End |` / `Ended |` prefix, or a `vs` together with a `(YYYY-MM-DD` timestamp. */
const EVENT_PREFIX = /^\s*(?:live|next|ended|end)\s*\|/i;
const EVENT_VERSUS = /\bvs\.?\b/i;
const EVENT_TIMESTAMP = /\(20\d\d-\d\d-\d\d/;

function isEventChannelName(name) {
  const text = String(name || '');
  return EVENT_PREFIX.test(text) || (EVENT_VERSUS.test(text) && EVENT_TIMESTAMP.test(text));
}

function classifyChannelKind(name) {
  if (isPlaceholderName(name)) return 'placeholder';
  if (teamChannelKeys(name)) return 'team';
  if (isEventChannelName(name)) return 'event';
  if (isSportsChannelName(name)) return 'linear';
  return 'other';
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Preferred markets when one identity exists in several groups; every other group scores 0. */
const GROUP_PRIORITY = Object.freeze({ UK: 5, US: 4, IE: 3, CA: 2, AU: 1 });

function groupScore(group) {
  const code = normalizeName(group).split(' ')[0].toUpperCase();
  return Object.hasOwn(GROUP_PRIORITY, code) ? GROUP_PRIORITY[code] : 0;
}

function entryScore(name, group) {
  return qualityScore(name) * 1000 + groupScore(group);
}

module.exports = {
  normalizeName,
  channelKey,
  channelAliasKey,
  teamChannelKeys,
  teamQueryKeys,
  eventQueryTokens,
  classifyChannelKind,
  isSportsChannelName,
  isPlaceholderName,
  entryScore,
  qualityScore,
  groupScore,
  GROUP_PRIORITY,
  QUALITY_TOKENS,
  TEAM_STOPWORDS
};
