const container = require('./container');
const { getChannelLogo } = require('./services/ChannelLogoService');

/**
 * Accurately determines if an event is currently live right now.
 * 24/7 networks are always live.
 * Fixtures with a kickoff time are live starting 15 minutes before kickoff
 * up to the sport-specific max game duration.
 */
function isMatchLive(match) {
  if (!match) return false;
  if (match.category === 'networks' || !match.date) return true;

  // 1. Explicit finished / postponed / cancelled statuses are never live
  if (match.status === 'finished' || match.status === 'ended' || match.status === 'postponed' || match.status === 'cancelled') {
    return false;
  }

  // 2. Explicit live status from provider
  if (match.status === 'live' || match.status === 'in' || match.status === 'in_progress') {
    return true;
  }

  // 3. Explicit upcoming / pre-match status from provider
  if (match.status === 'upcoming' || match.status === 'pre') {
    return false;
  }

  // 4. Time-based evaluation when status is not explicitly set
  const now = Date.now();
  const kickoff = match.date ? parseInt(match.date, 10) : 0;

  if (kickoff > 0) {
    // If kickoff is more than 15 minutes in the future, it's definitely UPCOMING, not live
    if (kickoff > now + 15 * 60 * 1000) {
      return false;
    }

    const durations = {
      cricket: 8 * 60 * 60 * 1000,
      mma: 6 * 60 * 60 * 1000,
      fighting: 6 * 60 * 60 * 1000,
      boxing: 5 * 60 * 60 * 1000,
      motorsport: 4 * 60 * 60 * 1000,
      american_football: 4 * 60 * 60 * 1000,
      baseball: 3.5 * 60 * 60 * 1000,
      basketball: 3 * 60 * 60 * 1000,
      tennis: 4 * 60 * 60 * 1000,
      golf: 6 * 60 * 60 * 1000,
      football: 2.5 * 60 * 60 * 1000,
      rugby: 2.5 * 60 * 60 * 1000,
      hockey: 3 * 60 * 60 * 1000,
      darts: 4 * 60 * 60 * 1000
    };
    const maxDuration = durations[match.category] || (3 * 60 * 60 * 1000);

    return now >= (kickoff - 15 * 60 * 1000) && now <= (kickoff + maxDuration);
  }

  return false;
}

