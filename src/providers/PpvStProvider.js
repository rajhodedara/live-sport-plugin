const BaseProvider = require('./BaseProvider');
const { isInconclusiveResolutionError } = require('../services/StreamResolutionOutcome');
const { LOCAL_CAPACITY_EXIT_CODE, LOCAL_TIMEOUT_EXIT_CODE, LOCAL_CANCELLED_EXIT_CODE } = require('./PpvStWasmExit');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { BASE_URL } = require('../config');
const path = require('path');
const { execFile } = require('child_process');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

class PpvStProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'PpvSt';
  }

  async getMatches() {
    const matches = [];
    try {
      const signal = AbortSignal.timeout(15000);
      const requestOptions = {
        headers: {
          'User-Agent': UA,
          'Referer': 'https://ppv.st/',
          'Origin': 'https://ppv.st'
        },
        signal,
        diagnosticOwner: 'catalog'
      };
      let res;
      try {
        res = await this.proxyFetch('https://api.ppv.st/api/streams', requestOptions);
      } catch (error) {
        if (error?.code !== 'ERR_OUTBOUND_CAPACITY' || signal.aborted) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
        signal.throwIfAborted();
        res = await this.proxyFetch('https://api.ppv.st/api/streams', requestOptions);
      }
      if (!res.ok) return matches;
      const data = typeof res.json === 'function' ? await res.json() : JSON.parse(res.text);
      if (!data?.success || !Array.isArray(data.streams)) return matches;

      for (const cat of data.streams) {
        if (!cat || typeof cat.category !== 'string' || !Array.isArray(cat.streams)) continue;
        let category = cat.category.toLowerCase();
        if (category === 'combat sports') category = 'fighting';
        if (category === 'australian football') category = 'american_football';
        if (category === '24/7 streams') category = 'networks';
        for (const stream of cat.streams) {
          if (!stream || typeof stream.name !== 'string' || !stream.name.trim()) continue;
          const slug = stream.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '');
          const sources = [];
          if (stream.iframe) sources.push({
            source: 'ppvst',
            id: stream.id,
            channelName: stream.source_tag || stream.name,
            embedUrl: stream.iframe
          });

          if (Array.isArray(stream.substreams)) {
            stream.substreams.forEach(sub => {
              if (sub && sub.iframe) {
                sources.push({
                  source: 'ppvst',
                  id: sub.id,
                  channelName: sub.source_tag || sub.name || stream.name,
                  embedUrl: sub.iframe,
                  language: sub.locale
                });
              }
            });
          }

          if (!sources.length) continue;

          const is247 = Boolean(
            stream.tag === '24/7 channel' ||
            stream.always_live ||
            category === 'networks' ||
            cat.category.toLowerCase() === '24/7 streams' ||
            !stream.starts_at ||
            Number(stream.starts_at) <= 0 ||
            /^24\/7/i.test(stream.name)
          );

          let team1 = null;
          let team2 = null;
          if (!is247) {
            const extracted = extractTeamsFromTitle(stream.name);
            if (extracted) {
              team1 = { name: extracted[0] };
              team2 = { name: extracted[1] };
            }
          }

          let streamCat = category;
          const streamUrl = stream.iframe || '';
          if (/\b(?:ncaa|college|ncaab|ncaaf)\b/i.test(`${stream.name} ${cat.category}`) || /\/(?:cbb|cfb)\//i.test(streamUrl)) {
            streamCat = 'college';
          }

          matches.push(new MatchEntity({
            id: `ppv_${stream.id}_${slug}`,
            title: stream.name,
            baseTitle: stream.name,
            category: is247 ? 'networks' : this.normalizeCategory(streamCat),
            date: is247 ? '' : (stream.starts_at ? String(stream.starts_at * 1000) : '0'),
            status: is247 ? '' : (stream.starts_at && stream.starts_at * 1000 > Date.now() ? 'upcoming' : 'live'),
            popular: is247 ? '1' : undefined,
            league: is247 ? 'Live TV' : cat.category,
            logo: null,
            thumbnail_url: null,
            poster: null,
            team1: team1,
            team2: team2,
            sources: sources
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];
    src = src && typeof src === 'object' ? src : {};
    let embedUrl;
    try {
      if (typeof src.embedUrl !== 'string') return streams;
      const parsed = new URL(src.embedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return streams;
      embedUrl = parsed.href;
    } catch (_) { return streams; }

    let referer = 'https://embedindia.st/';
    try { referer = new URL(embedUrl).origin + '/'; } catch(e) {}
    const origin = referer.slice(0, -1);

    try {
      const match = embedUrl.match(/embed(?:-noads)?\/(?:admin\/)?([^?#]+)/);
      if (!match) return streams;
      const channelId = match[1];

      const scriptPath = path.join(__dirname, 'run_gasm_india.js');

      const stdout = await new Promise((resolve, reject) => {
        execFile('node', [scriptPath, channelId, referer, 'EMPTY', embedUrl], { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) {
            // Exit 75 is the extractor's typed local-capacity signal; it is
            // not proof that PPV.st has no playable stream. Keep it distinct
            // from a hard WASM failure so the cache can retry after 2s.
            if (err.code === LOCAL_CAPACITY_EXIT_CODE) {
              return reject(Object.assign(new Error('PPV.st extractor transport capacity exhausted'), {
                code: 'ERR_OUTBOUND_CAPACITY', isFatal: true
              }));
            }
            if (err.code === LOCAL_CANCELLED_EXIT_CODE) {
              return reject(Object.assign(new Error('PPV.st extractor transport cancelled'), {
                name: 'AbortError', code: 'ABORT_ERR'
              }));
            }
            // execFile kills a timed-out child with SIGTERM. The previous
            // generic wrapper stripped that signal, creating a 30s cache miss.
            // The child can also report a typed fetch timeout before this kill.
            if (err.code === LOCAL_TIMEOUT_EXIT_CODE || (err.killed === true && err.signal === 'SIGTERM')) {
              return reject(Object.assign(new Error('PPV.st extractor deadline exceeded'), {
                name: 'TimeoutError', code: 'ETIMEDOUT'
              }));
            }
            return reject(new Error(stderr || err.message));
          }
          resolve(stdout);
        });
      });

      const m = stdout.match(/"file":\s*"(https?:\/\/[^"]+\.m3u8.*?)"/);
      if (m) {
        const m3u8Url = m[1];
        const streamReferer = (m3u8Url.includes('indianservers.st') || m3u8Url.includes('embedindia.st') || embedUrl.includes('taifood'))
          ? 'https://embedindia.st/'
          : referer;
        const streamOrigin = (streamReferer === 'https://embedindia.st/')
          ? 'https://embedindia.st'
          : origin;
        const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(streamReferer)}&origin=${encodeURIComponent(streamOrigin)}`;
        
          const langStr = typeof src.language === 'string' && src.language ? ` [${src.language.toUpperCase()}]` : '';
          const channelName = typeof src.channelName === 'string' ? src.channelName : '';
          const isTikTokStream = Boolean(/admin|strmd\.st|\.image|tiktokcdn|byteoversea/i.test(m3u8Url) || /admin|strmd\.st|\.image|tiktokcdn/i.test(embedUrl));
          const s = new StreamEntity({
            name: 'PpvSt',
            title: `PpvSt${langStr}${channelName ? ' - ' + channelName : ''} (${matchTitle || channelId})`,
            url: proxyUrl,
            behaviorHints: { 
              notWebReady: true,
              proxyHeaders: {
                request: {
                  'Referer': streamReferer,
                  'Origin': streamOrigin,
                  'User-Agent': UA
                }
              }
            },
            resolution: 'HD',
            channelName: channelName || undefined,
            language: typeof src.language === 'string' ? src.language : undefined
          });
          if (isTikTokStream) {
            s.isTikTok = true;
            s._isTikTok = true;
          }
          streams.push(s);
      }
    } catch(e) {
      // The extractor reported a *local* transient failure. Propagate it
      // before adding the web fallback; otherwise a positive web-only cache
      // entry can hide the direct stream for the full TTL.
      if (isInconclusiveResolutionError(e)) throw e;
      console.warn(`[${this.name}] WASM extraction failed: ${e.message}`);
    }
    
    // Keep the explicitly labeled web option even after extraction succeeds:
    // the later HLS verification can still reject the minted manifest. The
    // response layer hides web fallbacks when a direct stream is available.
    {
        streams.push(new StreamEntity({
            name: 'PpvSt',
            title: `${matchTitle || sourceId} (Web Player)`,
            externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
            channelName: typeof src.channelName === 'string' ? src.channelName : undefined,
            language: typeof src.language === 'string' ? src.language : undefined,
        }));
    }
    
    return streams;
  }
}

module.exports = PpvStProvider;
