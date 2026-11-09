'use strict';

/**
 * Favourite-team suggestions for the /api/options payload.
 *
 * Names come from the fixtures currently in the match cache: a name that shows
 * up in more fixtures is a more useful suggestion. Free text is still accepted
 * by the setup page, so a missing or empty list only costs suggestions.
 */

const MAX_TEAMS = 400;
const MAX_NAME_LENGTH = 60;

/**
 * @param {Array} matches cached matches, each with optional team1/team2 objects
 * @param {{limit?: number}} [options]
 * @returns {string[]} team names, most frequent first, then alphabetical
 */
function collectTeamNames(matches, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : MAX_TEAMS;
  const counts = new Map();

  for (const match of Array.isArray(matches) ? matches : []) {
    for (const team of [match && match.team1, match && match.team2]) {
      const name = team && typeof team.name === 'string' ? team.name.trim() : '';
      if (!name || name.length > MAX_NAME_LENGTH) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map((entry) => entry[0]);
}

module.exports = { collectTeamNames, MAX_TEAMS, MAX_NAME_LENGTH };
