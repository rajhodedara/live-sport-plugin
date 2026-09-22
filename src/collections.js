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
  },
  {
    id: 'folder-basketball-replays',
    sport: 'basketball',
    title: 'Basketball',
    poster: '/posters/replays/luffy_basketball.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_basketball_today', name: "📅 Today's Games" },
      { id: 'nuvio_sports_replays_basketball_yesterday', name: "📅 Yesterday's Games" },
      { id: 'nuvio_sports_replays_basketball_this_week', name: "📅 This Week's Games" },
      { id: 'nuvio_sports_replays_basketball_nba', name: "🏀 NBA Replays" },
      { id: 'nuvio_sports_replays_basketball_older', name: "📅 Older Games" },
      { id: 'nuvio_sports_replays_basketball', name: "All Basketball Replays" }
    ]
  },
  {
    id: 'folder-tennis-replays',
    sport: 'tennis',
    title: 'Tennis',
    poster: '/posters/replays/luffy_tennis.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_tennis_today', name: "📅 Today's Matches" },
      { id: 'nuvio_sports_replays_tennis_yesterday', name: "📅 Yesterday's Matches" },
      { id: 'nuvio_sports_replays_tennis_this_week', name: "📅 This Week's Matches" },
      { id: 'nuvio_sports_replays_tennis_atp', name: "🎾 ATP Tour Replays" },
      { id: 'nuvio_sports_replays_tennis_older', name: "📅 Older Matches" },
      { id: 'nuvio_sports_replays_tennis', name: "All Tennis Replays" }
    ]
  },
  {
    id: 'folder-hockey-replays',
    sport: 'hockey',
    title: 'Hockey',
    poster: '/posters/replays/luffy_hockey.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_hockey_today', name: "📅 Today's Games" },
      { id: 'nuvio_sports_replays_hockey_yesterday', name: "📅 Yesterday's Games" },
      { id: 'nuvio_sports_replays_hockey_this_week', name: "📅 This Week's Games" },
      { id: 'nuvio_sports_replays_hockey_nhl', name: "🏒 NHL Replays" },
      { id: 'nuvio_sports_replays_hockey_older', name: "📅 Older Games" },
      { id: 'nuvio_sports_replays_hockey', name: "All Hockey Replays" }
    ]
  },
  {
    id: 'folder-american_football-replays',
    sport: 'american_football',
    title: 'American Football',
    poster: '/posters/replays/luffy_american_football.jpg',
    catalogs: [
      { id: 'nuvio_sports_replays_american_football_today', name: "📅 Today's Games" },
      { id: 'nuvio_sports_replays_american_football_yesterday', name: "📅 Yesterday's Games" },
      { id: 'nuvio_sports_replays_american_football_this_week', name: "📅 This Week's Games" },
      { id: 'nuvio_sports_replays_american_football_nfl', name: "🏈 NFL Replays" },
      { id: 'nuvio_sports_replays_american_football_older', name: "📅 Older Games" },
      { id: 'nuvio_sports_replays_american_football', name: "All American Football Replays" }
    ]
  }
];

function getSportCatalogs(def) {
  // Return the permanent, rolling relative date rows and competition catalogs.
  // These rows never expire, never require re-importing collections JSON,
  // and dynamically adapt as new matches are scraped!
  return [...def.catalogs];
}

/** Encodes a config object to the base64url segment the addon URLs use. */
function encodeConfigSegment(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes a base64url config segment; null when it is not a config object. */
function decodeConfigSegment(segment) {
  try {
    let b = String(segment).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const parsed = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Builds the Nuvio Collections JSON.
 *
 * `options` lets the caller force personalization into the rows' manifestUrl
 * (e.g. { replayFilter: 'mainstream' }). This matters because every collection
 * row queries its OWN manifestUrl: if that URL carries no config, an imported
 * collection silently ignores the user's replay scope. Explicit options are
 * merged over any config segment already in the URL, so a bare
 * /collections.json?replayFilter=mainstream import still honours the filter.
 *
 * With no options the pre-existing behaviour is preserved exactly: the segment
 * is used verbatim.
 */
function generateCollections(baseUrl = BASE_URL, config = '', options = {}) {
  const cleanBaseUrl = (baseUrl || '').replace(/\/+$/, '');

  const overrides = {};
  if (options && options.replayFilter) overrides.replayFilter = String(options.replayFilter);
  if (options && options.languages) overrides.languages = String(options.languages);

  // The rows' manifestUrl must carry the personalization, but it is written
  // into EVERY folder/source pair (48 of them), so the encoding matters: a
  // full base64 config segment repeated 48x pushed the exported document past
  // Nuvio's paste size ceiling, which surfaced as a mid-document EOF parse
  // error rather than a syntax error.
  //
  // When the request already carried a config segment it is reused verbatim in
  // the path (no duplication, no recomputation). Explicit options are appended
  // as two short query params instead of being merged into a second segment:
  // `?rf=mainstream&lg=Spanish` costs a few bytes per row rather than ~41.
  const manifestPath = config ? `/${config}/manifest.json` : '/manifest.json';
  const manifestParams = new URLSearchParams();
  if (overrides.replayFilter) manifestParams.set('rf', overrides.replayFilter);
  if (overrides.languages) manifestParams.set('lg', overrides.languages);
  const manifestQuery = manifestParams.toString();
  const manifestUrl = `${cleanBaseUrl}${manifestPath}${manifestQuery ? `?${manifestQuery}` : ''}`;

  const folders = FOLDER_DEFINITIONS.map(def => {
    const coverImageUrl = `${cleanBaseUrl}${def.poster}?v=luffy`;
    const dynamicCatalogs = getSportCatalogs(def);
    const catalogSources = dynamicCatalogs.map(cat => ({
      addonId: 'community.nuvio.live-sports',
      addonName: 'Nuvio Live Sports',
      manifestUrl: manifestUrl,
      catalogId: cat.id,
      catalogName: cat.name,
      // `name` and `title` were byte-identical duplicates of catalogName.
      // With the config segment repeated in all 48 manifestUrls, the export
      // had grown to ~20.5 kB, which Nuvio's paste import truncates (it
      // reports EOF mid-document rather than a syntax error). One label is
      // all the schema needs; the functional fields are unchanged.
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
