'use strict';

/**
 * LanguagePriorityService
 *
 * Pure helpers behind the "Preferred languages" config option (`config.languages`).
 *
 * Why this exists: every stream carries a `language` value populated by
 * ChannelCountryService.detectChannelCountry() — an English name such as
 * "English", "Hindi", "German". handleStream used to hard-code the ordering as
 * English -> unknown -> everything else, so a user who wants Hindi commentary
 * ranked above a German one had no way to say so: both landed in the same tier
 * and the order was decided by score alone.
 *
 * The ranking below is a strict superset of that old behaviour, so a user with
 * no config sees exactly the list they saw before:
 *
 *   rank 0        English — always, and deliberately NOT overridable
 *   rank 1..n     the configured languages, in the order the user typed them
 *   rank n+1      streams whose language was never detected
 *   rank n+2      every other known language
 *
 * With no config (n = 0) those collapse to 0 / 1 / 2, i.e. precisely the old
 * `langTier`. Unknown or unrecognised tokens in the config are dropped rather
 * than ranked, so a typo can only ever mean "no preference", never a broken
 * list or a thrown error.
 *
 * Everything here is pure: no I/O, no clock, no globals, no dependencies, and
 * no input shape can make it throw.
 */

/** Canonical key for the mandatory top language. */
const ENGLISH = 'english';

/** Stream names handleStream assigns; a direct stream outranks a web fallback. */
const DIRECT_STREAM_NAME = '⚡ Direct Stream';

/**
 * Canonical language name -> the extra spellings accepted for it (ISO 639-1 /
 * 639-2 codes, common endonyms). The canonical name itself is always accepted,
 * so only the non-obvious forms need listing here.
 *
 * Matching is done on the folded form (lowercase, accents stripped), so
 * "Português", "portugues" and "Portuguese" all reach the same entry.
 *
 * The first block is every language ChannelCountryService can currently emit;
 * the rest are widely-spoken languages a user may reasonably name even though
 * the detector does not produce them yet. Adding a language is a one-line edit.
 */
const LANGUAGE_ALIASES = {
  // ── Languages the country detector emits today ──────────────────────────
  english: ['en', 'eng', 'english'],
  arabic: ['ar', 'ara'],
  bosnian: ['bs', 'bos'],
  bulgarian: ['bg', 'bul'],
  croatian: ['hr', 'hrv'],
  czech: ['cs', 'cze', 'ces'],
  danish: ['da', 'dan'],
  dutch: ['nl', 'dut', 'nld', 'flemish'],
  french: ['fr', 'fra', 'fre', 'francais'],
  georgian: ['ka', 'kat', 'geo'],
  german: ['de', 'deu', 'ger', 'deutsch'],
  greek: ['el', 'ell', 'gre', 'hellenic'],
  hebrew: ['he', 'iw', 'heb'],
  hungarian: ['hu', 'hun', 'magyar'],
  icelandic: ['is', 'ice', 'isl'],
  italian: ['it', 'ita', 'italiano'],
  norwegian: ['no', 'nb', 'nn', 'nor', 'norsk'],
  polish: ['pl', 'pol', 'polski'],
  portuguese: ['pt', 'pt br', 'pt pt', 'por', 'portugues', 'brazilian'],
  romanian: ['ro', 'ron', 'rum'],
  russian: ['ru', 'rus'],
  serbian: ['sr', 'srp'],
  slovak: ['sk', 'slk', 'slo'],
  slovenian: ['sl', 'slv'],
  spanish: ['es', 'spa', 'espanol', 'castilian', 'latino'],
  swedish: ['sv', 'swe', 'svenska'],
  turkish: ['tr', 'tur', 'turkce'],

  // ── Other widely-spoken languages users ask for by name ─────────────────
  albanian: ['sq', 'sqi', 'alb'],
  amharic: ['am', 'amh'],
  azerbaijani: ['az', 'aze'],
  belarusian: ['be', 'bel'],
  bengali: ['bn', 'ben', 'bangla'],
  burmese: ['my', 'mya', 'bur'],
  catalan: ['ca', 'cat'],
  chinese: ['zh', 'zho', 'chi', 'cn', 'mandarin', 'cantonese'],
  estonian: ['et', 'est'],
  filipino: ['tl', 'fil', 'tagalog'],
  finnish: ['fi', 'fin', 'suomi'],
  galician: ['gl', 'glg'],
  gujarati: ['gu', 'guj'],
  hausa: ['ha', 'hau'],
  hindi: ['hi', 'hin'],
  indonesian: ['id', 'ind', 'in', 'bahasa'],
  irish: ['ga', 'gle'],
  japanese: ['ja', 'jpn', 'jp'],
  kannada: ['kn', 'kan'],
  kazakh: ['kk', 'kaz'],
  khmer: ['km', 'khm'],
  korean: ['ko', 'kor', 'kr'],
  kurdish: ['ku', 'kur'],
  lao: ['lo', 'lao'],
  latvian: ['lv', 'lav'],
  lithuanian: ['lt', 'lit'],
  macedonian: ['mk', 'mkd', 'mac'],
  malay: ['ms', 'msa', 'may'],
  malayalam: ['ml', 'mal'],
  marathi: ['mr', 'mar'],
  mongolian: ['mn', 'mon'],
  nepali: ['ne', 'nep'],
  pashto: ['ps', 'pus'],
  persian: ['fa', 'fas', 'per', 'farsi', 'dari'],
  punjabi: ['pa', 'pan'],
  sinhala: ['si', 'sin'],
  somali: ['so', 'som'],
  swahili: ['sw', 'swa', 'kiswahili'],
  tamil: ['ta', 'tam'],
  telugu: ['te', 'tel'],
  thai: ['th', 'tha'],
  ukrainian: ['uk', 'ukr'],
  urdu: ['ur', 'urd'],
  uzbek: ['uz', 'uzb'],
  vietnamese: ['vi', 'vie'],
  welsh: ['cy', 'cym', 'wel'],
  zulu: ['zu', 'zul']
};

