const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');

class CdnLiveProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'CDNLiveTV';
    this.apiUrl = 'https://api.cdnlivetv.tv/api/v1/events/sports/?user=cdnlivetv&plan=free';
    
    this.fetchMain = this.circuitBreaker.wrap(`${this.name}_fetchMain`, async () => {
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
      const res = await this.proxyFetch(this.apiUrl, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchMain.fire();
      const sportsData = data?.['cdn-live-tv'] || {};
      
      // CDNLive mostly provides Football/Soccer
      const soccerEvents = sportsData['Soccer'] || sportsData['Football'] || [];
      
      if (Array.isArray(soccerEvents)) {
        for (const item of soccerEvents) {
          const matchId = item.gameID || `${item.homeTeam}-vs-${item.awayTeam}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
          const title = `${item.homeTeam || ''} vs ${item.awayTeam || ''}`;
          
          let status = 'upcoming';
          if (item.status === 'live' || item.status === 'in') status = 'live';

          const matchTime = item.start ? parseTimezone(item.start, 'America/New_York') : Date.now();

          matches.push(new MatchEntity({
            id: `cdn_${matchId}`,
            title: title,
            category: 'football',
            status: status,
            timestamp: matchTime,
            sources: [{ source: 'cdnlive', id: matchId }]
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
      // Re-fetch (or use cache if circuitBreaker had a cache, but it doesn't. Since it's called 
      // individually, we fetch. In real production we might cache this in cacheService)
      const data = await this.fetchMain.fire();
      const sportsData = data?.['cdn-live-tv'] || {};
      const soccerEvents = sportsData['Soccer'] || sportsData['Football'] || [];
      
      const item = soccerEvents.find(e => 
        (e.gameID === sourceId) || 
        (`${e.homeTeam}-vs-${e.awayTeam}`.toLowerCase().replace(/[^a-z0-9-]/g, '-') === sourceId)
      );

      if (item && item.channels && Array.isArray(item.channels)) {
        for (const [idx, ch] of item.channels.entries()) {
          if (ch.url) {
            try {
              const playerRes = await fetch(ch.url, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  'Referer': 'https://cdnlivetv.tv/'
                },
                signal: AbortSignal.timeout(10000)
              });
              
              if (playerRes.ok) {
                const html = await playerRes.text();
                const decoderMatch = html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{.+?atob/);
                if (decoderMatch) {
                  const decoderName = decoderMatch[1];
                  const concatRegex = new RegExp(`var\\s+([a-zA-Z0-9_]+)\\s*=\\s*${decoderName}\\([^;]+;`);
                  const concatMatch = html.match(concatRegex);
                  
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
                    
                    if (m3u8Url) {
                      streams.push(new StreamEntity({
                        name: `CDNLiveTV`,
                        title: ch.channel_name || `CDNLive Stream ${idx + 1}`,
                        url: m3u8Url,
                        behaviorHints: {
                          notWebReady: true,
                          proxyHeaders: {
                            request: {
                              "Origin": "https://cdnlivetv.tv",
                              "Referer": "https://cdnlivetv.tv/",
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
            
            // Fallback
            streams.push(new StreamEntity({
              name: `CDNLiveTV`,
              title: ch.channel_name || `CDNLive Stream ${idx + 1} (Web Player)`,
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

module.exports = CdnLiveProvider;