function mapMatchToMetaPreview(match, config = {}) {
  const isLive = isMatchLive(match);
  const titleStr = match.title || (isLive ? 'Live Match' : 'Upcoming Match');
  const safeTitle = encodeURIComponent(Array.from(titleStr).slice(0, 30).join(''));
  
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

  // Generate a clean, readable fallback poster using the match title
  let posterText = match.title;
  if (match.team1 && match.team2 && match.team1.name && match.team2.name) {
      posterText = `${match.team1.name}\nvs\n${match.team2.name}`;
  } else {
      posterText = posterText.replace(/ vs /i, '\nvs\n').replace(/ - /i, '\n-\n');
  }
  
  if (posterText.length > 50) {
      posterText = match.category.toUpperCase();
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
  let posterIsGenerated = true;

  const channelLogo = getChannelLogo(match.title);
  if (match.poster) {
    poster = getProxyUrl(match.poster, false);
    posterIsGenerated = false;
  } else if (channelLogo) {
    poster = getProxyUrl(channelLogo, true);
    logo = channelLogo;
    posterIsGenerated = false;
  } else if (match.thumbnail_url) {
    const tUrl = match.thumbnail_url.startsWith('http') ? match.thumbnail_url : `https://streamfree.top${match.thumbnail_url}`;
    const isLogo = match.category === 'networks' || tUrl.toLowerCase().includes('logo') || tUrl.toLowerCase().includes('icon');

    poster = getProxyUrl(tUrl, isLogo);
    posterIsGenerated = false;

    if (isLogo) {
      logo = tUrl;
    }
  }

  if (logo && !logo.includes('wsrv.nl')) {
    logo = getProxyUrl(logo, true);
  }

  let background = match.background ? getProxyUrl(match.background, false) : poster;

  // Some scrapers (StreamSports99, Strims24) capture real per-team crest
  // URLs. Forward both - not just team1's, folded into the single legacy
  // `logo` field above - so the client can render an actual "club badge
  // vs club badge" cover instead of a generic poster when both exist.
  const team1Badge = match.team1 && match.team1.logo ? getProxyUrl(match.team1.logo, true) : null;
  const team2Badge = match.team2 && match.team2.logo ? getProxyUrl(match.team2.logo, true) : null;

  let timeString = match.category === 'networks' ? '24/7 Stream' : 'Live Now';
  let relativeTimeStr = '';
  let releasedIso = null;
  
  if (match.date && !isNaN(parseInt(match.date)) && parseInt(match.date) > 0) {
     const dateObj = new Date(parseInt(match.date));
     releasedIso = dateObj.toISOString();
     const options = { hour: '2-digit', minute: '2-digit' };
     
     if (config && config.timezone) {
       options.timeZone = config.timezone;
     }
     
     timeString = dateObj.toLocaleTimeString('en-US', options) + (options.timeZone ? ` (${options.timeZone})` : '');
     
     const now = Date.now();
     const diff = dateObj.getTime() - now;
     if (diff > 0 && !isLive) {
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

  const is247 = match.category === 'networks' || !match.date;
  const prefix = isLive ? (is247 ? '📺 ' : '🔴 LIVE: ') : '⏱️ ';
  const cast = [];
  if (match.team1 && match.team1.name) cast.push(match.team1.name);
  if (match.team2 && match.team2.name) cast.push(match.team2.name);

  const leagueStr = match.league ? `🏆 League: ${match.league}\n` : '';
  const statusStr = is247 
    ? '24/7 Live Network' 
    : (isLive ? '🔴 LIVE NOW' : `Kickoff at ${timeString}${relativeTimeStr}`);
  const desc = `${leagueStr}📅 Category: ${match.category.toUpperCase()}\n⏰ Status: ${statusStr}`;

  const metaPreview = {
    id: `nuvio_sport_${match.id}`,
    type: 'tv',
    name: `${prefix}${match.title}`,
    genres: [match.category.toUpperCase()],
    poster: poster,
    posterShape: 'landscape',
    background: background,
    logo: logo,
    releaseInfo: isLive ? (is247 ? '24/7' : 'LIVE') : timeString,
    description: desc,
    cast: cast,
    posterIsGenerated,
    team1: match.team1 && match.team1.name ? { name: match.team1.name, logo: team1Badge } : null,
    team2: match.team2 && match.team2.name ? { name: match.team2.name, logo: team2Badge } : null,
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

  if (categoryMatch === 'live') {
    filteredMatches = matches.filter(m => isMatchLive(m));
  } else if (categoryMatch === 'upcoming') {
    const now = Date.now();
    filteredMatches = matches.filter(m => !isMatchLive(m) && (parseInt(m.date) || 0) > now);
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
    filteredMatches = matches.filter(m => {
      if (m.category === categoryMatch) return true;
      // Also include 24/7 networks specifically matching the sport category
      if (m.category === 'networks') {
        const titleLower = m.title.toLowerCase();
        if (categoryMatch === 'cricket' && titleLower.includes('cricket')) return true;
        if (categoryMatch === 'tennis' && titleLower.includes('tennis')) return true;
        if (categoryMatch === 'motorsport' && (titleLower.includes('f1') || titleLower.includes('racing') || titleLower.includes('moto') || titleLower.includes('motorsport'))) return true;
        if (categoryMatch === 'basketball' && (titleLower.includes('nba') || titleLower.includes('basketball'))) return true;
        if (categoryMatch === 'football' && (titleLower.includes('football') || titleLower.includes('soccer') || titleLower.includes('golazo') || titleLower.includes('laliga') || titleLower.includes('premier league') || titleLower.includes('bein sports'))) return true;
        if (categoryMatch === 'rugby' && (titleLower.includes('rugby') || titleLower.includes('league') || titleLower.includes('nrl'))) return true;
        if (categoryMatch === 'american_football' && (titleLower.includes('nfl') || titleLower.includes('american football'))) return true;
        if (categoryMatch === 'baseball' && (titleLower.includes('mlb') || titleLower.includes('baseball'))) return true;
        if (categoryMatch === 'hockey' && (titleLower.includes('nhl') || titleLower.includes('hockey'))) return true;
        if (categoryMatch === 'golf' && (titleLower.includes('golf') || titleLower.includes('pga'))) return true;
      }
      return false;
    });
  }

  if (typeof conf.sports === 'string' && conf.sports !== 'all') {
    const allowedSports = conf.sports.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    // Don't filter out networks (24/7 TV) since they aren't tied to a specific sport
    filteredMatches = filteredMatches.filter(m => m.category === 'networks' || allowedSports.includes(m.category));
  }

  filteredMatches = [...filteredMatches].sort((a, b) => {
    const aIsLive = isMatchLive(a) ? 1 : 0;
    const bIsLive = isMatchLive(b) ? 1 : 0;
    if (aIsLive !== bIsLive) return bIsLive - aIsLive; // Live matches first
    
    // Within live matches: Actual live event fixtures (UFC, F1, Football, etc.) take priority over 24/7 TV channels
    const aIsEvent = a.category !== 'networks' ? 1 : 0;
    const bIsEvent = b.category !== 'networks' ? 1 : 0;
    if (aIsEvent !== bIsEvent) return bIsEvent - aIsEvent;

    // Featured / Popular matches first
    const aPop = a.popular === '1' ? 1 : 0;
    const bPop = b.popular === '1' ? 1 : 0;
    if (aPop !== bPop) return bPop - aPop;
    
    const dateA = a.date ? parseInt(a.date) : 0;
    const dateB = b.date ? parseInt(b.date) : 0;
    
    // Sort upcoming by closest kickoff first
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
