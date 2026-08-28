const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');

class WatchFootyProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'WatchFooty';
    // Hitting the /all endpoint to fetch 13+ sports instead of just football
    this.apiUrl = 'https://api.watchfooty.st/api/v1/matches/all';
    
    this.fetchMain = this.circuitBreaker.wrap(`${this.name}_fetchMain`, async () => {
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
      const res = await this.proxyFetch(this.apiUrl, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    this.fetchMatchDetails = this.circuitBreaker.wrap(`${this.name}_fetchMatch`, async (matchId) => {
      const url = `https://api.watchfooty.st/api/v1/match/${matchId}`;
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
      const res = await this.proxyFetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchMain.fire();
      
      if (Array.isArray(data)) {
        for (const item of data) {
          const matchId = item.matchId;
          const title = item.title || `${item.teams?.home?.name || 'Home'} vs ${item.teams?.away?.name || 'Away'}`;
          let status = 'upcoming';
          
          if (item.status === 'in' || item.status === 'live') {
            status = 'live';
          } else if (item.status === 'post' || item.status === 'postponed' || item.status === 'cancelled') {
            status = 'finished'; // Or upcoming, but we ignore finished usually
          }

          const matchTime = item.timestamp ? parseTimezone(item.timestamp, 'America/New_York') : Date.now();
          
          // Map dynamic sports directly from the API
          const category = item.sport ? item.sport.toLowerCase() : 'football';

          const posterUrl = item.poster ? (item.poster.startsWith('http') ? item.poster : `https://api.watchfooty.st${item.poster}`) : null;

          matches.push(new MatchEntity({
            id: `wf_${matchId}`,
            title: title,
            category: category,
            status: status,
            timestamp: matchTime,
            poster: posterUrl,
            background: posterUrl,
            sources: [{ source: 'watchfooty', id: matchId }]
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    try {
      const data = await this.fetchMatchDetails.fire(sourceId);
      const match = Array.isArray(data) ? data[0] : data;
      
      if (match && match.streams && Array.isArray(match.streams)) {
        let idx = 0;
        for (const s of match.streams) {
          if (s.url) {
            const isDirect = s.url.includes('.m3u8') || s.url.includes('.mp4');
            const entityParams = {
              name: `WatchFooty`,
              title: `WatchFooty Stream ${idx + 1}`,
              resolution: s.quality ? String(s.quality).toUpperCase() : 'SD'
            };
            
            if (isDirect) {
              entityParams.url = s.url;
              entityParams.behaviorHints = {
                notWebReady: true,
                proxyHeaders: {
                  request: {
                    "Origin": "https://watchfooty.st",
                    "Referer": "https://watchfooty.st/",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
                  }
                }
              };
              streams.push(new StreamEntity(entityParams));
            } else if (s.url.includes('sportsembed.su') || s.url.includes('watchfooty.st/embed')) {
              try {
                  console.log(`[WatchFootyProvider] Triggering native extraction for: ${s.url}`);
                  const { extractSportsEmbed } = require('./SportsEmbedExtractor');
                  const { BASE_URL } = require('../config');
                  const m3u8Url = await extractSportsEmbed(s.url);
                  if (m3u8Url) {
                      console.log(`[WatchFootyProvider] Successfully extracted M3U8: ${m3u8Url}`);
                      const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent('https://sportsembed.su/')}&origin=${encodeURIComponent('https://sportsembed.su')}`;
                      entityParams.url = proxyUrl;
                      entityParams.behaviorHints = { notWebReady: true };
                      streams.push(new StreamEntity(entityParams));
                  }
              } catch (e) {
                  console.error(`[WatchFootyProvider] Native extract failed for ${s.url}`, e.message);
                  entityParams.externalUrl = `/watch?url=${encodeURIComponent(s.url)}&title=${encodeURIComponent(matchTitle || 'WatchFooty')}`;
                  streams.push(new StreamEntity(entityParams));
              }
            } else {
              entityParams.externalUrl = `/watch?url=${encodeURIComponent(s.url)}&title=${encodeURIComponent(matchTitle || 'WatchFooty')}`;
              streams.push(new StreamEntity(entityParams));
            }
          }
          idx++;
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

module.exports = WatchFootyProvider;
