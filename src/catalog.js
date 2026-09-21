const container = require('./container');
const { getChannelLogo } = require('./services/ChannelLogoService');
const { prewarmMatch } = require('./streams');
const { BASE_URL } = require('./config');
const imageService = require('./services/ImageService');
const { parseTimezone } = require('./timezone');
const { getMatchTier } = require('./services/MainstreamRankingService');

function getKickoff(d) {
  if (!d) return 0;
  const n = Number(d);
  if (!isNaN(n) && Number.isFinite(n) && n > 0) return n;
  const s = String(d).trim();
  if (!s) return 0;
  // "0"/"00" are the sentinel for "no kickoff" (24/7 channels). Number() maps
  // them to 0, which the guard above rejects, but the final `new Date(s)`
  // fallback below would otherwise parse the *string* "0" as year ~2000 and
  // leak a bogus timestamp that is also host-timezone dependent.
  if (/^0+$/.test(s)) return 0;
  const parsed = parseTimezone(s, 'UTC');
  if (parsed && !isNaN(parsed) && parsed > 0) return parsed;
  const time = new Date(s).getTime();
  return isNaN(time) ? 0 : time;
}

/**
 * Formats a kickoff value for the composed match card (display only).
 * Mirrors the zone handling of the meta preview time string so the card and the
 * listing agree, without depending on that block's later position.
 */
function formatKickoffForCard(dateValue, config) {
  if (!dateValue || dateValue === '0') return '';
  const ko = getKickoff(dateValue);
  if (!ko || isNaN(ko)) return '';
  try {
    const zone = (config && config.timezone) || 'UTC';
    return new Date(ko).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zone });
  } catch (_) {
    return '';
  }
}

// How long an event can plausibly still be running after kickoff. Providers
// cache match status at fetch time, so status flags alone cannot tell us
// whether a fixture has finished; elapsed time against these windows can.
const SPORT_MAX_DURATION_MS = {
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
  darts: 4 * 60 * 60 * 1000,
  college: 4 * 60 * 60 * 1000
};
const DEFAULT_EVENT_DURATION_MS = 12 * 60 * 60 * 1000;

const REPLAY_SPORTS = [
  { id: 'football',          name: '⚽ Football Replays',          poster: '/posters/replays/football.jpg' },
  { id: 'motorsport',        name: '🏎️ Motorsport Replays',        poster: '/posters/replays/motorsport.jpg' },
  { id: 'baseball',          name: '⚾ Baseball Replays',          poster: '/posters/replays/baseball.jpg' },
  { id: 'rugby',             name: '🏉 Rugby Replays',             poster: '/posters/replays/rugby.jpg' },
  { id: 'basketball',        name: '🏀 Basketball Replays',        poster: '/posters/replays/basketball.jpg' },
  { id: 'tennis',            name: '🎾 Tennis Replays',            poster: '/posters/replays/tennis.jpg' },
  { id: 'hockey',            name: '🏒 Hockey Replays',            poster: '/posters/replays/hockey.jpg' },
  { id: 'american_football', name: '🏈 American Football Replays', poster: '/posters/replays/american_football.jpg' },
  { id: 'all',               name: '⏪ All Sports Replays',        poster: '/posters/replays/football.jpg' }
];

// Sources whose matches qualify for the replay retention window and replay hubs.
const REPLAY_SOURCES = new Set(['replayzone', 'livetv']);

const GENRE_TO_CATEGORY = {
  'football': 'football',
  'soccer': 'football',
  'cricket': 'cricket',
  'basketball': 'basketball',
  'motorsport': 'motorsport',
  'f1 & motor': 'motorsport',
  'formula 1': 'motorsport',
  'tennis': 'tennis',
  'baseball': 'baseball',
  'hockey': 'hockey',
  'rugby': 'rugby',
  'american football': 'american_football',
  'mma': 'mma',
  'golf': 'golf',
  'darts': 'darts',
  'college': 'college',
  'other': 'other'
};

function getEventDurationMs(category) {
  return SPORT_MAX_DURATION_MS[category] || DEFAULT_EVENT_DURATION_MS;
}

/**
 * Accurately determines if an event is currently live right now.
 * 24/7 networks are always live.
 * Fixtures with a kickoff time become live at kickoff (there is no pre-kickoff
 * lead-in) and stay live up to the sport-specific max game duration.
 */
function isMatchLive(match) {
  if (!match) return false;
  if (match.category === 'networks') return true;

  // 1. Explicit finished / postponed / cancelled statuses are never live
  if (match.status === 'finished' || match.status === 'ended' || match.status === 'postponed' || match.status === 'cancelled') {
    return false;
  }

  // 2. Explicit live status from provider
  if (match.status === 'live' || match.status === 'in' || match.status === 'in_progress') {
    if (match.date) {
      const kickoff = getKickoff(match.date);
      if (kickoff > 0) {
        const maxDuration = getEventDurationMs(match.category);
        const grace = 30 * 60 * 1000; // stoppage time / extra time / penalties
        if (Date.now() > kickoff + maxDuration + grace) return false;
      }
    }
    return true;
  }

  // 3. 'pre' means the provider says the match has NOT kicked off. WatchFooty
  //    refreshes this every sync and it is reliable, so it is trusted over the
  //    clock.
  const PRE_STALE_MS = 20 * 60 * 1000;
  if (match.status === 'pre') {
    const ko = match.date ? getKickoff(match.date) : 0;
    if (ko > 0 && Date.now() > ko + PRE_STALE_MS) {
      // fall through: the flag is stale, let the time-based branch decide
    } else {
      return false; // provider says not started, and the flag is fresh
    }
  }

  // 4. 'upcoming' is NOT trustworthy for every provider: StreamSports99 reports
  //    it even for in-progress games. So it only means "not started" while the
  //    kickoff is genuinely still ahead; once kickoff has passed, fall through and
  //    let the clock decide, otherwise real live games would disappear.
  if (match.status === 'upcoming') {
    if (!match.date) return false;
    if (Date.now() < getKickoff(match.date)) return false;
    // kicked off -> fall through to the time-based branch
  }

  if (!match.date) return true;

  // 5. Time-based evaluation.
  const now = Date.now();
  const kickoff = match.date ? getKickoff(match.date) : 0;

  if (kickoff > 0) {
    if (now < kickoff) return false; // not started yet
    const maxDuration = getEventDurationMs(match.category);
    return now <= (kickoff + maxDuration);
  }

  return false;
}

