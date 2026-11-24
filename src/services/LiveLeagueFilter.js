const {
  LIVE_LEAGUE_GROUPS,
  ALL_CURATED_LEAGUE_IDS,
  normalizeLeagueName,
} = require('../../public/live-league-options');

const KNOWN_IDS_SET = new Set(ALL_CURATED_LEAGUE_IDS);

// Build fast lookup maps for curated options:
// 1. All normalized curated labels and aliases -> set (for rejecting custom names that duplicate curated options)
// 2. Map of normalized name + category -> option
const CURATED_NORMALIZED_SET = new Set();
const CURATED_NAME_OPTIONS = []; // { normName, option, isCollegeSportSpecific }

for (const group of LIVE_LEAGUE_GROUPS) {
  for (const option of group.options) {
    const normLabel = normalizeLeagueName(option.label);
    if (normLabel) {
      CURATED_NORMALIZED_SET.add(normLabel);
      CURATED_NAME_OPTIONS.push({ normName: normLabel, option });
    }
    for (const alias of option.aliases || []) {
      const normAlias = normalizeLeagueName(alias);
      if (normAlias) {
        CURATED_NORMALIZED_SET.add(normAlias);
        CURATED_NAME_OPTIONS.push({ normName: normAlias, option });
      }
    }
  }
}

const SPORT_GENERIC_NAMES = {
  football: new Set(['football', 'soccer']),
  basketball: new Set(['basketball']),
  baseball: new Set(['baseball']),
  hockey: new Set(['hockey']),
  tennis: new Set(['tennis']),
  cricket: new Set(['cricket']),
  motorsport: new Set(['motorsport', 'motor', 'racing']),
  rugby: new Set(['rugby']),
  american_football: new Set(['american football', 'football']),
  mma: new Set(['mma', 'boxing', 'combat', 'fighting', 'ufc']),
  golf: new Set(['golf']),
  darts: new Set(['darts']),
  college: new Set(['college', 'ncaa']),
};

function isSportGenericName(normLeague, category) {
  if (!normLeague) return true;
  const cat = (category || '').toLowerCase();
  const genericSet = SPORT_GENERIC_NAMES[cat];
  if (genericSet && genericSet.has(normLeague)) return true;
  if (normLeague === cat) return true;
  return false;
}

/**
 * Validates and sanitizes live leagues configuration.
 * Returns null for omitted or structurally invalid config.
 * Returns { ids: string[], custom: string[], other: boolean } for valid config.
 */
function parseLiveLeagues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  // Structural check: must have at least one recognized property
  const hasIds = 'ids' in value;
  const hasCustom = 'custom' in value;
  const hasOther = 'other' in value;

  if (!hasIds && !hasCustom && !hasOther) {
    return null;
  }

  if (hasIds && !Array.isArray(value.ids)) {
    return null;
  }
  if (hasCustom && !Array.isArray(value.custom)) {
    return null;
  }
  if (hasOther && typeof value.other !== 'boolean') {
    return null;
  }

  // Sanitize IDs: unique known IDs preserving order
  const sanitizedIds = [];
  const seenIds = new Set();
  if (hasIds) {
    for (const id of value.ids) {
      if (typeof id === 'string' && KNOWN_IDS_SET.has(id) && !seenIds.has(id)) {
        seenIds.add(id);
        sanitizedIds.push(id);
      }
    }
  }

  // Sanitize custom names: up to 12 trimmed names of <= 60 chars, deduplicated by normalized key,
  // rejecting names that normalize to empty or duplicate curated labels/aliases.
  const sanitizedCustom = [];
  const seenCustomNorm = new Set();
  if (hasCustom) {
    for (const rawName of value.custom) {
      if (typeof rawName !== 'string') continue;
      const trimmed = rawName.trim();
      if (!trimmed || trimmed.length > 60) continue;
      const norm = normalizeLeagueName(trimmed);
      if (!norm) continue;
      if (CURATED_NORMALIZED_SET.has(norm)) continue; // duplicate of curated label/alias
      if (seenCustomNorm.has(norm)) continue; // deduplication by normalized key

      seenCustomNorm.add(norm);
      sanitizedCustom.push(trimmed);
      if (sanitizedCustom.length >= 12) break;
    }
  }

  const other = hasOther ? Boolean(value.other) : false;

  return {
    ids: sanitizedIds,
    custom: sanitizedCustom,
    other: other,
  };
}

