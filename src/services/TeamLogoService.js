/**
 * TeamLogoService.js
 *
 * Dedicated service for retrieving and caching official sports team crests,
 * league emblems, and tournament badges.
 *
 * Layers:
 * 1. Curated high-res league and tournament emblems (EPL, UCL, F1, NBA, NFL, UFC, etc.).
 * 2. Curated top sports clubs (0ms instantaneous memory resolution).
 * 3. TheSportsDB free public API search with alias resolution and entity cleaning.
 * 4. In-memory LRU + persistent JSON disk cache with negative caching.
 */

const fs = require('fs');
const path = require('path');
const { safeFetch } = require('../impitClient');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'team_logos_cache.json');
const MAX_CACHE_SIZE = 5000;
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for not-found entries

// ─── 1. Curated League & Competition Badges ─────────────────────────────────────
const LEAGUE_EMBLEMS = {
  // Football
  'premier league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
  'epl': 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
  'english premier league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
  'uefa champions league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/2.png',
  'champions league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/2.png',
  'uefa europa league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/2054.png',
  'europa league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/2054.png',
  'uefa conference league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/20700.png',
  'la liga': 'https://a.espncdn.com/i/leaguelogos/soccer/500/15.png',
  'laliga': 'https://a.espncdn.com/i/leaguelogos/soccer/500/15.png',
  'serie a': 'https://a.espncdn.com/i/leaguelogos/soccer/500/12.png',
  'bundesliga': 'https://a.espncdn.com/i/leaguelogos/soccer/500/10.png',
  'ligue 1': 'https://a.espncdn.com/i/leaguelogos/soccer/500/9.png',
  'fa cup': 'https://a.espncdn.com/i/leaguelogos/soccer/500/40.png',
  'copa del rey': 'https://a.espncdn.com/i/leaguelogos/soccer/500/80.png',
  'mls': 'https://a.espncdn.com/i/leaguelogos/soccer/500/19.png',
  'major league soccer': 'https://a.espncdn.com/i/leaguelogos/soccer/500/19.png',

  // Motorsport
  'formula 1': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-f1-uk.png',
  'f1': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-f1-uk.png',
  'motogp': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/international/motogp.png',
  'nascar': 'https://a.espncdn.com/i/teamlogos/leagues/500/racing.png',
  'indycar': 'https://a.espncdn.com/i/teamlogos/leagues/500/racing.png',

  // Basketball
  'nba': 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png',
  'euroleague': 'https://a.espncdn.com/i/leaguelogos/basketball/500/euroleague.png',
  'wnba': 'https://a.espncdn.com/i/teamlogos/leagues/500/wnba.png',

  // American Football
  'nfl': 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png',
  'ncaa football': 'https://a.espncdn.com/i/teamlogos/leagues/500/ncaa.png',
  'college football': 'https://a.espncdn.com/i/teamlogos/leagues/500/ncaa.png',

  // Baseball
  'mlb': 'https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png',

  // Hockey
  'nhl': 'https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png',

  // Combat
  'ufc': 'https://r2.thesportsdb.com/images/media/team/badge/f8fdbx1725179456.png',
  'bellator': 'https://r2.thesportsdb.com/images/media/team/badge/f8fdbx1725179456.png',
  'boxing': 'https://r2.thesportsdb.com/images/media/team/badge/f8fdbx1725179456.png',

  // Tennis
  'wimbledon': 'https://r2.thesportsdb.com/images/media/league/badge/28p86h1568285559.png',
  'us open': 'https://r2.thesportsdb.com/images/media/league/badge/7a7nfs1568285642.png',
  'roland garros': 'https://r2.thesportsdb.com/images/media/league/badge/french-open.png',
  'australian open': 'https://r2.thesportsdb.com/images/media/league/badge/australian-open.png',
  'atp': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-states/tennis-channel-us.png',
  'wta': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-states/tennis-channel-us.png',

  // Golf
  'pga tour': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',
  'pga': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',
  'dp world tour': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',
  'european tour': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',
  'lpga': 'https://a.espncdn.com/i/teamlogos/leagues/500/lpga.png',
  'liv golf': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',
  'golf': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png'
};

