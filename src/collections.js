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
    poster: '/posters/replays/football.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_football_recent', name: '🔥 Recent Replays' },
      { id: 'nuvio_sports_replays_football_premier_league', name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League Replays' },
      { id: 'nuvio_sports_replays_football_ucl', name: '⭐ Champions League & UEFA' },
      { id: 'nuvio_sports_replays_football', name: '⚽ All Football Replays' }
    ]
  },
  {
    id: 'folder-motorsport-replays',
    sport: 'motorsport',
    title: 'Motorsport',
    poster: '/posters/replays/motorsport.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_motorsport_recent', name: '🔥 Recent Motorsport' },
      { id: 'nuvio_sports_replays_motorsport_f1', name: '🏎️ Formula 1 Replays' },
      { id: 'nuvio_sports_replays_motorsport', name: '🏁 All Motorsport Replays' }
    ]
  },
  {
    id: 'folder-basketball-replays',
    sport: 'basketball',
    title: 'Basketball',
    poster: '/posters/replays/basketball.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_basketball_recent', name: '🔥 Recent Basketball' },
      { id: 'nuvio_sports_replays_basketball_nba', name: '🏀 NBA Replays' },
      { id: 'nuvio_sports_replays_basketball', name: '🏀 All Basketball Replays' }
    ]
  },
  {
    id: 'folder-baseball-replays',
    sport: 'baseball',
    title: 'Baseball',
    poster: '/posters/replays/baseball.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_baseball_recent', name: '🔥 Recent Baseball' },
      { id: 'nuvio_sports_replays_baseball_mlb', name: '⚾ MLB Replays' },
      { id: 'nuvio_sports_replays_baseball', name: '⚾ All Baseball Replays' }
    ]
  },
  {
    id: 'folder-rugby-replays',
    sport: 'rugby',
    title: 'Rugby',
    poster: '/posters/replays/rugby.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_rugby_recent', name: '🔥 Recent Rugby' },
      { id: 'nuvio_sports_replays_rugby', name: '🏉 All Rugby Replays' }
    ]
  },
  {
    id: 'folder-american-football-replays',
    sport: 'american_football',
    title: 'American Football',
    poster: '/posters/replays/american_football.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_american_football_recent', name: '🔥 Recent NFL' },
      { id: 'nuvio_sports_replays_american_football', name: '🏈 All American Football Replays' }
    ]
  },
  {
    id: 'folder-hockey-replays',
    sport: 'hockey',
    title: 'Hockey',
    poster: '/posters/replays/hockey.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_hockey_recent', name: '🔥 Recent Hockey' },
      { id: 'nuvio_sports_replays_hockey', name: '🏒 All Hockey Replays' }
    ]
  },
  {
    id: 'folder-cricket-replays',
    sport: 'cricket',
    title: 'Cricket',
    poster: '/posters/replays/cricket.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_cricket', name: '🏏 Cricket Replays' }
    ]
  },
  {
    id: 'folder-tennis-replays',
    sport: 'tennis',
    title: 'Tennis',
    poster: '/posters/replays/tennis.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_tennis', name: '🎾 Tennis Replays' }
    ]
  },
  {
    id: 'folder-mma-replays',
    sport: 'mma',
    title: 'MMA & Fighting',
    poster: '/posters/replays/mma.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_mma', name: '🥊 MMA & Fighting Replays' }
    ]
  }
];

function getSportCatalogs(def) {
  let replayMatches = [];
  try {
    const container = require('./container');
    const cacheService = container.resolve('cacheService');
    const allMatches = cacheService.getMatches() || [];
    replayMatches = allMatches.filter(m => {
      if (!m || !Array.isArray(m.sources) || m.sources.length === 0) return false;
      if (m.sources.some(s => s.source === 'timstreams')) return false;
      if (!m.sources.some(s => s.source === 'replayzone')) return false;
      if (def.sport !== 'all' && m.category !== def.sport) return false;
      return true;
    });
  } catch (_) {}

  const dateMap = new Map();
  replayMatches.forEach(m => {
    if (m.date) {
      const dStr = m.date.slice(0, 10);
      if (!dateMap.has(dStr)) dateMap.set(dStr, 0);
      dateMap.set(dStr, dateMap.get(dStr) + 1);
    }
  });

  const sortedDates = Array.from(dateMap.keys()).sort().reverse();
  const dateCatalogs = [];

  if (sortedDates.length > 0) {
    sortedDates.slice(0, 14).forEach(dStr => {
      const dateObj = new Date(dStr + 'T00:00:00Z');
      const displayDate = !isNaN(dateObj.getTime())
        ? dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : dStr;
      dateCatalogs.push({
        id: `nuvio_sports_replays_${def.sport}_date_${dStr}`,
        name: `📅 ${displayDate}`
      });
    });
  } else {
    // Fallback: generate last 7 calendar days
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const dStr = d.toISOString().slice(0, 10);
      const dateObj = new Date(dStr + 'T00:00:00Z');
      const displayDate = !isNaN(dateObj.getTime())
        ? dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : dStr;
      dateCatalogs.push({
        id: `nuvio_sports_replays_${def.sport}_date_${dStr}`,
        name: `📅 ${displayDate}`
      });
    }
  }

  // Followed by competitions and all replays from def.catalogs (avoiding duplicates)
  const existingIds = new Set(dateCatalogs.map(c => c.id));
  (def.catalogs || []).forEach(cat => {
    if (!existingIds.has(cat.id)) {
      dateCatalogs.push(cat);
      existingIds.add(cat.id);
    }
  });

  // Ensure All Replays exists
  const allReplaysId = `nuvio_sports_replays_${def.sport}`;
  if (!existingIds.has(allReplaysId)) {
    dateCatalogs.push({ id: allReplaysId, name: `⚽ All ${def.title} Replays` });
  }

  return dateCatalogs;
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
