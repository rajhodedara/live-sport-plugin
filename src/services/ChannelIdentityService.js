'use strict';

const ChannelCountryService = require('./ChannelCountryService');

/**
 * Common ISO language code -> canonical English language name
 */
const ISO_LANG_MAP = {
  en: 'English',
  eng: 'English',
  fr: 'French',
  fra: 'French',
  de: 'German',
  deu: 'German',
  ger: 'German',
  es: 'Spanish',
  spa: 'Spanish',
  it: 'Italian',
  ita: 'Italian',
  nl: 'Dutch',
  nld: 'Dutch',
  pl: 'Polish',
  pol: 'Polish',
  pt: 'Portuguese',
  por: 'Portuguese',
  tr: 'Turkish',
  tur: 'Turkish',
  ar: 'Arabic',
  ara: 'Arabic',
  hi: 'Hindi',
  hin: 'Hindi',
  ru: 'Russian',
  rus: 'Russian',
  sq: 'Albanian',
  alb: 'Albanian',
  el: 'Greek',
  gre: 'Greek',
  ro: 'Romanian',
  ron: 'Romanian',
  hr: 'Croatian',
  hrv: 'Croatian',
  sr: 'Serbian',
  srp: 'Serbian',
  cs: 'Czech',
  cze: 'Czech',
  sk: 'Slovak',
  slk: 'Slovak',
  hu: 'Hungarian',
  hun: 'Hungarian',
  sv: 'Swedish',
  swe: 'Swedish',
  da: 'Danish',
  dan: 'Danish',
  no: 'Norwegian',
  nor: 'Norwegian',
  fi: 'Finnish',
  fin: 'Finnish',
  ms: 'Malay',
  msa: 'Malay',
  id: 'Indonesian',
  ind: 'Indonesian',
  he: 'Hebrew',
  heb: 'Hebrew'
};

/**
 * Common country names -> canonical primary language fallback
 */
const COUNTRY_LANG_MAP = {
  'United Kingdom': 'English',
  'United States': 'English',
  'USA': 'English',
  'UK': 'English',
  'Canada': 'English',
  'Australia': 'English',
  'New Zealand': 'English',
  'Ireland': 'English',
  'France': 'French',
  'Germany': 'German',
  'Austria': 'German',
  'Switzerland': 'German',
  'Spain': 'Spanish',
  'Mexico': 'Spanish',
  'Argentina': 'Spanish',
  'Italy': 'Italian',
  'Netherlands': 'Dutch',
  'Poland': 'Polish',
  'Portugal': 'Portuguese',
  'Brazil': 'Portuguese',
  'Turkey': 'Turkish',
  'Albania': 'Albanian',
  'Israel': 'Hebrew',
  'Malaysia': 'English', // Sports broadcasting (Astro) is primarily English commentary
  'India': 'Hindi',
  'South Africa': 'English',
  'Arabic': 'Arabic'
};

/**
 * Common network acronyms that should remain UPPERCASE in canonical display titles
 */
const UPPERCASE_TOKENS = new Set([
  'TV', 'HD', 'UHD', 'FHD', 'SD', 'BBC', 'ITV', 'CNN', 'ESPN', 'TNT', 'BT', 'FOX',
  'NBC', 'CBS', 'ABC', 'TSN', 'WWE', 'UFC', 'MMA', 'NFL', 'NBA', 'MLB', 'NHL',
  'PGA', 'F1', 'USA', 'UK', 'DAZN', 'TUDN', 'MSNBC', 'CNBC', 'MTV', 'VH1', 'SEC',
  'ACC', 'BTN', 'NESN', 'MASN', 'MSG', 'RDS', 'ORF', 'SRF', 'RAI', 'TF1', 'M6',
  'RTE', 'NPO', 'TVP', 'PPV'
]);