// ─── 2. Curated Club Aliases ────────────────────────────────────────────────────
const TEAM_ALIASES = {
  'man utd': 'Manchester United',
  'man united': 'Manchester United',
  'man city': 'Manchester City',
  'mcfc': 'Manchester City',
  'mufc': 'Manchester United',
  'barca': 'Barcelona',
  'barça': 'Barcelona',
  'fc barcelona': 'Barcelona',
  'real madrid cf': 'Real Madrid',
  'atletico': 'Atletico Madrid',
  'atlético': 'Atletico Madrid',
  'atlético madrid': 'Atletico Madrid',
  'psg': 'Paris Saint Germain',
  'paris sg': 'Paris Saint Germain',
  'bayern': 'Bayern Munich',
  'fc bayern': 'Bayern Munich',
  'bayern munchen': 'Bayern Munich',
  'bayern münchen': 'Bayern Munich',
  'dortmund': 'Borussia Dortmund',
  'bvb': 'Borussia Dortmund',
  'inter': 'Inter Milan',
  'inter milano': 'Inter Milan',
  'ac milan': 'AC Milan',
  'juve': 'Juventus',
  'spurs': 'Tottenham Hotspur',
  'tottenham': 'Tottenham Hotspur',
  'wolves': 'Wolverhampton Wanderers',
  'brighton': 'Brighton & Hove Albion',
  'newcastle': 'Newcastle United',
  'west ham': 'West Ham United',
  'sporting cp': 'Sporting Lisbon',
  'sporting': 'Sporting Lisbon',
  'benfica': 'Benfica',
  'porto': 'Porto',
  'ajax': 'Ajax',
  'feyenoord': 'Feyenoord',
  'celtic': 'Celtic',
  'rangers': 'Rangers',
  'lakers': 'Los Angeles Lakers',
  'warriors': 'Golden State Warriors',
  'celtics': 'Boston Celtics',
  'bulls': 'Chicago Bulls',
  'heat': 'Miami Heat',
  'knicks': 'New York Knicks',
  'chiefs': 'Kansas City Chiefs',
  'eagles': 'Philadelphia Eagles',
  '49ers': 'San Francisco 49ers',
  'cowboys': 'Dallas Cowboys',
  'yankees': 'New York Yankees',
  'dodgers': 'Los Angeles Dodgers',
  'red sox': 'Boston Red Sox'
};

