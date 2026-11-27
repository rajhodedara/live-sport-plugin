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
    { type: 'tv', id: 'nuvio_sports_networks', name: '📺 24/7 Live TV', extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false }
    ] },
    { type: 'tv', id: 'nuvio_sports_replays', name: '⏪ Sports Replays', extra: [{ name: 'skip', isRequired: true }] },
    
    // Parent Replay Catalogs
    { type: 'tv', id: 'nuvio_sports_replays_football', name: '⚽ Football Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_motorsport', name: '🏎️ Motorsport Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_baseball', name: '⚾ Baseball Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_rugby', name: '🏉 Rugby Replays', extra: [{ name: 'skip', isRequired: true }] },
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
    { key: 'liveLanguages', title: 'Live Commentary Languages (comma separated)', type: 'text' },
    { key: 'languageFilter', title: 'Live Language Filter (all or only)', type: 'text', default: 'all' },
    // 'all' (default) lists every replay; 'mainstream' hides niche and
    // lower-division fixtures from the replay catalogs and hubs.
    { key: 'replayFilter', title: 'Replay Catalog (all or mainstream)', type: 'text', default: 'all' },
    { key: 'liveSources', title: 'Live & TV Sources (comma separated)', type: 'text', default: 'all' },
    { key: 'replaySources', title: 'Replay & VOD Sources (comma separated)', type: 'text', default: 'all' },
    { key: 'sources', title: 'All Sources (legacy, comma separated)', type: 'text', default: 'all' }
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

const ALWAYS_KEEP_CATALOGS = new Set([
  'nuvio_sports_teams',
  'nuvio_sports_live',
  'nuvio_sports_upcoming',
  'nuvio_sports_networks',
  'nuvio_sports_replays'
]);

/**
 * Filters manifest catalogs when `sports` is an explicit comma-separated list
 * (anything other than `'all'`). Derives sport names from `nuvio_sports_*`
 * catalog IDs so newly added sport catalogs stay selectable automatically.
 */
function filterCatalogsBySports(catalogs, sports) {
  if (typeof sports !== 'string' || sports === 'all') return catalogs;
  const enabledSports = new Set(sports.split(',').map(s => s.trim()).filter(Boolean));
  return catalogs.filter((c) => {
    if (ALWAYS_KEEP_CATALOGS.has(c.id)) return true;
    if (c.id.startsWith('nuvio_sports_replays_')) {
      for (const sport of enabledSports) {
        if (c.id.startsWith(`nuvio_sports_replays_${sport}`)) return true;
      }
      return false;
    }
    if (c.id.startsWith('nuvio_sports_')) {
      const sport = c.id.slice('nuvio_sports_'.length);
      return enabledSports.has(sport);
    }
    return false;
  });
}

module.exports = { builder, manifest, filterCatalogsBySports };