// Brands upstream sometimes ships with the trailing digit detached
// ("TF 1", "M 6"). Left alone, step 7 below reads that digit as a channel
// number, which both mis-titles the card ("Tf 1") and blocks the merge with
// the glued spelling ("TF1") on MatchAggregator's channelNumber guard.
// Only digit-bearing French DTT brands are listed: in "Sky Sports F1",
// "TV 1000" or "beIN Sports 1" the digit is a real channel number and must
// keep its own identity.
const GLUED_BRANDS = ['TF1', 'M6', 'W9', 'C8', 'NRJ12', 'RTL9'];
const GLUED_BRAND_RE = new RegExp(
  `\\b(?:${GLUED_BRANDS.map((b) => b.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')).join('|')})\\b`,
  'gi'
);

function glueBrandDigits(name) {
  return name.replace(GLUED_BRAND_RE, (m) => m.replace(/\s+/g, '').toUpperCase());
}

const _channelParseCache = new Map();
const MAX_CHANNEL_CACHE = 5000;

class ChannelIdentityService {
  /**
   * Clears the parseChannel memoization cache.
   */
  static clearCache() {
    _channelParseCache.clear();
  }

  /**
   * Parses raw channel name and returns normalized identity and extracted attributes
   * @param {string} rawName 
   * @param {Object} [meta] { group, league, language, country, countryCode, is4k, isBackup, isTimeshift }
   * @returns {{
   *   canonicalTitle: string,
   *   identityKey: string,
   *   channelNumber: string|null,
   *   country: string|null,
   *   countryCode: string|null,
   *   countryFlag: string|null,
   *   language: string,
   *   resolution: string,
   *   isBackup: boolean,
   *   isTimeshift: boolean
   * }}
   */
  static parseChannel(rawName, meta = {}) {
    const raw = glueBrandDigits(String(rawName || '').trim());
    if (!raw) {
      return {
        canonicalTitle: 'Unknown Channel',
        identityKey: 'unknownchannel',
        channelNumber: null,
        country: null,
        countryCode: null,
        countryFlag: null,
        language: 'English',
        resolution: 'HD',
        isBackup: false,
        isTimeshift: false
      };
    }

    const groupKey = (meta && (meta.group || meta.league || meta.country)) || '';
    const cacheKey = `${raw}|${groupKey}|${meta.country || ''}|${meta.countryCode || ''}|${(meta && meta.language) || ''}|${Boolean(meta && meta.isBackup)}|${Boolean(meta && meta.isTimeshift)}|${Boolean(meta && meta.is4k)}|${(meta && meta.resolution) || ''}`;
    const cached = _channelParseCache.get(cacheKey);
    if (cached) return cached;

    // 1. Detect Backup Feed
    const isBackup = Boolean(
      meta.isBackup === true ||
      /\b(?:backup(?:\s*\d+)?|bkp|alternate|alt)\b/i.test(raw) ||
      /\(\s*backup(?:\s*\d+)?\s*\)/i.test(raw) ||
      /\[\s*backup(?:\s*\d+)?\s*\]/i.test(raw)
    );

    // 2. Detect Timeshift Feed (+1, +2, etc.)
    const isTimeshift = Boolean(
      meta.isTimeshift === true ||
      /(?:(?:\+|\bplus\s*)\d{1,2}\s*(?:hr|hour|h)?\b|\btime\s*shift\b|\bdelay\b)/i.test(raw)
    );

    // 3. Detect Resolution / Quality
    let resolution = 'HD';
    if (meta.is4k || /\b(?:4k|uhd)\b/i.test(raw)) {
      resolution = '4K';
    } else if (/\b(?:1080p|fhd|full\s*hd)\b/i.test(raw)) {
      resolution = '1080p';
    } else if (/\b(?:720p)\b/i.test(raw)) {
      resolution = '720p';
    } else if (/\b(?:sd|480p|360p)\b/i.test(raw)) {
      resolution = 'SD';
    } else if (meta.resolution) {
      resolution = meta.resolution;
    }

    // 4. Detect Country and Language
    // Explicit group or country metadata from provider is authoritative ground truth
    const explicitCountryInfo = ChannelCountryService.getCountryInfo(meta.countryCode) || ChannelCountryService.getCountryInfo(meta.country);
    const groupCountryInfo = (meta.group && !/^(?:live tv|general|channels|networks|other|multi-region)$/i.test(meta.group.trim()))
      ? ChannelCountryService.detectChannelCountry(meta.group.trim())
      : (meta.country ? ChannelCountryService.detectChannelCountry(meta.country) : null);
    const detectedCountryInfo = ChannelCountryService.detectChannelCountry(raw);
    const primaryCountryInfo = explicitCountryInfo || groupCountryInfo || detectedCountryInfo;

    let country = (explicitCountryInfo ? explicitCountryInfo.country : meta.country) || (groupCountryInfo ? groupCountryInfo.country : (meta.group && !/^(?:live tv|general|channels|networks|other|multi-region)$/i.test(meta.group.trim()) ? meta.group.trim() : null)) || (detectedCountryInfo ? detectedCountryInfo.country : null);
    let countryCode = (primaryCountryInfo && primaryCountryInfo.name) || (country && COUNTRY_LANG_MAP[country] ? country.slice(0, 2).toUpperCase() : null);
    let countryFlag = (primaryCountryInfo && primaryCountryInfo.flag) || null;

    let language = 'English';
    if (meta.language && typeof meta.language === 'string') {
      const code = meta.language.toLowerCase().trim();
      language = ISO_LANG_MAP[code] || meta.language;
    } else {
      // Check explicit language tokens in raw name
      const rawLower = raw.toLowerCase();
      if (/\barabic\b/i.test(rawLower)) language = 'Arabic';
      else if (/\bfrench\b/i.test(rawLower)) language = 'French';
      else if (/\bgerman\b/i.test(rawLower)) language = 'German';
      else if (/\bspanish\b/i.test(rawLower)) language = 'Spanish';
      else if (/\bitalian\b/i.test(rawLower)) language = 'Italian';
      else if (/\bportuguese\b/i.test(rawLower)) language = 'Portuguese';
      else if (/\bpolish\b/i.test(rawLower)) language = 'Polish';
      else if (/\bturkish\b/i.test(rawLower)) language = 'Turkish';
      else if (/\bhindi\b/i.test(rawLower)) language = 'Hindi';
      else if (/\brussian\b/i.test(rawLower)) language = 'Russian';
      else if (/\bdutch\b/i.test(rawLower)) language = 'Dutch';
      else if (primaryCountryInfo && primaryCountryInfo.language) {
        language = primaryCountryInfo.language;
      } else if (country && COUNTRY_LANG_MAP[country]) {
        language = COUNTRY_LANG_MAP[country];
      }
    }

    // 5. Build Canonical Title
    let clean = raw;

    // Strip flag emojis & surrogate pairs
    clean = clean.replace(/[\uD83C-\uDBFF\uDC00-\uDFFF]+/g, ' ');

    // Strip provider prefix tags like [RAW], [VIP], UK:, US:, etc.
    clean = clean.replace(/^\[(?:raw|vip|st|vavoo|dlv|sktech)\]\s*/i, '');
    clean = clean.replace(/^(?:UK|US|USA|DE|FR|ES|IT|PL|TR|PT|NL|MY|IN|AU|CA|NZ|AR|CL|BR)\s*:\s*/i, '');

    // Strip bracketed metadata: (Backup), [Backup 1], (4K), (HD), (+1), (UK), (France), (EN), (RAW), (MATCH TIME), (LOCAL), etc.
    clean = clean.replace(/\[\s*(?:backup(?:\s*\d+)?|bkp|alternate|alt)\s*\]/gi, ' ');
    clean = clean.replace(/\(\s*(?:backup(?:\s*\d+)?|bkp|alternate|alt)\s*\)/gi, ' ');
    clean = clean.replace(/\[\s*(?:4k|uhd|fhd|1080p|720p|hd|sd|hevc|h\.?26[45]|50fps|60fps|raw|feed|local|match\s*time|live\s*during\s*events\s*only|sat)\s*\]/gi, ' ');
    clean = clean.replace(/\(\s*(?:4k|uhd|fhd|1080p|720p|hd|sd|hevc|h\.?26[45]|50fps|60fps|raw|feed|local|match\s*time|live\s*during\s*events\s*only|sat)\s*\)/gi, ' ');
    clean = clean.replace(/\[\s*\]/g, ' ');
    clean = clean.replace(/\(\s*\)/g, ' ');
    clean = clean.replace(/\(\s*(?:\+\s*\d{1,2}|\btime\s*shift\b|\bdelay\b)\s*\)/gi, ' ');
    clean = clean.replace(/\(\s*(?:uk|usa?|united\s*kingdom|united\s*states|france|germany|deutschland|italy|italia|spain|espana|portugal|poland|polska|netherlands|turkey|turkiye|albania|arabic|arab|malaysia|canada|australia|new\s*zealand|ireland|austria|switzerland|india|south\s*africa|latam|balkan|argentina|chile|brazil|de|nz|ar|cl|br|pt|es|it|fr|nl|pl|tr)\s*\)/gi, ' ');
    clean = clean.replace(/\(\s*(?:en|eng|english|fr|fra|french|de|deu|ger|german|es|spa|spanish|it|ita|italian|pt|por|portuguese|pl|pol|polish|tr|tur|turkish|ar|ara|arabic|hi|hin|hindi|ru|rus|russian)\s*\)/gi, ' ');

    // Strip server/cluster suffix (e.g. .b, .c, .s, .a, etc.)
    clean = clean.replace(/\s*\.[a-z]\b/gi, ' ');

    // Strip quality, feed, and stream modifiers outside brackets
    clean = clean.replace(/\b(?:4k|uhd|fhd|full\s*hd|1080p|720p|hd|sd|hevc|h\.?26[45]|50fps|60fps|raw|feed)\b/gi, ' ');

    // Strip timeshift labels outside brackets (+1, +2, +1 hr, Timeshift)
    clean = clean.replace(/(?:(?:\+|\bplus\s*)\d{1,2}\s*(?:hr|hour|h)?\b|\btime\s*shift\b|\bdelay\b)/gi, ' ');

    // Strip backup labels outside brackets
    clean = clean.replace(/\b(?:backup(?:\s*\d+)?|bkp|alternate|alt)\b/gi, ' ');

    // Standardize known sports brand stems (sport -> Sports, e.g. TNT SPORT 1 -> TNT Sports 1)
    clean = clean.replace(/\bcanal\s*(?:\+|\bplus\b)\s*sports?\b/gi, 'Canal+ Sport');
    clean = clean.replace(/\bcanal\s*(?:\+|\bplus\b)/gi, 'Canal+');
    clean = clean.replace(/\bmoto\s*gp\b/gi, 'MotoGP');
    clean = clean.replace(/\bsuper\s*sports?\b/gi, 'SuperSport');
    clean = clean.replace(/\beuro\s*sports?\b/gi, 'Eurosport');
    clean = clean.replace(/\bskys?\s*ports?\b/gi, 'Sky Sports');
    clean = clean.replace(/\b(tnt|bt|sky|bein|premier|dyn|arena|eleven|fox|cbs|nbc|polsat|astro|viaplay|dazn|tsn|flow|eir|ziggo|setanta|sony|star)\s+sports?\b/gi, (match, brand) => {
      const bUpper = brand.toUpperCase();
      const bName = UPPERCASE_TOKENS.has(bUpper) ? bUpper : (brand.charAt(0).toUpperCase() + brand.slice(1).toLowerCase());
      return bName + ' Sports';
    });

    // Split glued digits from words (e.g. "Sky Bundesliga1" -> "Sky Bundesliga 1", "TNT1" -> "TNT 1")
    // Guarded: preserves single-letter brand acronyms like F1, M6, A2, and French TF1
    clean = clean.replace(/(?<=[a-zA-Z]{2,})(?<!\b(?:f|m|a|k|h|tf))(\d+)\b/gi, ' $1');

    // Strip trailing language qualifiers if substantive brand words remain (e.g. "Cartoon Network Arabic" -> "Cartoon Network")
    const langPattern = /\b(?:arabic|english|french|german|spanish|italian|portuguese|polish|turkish|hindi|russian|dutch)\b/gi;
    const testStrippedLang = clean.replace(langPattern, ' ').trim();
    if (testStrippedLang.replace(/[^a-zA-Z0-9]/g, '').length >= 2) {
      clean = testStrippedLang;
    }

    // Strip trailing or separated country qualifiers if substantive brand words remain
    // e.g., "Astro Cricket Malaysia" -> "Astro Cricket", "Cartoonito UK" -> "Cartoonito", "M6 France" -> "M6"
    const countryPattern = /\b(?:uk|usa?|france|germany|deutschland|italy|italia|spain|espana|portugal|poland|polska|netherlands|turkey|turkiye|albania|malaysia|canada|australia|austria|switzerland|india|argentina|chile|brazil)\b/gi;
    // Short codes can be brand words: the interior "de" in Liga de Campeones
    // is not a Germany annotation. Only strip those at a name boundary.
    const testStrippedCountry = clean.replace(countryPattern, ' ')
      .replace(/^\s*(?:de|nz|ar|cl|br|pt|es|it|fr|nl|pl|tr)\b/gi, ' ')
      .replace(/\b(?:de|nz|ar|cl|br|pt|es|it|fr|nl|pl|tr)\s*$/gi, ' ').trim();
    // Safety guard: only strip if at least 2 alphanumeric characters remain (so "M6", "F1", "TF1" won't lose acronym, but "France 2" won't lose "France")
    if (testStrippedCountry.replace(/[^a-zA-Z0-9]/g, '').length >= 2) {
      clean = testStrippedCountry;
    }

    // Collapse punctuation and whitespace
    clean = clean
      .replace(/[|:–—\-_/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 6. Format Canonical Display Title (Title Casing while preserving acronyms)
    let canonicalTitle = clean.split(' ').map((word) => {
      if (!word) return '';
      const upper = word.toUpperCase();
      if (UPPERCASE_TOKENS.has(upper)) return upper;
      if (/^bein$/i.test(word)) return 'beIN';
      if (/^canal\+?$/i.test(word)) return 'Canal+';
      if (/^motogp$/i.test(word)) return 'MotoGP';
      if (/^supersport$/i.test(word)) return 'SuperSport';
      if (/^eurosport$/i.test(word)) return 'Eurosport';
      if (/[a-z][A-Z]/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ').trim();

    // 7. Extract Channel Number (Strict Isolation)
    // Preserves numbers like in "Astro Cricket 1", "Astro Cricket 2", "beIN Sports 1", "DAZN 2"
    let channelNumber = null;
    const numMatch = canonicalTitle.match(/\b(\d+)\b(?:\s*$)/);
    if (numMatch) {
      channelNumber = numMatch[1];
    }

    // 8. Compute Deterministic Identity Key
    // Lowercase alphanumeric only. Replace 'sports' with 'sport' so singular/plural brand mismatches
    // (e.g. TNT SPORT 1 vs TNT Sports 1) produce the exact same key.
    const identityKey = canonicalTitle
      .toLowerCase()
      .replace(/\bsports?\b/g, 'sport')
      .replace(/sports/g, 'sport')
      .replace(/[^a-z0-9]+/g, '');

    const result = {
      canonicalTitle: canonicalTitle || raw,
      identityKey: identityKey || 'unknown',
      channelNumber,
      country,
      countryCode,
      countryFlag,
      language,
      resolution,
      isBackup,
      isTimeshift
    };

    // Older channel IDs were built after removing short country-like words
    // anywhere in a brand (including Spanish "de"). Preserve that former
    // display spelling for providers whose public IDs include the title slug.
    const legacyCanonicalTitle = canonicalTitle.replace(/\b(?:de|nz|ar|cl|br|pt|es|it|fr|nl|pl|tr)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    if (legacyCanonicalTitle !== canonicalTitle && legacyCanonicalTitle.replace(/[^a-z0-9]/gi, '').length >= 2) {
      result.legacyCanonicalTitle = legacyCanonicalTitle;
    }

    if (_channelParseCache.size >= MAX_CHANNEL_CACHE) {
      const oldestKey = _channelParseCache.keys().next().value;
      _channelParseCache.delete(oldestKey);
    }
    _channelParseCache.set(cacheKey, result);

    return result;
  }
}

module.exports = ChannelIdentityService;
