const container = require('./container');
const { normalizeTimeZone } = require('./timezone');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapMatchToMetaPreview(match, config = {}) {
  const displayTitle = (() => {
    if (match.team1 && match.team1.name && match.team2 && match.team2.name) {
      return `${match.team1.name}\n${match.team2.name}`;
    }
    return match.title || 'Live Match';
  })();
  
  // Dynamic Sport-Specific Posters
  const categoryColors = {
    football: '10b981', // green
    basketball: 'f97316', // orange
    motorsport: 'ef4444', // red
    cricket: '0ea5e9', // light blue
    tennis: 'a3e635', // lime
    rugby: '8b5cf6', // purple
    american_football: '0369a1', // dark blue
    baseball: 'f43f5e', // rose
    hockey: '06b6d4', // cyan
    golf: '22c55e', // emerald
    darts: 'eab308', // yellow
    mma: 'dc2626', // crimson red
    networks: '64748b', // slate
    college: 'd946ef' // fuchsia
  };
  const color = categoryColors[match.category] || '333333';
  
  function getChannelLogo(title) {
    const t = title.toLowerCase();
    if (t.includes('sky sports cricket')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/8/87/Sky_Sports_Cricket_2020.svg/512px-Sky_Sports_Cricket_2020.svg.png';
    if (t.includes('sky sports main event')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/1/15/Sky_Sports_Main_Event_2020.svg/512px-Sky_Sports_Main_Event_2020.svg.png';
    if (t.includes('sky sports premier league')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/d/d4/Sky_Sports_Premier_League_2020.svg/512px-Sky_Sports_Premier_League_2020.svg.png';
    if (t.includes('sky sports football')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/6/67/Sky_Sports_Football_2020.svg/512px-Sky_Sports_Football_2020.svg.png';
    if (t.includes('sky sports f1')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/6/60/Sky_Sports_F1_2020.svg/512px-Sky_Sports_F1_2020.svg.png';
    if (t.includes('sky sports action')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/5/52/Sky_Sports_Action_2020.svg/512px-Sky_Sports_Action_2020.svg.png';
    if (t.includes('sky sports arena')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/0/00/Sky_Sports_Arena_2020.svg/512px-Sky_Sports_Arena_2020.svg.png';
    if (t.includes('sky sports golf')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/0/02/Sky_Sports_Golf_2020.svg/512px-Sky_Sports_Golf_2020.svg.png';
    if (t.includes('sky sports')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f6/Sky_Sports_2020.svg/512px-Sky_Sports_2020.svg.png';
    if (t.includes('willow')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Willow_TV_logo.svg/512px-Willow_TV_logo.svg.png';
    if (t.includes('astro cricket')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/0/05/Astro_Cricket_logo.svg/512px-Astro_Cricket_logo.svg.png';
    if (t.includes('astro supersport')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/1/14/Astro_SuperSport_logo.svg/512px-Astro_SuperSport_logo.svg.png';
    if (t.includes('tsn')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/3/30/TSN_Logo_2023.svg/512px-TSN_Logo_2023.svg.png';
    if (t.includes('sportsnet')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/90/Sportsnet_2023_Logo.svg/512px-Sportsnet_2023_Logo.svg.png';
    if (t.includes('bein sports')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/BeIN_SPORTS_2017.svg/512px-BeIN_SPORTS_2017.svg.png';
    if (t.includes('espn')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/ESPN_wordmark.svg/512px-ESPN_wordmark.svg.png';
    if (t.includes('fox sports')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Fox_Sports_logo.svg/512px-Fox_Sports_logo.svg.png';
    if (t.includes('tnt sports')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/TNT_Sports_%28United_Kingdom%29_logo.svg/512px-TNT_Sports_%28United_Kingdom%29_logo.svg.png';
    if (t.includes('bt sport')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/BT_Sport_logo.svg/512px-BT_Sport_logo.svg.png';
    if (t.includes('eurosport')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/01/Eurosport_logo_2023.svg/512px-Eurosport_logo_2023.svg.png';
    if (t.includes('star sports')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/Star_Sports_logo.svg/512px-Star_Sports_logo.svg.png';
    if (t.includes('super sport') || t.includes('supersport')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/SuperSport_logo.svg/512px-SuperSport_logo.svg.png';
    if (t.includes('ten sports')) return 'https://upload.wikimedia.org/wikipedia/en/thumb/7/77/Ten_Sports_Logo.svg/512px-Ten_Sports_Logo.svg.png';
    if (t.includes('optus')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/Optus_Sport_Logo.svg/512px-Optus_Sport_Logo.svg.png';
    if (t.includes('nbc sports')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/NBC_Sports_logo.svg/512px-NBC_Sports_logo.svg.png';
    if (t.includes('cbs sports')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/31/CBS_Sports_2020.svg/512px-CBS_Sports_2020.svg.png';
    if (t.includes('arena sport')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/09/Arena_Sport_logo.svg/512px-Arena_Sport_logo.svg.png';
    if (t.includes('digi sport')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/Digisport_Romania_logo.svg/512px-Digisport_Romania_logo.svg.png';
    if (t.includes('eleven sports')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/Eleven_Sports_logo.svg/512px-Eleven_Sports_logo.svg.png';
    if (t.includes('bally sports')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Bally_Sports_logo.svg/512px-Bally_Sports_logo.svg.png';
    if (t.includes('mlb network')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7a/MLB_Network_logo.svg/512px-MLB_Network_logo.svg.png';
    if (t.includes('nba tv')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/NBA_TV_logo.svg/512px-NBA_TV_logo.svg.png';
    if (t.includes('nfl network')) return 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/NFL_Network_logo.svg/512px-NFL_Network_logo.svg.png';
    return null;
  }

  // Generate a clean, readable fallback poster using the team names when available.
  let posterText = displayTitle;
  if (match.team1 && match.team2 && match.team1.name && match.team2.name) {
      posterText = `${match.team1.name}\n${match.team2.name}`;
  } else {
      posterText = posterText.replace(/ vs /i, '\n').replace(/ - /i, '\n').replace(/\s*\n\s*/g, '\n');
  }
  
  const fallbackPoster = `https://placehold.co/800x450/111111/${color}.png?text=${encodeURIComponent(posterText)}&font=Montserrat`;
  
  // Helper to construct a standardized proxy URL for all images
  const getProxyUrl = (url, isLogo) => {
    if (!url) return null;
    const fit = isLogo ? 'contain' : 'cover';
    const bg = isLogo ? '&bg=1a1a1a' : '';
    return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=800&h=450&fit=${fit}${bg}&output=jpeg&q=80`;
  };

  let poster = fallbackPoster;
  let logo = match.logo || (match.team1 && match.team1.logo ? match.team1.logo : null);

  const channelLogo = getChannelLogo(match.title);
  if (match.poster) {
    poster = getProxyUrl(match.poster, false);
  } else if (channelLogo) {
    poster = getProxyUrl(channelLogo, true);
    logo = channelLogo;
  } else if (match.thumbnail_url) {
    const tUrl = match.thumbnail_url.startsWith('http') ? match.thumbnail_url : `https://streamfree.top${match.thumbnail_url}`;
    const isLogo = match.category === 'networks' || tUrl.toLowerCase().includes('logo') || tUrl.toLowerCase().includes('icon');
    
    poster = getProxyUrl(tUrl, isLogo);
    
    if (isLogo) {
      logo = tUrl;
    }
  }

  if (logo && !logo.includes('wsrv.nl')) {
    logo = getProxyUrl(logo, true);
  }
  
  let background = match.background ? getProxyUrl(match.background, false) : poster;

  let timeString = '24/7 Stream';
  let relativeTimeStr = '';
  let releasedIso = null;
  
  if (match.date && !isNaN(parseInt(match.date)) && parseInt(match.date) > 0) {
     const dateObj = new Date(parseInt(match.date));
     releasedIso = dateObj.toISOString();
     const timezone = normalizeTimeZone(config && config.timezone ? config.timezone : 'America/New_York');
     const options = { hour: '2-digit', minute: '2-digit', timeZone: timezone };

     timeString = dateObj.toLocaleTimeString('en-US', options);

     const now = Date.now();
     const diff = dateObj.getTime() - now;
     if (diff > 0 && match.popular === '0') {
       const hours = Math.floor(diff / (1000 * 60 * 60));
       const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
       if (hours > 24) {
         relativeTimeStr = ` (in ${Math.floor(hours / 24)} days)`;
       } else if (hours > 0) {
         relativeTimeStr = ` (in ${hours}h ${minutes}m)`;
       } else {
         relativeTimeStr = ` (in ${minutes} mins)`;
       }
     }
  }

  const getLiveDisplayWindow = (event, now = Date.now()) => {
    const timeMs = event && event.date ? Number(event.date) : 0;
    if (!timeMs || Number.isNaN(timeMs)) return event && event.popular === '1';
    return now >= timeMs - (10 * 60 * 1000) && now <= timeMs + (3 * 60 * 60 * 1000);
  };

  const isLiveDisplay = match.popular === '1' && getLiveDisplayWindow(match);
  const prefix = '';
  const cast = [];
  if (match.team1 && match.team1.name) cast.push(match.team1.name);
  if (match.team2 && match.team2.name) cast.push(match.team2.name);

  const desc = '';

  const metaPreview = {
    id: `nuvio_sport_${match.id}`,
    type: 'tv',
    name: `${prefix}${displayTitle}`,
    genres: [match.category.toUpperCase()],
    poster: poster,
    posterShape: 'landscape',
    background: background,
    releaseInfo: timeString,
    description: desc,
    cast: cast,
    behaviorHints: {
      defaultVideoId: `nuvio_sport_${match.id}`
    }
  };

  if (releasedIso) {
    metaPreview.released = releasedIso;
  }

  return metaPreview;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleCatalog(type, id, extra, config) {
  if (type !== 'tv' || !id.startsWith('nuvio_sports_')) {
    return { metas: [] };
  }
  
  const conf = config || (extra && extra.config) || {};

  const categoryMatch = id.replace('nuvio_sports_', '');
  
  // Use CacheService instead of hitting APIs on demand
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  
  let filteredMatches = matches;

  const isLiveDisplayWindow = (event) => {
    const timeMs = event && event.date ? Number(event.date) : 0;
    if (!timeMs || Number.isNaN(timeMs)) return event && event.popular === '1';
    const now = Date.now();
    return now >= timeMs - (10 * 60 * 1000) && now <= timeMs + (3 * 60 * 60 * 1000);
  };

  if (categoryMatch === 'live') {
    filteredMatches = matches.filter(isLiveDisplayWindow);
  } else if (categoryMatch === 'upcoming') {
    const now = Date.now();
    filteredMatches = matches.filter(m => {
      const kickoff = parseInt(m.date) || 0;
      return m.popular === '0' && kickoff > now;
    });
  } else if (categoryMatch === 'teams') {
    if (typeof conf.teams === 'string' && conf.teams.trim()) {
      const favoriteTeams = conf.teams.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
      filteredMatches = matches.filter(m => {
        const titleWords = m.title.toLowerCase();
        return favoriteTeams.some(team => titleWords.includes(team));
      });
    } else {
      filteredMatches = []; // If no config, return empty
    }
  } else if (categoryMatch === 'other') {
    const topLevelCats = ['football', 'cricket', 'basketball', 'motorsport', 'hockey', 'baseball', 'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts', 'networks', 'college'];
    filteredMatches = matches.filter(m => !topLevelCats.includes(m.category));
  } else if (categoryMatch !== 'catalog') {
    filteredMatches = matches.filter(m => m.category === categoryMatch);
  }

  if (typeof conf.sports === 'string' && conf.sports !== 'all') {
    const allowedSports = conf.sports.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    // Don't filter out networks (24/7 TV) since they aren't tied to a specific sport
    filteredMatches = filteredMatches.filter(m => m.category === 'networks' || allowedSports.includes(m.category));
  }

  filteredMatches = [...filteredMatches].sort((a, b) => {
    const aIsLive = a.popular === '1' ? 1 : 0;
    const bIsLive = b.popular === '1' ? 1 : 0;
    if (aIsLive !== bIsLive) return bIsLive - aIsLive;
    
    const dateA = a.date ? parseInt(a.date) : 0;
    const dateB = b.date ? parseInt(b.date) : 0;
    
    // Sort upcoming by closest first
    if (dateA > 0 && dateB > 0) return dateA - dateB;
    return 0;
  });

  let metas = filteredMatches.map(m => mapMatchToMetaPreview(m, conf));

  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    metas = metas.filter(m => 
      m.name.toLowerCase().includes(q) || 
      (m.description && m.description.toLowerCase().includes(q)) ||
      (m.cast && m.cast.some(c => c.toLowerCase().includes(q)))
    );
  }

  return { metas };
}

async function handleMeta(type, id, config) {
  if (type !== 'tv' || !id.startsWith('nuvio_sport_')) {
    return { meta: null };
  }

  const matchId = id.replace('nuvio_sport_', '');
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  const match = matches.find(m => m.id === matchId);

  if (!match) {
    return { meta: null };
  }

  return { meta: mapMatchToMetaPreview(match, config || {}) };
}

module.exports = {
  handleCatalog,
  handleMeta
};