/**
 * Determines whether a match should be presented as a replay (a past event whose
 * coverage is still available) rather than a live or upcoming fixture.
 *
 * Shared by the catalog replay filter and the meta-preview mapper so the two can
 * never drift apart. 24/7 networks are never replays.
 * Replays must originate from a replay-capable provider (replayzone, livetv).
 */
function isReplayMatch(match) {
  if (!match) return false;
  if (match.category === 'networks') return false;
  if (match.status === 'postponed' || match.status === 'cancelled') return false;

  // Replays require a replay-capable provider (replayzone, livetv)
  if (match.sources && match.sources.length > 0) {
    if (!match.sources.some(s => REPLAY_SOURCES.has(s.source))) return false;
  }

  const kickoff = match.date ? getKickoff(match.date) : 0;

  // Without a usable kickoff time, only an explicit terminal status qualifies.
  if (kickoff === 0) {
    return match.status === 'finished' || match.status === 'ended';
  }

  // An explicit terminal status is authoritative.
  if (match.status === 'finished' || match.status === 'ended') {
    return kickoff <= Date.now();
  }

  return Date.now() > kickoff + getEventDurationMs(match.category);
}

/**
 * Ordering for the Live Now / Upcoming / per-sport catalogs.
 *
 * Extracted to a named, exported function so the ordering contract can be
 * unit-tested directly instead of being asserted through the full HTTP catalog
 * path (which needs the container, the match cache and the network).
 *
 * Key order, highest priority first:
 *   1. live before not-live
 *   2. real fixtures before 24/7 channels
 *   3. mainstream before local / lower-division (getMatchTier)
 *   4. popular before non-popular
 *   5. date (upcoming = nearest kickoff first; live/replay = newest first)
 */
/**
 * Lowercases and strips diacritics so "Nautico" matches "Náutico".
 * NFKD + combining-mark strip covers the Latin ranges the providers emit
 * (BR/PT/ES/FR/DE/TR). Applied to both the query and the title.
 */
function foldText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Normalizes the "Favorite teams" config field into lowercase tokens.
 * Shared by the teams catalog and the favourites-first ordering below.
 */
function parseFavoriteTeams(conf) {
  const raw = conf && conf.teams;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  // Keep both the folded phrase (for debugging/telemetry) and its tokens.
  // A multi-word favourite only matches when every token is found, so
  // "man united" cannot be satisfied by "Manchester City".
  return raw.split(',')
    .map(t => foldText(t.trim()))
    .filter(Boolean)
    .map(phrase => ({ phrase, tokens: phrase.split(/\s+/).filter(Boolean) }));
}

/**
 * True when the match title mentions any favourite team.
 */
function isFavoriteMatch(match, favorites) {
  if (!favorites || favorites.length === 0) return false;
  const title = foldText(match && match.title);
  if (!title) return false;

  // Match on WORD BOUNDARIES with prefix semantics, not raw substrings.
  // Raw substring matching had two failure modes:
  //   - "Atletico" missed "Atlético Goianiense" (did not know the accent
  //     fold target existed) and shorter forms missed longer official names;
  //   - "Real" wrongly matched "Montreal Canadiens" (substring mid-word).
  // Prefix-on-token fixes both: "atletico" matches the token "atletico",
  // while "real" no longer matches "montreal".
  const titleTokens = title.split(/[^a-z0-9]+/).filter(Boolean);
  if (titleTokens.length === 0) return false;

  return favorites.some(fav =>
    fav.tokens.length > 0 &&
    fav.tokens.every(ft => titleTokens.some(tt => tt.startsWith(ft)))
  );
}

function compareCatalogMatches(a, b, isReplayMode = false) {
  const aIsLive = isMatchLive(a) ? 1 : 0;
  const bIsLive = isMatchLive(b) ? 1 : 0;
  if (aIsLive !== bIsLive) return bIsLive - aIsLive; // Live matches first

  // In "Live Now", actual in-progress fixtures must outrank eternal 24/7
  // channels. A 24/7 network is always "live", so it otherwise sorts as a
  // live event and floods the top of the list. Two tests are needed:
  //   1. category !== 'networks'
  //   2. has a kickoff time - the injected 24/7 channels (Willow, Fox Cricket,
  //      Fox League, Tennis) carry no date, whereas real fixtures do.
  // Together these push real matches up while leaving genuine channel-only
  // networks at the bottom.
  const isRealFixture = (m) => (m.category !== 'networks' && (!!m.date || !!m.team1 || !!m.team2 || m.title.includes(' vs ') || m.title.includes(' @ '))) ? 1 : 0;
  const aFix = isRealFixture(a);
  const bFix = isRealFixture(b);
  if (aFix !== bFix) return bFix - aFix; // Real fixtures before 24/7 channels

  // Mainstream fixtures before local / lower-division ones. The `popular`
  // flag cannot express this: Streamed.pk marks ~76 of its ~98 events popular
  // and exposes no league field, so a top-flight "La Liga" tie and a
  // "La Liga 2" fixture arrive looking identical. The classifier demotes
  // explicit lower-division / reserve fixtures, and that demotion beats the
  // Streamed.pk source signal (it does carry a few second-tier games).
  const aTier = getMatchTier(a);
  const bTier = getMatchTier(b);
  if (aTier !== bTier) return aTier - bTier; // Lower tier value sorts first

  // Featured / Popular matches first
  const aPop = a.popular === '1' ? 1 : 0;
  const bPop = b.popular === '1' ? 1 : 0;
  if (aPop !== bPop) return bPop - aPop;

  const dateA = a.date ? getKickoff(a.date) : 0;
  const dateB = b.date ? getKickoff(b.date) : 0;

  // Sort upcoming by closest kickoff first, replays and live by newest first
  if (dateA > 0 && dateB > 0) {
    if (isReplayMode || aIsLive) {
      return dateB - dateA;
    } else {
      return dateA - dateB;
    }
  } else if (dateA > 0 && dateB === 0) {
    return -1; // A (with date) comes before B (without date)
  } else if (dateA === 0 && dateB > 0) {
    return 1; // B (with date) comes before A (without date)
  }
  return 0;
}