// ─── 3. Instant Curated Top Badges ──────────────────────────────────────────────
const CURATED_BADGES = {
  'arsenal': 'https://r2.thesportsdb.com/images/media/team/badge/uyhbfe1612467038.png',
  'chelsea': 'https://r2.thesportsdb.com/images/media/team/badge/yvwvtu1448813215.png',
  'liverpool': 'https://r2.thesportsdb.com/images/media/team/badge/c8srrm1679948011.png',
  'manchester city': 'https://r2.thesportsdb.com/images/media/team/badge/vwpvry1467462651.png',
  'manchester united': 'https://r2.thesportsdb.com/images/media/team/badge/xzqdr11517660295.png',
  'tottenham hotspur': 'https://r2.thesportsdb.com/images/media/team/badge/df27491689791404.png',
  'barcelona': 'https://r2.thesportsdb.com/images/media/team/badge/wq9sir1639406443.png',
  'real madrid': 'https://r2.thesportsdb.com/images/media/team/badge/vwvwrw1473502969.png',
  'atletico madrid': 'https://r2.thesportsdb.com/images/media/team/badge/3lffk81716960309.png',
  'bayern munich': 'https://r2.thesportsdb.com/images/media/team/badge/01ogkh1716960412.png',
  'borussia dortmund': 'https://r2.thesportsdb.com/images/media/team/badge/1kewfe1679948281.png',
  'paris saint germain': 'https://r2.thesportsdb.com/images/media/team/badge/rwqrrq1473504808.png',
  'juventus': 'https://r2.thesportsdb.com/images/media/team/badge/7v9o0w1597161680.png',
  'inter milan': 'https://r2.thesportsdb.com/images/media/team/badge/c9m0u21625754854.png',
  'ac milan': 'https://r2.thesportsdb.com/images/media/team/badge/usupty1473502931.png',
  'los angeles lakers': 'https://r2.thesportsdb.com/images/media/team/badge/d8uoxw1714254511.png',
  'golden state warriors': 'https://r2.thesportsdb.com/images/media/team/badge/5ih8f51597161580.png',
  'boston celtics': 'https://r2.thesportsdb.com/images/media/team/badge/0532291597161528.png',
  'kansas city chiefs': 'https://r2.thesportsdb.com/images/media/team/badge/n58gp51784720929.png',
  'ferrari': 'https://r2.thesportsdb.com/images/media/team/badge/fk5myv1561490584.png',
  'red bull racing': 'https://r2.thesportsdb.com/images/media/team/badge/si5qxc1733228232.png',
  'mercedes amg': 'https://r2.thesportsdb.com/images/media/team/badge/w76s721561490635.png',
  'mclaren': 'https://r2.thesportsdb.com/images/media/team/badge/8s3bcf1561490610.png',
  'radomlje': 'https://r2.thesportsdb.com/images/media/team/badge/gh0sjd1625755749.png',
  'bravo': 'https://r2.thesportsdb.com/images/media/team/badge/szjnx81579812986.png'
};

class TeamLogoService {
  constructor() {
    this.cache = new Map(); // key -> { url, expiresAt }
    this.inFlight = new Map(); // key -> Promise<string|null>
    this._loadDiskCache();
  }

