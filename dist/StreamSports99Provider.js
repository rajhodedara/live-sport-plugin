const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');

// Kickoff window: the upstream API lists fixtures days ahead; most never get
// channels and resolve to nothing. Keep live/recent events + 48 h lookahead only.
const WINDOW_PAST_MS = 6 * 60 * 60 * 1000;   // started up to 6 h ago
const WINDOW_FUTURE_MS = 48 * 60 * 60 * 1000; // or starting within 48 h

class StreamSports99Provider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'StreamSports99';
    // VIP Endpoint to get access to all categories
    this.apiUrl = 'https://api.cdnlivetv.is/api/v1/events/sports/?user=streamsports99&plan=vip';
    
    this.fetchMain = this.circuitBreaker.wrap(`${this.name}_fetchMain`, async () => {
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
      const res = await this.proxyFetch(this.apiUrl, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });
  }

  mapCategory(apiCategory) {
    const lower = apiCategory.toLowerCase();
    const map = {
      'soccer': 'football',
      'nba': 'basketball',
      'nfl': 'american_football',
      'nhl': 'hockey',
      'mlb': 'baseball',
      'cricket': 'cricket',
      'motorsport': 'motorsport',
      'f1': 'motorsport',
      'ufc': 'mma',
      'mma': 'mma',
      'boxing': 'mma',
      'wwe': 'mma',
      'tennis': 'tennis',
      'golf': 'golf',
      'rugby': 'rugby',
      'darts': 'darts',
      'ncaa': 'college',
      'ncaaw': 'college'
    };
    return map[lower] || 'other';
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchMain.fire();
      const sportsData = data?.['cdn-live-tv'] || {};
      
      const excludeKeys = ['total_events', 'cached', 'timestamp'];

      Object.keys(sportsData).forEach(key => {
        if (excludeKeys.includes(key) || key.startsWith('total_events_')) return;
        
        const events = sportsData[key];
        const mappedCategory = this.mapCategory(key);

        if (Array.isArray(events)) {
          for (const item of events) {
            // Only include matches that actually have stream channels available
            if (!item.channels || !Array.isArray(item.channels) || item.channels.length === 0) continue;

            // Some events might just have 'name' instead of homeTeam/awayTeam
            const title = item.name || `${item.homeTeam || ''} vs ${item.awayTeam || ''}`.trim();
            if (!title || title === 'vs') continue;

            const matchId = item.gameID || title.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            
            let status = 'upcoming';
            if (item.status === 'live' || item.status === 'in') status = 'live';

            const matchTime = item.start ? (parseTimezone(item.start, 'UTC') || Date.now()) : Date.now();

            // Drop far-out fixtures: they never get channels and resolve to nothing.
            // Live-flagged events are always kept (clock-skew tolerant).
            if (item.start && Number.isFinite(matchTime)) {
              const isLive = status === 'live';
              if (!isLive && (matchTime < Date.now() - WINDOW_PAST_MS || matchTime > Date.now() + WINDOW_FUTURE_MS)) {
                continue;
              }
            }

            matches.push(new MatchEntity({
              id: `ss99_${matchId}`,
              title: title,
              category: mappedCategory,
              status: status,
              timestamp: matchTime,
              date: matchTime.toString(),
              popular: status === 'live' ? '1' : '0',
              league: item.tournament || key,
              team1: { name: item.homeTeam, logo: item.homeTeamIMG },
              team2: { name: item.awayTeam, logo: item.awayTeamIMG },
              thumbnail_url: item.homeTeamIMG || item.awayTeamIMG || '', // Use home team as primary thumbnail
              sources: [{ source: 'streamsports99', id: matchId }]
            }));
          }
        }
      });
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    try {
      const data = await this.fetchMain.fire();
      const sportsData = data?.['cdn-live-tv'] || {};
      const excludeKeys = ['total_events', 'cached', 'timestamp'];
      
      let item = null;

      // Find the specific item across all categories
      for (const key of Object.keys(sportsData)) {
        if (excludeKeys.includes(key) || key.startsWith('total_events_')) continue;
        const events = sportsData[key];
        if (Array.isArray(events)) {
          const found = events.find(e => {
            const title = e.name || `${e.homeTeam || ''} vs ${e.awayTeam || ''}`.trim();
            const genId = title.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            return e.gameID === sourceId || genId === sourceId;
          });
          if (found) {
            item = found;
            break;
          }
        }
      }

      if (item && item.channels && Array.isArray(item.channels)) {


        for (const [idx, ch] of item.channels.entries()) {
          if (ch.url) {

            // --- INTERNAL FALLBACK ---
            console.log("[DEBUG SS99] ENTERING EXTRACTION TRY BLOCK FOR", ch.url);
            try {
              const { safeFetch } = require('../impitClient');
              const playerRes = await safeFetch(ch.url, {
                headersTimeout: 15000, bodyTimeout: 15000,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  'Referer': 'https://streamsports99.fun/'
                },
                signal: AbortSignal.timeout(10000)
              });
              
              console.log(`[DEBUG SS99] playerRes.ok: ${playerRes.ok}, status: ${playerRes.status}`);
              
              if (playerRes.ok || playerRes.status === 200) {
                const html = await playerRes.text();
                const decoderMatch = html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{.+?atob/);
                console.log(`[DEBUG SS99] HTML length: ${html.length}, decoderMatch: ${!!decoderMatch}`);
                if (decoderMatch) {
                  const decoderName = decoderMatch[1];
                  const concatRegex = new RegExp(`var\\s+([a-zA-Z0-9_]+)\\s*=\\s*${decoderName}\\([^;]+;`);
                  const concatMatch = html.match(concatRegex);
                  console.log(`[DEBUG SS99] decoderName: ${decoderName}, concatMatch: ${!!concatMatch}`);
                  if (concatMatch) {
                    const varRegex = new RegExp(`${decoderName}\\(([a-zA-Z0-9_]+)\\)`, 'g');
                    let match;
                    const vars = [];
                    while ((match = varRegex.exec(concatMatch[0])) !== null) {
                      vars.push(match[1]);
                    }
                    
                    let m3u8Url = '';
                    for (const v of vars) {
                      const valMatch = html.match(new RegExp(`var\\s+${v}\\s*=\\s*'([^']+)'`));
                      if (valMatch && valMatch[1]) {
                        let b64 = valMatch[1].replace(/-/g, '+').replace(/_/g, '/');
                        while (b64.length % 4) b64 += '=';
                        try { m3u8Url += Buffer.from(b64, 'base64').toString('utf8'); } catch(e) {}
                      }
                    }
                    console.log(`[DEBUG SS99] vars: ${vars.length}, m3u8Url length: ${m3u8Url.length}`);
                    
                    if (m3u8Url) {
                      streams.push(new StreamEntity({
                        name: `StreamSports99`,
                        title: ch.channel_name || `VIP Stream ${idx + 1}`,
                        url: m3u8Url,
                        behaviorHints: {
                          notWebReady: true,
                          proxyHeaders: {
                            request: {
                              "Origin": "https://streamsports99.fun",
                              "Referer": "https://streamsports99.fun/",
                              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
                            }
                          }
                        },
                        resolution: 'HD'
                      }));
                      continue;
                    }
                  }
                }
              }
            } catch (e) {
              console.warn(`[${this.name}] Failed to extract m3u8 for ${ch.url}:`, e.message);
            }
            
            // Fallback to web player link if extraction fails
            streams.push(new StreamEntity({
              name: `StreamSports99`,
              title: ch.channel_name || `VIP Stream ${idx + 1} (Web Player)`,
              externalUrl: ch.url,
              resolution: 'HD'
            }));
          }
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

module.exports = StreamSports99Provider;
