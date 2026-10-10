/**
 * manifest.js — Stremio / Nuvio Addon Manifest
 *
 * Live sports events and 24/7 sports networks aggregator.
 */

const { addonBuilder } = require('stremio-addon-sdk');

const manifest = {
  id: 'community.nuvio.live-sports',
  version: '3.1.3',
  name: '🏆 Nuvio Live Sports',
  description:
    'The ultimate live sports aggregator. Stream live Football, NBA, NFL, NHL, F1, and more. ' +
    'Aggregates high-speed live streams and 24/7 sports TV networks with zero-lag playback.',
  logo: '/logo.png',

  types: ['tv', 'series', 'channel'],
  resources: ['catalog', 'meta', 'stream'],

  catalogs: [
    { type: 'tv', id: 'nuvio_sports_teams', name: '⭐ Your Teams', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_live', name: '🔴 Live Now', extra: [
      { name: 'genre', options: ['Football', 'Cricket', 'Basketball', 'Motorsport', 'Tennis', 'Baseball', 'Hockey', 'Rugby', 'American Football', 'MMA', 'Golf', 'Darts', 'Other'], isRequired: false },
      { name: 'search', isRequired: false }
    ] },
    { type: 'tv', id: 'nuvio_sports_networks', name: '📺 24/7 Live TV', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_replays', name: '⏪ Sports Replays', extra: [{ name: 'skip', isRequired: true }] },
    
    // Football Sub-catalogs for Collections
    { type: 'tv', id: 'nuvio_sports_replays_football', name: '⚽ Football Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_today', name: "📅 Today's Replays", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_yesterday', name: "📅 Yesterday's Replays", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_this_week', name: "📅 This Week's Replays", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_older', name: "📅 Older Replays", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_premier_league', name: "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_ucl', name: "⭐ Champions League", extra: [{ name: 'skip', isRequired: true }] },

    // Motorsport Sub-catalogs for Collections
    { type: 'tv', id: 'nuvio_sports_replays_motorsport', name: '🏎️ Motorsport Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_motorsport_today', name: "📅 Today's Races", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_motorsport_yesterday', name: "📅 Yesterday's Races", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_motorsport_this_week', name: "📅 This Week's Races", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_motorsport_older', name: "📅 Older Races", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_motorsport_f1', name: "🏎️ Formula 1", extra: [{ name: 'skip', isRequired: true }] },

    // Baseball Sub-catalogs for Collections
    { type: 'tv', id: 'nuvio_sports_replays_baseball', name: '⚾ Baseball Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_baseball_today', name: "📅 Today's Games", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_baseball_yesterday', name: "📅 Yesterday's Games", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_baseball_this_week', name: "📅 This Week's Games", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_baseball_older', name: "📅 Older Games", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_baseball_mlb', name: "⚾ MLB", extra: [{ name: 'skip', isRequired: true }] },

    // Rugby Sub-catalogs for Collections
    { type: 'tv', id: 'nuvio_sports_replays_rugby', name: '🏉 Rugby Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_rugby_today', name: "📅 Today's Matches", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_rugby_yesterday', name: "📅 Yesterday's Matches", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_rugby_this_week', name: "📅 This Week's Matches", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_rugby_older', name: "📅 Older Matches", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_basketball', name: '🏀 Basketball Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_tennis', name: '🎾 Tennis Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_hockey', name: '🏒 Hockey Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_american_football', name: '🏈 American Football Replays', extra: [{ name: 'skip', isRequired: true }] },

    { type: 'tv', id: 'nuvio_sports_football', name: '⚽ Soccer', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_cricket', name: '🏏 Cricket', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_basketball', name: '🏀 Basketball', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_motorsport', name: '🏎️ F1 & Motor', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_hockey', name: '🏒 Hockey', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_baseball', name: '⚾ Baseball', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_mma', name: '🥊 MMA', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_golf', name: '⛳ Golf', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_tennis', name: '🎾 Tennis', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_rugby', name: '🏉 Rugby', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_american_football', name: '🏈 American Football', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_darts', name: '🎯 Darts', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_college', name: '🎓 College Sports', extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_other', name: '🏅 Other Sports', extra: [{ name: 'search', isRequired: false }] },

    { type: 'tv', id: 'nuvio_sports_upcoming', name: '⏱️ Upcoming', extra: [
      { name: 'genre', options: ['Football', 'Cricket', 'Basketball', 'Motorsport', 'Tennis', 'Baseball', 'Hockey', 'Rugby', 'American Football', 'MMA', 'Golf', 'Darts', 'Other'], isRequired: false },
      { name: 'search', isRequired: false }
    ] }
  ],

  config: [
    { key: 'teams', title: 'Favorite Teams (comma separated)', type: 'text' },
    { key: 'sports', title: 'Enabled Sports (comma separated)', type: 'text', default: 'all' },
    { 
      key: 'timezone', 
      title: 'Timezone', 
      type: 'text',
      default: 'UTC'
    },
    // Preferred commentary languages, in order. Names or codes both work
    // ("Spanish, Arabic, Hindi", "es, ar, hi"); English is always ranked first
  // regardless.
    { key: 'languages', title: 'Preferred Languages (comma separated, English always first)', type: 'text' },
    // 'all' (default) lists every replay; 'mainstream' hides niche and
    // lower-division fixtures from the replay catalogs and hubs.
    { key: 'replayFilter', title: 'Replay Catalog (all or mainstream)', type: 'text', default: 'all' }
  ],

  idPrefixes: ['nuvio_sport_'],

  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true
  },

  stremioAddonsConfig: {
    issuer: 'https://stremio-addons.net',
    signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..F6aEbE6t6R_hibs0MWTXdw.T0iVZbTb3-Cn9MUDoIic5yovMLCxjssPZHs2meJgSbTBXVegWV0j27ZCkIi60pNbuxEy2tQXHxbVytxthyD4GozD5DCzDnpdUcWQOmhd4IQs37WQxp7-neyrt9aeLP_N.XRyLWSFHcEupa3FTtsh_eA'
  },
};

const builder = new addonBuilder(manifest);

// Rolling/competition replay rows for the sport collections. Kept OUT of the
// static manifest so the manifest stays under the Stremio SDK's 8192-byte limit.
const REPLAY_MANIFEST_ROWS = [
  // Basketball
  { type: 'tv', id: 'nuvio_sports_replays_basketball_today', name: "\uD83D\uDCC5 Today's Games", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_basketball_yesterday', name: "\uD83D\uDCC5 Yesterday's Games", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_basketball_this_week', name: "\uD83D\uDCC5 This Week's Games", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_basketball_nba', name: '\uD83C\uDFC0 NBA', extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_basketball_older', name: '\uD83D\uDCC5 Older Games', extra: [{ name: 'skip', isRequired: true }] },
  // Tennis
  { type: 'tv', id: 'nuvio_sports_replays_tennis_today', name: "\uD83D\uDCC5 Today's Matches", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_tennis_yesterday', name: "\uD83D\uDCC5 Yesterday's Matches", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_tennis_this_week', name: "\uD83D\uDCC5 This Week's Matches", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_tennis_atp', name: '\uD83C\uDFBE ATP Tour', extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_tennis_older', name: '\uD83D\uDCC5 Older Matches', extra: [{ name: 'skip', isRequired: true }] },
  // Hockey
  { type: 'tv', id: 'nuvio_sports_replays_hockey_today', name: "\uD83D\uDCC5 Today's Games", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_hockey_yesterday', name: "\uD83D\uDCC5 Yesterday's Games", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_hockey_this_week', name: "\uD83D\uDCC5 This Week's Games", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_hockey_nhl', name: '\uD83C\uDFD2 NHL', extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_hockey_older', name: '\uD83D\uDCC5 Older Games', extra: [{ name: 'skip', isRequired: true }] },
  // American Football
  { type: 'tv', id: 'nuvio_sports_replays_american_football_today', name: "\uD83D\uDCC5 Today's Games", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_american_football_yesterday', name: "\uD83D\uDCC5 Yesterday's Games", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_american_football_this_week', name: "\uD83D\uDCC5 This Week's Games", extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_american_football_nfl', name: '\uD83C\uDFC8 NFL', extra: [{ name: 'skip', isRequired: true }] },
  { type: 'tv', id: 'nuvio_sports_replays_american_football_older', name: '\uD83D\uDCC5 Older Games', extra: [{ name: 'skip', isRequired: true }] }
];

/**
 * Builds and customizes manifest catalogs based on user config and optional match cache.
 *
 * @param {Array<object>} baseCatalogs
 * @param {object} parsedConfig
 * @param {Array<object>|null} cachedMatches
 * @returns {Array<object>}
 */
function buildManifestCatalogs(baseCatalogs, parsedConfig = {}, cachedMatches = null) {
  let catalogs = JSON.parse(JSON.stringify(baseCatalogs));

  // 1. Inject REPLAY_MANIFEST_ROWS if missing
  for (const extra of REPLAY_MANIFEST_ROWS) {
    if (!catalogs.some((c) => c.id === extra.id)) catalogs.push(extra);
  }

  // 2. Custom sports filtering and ordering
  if (typeof parsedConfig.sports === 'string' && parsedConfig.sports !== 'all') {
    if (parsedConfig.sports === 'none') {
      const keepCatalogs = ['nuvio_sports_teams', 'nuvio_sports_live', 'nuvio_sports_upcoming', 'nuvio_sports_networks', 'nuvio_sports_replays'];
      catalogs = catalogs.filter(c => keepCatalogs.includes(c.id));
    } else {
      const enabledSports = parsedConfig.sports
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

      const catalogMap = new Map();
      for (const cat of catalogs) {
        catalogMap.set(cat.id, cat);
      }

      const topAnchorIds = ['nuvio_sports_teams', 'nuvio_sports_live', 'nuvio_sports_networks', 'nuvio_sports_replays'];
      const orderedCatalogs = [];

      // 1. Top anchors (in their initial relative order)
      for (const id of topAnchorIds) {
        if (catalogMap.has(id)) {
          orderedCatalogs.push(catalogMap.get(id));
        }
      }

      // 2. Replay sub-catalogs grouped by user's enabled sports order
      for (const sport of enabledSports) {
        for (const cat of catalogs) {
          if (cat.id.startsWith(`nuvio_sports_replays_${sport}`)) {
            if (!orderedCatalogs.some(c => c.id === cat.id)) {
              orderedCatalogs.push(cat);
            }
          }
        }
      }

      // 3. Sport catalogs in exact user-specified order
      for (const sport of enabledSports) {
        const sportCatalogId = `nuvio_sports_${sport}`;
        if (catalogMap.has(sportCatalogId)) {
          orderedCatalogs.push(catalogMap.get(sportCatalogId));
        }
      }

      // 4. Bottom anchor (Upcoming)
      if (catalogMap.has('nuvio_sports_upcoming')) {
        orderedCatalogs.push(catalogMap.get('nuvio_sports_upcoming'));
      }

      catalogs = orderedCatalogs;
    }
  }

  // Remove teams catalog if the user hasn't configured any teams
  if (typeof parsedConfig.teams !== 'string' || parsedConfig.teams.trim() === '') {
    catalogs = catalogs.filter(c => c.id !== 'nuvio_sports_teams');
  }

  // Empty catalog pruning if cache is populated
  if (Array.isArray(cachedMatches) && cachedMatches.length > 0) {
    const present = new Set(cachedMatches.map(m => m && m.category).filter(Boolean));
    const ALWAYS_KEEP = new Set([
      'nuvio_sports_teams', 'nuvio_sports_live', 'nuvio_sports_upcoming',
      'nuvio_sports_other', 'nuvio_sports_networks'
    ]);
    catalogs = catalogs.filter((c) => {
      if (ALWAYS_KEEP.has(c.id)) return true;

      if (c.id === 'nuvio_sports_replays' || c.id.startsWith('nuvio_sports_replays_')) {
        if (parsedConfig.replayFilter === 'disabled') {
          return false;
        }
        return true;
      }

      const cat = c.id.replace('nuvio_sports_', '');
      if (present.has(cat)) return true;
      if (cachedMatches.some(m => m && m.category === 'networks')) {
        const titleLower = (m => String((m && m.title) || '').toLowerCase());
        if (cachedMatches.some(m => m && m.category === 'networks' && titleLower(m).includes(cat))) return true;
      }
      return false;
    });
  }

  // Ensure "⭐ Your Teams" catalog is strictly in first place (index 0) if present
  const teamsCatalogIndex = catalogs.findIndex(c => c.id === 'nuvio_sports_teams');
  if (teamsCatalogIndex > 0) {
    const [teamsCatalog] = catalogs.splice(teamsCatalogIndex, 1);
    catalogs.unshift(teamsCatalog);
  }

  return catalogs;
}

module.exports = {
  builder,
  manifest,
  REPLAY_MANIFEST_ROWS,
  buildManifestCatalogs
};