function normalizeImageUrl(url, defaultHost = '') {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  if (u.startsWith('/')) return `${defaultHost}${u}`;
  return `${defaultHost}/${u}`;
}

function mapMatchToMetaPreview(match, config = {}, reqType = 'tv') {
  const isLive = isMatchLive(match);
  const isReplay = !isLive && isReplayMatch(match);
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
  
  // Channel logos come from the unified ChannelLogoService (tv-logos CDN + Wikimedia).

  // Generate a clean, readable fallback poster using the match title
  let posterText = match.title;
  if (match.team1 && match.team2 && match.team1.name && match.team2.name) {
      posterText = `${match.team1.name}\nvs\n${match.team2.name}`;
  } else if (isReplay) {
      // Replay titles are session titles ("A @ B - League - Full Game Replay -
      // September 14, 2026"), not "X vs Y" fixtures. Split on the first dash so
      // the card leads with the teams instead of the raw upstream title.
      posterText = posterText.replace(/ [-\u2013\u2014] /, '\n-\n');
  } else {
      posterText = posterText.replace(/ vs /i, '\nvs\n').replace(/ - /i, '\n-\n');
  }
  
  if (posterText.length > 50) {
      posterText = match.category.toUpperCase();
  }
  
  // Self-hosted fallback poster (replaces the external placehold.co dependency)
  const fallbackPoster = imageService.placeholderUrl(BASE_URL, posterText, color);

  // Self-hosted image proxy: serves the upstream image from cache and falls
  // back to a generated placeholder when the source is dead, so the client
  // never sees a broken image.
  const buildImg = (sourceUrl, fbText, c, embed = false) =>
    imageService.proxyUrl(BASE_URL, sourceUrl, { text: fbText, color: c, embed });

  // ─── TIER 1: Provider's Own Artwork (Highest Priority) ───
  const providerPoster = match.poster ? normalizeImageUrl(match.poster) : null;
  const providerLogo = match.logo ? normalizeImageUrl(match.logo) : null;
  const providerThumb = match.thumbnail_url ? normalizeImageUrl(match.thumbnail_url) : null;
  const providerTeamLogo = match.team1 && match.team1.logo ? normalizeImageUrl(match.team1.logo) : null;
  const providerTeamLogo2 = match.team2 && match.team2.logo ? normalizeImageUrl(match.team2.logo) : null;

  // ─── TIER 2: Fallback Lookups (Only evaluated if provider didn't supply artwork) ───
  let fallbackTeamLogo = null;
  let fallbackTeamLogo2 = null;
  let leagueEmblem = null;
  let broadcasterLogo = null;
  let broadcasterName = null;

  const needsLogo = !providerLogo && !providerTeamLogo && !providerThumb;
  const needsPoster = !providerPoster && !providerThumb;

  // A provider thumbnail that is really a crest/icon (rather than landscape
  // artwork) cannot serve as a poster; it only suits the embedded single-crest
  // card. When that is the case — or when there is no provider artwork at all —
  // we compose a designed match card, so the lookups below are worth running.
  const isThumbLogo = providerThumb && (match.category === 'networks' || providerThumb.toLowerCase().includes('logo') || providerThumb.toLowerCase().includes('icon'));

  if (needsLogo || needsPoster) {
    let teamLogoService = null;
    try {
      teamLogoService = container.resolve('teamLogoService');
    } catch (_) {}

    // A. Fallback team crest from TheSportsDB / Cache
    if (match.team1 && match.team1.name && teamLogoService) {
      fallbackTeamLogo = teamLogoService.getCachedLogo(match.team1.name);
      if (!fallbackTeamLogo) {
        teamLogoService.findTeamLogo(match.team1.name).catch(() => {});
      }
    }

    // A2. Same for the away side. The second crest was previously never
    // resolved, which left composed cards half-empty.
    if (match.team2 && match.team2.name && teamLogoService) {
      fallbackTeamLogo2 = teamLogoService.getCachedLogo(match.team2.name);
      if (!fallbackTeamLogo2) {
        teamLogoService.findTeamLogo(match.team2.name).catch(() => {});
      }
    }

    // B. Fallback league / competition emblem
    if (teamLogoService) {
      leagueEmblem = teamLogoService.getLeagueLogo(match.league, match.title, match.category);
    }

    // C. Fallback broadcaster logo from attached sources
    if (match.sources && Array.isArray(match.sources)) {
      for (const s of match.sources) {
        if (!s.channelName) continue;
        if (!broadcasterName) broadcasterName = s.channelName;
        const l = getChannelLogo(s.channelName);
        if (l) { broadcasterLogo = l; broadcasterName = s.channelName; break; }
      }
    }
  }

  // Channel logo for 24/7 channels where title IS the channel name
  const channelLogo = getChannelLogo(match.title);

  // ─── Resolve Effective Poster ───
  // Precedence: PROVIDER artwork wins outright. Anything the provider gives us
  // (poster, thumbnail, logo) is used as-is. Only when the provider supplies no
  // artwork at all do we fall back to the composed cinematic card — and our own
  // crest/league/channel lookups are fed INTO that card as ingredients rather
  // than pre-empting it with a lone crest on an empty background.
  let poster;

  if (providerPoster) {
    poster = buildImg(providerPoster, posterText, color) || fallbackPoster;
  } else if (providerThumb) {
    poster = buildImg(providerThumb, posterText, color, isThumbLogo) || fallbackPoster;
  } else if (providerLogo) {
    poster = buildImg(providerLogo, posterText, color, true) || fallbackPoster;
  } else {
    // No provider artwork at all (typical for 24/7 networks from CdnLive and
    // niche DaddyLive fixtures). Compose the cinematic card, and make sure the
    // resolved channel logo lands on the HERO slot for channel-style entries —
    // otherwise a 24/7 station renders as a big text card with its logo reduced
    // to a 20px footer chip, which reads as "no logo".
    const isChannelLike = !match.team1 && !match.team2;
    const channelMark = broadcasterLogo || channelLogo;

    poster = imageService.matchCardUrl(BASE_URL, {
      category: match.category,
      title: match.title,
      team1: match.team1 && match.team1.name,
      team2: match.team2 && match.team2.name,
      // For channel entries the logo becomes the hero mark.
      badge1: isChannelLike ? null : (providerTeamLogo || fallbackTeamLogo),
      badge2: isChannelLike ? null : (providerTeamLogo2 || fallbackTeamLogo2),
      channelMark: isChannelLike ? channelMark : null,
      league: match.league,
      leagueBadge: leagueEmblem,
      channel: broadcasterName || (isChannelLike ? match.title : null),
      channelBadge: channelMark,
      status: isReplay ? 'replay' : (isLive ? 'live' : ((match.category === 'networks' || !match.date || match.date === '0') ? '247' : 'upcoming')),
      time: formatKickoffForCard(match.date, config),
      shape: reqType === 'series' ? 'poster' : 'landscape'
    }) || fallbackPoster;
  }

  // ─── Branded Player / Buffering Logo ───
  // Stremio & Nuvio video players use `meta.logo` as the loading & buffering splash badge.
  // Using our crisp plugin badge ensures our branded logo is displayed every time a stream buffers.
  const logo = `${BASE_URL}/logo.png`;
  
  const matchBackground = match.background ? normalizeImageUrl(match.background) : null;
  // If the poster was embedded, embed the background too since it defaults to poster
  const embedBg = (!matchBackground && poster.includes('embed=1')) || false;
  let background = matchBackground ? (buildImg(matchBackground, posterText, color) || poster) : poster;

  let timeString = match.category === 'networks' ? '24/7 Stream' : 'Live Now';
  let dateString = '';
  let relativeTimeStr = '';
  let releasedIso = null;
  
  if (match.date) {
    try {
      const ko = getKickoff(match.date);
      if (ko > 0 && !isNaN(ko)) {
        const dateObj = new Date(ko);
        if (!isNaN(dateObj.getTime())) {
          releasedIso = dateObj.toISOString();
          const options = { hour: 'numeric', minute: '2-digit', hour12: true };
          const dateOptions = { month: 'short', day: 'numeric', year: 'numeric' };
          
          // Date and time must always render in the SAME zone. Previously the
          // no-config branch left `options` on the host zone while forcing
          // `dateOptions` to UTC, so a user with no timezone configured could see
          // a time and a calendar day that belonged to different days (7-8h split
          // on the America/Los_Angeles deploy). Both now default to UTC.
          const configuredZone = config && config.timezone;
          const displayZone = configuredZone || 'UTC';
          options.timeZone = displayZone;
          dateOptions.timeZone = displayZone;

          // Suffix semantics unchanged: only an explicitly configured zone is
          // named, so unconfigured listings look the same as before.
          timeString = dateObj.toLocaleTimeString('en-US', options) + (configuredZone ? ` (${configuredZone})` : '');
          dateString = dateObj.toLocaleDateString('en-US', dateOptions);
          
          const now = Date.now();
          const diff = dateObj.getTime() - now;
          if (diff > 0 && !isLive) {
            const hours = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            if (hours > 24) {
              const days = Math.floor(hours / 24);
              relativeTimeStr = ` (in ${days}d ${hours % 24}h)`;
            } else if (hours > 0) {
              relativeTimeStr = ` (in ${hours}h ${minutes}m)`;
            } else {
              relativeTimeStr = ` (in ${minutes}m)`;
            }
          }
        }
      }
    } catch (_) {}
  }

  const is247 = !isReplay && (match.category === 'networks' || !match.date || match.date === '0');
  const prefix = isReplay ? '⏪ ' : (isLive ? (is247 ? '📺 ' : '🔴 LIVE: ') : '⏱️ ');
  const cast = [];
  if (match.team1 && match.team1.name) cast.push(match.team1.name);
  if (match.team2 && match.team2.name) cast.push(match.team2.name);

  const replayReleaseInfo = dateString || (match.date && typeof match.date === 'string' && match.date !== '0' ? match.date.slice(0, 10) : 'Replay');

  const leagueStr = match.league ? `🏆 League: ${match.league}\n` : '';
  const statusStr = is247
    ? '24/7 Live Network'
    : (isLive
        ? '🔴 LIVE NOW'
        : (isReplay ? `⏪ Replay (${replayReleaseInfo})` : `⏱️ Kickoff at ${timeString}${relativeTimeStr}`));
  const desc = `${leagueStr}📅 Category: ${match.category.toUpperCase()}\n⏰ Status: ${statusStr}`;

  const isSeriesReplay = reqType === 'series';

  const metaPreview = {
    id: `nuvio_sport_${match.id}`,
    type: reqType,
    name: `${prefix}${match.title}`,
    genres: [match.category.toUpperCase()],
    poster: poster,
    posterShape: isSeriesReplay ? 'regular' : 'landscape',
    background: background,
    logo: logo,
    releaseInfo: isReplay ? replayReleaseInfo : (isLive ? (is247 ? '24/7' : 'LIVE') : timeString),
    description: desc,
    cast: cast,
    behaviorHints: {
      defaultVideoId: isSeriesReplay ? `nuvio_sport_${match.id}:1:1` : `nuvio_sport_${match.id}`
    }
  };

  if (releasedIso) {
    metaPreview.released = releasedIso;
  }

  if (isSeriesReplay) {
    const videos = [];
    const cleanSources = (match.sources || []).filter(s => s && s.url && !s.source?.includes('timstreams'));
    if (cleanSources.length > 0) {
      cleanSources.forEach((s, idx) => {
        let rawLabel = (s.name || '').trim();
        let cleanLabel = rawLabel;
        if (/^part\s*1\b/i.test(rawLabel)) {
          cleanLabel = 'Part 1 (1st Half)';
        } else if (/^part\s*2\b/i.test(rawLabel)) {
          cleanLabel = 'Part 2 (2nd Half)';
        } else if (/^1st\s*half/i.test(rawLabel)) {
          cleanLabel = '1st Half';
        } else if (/^2nd\s*half/i.test(rawLabel)) {
          cleanLabel = '2nd Half';
        } else if (/^full\s*match/i.test(rawLabel)) {
          cleanLabel = 'Full Match Replay';
        } else if (/^highlight/i.test(rawLabel)) {
          cleanLabel = 'Match Highlights';
        } else if (/^server\s*#?1\b/i.test(rawLabel)) {
          cleanLabel = 'Full Replay (Server 1)';
        } else if (/^server\s*#?2\b/i.test(rawLabel)) {
          cleanLabel = 'Full Replay (Server 2)';
        } else if (!cleanLabel) {
          cleanLabel = `Replay Part ${idx + 1}`;
        }

        videos.push({
          id: `nuvio_sport_${match.id}:1:${idx + 1}`,
          title: cleanLabel,
          season: 1,
          episode: idx + 1,
          released: releasedIso || (match.date && match.date.length >= 10 ? `${match.date.slice(0, 10)}T00:00:00Z` : new Date().toISOString()),
          thumbnail: match.thumbnail_url || poster,
          overview: `${match.title} - ${cleanLabel}`
        });
      });
    } else {
      videos.push({
        id: `nuvio_sport_${match.id}:1:1`,
        title: 'Full Match Replay',
        season: 1,
        episode: 1,
        released: releasedIso || (match.date && match.date.length >= 10 ? `${match.date.slice(0, 10)}T00:00:00Z` : new Date().toISOString()),
        thumbnail: match.thumbnail_url || poster,
        overview: `${match.title} - Full Match Replay`
      });
    }
    metaPreview.videos = videos;
  }

  return metaPreview;
}