/**
 * Folded alias -> canonical key. Built once at load time. Keyed on the folded
 * form so a lookup only ever has to fold the incoming value.
 */
const ALIAS_TO_CANONICAL = (() => {
  const map = new Map();
  for (const [canonical, aliases] of Object.entries(LANGUAGE_ALIASES)) {
    for (const alias of aliases.concat(canonical)) {
      const key = foldLanguage(alias);
      // First writer wins, so a canonical name can never be stolen by another
      // language's alias if the table is ever extended carelessly.
      if (key && !map.has(key)) map.set(key, canonical);
    }
  }
  return map;
})();

/**
 * Folds any value into the comparison form used for every lookup:
 * lowercase, accents stripped, non-alphanumerics collapsed to one space.
 * Returns '' for anything that carries no language (null, undefined, numbers,
 * objects) so callers can treat '' as "unknown" without a type check.
 */
function foldLanguage(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Canonical key for a language name or code, or '' when it is not recognised.
 * Never throws: non-strings and empty values fold to ''.
 */
function canonicalLanguage(value) {
  const key = foldLanguage(value);
  if (!key) return '';
  return ALIAS_TO_CANONICAL.get(key) || '';
}

/** True when the value names English (in any accepted spelling). */
function isEnglish(value) {
  return canonicalLanguage(value) === ENGLISH;
}

/**
 * Normalizes the raw config value into an ordered list of canonical language
 * keys, minus English (which is always rank 0, so listing it is a no-op).
 *
 * Accepts either the whole config object (`{ languages: 'Spanish, Arabic, Hindi' }`) or
 * the raw field value, so callers on both sides of the wire can use it as-is.
 * Tokens that name nothing we know, duplicates, blanks and malformed input are
 * all dropped silently — a config typo must never break the stream list.
 */
function parseLanguagePriority(config) {
  try {
    const raw = typeof config === 'string'
      ? config
      : (config && typeof config === 'object' ? config.languages : null);

    // Tolerate a client that sends a JSON array instead of the documented
    // comma-separated string.
    const tokens = Array.isArray(raw)
      ? raw
      : (typeof raw === 'string' ? raw.split(',') : []);

    const ordered = [];
    const seen = new Set();
    for (const token of tokens) {
      const canonical = canonicalLanguage(token);
      if (!canonical) continue;      // unknown token — ignore harmlessly
      if (canonical === ENGLISH) continue; // English is always ranked first anyway
      if (seen.has(canonical)) continue;   // keep the FIRST mention's position
      seen.add(canonical);
      ordered.push(canonical);
    }
    return ordered;
  } catch (_) {
    return [];
  }
}

/**
 * Rank of one language under an ordered priority list (from
 * parseLanguagePriority). Lower is better.
 *
 *   English            -> 0                        (never overridable)
 *   configured         -> 1 + index in the list
 *   no language        -> list.length + 1
 *   other known        -> list.length + 2
 *
 * The last two keep the historical "unknown before other-foreign" split for an
 * empty list, which is what makes the no-config case identical to the old tiers.
 */
function languageRank(language, priorities) {
  const list = Array.isArray(priorities) ? priorities : [];
  const canonical = canonicalLanguage(language);

  if (canonical === ENGLISH) return 0;

  if (canonical) {
    const index = list.indexOf(canonical);
    if (index !== -1) return index + 1;
    return list.length + 2; // known but not requested
  }

  return list.length + 1; // unknown / undetected
}

/** The score blend used to break ties inside one language rank (unchanged). */
function streamRankScore(stream) {
  if (!stream) return 0;
  return ((stream.score || 0) * 0.8) + ((stream.speedScore ?? 50) * 0.2);
}

/**
 * The comparator handleStream applies to its assembled stream list.
 * `priorities` is the parsed list; pass parseLanguagePriority(config).
 *
 * Order, unchanged from the hard-coded sort except that the language tier is
 * now configurable:
 *   1. direct streams before web fallbacks
 *   2. language rank
 *   3. rankScore = score*0.8 + speedScore*0.2
 */
function compareStreams(a, b, priorities) {
  try {
    const aIsDirect = a && a.name === DIRECT_STREAM_NAME ? 1 : 0;
    const bIsDirect = b && b.name === DIRECT_STREAM_NAME ? 1 : 0;
    if (aIsDirect !== bIsDirect) return bIsDirect - aIsDirect;

    const rankDelta = languageRank(a && a.language, priorities) - languageRank(b && b.language, priorities);
    if (rankDelta) return rankDelta;

    return streamRankScore(b) - streamRankScore(a);
  } catch (_) {
    // A comparator that throws leaves the array in an undefined order (V8 may
    // even leave holes), so degrade to the score blend rather than propagate.
    return streamRankScore(b) - streamRankScore(a);
  }
}

module.exports = {
  ENGLISH,
  DIRECT_STREAM_NAME,
  LANGUAGE_ALIASES,
  parseLanguagePriority,
  languageRank,
  canonicalLanguage,
  isEnglish,
  streamRankScore,
  compareStreams,
  // Exported for tests: the fold is the single place the matching semantics of
  // every alias lookup are defined.
  foldLanguage
};
