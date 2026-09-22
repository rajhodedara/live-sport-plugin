'use strict';

/**
 * ReplayFilterService
 *
 * Pure helper behind the "Replay catalog" config option (`config.replayFilter`).
 *
 * Why this exists: the replay rows are assembled from every replay-capable
 * source, so they are dominated by niche / lower-division fixtures — a busy
 * Saturday can list hundreds of them. MainstreamRankingService already knows
 * how to tell a mainstream fixture from a minor one; this service turns that
 * classifier into a single user-facing switch:
 *
 *   'all' (default)  -> no filtering at all; today's behaviour, unchanged
 *   'mainstream'     -> only getMatchTier(match) === TIER.MAINSTREAM survives
 *
 * Two details worth keeping in mind:
 *   - When the option is absent or 'all' the input array is returned by
 *     IDENTICAL reference, so the default path cannot drift from the old code
 *     even by a reallocation.
 *   - An empty result is a legitimate outcome (a quiet day really can have no
 *     mainstream replays), so nothing here treats it as an error. Callers hand
 *     the empty list straight to their normal "no matches" path.
 *
 * Pure: no I/O, no clock, no globals. Malformed config and malformed input both
 * degrade to "no filtering" rather than throwing.
 */

const { TIER, getMatchTier } = require('./MainstreamRankingService');

const REPLAY_FILTER_ALL = 'all';
const REPLAY_FILTER_MAINSTREAM = 'mainstream';

/** Normalizes the raw option to one of the two known values ('all' default). */
function parseReplayFilter(config) {
  try {
    const raw = typeof config === 'string'
      ? config
      : (config && typeof config === 'object' ? config.replayFilter : null);
    if (typeof raw !== 'string') return REPLAY_FILTER_ALL;
    const normalized = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
    // Accept the obvious spellings a hand-written config URL may carry.
    if (normalized === 'mainstream' || normalized === 'mainstreamonly') return REPLAY_FILTER_MAINSTREAM;
    return REPLAY_FILTER_ALL;
  } catch (_) {
    return REPLAY_FILTER_ALL;
  }
}

/** True when the user asked for mainstream-only replay catalogs. */
function isMainstreamOnlyReplayFilter(config) {
  return parseReplayFilter(config) === REPLAY_FILTER_MAINSTREAM;
}

/**
 * Applies the replay personalization to a list of matches.
 *
 * Returns the SAME array when nothing should be filtered, so the default path
 * is byte-identical to the pre-option behaviour. Non-array input yields an
 * empty array rather than a throw, which keeps the callers' map/filter chains
 * valid when a cache hands back something unexpected.
 */
function filterReplayMatches(matches, config) {
  try {
    if (!Array.isArray(matches)) return [];
    if (!isMainstreamOnlyReplayFilter(config)) return matches;
    // getMatchTier tolerates null / non-object entries (they classify NEUTRAL),
    // so a malformed match is dropped by the filter instead of crashing it.
    return matches.filter(m => getMatchTier(m) === TIER.MAINSTREAM);
  } catch (_) {
    // Never let a personalization filter empty a catalog by accident: on any
    // unexpected failure fall back to the unfiltered list.
    return Array.isArray(matches) ? matches : [];
  }
}

module.exports = {
  REPLAY_FILTER_ALL,
  REPLAY_FILTER_MAINSTREAM,
  parseReplayFilter,
  isMainstreamOnlyReplayFilter,
  filterReplayMatches
};