async function buildReplayHubMeta(id, config = {}) {
  const cacheService = container.resolve('cacheService');
  let rawMatches = cacheService.getMatches() || [];
  if (rawMatches.length === 0 || !rawMatches.some(m => isReplayMatch(m))) {
    try {
      const aggregator = container.resolve('matchAggregator');
      const synced = await aggregator.syncMatches();
      if (synced && synced.length > 0) rawMatches = synced;
    } catch (_) {}
  }
  const replayMatches = rawMatches.filter(m => isReplayMatch(m) && m.sources && m.sources.some(s => REPLAY_SOURCES.has(s.source)));

  // Case A: Date Hub (e.g. nuvio_sport_replay_date_2026-09-16 or nuvio_sport_replay_football_date_2026-09-16)
  if (id.includes('_date_')) {
    const parts = id.split('_date_');
    const rawSport = parts[0].replace(/^nuvio_sport_replay_?/, '');
    const sportKey = (rawSport && rawSport !== 'date') ? rawSport : null;
    const targetDate = parts[1];

    let dayMatches = replayMatches.filter(m => m.date && m.date.startsWith(targetDate));
    const sportDef = sportKey ? (REPLAY_SPORTS.find(s => s.id === sportKey) || { id: sportKey, name: `${sportKey.toUpperCase()} Replays`, poster: '/posters/replays/football.jpg' }) : null;

    if (sportKey && sportKey !== 'all') {
      dayMatches = dayMatches.filter(m => m.category === sportKey);
    }

    const dateObj = new Date(targetDate + 'T00:00:00Z');
    const displayDate = !isNaN(dateObj.getTime())
      ? dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : targetDate;

    const titleName = sportDef ? `${sportDef.name} — 📅 ${displayDate}` : `📅 ${displayDate} Replays`;
    const poster = sportDef ? `${BASE_URL}${sportDef.poster}` : imageService.placeholderUrl(BASE_URL, `${displayDate}\nReplays`, '0284c7');

    const videos = dayMatches.map((m, epIdx) => ({
      id: `nuvio_sport_${m.id}:hub_1:${epIdx + 1}`,
      title: `${m.title}${m.league ? ` (${m.league})` : ''}`,
      name: `${m.title}${m.league ? ` (${m.league})` : ''}`,
      season: 1,
      season_number: 1,
      seasonNumber: 1,
      number: epIdx + 1,
      episode: epIdx + 1,
      episode_number: epIdx + 1,
      seasonTitle: displayDate,
      seasonName: displayDate,
      season_title: displayDate,
      season_name: displayDate,
      displayName: displayDate,
      display_name: displayDate,
      seasonDisplayName: displayDate,
      season_display_name: displayDate,
      seasonLabel: displayDate,
      season_label: displayDate,
      seasonPoster: poster,
      released: `${targetDate}T00:00:00.000Z`,
      firstAired: `${targetDate}T00:00:00.000Z`,
      thumbnail: m.thumbnail_url || (m.poster ? normalizeImageUrl(m.poster) : poster),
      overview: `📅 ${displayDate} • ${m.league || m.category.toUpperCase()}\n${m.title}`
    }));

    return {
      meta: {
        id: id,
        type: 'series',
        name: titleName,
        genres: ['REPLAYS', ...(sportDef ? [sportDef.id.toUpperCase()] : ['DATES'])],
        poster: poster,
        posterShape: 'regular',
        background: poster,
        logo: `${BASE_URL}/logo.png`,
        description: `${dayMatches.length} full match replays from ${displayDate}. Select any match below to start watching.`,
        releaseInfo: displayDate,
        seasons: [
          {
            season: 1,
            season_number: 1,
            seasonNumber: 1,
            number: 1,
            name: displayDate,
            title: displayDate,
            seasonTitle: displayDate,
            seasonName: displayDate,
            season_title: displayDate,
            season_name: displayDate,
            displayName: displayDate,
            display_name: displayDate,
            label: displayDate,
            poster: poster,
            thumbnail: poster,
            overview: `${displayDate} Replays`
          }
        ],
        videos: videos,
        behaviorHints: {
          defaultVideoId: videos.length > 0 ? videos[0].id : undefined
        }
      }
    };
  }

  // Case B: Sport Hub (e.g. nuvio_sport_replay_football or nuvio_sport_replay_all)
  const sportKey = id.replace('nuvio_sport_replay_', '');
  const sportDef = REPLAY_SPORTS.find(s => s.id === sportKey) || { id: sportKey, name: '⏪ Sports Replays', poster: '/posters/replays/football.jpg' };
  
  let targetMatches = replayMatches;
  if (sportKey !== 'all') {
    targetMatches = replayMatches.filter(m => m.category === sportKey);
  }

  // Group by date (YYYY-MM-DD)
  const dateGroups = new Map();
  targetMatches.forEach(m => {
    if (!m.date) return;
    const dStr = m.date.slice(0, 10);
    if (!dateGroups.has(dStr)) dateGroups.set(dStr, []);
    dateGroups.get(dStr).push(m);
  });

  const sortedDates = Array.from(dateGroups.keys()).sort().reverse();
  const seasons = [];
  const videos = [];
  const posterUrl = `${BASE_URL}${sportDef.poster}`;

  sortedDates.forEach((dStr, sIdx) => {
    const seasonNum = sIdx + 1;
    const dateObj = new Date(dStr + 'T00:00:00Z');
    const displayDate = !isNaN(dateObj.getTime())
      ? dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : dStr;

    seasons.push({
      season: seasonNum,
      season_number: seasonNum,
      seasonNumber: seasonNum,
      number: seasonNum,
      name: displayDate,
      title: displayDate,
      seasonTitle: displayDate,
      seasonName: displayDate,
      season_title: displayDate,
      season_name: displayDate,
      displayName: displayDate,
      display_name: displayDate,
      label: displayDate,
      poster: posterUrl,
      thumbnail: posterUrl,
      overview: `${displayDate} • ${sportDef.name}`
    });

    const dayMatches = dateGroups.get(dStr);
    dayMatches.forEach((m, epIdx) => {
      videos.push({
        id: `nuvio_sport_${m.id}:hub_${seasonNum}:${epIdx + 1}`,
        title: `${m.title}${m.league ? ` (${m.league})` : ''}`,
        name: `${m.title}${m.league ? ` (${m.league})` : ''}`,
        season: seasonNum,
        season_number: seasonNum,
        seasonNumber: seasonNum,
        number: epIdx + 1,
        episode: epIdx + 1,
        episode_number: epIdx + 1,
        seasonTitle: displayDate,
        seasonName: displayDate,
        season_title: displayDate,
        season_name: displayDate,
        displayName: displayDate,
        display_name: displayDate,
        seasonDisplayName: displayDate,
        season_display_name: displayDate,
        seasonLabel: displayDate,
        season_label: displayDate,
        seasonPoster: posterUrl,
        released: `${dStr}T00:00:00.000Z`,
        firstAired: `${dStr}T00:00:00.000Z`,
        thumbnail: m.thumbnail_url || (m.poster ? normalizeImageUrl(m.poster) : posterUrl),
        overview: `📅 ${displayDate} • ${m.league || m.category.toUpperCase()}\n${m.title}`
      });
    });
  });

  const dateGuide = sortedDates.slice(0, 5).map((d, i) => {
    const dobj = new Date(d + 'T00:00:00Z');
    const dname = !isNaN(dobj.getTime())
      ? dobj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : d;
    return `• Season ${i + 1}: ${dname} (${dateGroups.get(d).length} matches)`;
  }).join('\n');

  const description = sortedDates.length > 0
    ? `Complete catalog of ${sportDef.name}, organized date-wise.\n${dateGuide}\n\nSelect a date row to view matches from that day.`
    : `Complete catalog of ${sportDef.name}, organized date-wise.`;

  return {
    meta: {
      id: id,
      type: 'series',
      name: sportDef.name,
      genres: [sportKey.toUpperCase()],
      poster: posterUrl,
      posterShape: 'regular',
      background: posterUrl,
      logo: `${BASE_URL}/logo.png`,
      description: description,
      releaseInfo: sortedDates[0] || 'Replays',
      seasons: seasons,
      videos: videos,
      behaviorHints: {
        defaultVideoId: videos.length > 0 ? videos[0].id : undefined
      }
    }
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleReplayCatalog(id, extra, config, reqType = 'tv') {
  const sub = id.replace('nuvio_sports_replays_', '');
  
  // Known sports for replays
  const sports = ['football', 'motorsport', 'baseball', 'rugby', 'basketball', 'tennis', 'hockey', 'american_football'];
  let targetSport = sports.find(s => sub === s || sub.startsWith(s + '_')) || 'other';
  let filterType = sub.replace(targetSport, '').replace(/^_/, ''); // e.g. '', 'recent', 'premier_league', 'ucl', 'f1', 'nba', 'mlb'

  const cacheService = container.resolve('cacheService');
  let rawMatches = cacheService.getMatches() || [];
  if (rawMatches.length === 0 || !rawMatches.some(m => isReplayMatch(m))) {
    try {
      const aggregator = container.resolve('matchAggregator');
      const synced = await aggregator.syncMatches();
      if (synced && synced.length > 0) rawMatches = synced;
    } catch (_) {}
  }

  let matches = rawMatches.filter(m => {
    if (!m || !Array.isArray(m.sources) || m.sources.length === 0) return false;
    if (!isReplayMatch(m)) return false;
    if (m.sources.some(s => s.source === 'timstreams')) return false;
    if (!m.sources.some(s => REPLAY_SOURCES.has(s.source))) return false;

    if (targetSport === 'other') {
      return !sports.includes(m.category);
    }
    return m.category === targetSport;
  });

  // Apply sub-filters
  const dateMatch = filterType.match(/(?:date_)?(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    const targetDate = dateMatch[1];
    matches = matches.filter(m => m.date && m.date.startsWith(targetDate));
  } else if (filterType === 'today') {
    const todayStr = new Date().toISOString().slice(0, 10);
    matches = matches.filter(m => m.date && m.date.startsWith(todayStr));
  } else if (filterType === 'yesterday') {
    const yDate = new Date(Date.now() - 86400000);
    const yesterdayStr = yDate.toISOString().slice(0, 10);
    matches = matches.filter(m => m.date && m.date.startsWith(yesterdayStr));
  } else if (filterType === 'this_week') {
    const twoDaysAgo = Date.now() - 2 * 86400000;
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    matches = matches.filter(m => {
      const ko = m.date ? getKickoff(m.date) : 0;
      return ko <= twoDaysAgo && ko >= sevenDaysAgo;
    });
  } else if (filterType === 'older') {
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    matches = matches.filter(m => {
      const ko = m.date ? getKickoff(m.date) : 0;
      return ko < sevenDaysAgo;
    });
  } else if (filterType === 'recent') {
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent = matches.filter(m => {
      const ko = m.date ? getKickoff(m.date) : 0;
      return ko >= twoWeeksAgo;
    });
    matches = recent.length >= 10 ? recent : matches.slice(0, 40);
  } else if (filterType === 'premier_league' || filterType === 'epl') {
    matches = matches.filter(m => (m.league && /premier/i.test(m.league)) || /premier\s*league/i.test(m.title));
  } else if (filterType === 'ucl' || filterType === 'champions_league') {
    matches = matches.filter(m => (m.league && /champions|europa|conference|uefa/i.test(m.league)) || /champions\s*league|europa\s*league/i.test(m.title));
  } else if (filterType === 'european') {
    matches = matches.filter(m => (m.league && /la\s*liga|serie\s*a|bundesliga|ligue\s*1/i.test(m.league)));
  } else if (filterType === 'f1') {
    matches = matches.filter(m => (m.league && /formula\s*1|f1/i.test(m.league)) || /formula\s*1|\bf1\b/i.test(m.title));
  } else if (filterType === 'nba') {
    matches = matches.filter(m => (m.league && /nba/i.test(m.league)) || /\bnba\b/i.test(m.title));
  } else if (filterType === 'mlb') {
    matches = matches.filter(m => (m.league && /mlb/i.test(m.league)) || /\bmlb\b/i.test(m.title));
  } else if (filterType === 'nfl') {
    matches = matches.filter(m => (m.league && /nfl/i.test(m.league)) || /\bnfl\b/i.test(m.title));
  } else if (filterType === 'nhl') {
    matches = matches.filter(m => (m.league && /nhl/i.test(m.league)) || /\bnhl\b/i.test(m.title));
  } else if (filterType === 'atp' || filterType === 'wta') {
    matches = matches.filter(m => (m.league && new RegExp(filterType, 'i').test(m.league)) || new RegExp('\\b' + filterType + '\\b', 'i').test(m.title));
  }

  // Sort newest kickoff first
  matches.sort((a, b) => {
    const dateA = a.date ? getKickoff(a.date) : 0;
    const dateB = b.date ? getKickoff(b.date) : 0;
    return dateB - dateA;
  });

  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    matches = matches.filter(m =>
      (m.title && m.title.toLowerCase().includes(q)) ||
      (m.league && m.league.toLowerCase().includes(q))
    );
  }

  // Pagination. The manifest declares `skip` as a required extra for every
  // replay catalog, but it was never read here: a single page of 100 was all
  // the client could ever see, silently dropping the rest of the day
  // (e.g. 315 football replays on a busy day -> only 100 reachable).
  // Honour `skip` and keep the page size at the Stremio-standard 100.
  const pageSize = 100;
  const skip = Math.max(0, parseInt((extra && extra.skip) || '0', 10) || 0);
  const total = matches.length;
  const page = (skip > 0 || total > pageSize) ? matches.slice(skip, skip + pageSize) : matches;

  const metas = page.map(m => mapMatchToMetaPreview(m, config, reqType));
  return { metas };
}

async function handleCatalog(type, id, extra, config) {
  if (type !== 'tv' && type !== 'series' && type !== 'channel') return { metas: [] };

  if (!id.startsWith('nuvio_sports_')) {
    return { metas: [] };
  }

  // Fire-and-forget stale-while-revalidate: return the cached list now and let
  // CronService refresh it in the background once it passes the revalidate window.
  container.resolve('cronService').ensureFresh();
  
  const conf = config || (extra && extra.config) || {};

  const categoryMatch = id.replace('nuvio_sports_', '');

  // ── Sport Replay Catalogs (for Nuvio Collections & Sport Rows) ──
  if (categoryMatch.startsWith('replays_')) {
    return handleReplayCatalog(id, extra, conf, type);
  }
  // Use CacheService instead of hitting APIs on demand
  const cacheService = container.resolve('cacheService');
  const rawMatches = cacheService.getMatches() || [];
  const matches = rawMatches.filter(m => m && Array.isArray(m.sources) && m.sources.length > 0);
  
  let filteredMatches = matches;

  const favoriteTeams = parseFavoriteTeams(conf);

  if (categoryMatch === 'live') {
    filteredMatches = matches.filter(m => isMatchLive(m));
  } else if (categoryMatch === 'upcoming') {
    const now = Date.now();
    filteredMatches = matches.filter(m => !isMatchLive(m) && (getKickoff(m.date) || 0) > now);
  } else if (categoryMatch === 'replays') {
    filteredMatches = matches.filter(m => {
      if (!isReplayMatch(m)) return false;
      if (m.sources && m.sources.some(s => s.source === 'timstreams')) return false;
      if (!m.sources || !m.sources.some(s => REPLAY_SOURCES.has(s.source))) return false;
      return true;
    });
  } else if (categoryMatch === 'teams') {
    if (favoriteTeams.length) {
      filteredMatches = matches.filter(m => isFavoriteMatch(m, favoriteTeams));
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
        if (categoryMatch === 'rugby') {
          if (titleLower.includes('premier league') || titleLower.includes('champions league') || titleLower.includes('europa league') || titleLower.includes('la liga') || titleLower.includes('serie a') || titleLower.includes('bundesliga')) return false;
          if (titleLower.includes('rugby') || titleLower.includes('nrl') || titleLower.includes('super league') || titleLower.includes('six nations') || titleLower.includes('fox league')) return true;
        }
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

  const isReplayMode = (extra && extra.genre === 'Replays') || categoryMatch === 'replays';

  filteredMatches = filteredMatches.filter(m => {
    const isReplay = isReplayMatch(m);

    if (isReplayMode) {
      if (m.sources && m.sources.some(s => s.source === 'timstreams')) return false;
      return isReplay && m.sources && m.sources.some(s => REPLAY_SOURCES.has(s.source));
    }

    if (isReplay) return false; // Live & Upcoming mode (default) hides replays
    if (m.status === 'finished' || m.status === 'ended') return false; // Hide dead finished live streams
    const kickoff = m.date ? getKickoff(m.date) : 0;
    if (kickoff > 0 && !isMatchLive(m) && Date.now() > kickoff + getEventDurationMs(m.category)) {
      return false;
    }
    return true;
  });

  filteredMatches = [...filteredMatches].sort((a, b) => compareCatalogMatches(a, b, isReplayMode));

  if (categoryMatch === 'replays' && (!extra || !extra.search)) {
    let targetSports = REPLAY_SPORTS;
    let targetMatches = filteredMatches;
    let selectedSport = null;

    if (extra && extra.genre) {
      const wanted = GENRE_TO_CATEGORY[extra.genre.trim().toLowerCase()];
      if (wanted) {
        selectedSport = wanted;
        targetSports = REPLAY_SPORTS.filter(s => s.id === wanted || s.id === 'all');
        targetMatches = filteredMatches.filter(m => m.category === wanted);
      }
    }

    const hubMetas = targetSports.map(s => {
      const posterUrl = `${BASE_URL}${s.poster}`;
      return {
        id: `nuvio_sport_replay_${s.id}`,
        type: 'series',
        name: s.name,
        genres: [s.id.toUpperCase()],
        poster: posterUrl,
        posterShape: 'regular',
        background: posterUrl,
        logo: `${BASE_URL}/logo.png`,
        description: `Browse ${s.name} date-wise. Tap to view dates and matches.`,
        behaviorHints: {
          defaultVideoId: `nuvio_sport_replay_${s.id}:1:1`
        }
      };
    });

    // Unique dates (last 14 days of replays) as direct date posters
    const dateMap = new Map();
    targetMatches.forEach(m => {
      if (m.date) {
        const dStr = m.date.slice(0, 10);
        if (!dateMap.has(dStr)) dateMap.set(dStr, 0);
        dateMap.set(dStr, dateMap.get(dStr) + 1);
      }
    });

    const sortedDates = Array.from(dateMap.keys()).sort().reverse().slice(0, 14);
    const dateMetas = sortedDates.map(dStr => {
      const count = dateMap.get(dStr);
      const dateObj = new Date(dStr + 'T00:00:00Z');
      const displayDate = !isNaN(dateObj.getTime())
        ? dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : dStr;
      
      const isSportSpecific = selectedSport && selectedSport !== 'all';
      const sportDef = isSportSpecific ? REPLAY_SPORTS.find(s => s.id === selectedSport) : null;
      const sportIdPrefix = isSportSpecific ? `${selectedSport}_` : '';
      const posterUrl = sportDef
        ? `${BASE_URL}${sportDef.poster}`
        : imageService.placeholderUrl(BASE_URL, `${displayDate}\n${count} Matches`, '0284c7');
      const posterName = sportDef
        ? `${sportDef.name} — 📅 ${displayDate}`
        : `📅 ${displayDate} Replays`;

      return {
        id: `nuvio_sport_replay_${sportIdPrefix}date_${dStr}`,
        type: 'series',
        name: posterName,
        genres: ['REPLAYS', ...(sportDef ? [sportDef.id.toUpperCase()] : ['DATES'])],
        poster: posterUrl,
        posterShape: 'regular',
        background: posterUrl,
        logo: `${BASE_URL}/logo.png`,
        description: `${count} full match replays from ${displayDate}. Tap to view matches.`,
        releaseInfo: displayDate,
        behaviorHints: {
          defaultVideoId: `nuvio_sport_replay_${sportIdPrefix}date_${dStr}:1:1`
        }
      };
    });

    return { metas: [...hubMetas, ...dateMetas] };
  }

  let metas = filteredMatches.map(m => mapMatchToMetaPreview(m, conf, type));

  // ── Genre filter (Replays / Live Now / Upcoming) ──────────────────────────
  const GENRE_FILTERABLE = { replays: 1, live: 1, upcoming: 1 };
  if (GENRE_FILTERABLE[categoryMatch] && extra && typeof extra.genre === 'string' && extra.genre.trim()) {
    const wanted = GENRE_TO_CATEGORY[extra.genre.trim().toLowerCase()] || null;
    if (wanted) {
      if (wanted === 'other') {
        const known = new Set(Object.values(GENRE_TO_CATEGORY));
        metas = metas.filter(m => {
          const cat = String((m.genres && m.genres[0]) || '').toLowerCase();
          return cat && !known.has(cat);
        });
      } else {
        const label = wanted.toUpperCase();
        metas = metas.filter(m => (m.genres || []).some(g => String(g).toUpperCase() === label));
      }
    }
  }
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
  if (type !== 'tv' && type !== 'series' && type !== 'channel') {
    return { meta: null };
  }

  if (!id) {
    return { meta: null };
  }

  // Fire-and-forget stale-while-revalidate, same as handleCatalog.
  container.resolve('cronService').ensureFresh();

  // Individual match meta or Replay Hub meta
  if (!id.startsWith('nuvio_sport_')) {
    return { meta: null };
  }

  if (id.startsWith('nuvio_sport_replay_')) {
    return buildReplayHubMeta(id, config);
  }

  const matchId = id.replace('nuvio_sport_', '').split(':')[0];
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  const match = matches.find(m => m.id === matchId);

  if (!match || !Array.isArray(match.sources) || match.sources.length === 0) {
    return { meta: null };
  }

  // Prewarm while the user is still on the detail page, so the eventual click is
  // near-instant. Fire-and-forget, and deliberately scoped:
  //   - LIVE matches only (replays / upcoming / 24/7 networks are skipped), so we
  //     never mint tokens for content nobody is about to watch;
  //   - ALL sources, not just the top few. Minting only the top 3 meant the
  //     remaining providers (WatchFooty is commonly 4th) were minted while the
  //     user was already waiting - which is exactly where the delay came from.
  try {
    if (isMatchLive(match) && match.category !== 'networks' && !isReplayMatch(match)) {
      prewarmMatch(match, config || {}, Number.MAX_SAFE_INTEGER).catch(() => {});
    }
  } catch (_) {}

  const effectiveType = type === 'series' ? 'series' : 'tv';
  return { meta: mapMatchToMetaPreview(match, config || {}, effectiveType) };
}

module.exports = {
  handleCatalog,
  handleReplayCatalog,
  handleMeta,
  isMatchLive,
  isReplayMatch,
  mapMatchToMetaPreview,
  getKickoff,
  getEventDurationMs,
  compareCatalogMatches,
  SPORT_MAX_DURATION_MS,
  REPLAY_SPORTS,
  getMatchTier
};
