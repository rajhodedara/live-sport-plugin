/**
 * manifest.js — Stremio / Nuvio Addon Manifest
 *
 * Live sports events and 24/7 sports networks aggregator.
 */

const { addonBuilder } = require('stremio-addon-sdk');

const manifest = {
  id: 'community.nuvio.live-sports',
  version: '3.0.0',
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
    { type: 'tv', id: 'nuvio_sports_networks', name: '📺 24/7 Live TV', extra: [{ name: 'search', isRequired: false }] },
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
    }
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

module.exports = { builder, manifest };
