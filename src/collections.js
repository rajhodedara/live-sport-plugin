/**
 * collections.js — Nuvio Native Collections Generator
 *
 * Generates Nuvio Collections JSON schema for Sports Replays & Live Sports.
 * Creates Landscape cards for each sport category that open into
 * organized match rows (e.g. Recent Replays, Premier League, All Replays),
 * matching the layout seen in Nuvio streaming platform hubs (Netflix, Prime Video, etc.).
 */

const { BASE_URL } = require('./config');

const FOLDER_DEFINITIONS = [
  {
    id: 'folder-football-replays',
    sport: 'football',
    title: 'Football',
    poster: '/posters/replays/luffy_football.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_football_today', name: "📅 Today's Replays" },
      { id: 'nuvio_sports_replays_football_yesterday', name: "📅 Yesterday's Replays" },
      { id: 'nuvio_sports_replays_football_this_week', name: "📅 This Week's Replays" },
      { id: 'nuvio_sports_replays_football_premier_league', name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League Replays' },
      { id: 'nuvio_sports_replays_football_ucl', name: '⭐ Champions League & UEFA' },
      { id: 'nuvio_sports_replays_football_older', name: '📅 Older Replays' },
      { id: 'nuvio_sports_replays_football', name: '⚽ All Football Replays' }
    ]
  },
  {
    id: 'folder-motorsport-replays',
    sport: 'motorsport',
    title: 'Motorsport',
    poster: '/posters/replays/luffy_motorsport.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_motorsport_today', name: "📅 Today's Races" },
      { id: 'nuvio_sports_replays_motorsport_yesterday', name: "📅 Yesterday's Races" },
      { id: 'nuvio_sports_replays_motorsport_this_week', name: "📅 This Week's Races" },
      { id: 'nuvio_sports_replays_motorsport_f1', name: '🏎️ Formula 1 Replays' },
      { id: 'nuvio_sports_replays_motorsport_older', name: '📅 Older Races' },
      { id: 'nuvio_sports_replays_motorsport', name: '🏁 All Motorsport Replays' }
    ]
  },
  {
    id: 'folder-baseball-replays',
    sport: 'baseball',
    title: 'Baseball',
    poster: '/posters/replays/luffy_baseball.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_baseball_today', name: "📅 Today's Games" },
      { id: 'nuvio_sports_replays_baseball_yesterday', name: "📅 Yesterday's Games" },
      { id: 'nuvio_sports_replays_baseball_this_week', name: "📅 This Week's Games" },
      { id: 'nuvio_sports_replays_baseball_mlb', name: '⚾ MLB Replays' },
      { id: 'nuvio_sports_replays_baseball_older', name: '📅 Older Games' },
      { id: 'nuvio_sports_replays_baseball', name: '⚾ All Baseball Replays' }
    ]
  },
  {
    id: 'folder-rugby-replays',
    sport: 'rugby',
    title: 'Rugby',
    poster: '/posters/replays/luffy_rugby.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_rugby_today', name: "📅 Today's Matches" },
      { id: 'nuvio_sports_replays_rugby_yesterday', name: "📅 Yesterday's Matches" },
      { id: 'nuvio_sports_replays_rugby_this_week', name: "📅 This Week's Matches" },
      { id: 'nuvio_sports_replays_rugby_older', name: '📅 Older Matches' },
      { id: 'nuvio_sports_replays_rugby', name: '🏉 All Rugby Replays' }
    ]
  }
];

function getSportCatalogs(def) {
  // Return the permanent, rolling relative date rows and competition catalogs.
  // These rows never expire, never require re-importing collections JSON,
  // and dynamically adapt as new matches are scraped!
  return [...def.catalogs];
}

function generateCollections(baseUrl = BASE_URL, config = '') {
  const cleanBaseUrl = (baseUrl || '').replace(/\/+$/, '');
  const manifestPath = config ? `/${config}/manifest.json` : '/manifest.json';
  const manifestUrl = `${cleanBaseUrl}${manifestPath}`;

  const folders = FOLDER_DEFINITIONS.map(def => {
    const coverImageUrl = `${cleanBaseUrl}${def.poster}`;
    const dynamicCatalogs = getSportCatalogs(def);
    const catalogSources = dynamicCatalogs.map(cat => ({
      addonId: 'community.nuvio.live-sports',
      addonName: 'Nuvio Live Sports',
      manifestUrl: manifestUrl,
      catalogId: cat.id,
      catalogName: cat.name,
      name: cat.name,
      title: cat.name,
      type: 'tv',
      showInHome: false
    }));

    return {
      id: def.id,
      title: def.title,
      tileShape: 'LANDSCAPE',
      hideTitle: false,
      focusGifEnabled: false,
      coverImageUrl: coverImageUrl,
      focusGifUrl: coverImageUrl,
      heroBackdropUrl: coverImageUrl,
      backdropUrl: coverImageUrl,
      catalogSources: catalogSources
    };
  });

  return [
    {
      id: 'collection-sports-replays',
      title: 'Sports Replays',
      pinToTop: true,
      showAllTab: true,
      viewMode: 'FOLLOW_LAYOUT',
      focusGlowEnabled: true,
      folders: folders
    }
  ];
}

module.exports = {
  FOLDER_DEFINITIONS,
  generateCollections
};