function findCuratedOption(normName, category) {
  if (!normName) return null;
  const cat = (category || '').toLowerCase();

  for (const entry of CURATED_NAME_OPTIONS) {
    if (entry.normName === normName) {
      const opt = entry.option;
      // Sport-scoped check:
      if (!cat || opt.categories.includes(cat)) {
        // If fixture category is generic 'college', require that option/alias is sport-specific
        if (cat === 'college') {
          // Curated options for college are college-football, college-basketball, college-baseball, college-hockey
          // None of them have generic alias "college" or "ncaa", so entry.normName already must be sport-specific
          if (entry.normName === 'college' || entry.normName === 'ncaa') {
            continue;
          }
        }
        return opt;
      }
    }
  }
  return null;
}

/**
 * Checks if a fixture matches the live leagues selection.
 * @param {Object} fixture - { category, league, title }
 * @param {Object|null} selection - Sanitized { ids, custom, other } or null
 * @returns {boolean}
 */
function matchesLiveLeague(fixture, selection) {
  if (!selection) {
    // Selection omitted or structurally invalid includes any fixture
    return true;
  }

  const { ids, custom, other } = selection;

  // Deliberate empty selection hides all live fixtures
  if (ids.length === 0 && custom.length === 0 && !other) {
    return false;
  }

  const cat = (fixture && fixture.category) || '';
  const rawLeague = (fixture && fixture.league) || '';
  const title = (fixture && fixture.title) || '';

  const normLeague = normalizeLeagueName(rawLeague);

  let candidate = '';

  // Consult title only if league is missing or normalizes to sport name
  if (!normLeague || isSportGenericName(normLeague, cat)) {
    let candidateColon = '';
    let candidateDash = '';

    if (title.includes(':')) {
      candidateColon = title.split(':')[0].trim();
    }
    if (title.includes(' - ')) {
      const parts = title.split(' - ');
      candidateDash = parts[parts.length - 1].trim();
    }

    // Try finding a recognized curated competition or custom match from candidates
    const normColon = normalizeLeagueName(candidateColon);
    const normDash = normalizeLeagueName(candidateDash);

    if (normColon && findCuratedOption(normColon, cat)) {
      candidate = candidateColon;
    } else if (normDash && findCuratedOption(normDash, cat)) {
      candidate = candidateDash;
    } else if (normColon && custom.some(c => normalizeLeagueName(c) === normColon)) {
      candidate = candidateColon;
    } else if (normDash && custom.some(c => normalizeLeagueName(c) === normDash)) {
      candidate = candidateDash;
    } else if (candidateColon) {
      candidate = candidateColon;
    } else if (candidateDash) {
      candidate = candidateDash;
    }
  } else {
    candidate = rawLeague;
  }

  const normCandidate = normalizeLeagueName(candidate);
  if (!normCandidate) {
    // If there is no recognized label, the fixture falls into Other
    return Boolean(other);
  }

  // 1. Prefer an exact sport-scoped curated match on the candidate
  const curatedOption = findCuratedOption(normCandidate, cat);
  if (curatedOption) {
    // If it's a known curated competition:
    // "A known but unchecked curated competition stays excluded even with Other selected."
    return ids.includes(curatedOption.id);
  }

  // 2. Then an exact custom match
  const matchesCustom = custom.some(c => normalizeLeagueName(c) === normCandidate);
  if (matchesCustom) {
    return true;
  }

  // 3. Fall into Other
  // Custom names that are unchecked or removed have no dedicated category and can still appear through Other.
  return Boolean(other);
}

module.exports = {
  LIVE_LEAGUE_GROUPS,
  ALL_CURATED_LEAGUE_IDS,
  normalizeLeagueName,
  parseLiveLeagues,
  matchesLiveLeague,
};