  _loadDiskCache() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        const json = JSON.parse(raw);
        if (json && typeof json === 'object') {
          for (const [k, v] of Object.entries(json)) {
            if (v && typeof v === 'string') {
              this.cache.set(k, { url: v, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
            }
          }
        }
      }
    } catch (_) {}
  }

  _saveDiskCache() {
    try {
      const obj = {};
      for (const [k, entry] of this.cache.entries()) {
        if (entry && entry.url) obj[k] = entry.url;
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (_) {}
  }

  _cleanName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '')
      .replace(/\b(fc|cf|sc|cd|ca|afc|fk|sk|bk|rsc|vfb|tsv|united|city)\b/gi, ' ')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _normalizeKey(name) {
    if (!name) return '';
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Synchronous check for known or cached team badge.
   */
  getCachedLogo(teamName) {
    if (!teamName) return null;
    const rawLower = String(teamName).toLowerCase().trim();
    const key = this._normalizeKey(teamName);

    // 1. Direct Curated Badges
    if (CURATED_BADGES[rawLower]) return CURATED_BADGES[rawLower];

    // 2. Alias mapping
    if (TEAM_ALIASES[rawLower] && CURATED_BADGES[TEAM_ALIASES[rawLower].toLowerCase()]) {
      return CURATED_BADGES[TEAM_ALIASES[rawLower].toLowerCase()];
    }

    // 3. Memory cache
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) return cached.url || null;
      this.cache.delete(key);
    }

    return null;
  }

  /**
   * Resolves a league or competition emblem from league name or event title.
   */
  getLeagueLogo(leagueName, eventTitle = '', category = '') {
    const targets = [
      String(leagueName || '').toLowerCase().trim(),
      String(eventTitle || '').toLowerCase().trim()
    ];

    for (const target of targets) {
      if (!target) continue;
      for (const [key, emblemUrl] of Object.entries(LEAGUE_EMBLEMS)) {
        if (target === key || target.includes(key)) {
          return emblemUrl;
        }
      }
    }

    // Category fallbacks
    const cat = String(category || '').toLowerCase();
    if (cat === 'motorsport' || cat === 'f1') {
      return LEAGUE_EMBLEMS['formula 1'];
    }
    if (cat === 'basketball' || cat === 'nba') {
      return LEAGUE_EMBLEMS['nba'];
    }
    if (cat === 'american_football' || cat === 'nfl') {
      return LEAGUE_EMBLEMS['nfl'];
    }
    if (cat === 'baseball' || cat === 'mlb') {
      return LEAGUE_EMBLEMS['mlb'];
    }
    if (cat === 'hockey' || cat === 'nhl') {
      return LEAGUE_EMBLEMS['nhl'];
    }
    if (cat === 'mma' || cat === 'fighting') {
      return LEAGUE_EMBLEMS['ufc'];
    }
    if (cat === 'golf') {
      return LEAGUE_EMBLEMS['golf'];
    }

    return null;
  }

  /**
   * Asynchronously searches for a team badge using TheSportsDB.
   */
  async findTeamLogo(teamName) {
    if (!teamName || typeof teamName !== 'string') return null;

    const rawLower = String(teamName).toLowerCase().trim();
    const key = this._normalizeKey(teamName);

    // Instant cached lookup
    const cached = this.getCachedLogo(teamName);
    if (cached) return cached;

    // Check negative cache
    const negEntry = this.cache.get(key);
    if (negEntry && !negEntry.url && negEntry.expiresAt > Date.now()) {
      return null;
    }

    // De-duplicate in-flight requests
    if (this.inFlight.has(key)) {
      return await this.inFlight.get(key);
    }

    const fetchPromise = (async () => {
      try {
        const queryName = TEAM_ALIASES[rawLower] || teamName;
        const cleanQuery = this._cleanName(queryName) || queryName;

        const url = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(cleanQuery)}`;
        const res = await safeFetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(6000)
        });

        if (res && res.ok) {
          const data = typeof res.json === 'function' ? await res.json() : JSON.parse(res.text);
          if (data && Array.isArray(data.teams) && data.teams.length > 0) {
            const queryLower = cleanQuery.toLowerCase();
            const bestTeam = data.teams.find(tm => {
              const strTeam = (tm.strTeam || '').toLowerCase();
              const strAlt = (tm.strAlternate || '').toLowerCase();
              return strTeam === queryLower || strAlt.includes(queryLower) || strTeam.includes(queryLower);
            }) || data.teams[0];

            if (bestTeam && bestTeam.strBadge) {
              const badgeUrl = bestTeam.strBadge;
              this.cache.set(key, { url: badgeUrl, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
              if (this.cache.size % 20 === 0) this._saveDiskCache();
              return badgeUrl;
            }
          }
        }

        // Cache not-found for 24h to prevent hammering
        this.cache.set(key, { url: null, expiresAt: Date.now() + NEGATIVE_TTL_MS });
        return null;
      } catch (_) {
        return null;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, fetchPromise);
    return await fetchPromise;
  }

  /**
   * Enriches a match entity with team and event badges.
   */
  async enrichMatch(match) {
    if (!match) return match;

    // 1. Team 1 badge
    if (match.team1 && match.team1.name && !match.team1.logo) {
      const b1 = await this.findTeamLogo(match.team1.name);
      if (b1) match.team1.logo = b1;
    }

    // 2. Team 2 badge
    if (match.team2 && match.team2.name && !match.team2.logo) {
      const b2 = await this.findTeamLogo(match.team2.name);
      if (b2) match.team2.logo = b2;
    }

    // 3. Match primary logo fallback
    if (!match.logo) {
      if (match.team1 && match.team1.logo) {
        match.logo = match.team1.logo;
      } else {
        const leagueLogo = this.getLeagueLogo(match.league, match.title, match.category);
        if (leagueLogo) match.logo = leagueLogo;
      }
    }

    return match;
  }
}

module.exports = TeamLogoService;
