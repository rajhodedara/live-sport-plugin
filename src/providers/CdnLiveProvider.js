const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');

const CHANNEL_PREFIX = 'ch:';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const CHANNEL_LIST_URLS = [
  'https://api.cdnlivetv.tv/api/v1/channels/?user=cdnlivetv&plan=free',
  'https://api.cdnlivetv.is/api/v1/channels/?user=cdnlivetv&plan=free'
];

const REGION_CODES = {
  us: 'US',
  gb: 'UK',
  uk: 'UK',
  ca: 'CA',
  au: 'AU',
  de: 'DE',
  es: 'ES',
  fr: 'FR',
  it: 'IT',
  nl: 'NL',
  br: 'BR',
  ar: 'AR',
  mx: 'MX',
  pt: 'PT',
  pl: 'PL',
  ro: 'RO',
  gr: 'GR',
  cy: 'CY',
  ae: 'AE',
  sa: 'SA',
  in: 'IN',
  pk: 'PK',
  nz: 'NZ',
  za: 'ZA'
};

function regionFromCode(code) {
  if (!code) return '';
  const c = String(code).trim().toLowerCase();
  return REGION_CODES[c] || c.toUpperCase();
}

function tokenExpiry(url) {
  const m = /[?&]token=([^&]+)/.exec(String(url || ''));
  if (!m) return 0;
  try {
    const parts = Buffer.from(decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      .toString('utf8').split(':');
    const ts = parseInt(parts[1], 10);
    return !isNaN(ts) && ts > 0 ? ts : 0;
  } catch (e) {
    return 0;
  }
}

class CdnLiveProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'CDNLiveTV';
    this.apiUrl = 'https://api.cdnlivetv.tv/api/v1/events/sports/?user=cdnlivetv&plan=free';
    this._decoded = new Map(); // playerUrl -> { url, expiresAt }
    
    this.fetchMain = this.circuitBreaker.wrap(`${this.name}_fetchMain`, async () => {
      const headers = { 'User-Agent': UA };
      const res = await this.proxyFetch(this.apiUrl, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    this.fetchChannels = this.circuitBreaker.wrap(`${this.name}_channels`, async () => {
      let lastErr = null;
      for (const url of CHANNEL_LIST_URLS) {
        try {
          const res = await this.proxyFetch(url, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(20000)
          });
          if (!res.ok) throw new Error(`channel list responded ${res.status}`);
          return await res.json();
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('no channel list host answered');
    });
  }

  async getMatches() {
    const [events, channels] = await Promise.all([
      this.getEventMatches(),
      this.getChannelMatches()
    ]);
    return [...events, ...channels];
  }

  /**
   * Fetches 24/7 sports networks and channels from CDNLive.
   * Only includes channels marked 'online'.
   */
  async getChannelMatches() {
    try {
      const data = await this.fetchChannels.fire();
      const list = data && Array.isArray(data.channels) ? data.channels : [];
      const nameOf = (c) => String((c && c.name) || '').trim().toLowerCase();

      // Only online channels with valid URLs
      const online = list.filter(c =>
        c && c.name && typeof c.url === 'string' && /^https?:\/\//i.test(c.url) && c.status === 'online'
      );

      // Add US ESPN if absent in listing
      const usListed = new Set(list.filter(c => c && c.code === 'us').map(nameOf));
      if (!usListed.has('espn')) {
        online.push({
          name: 'ESPN',
          code: 'us',
          url: 'https://cdnlivetv.tv/api/v1/channels/player/?name=ESPN&code=us&user=cdnlivetv&plan=free',
          image: '',
          status: 'online'
        });
      }

      // Deduplicate by name and country code
      const seen = new Set();
      const picked = [];
      for (const c of online) {
        const key = `${nameOf(c)}|${String(c.code || '').toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(c);
      }

      return picked.map(c => {
        const title = String(c.name).trim();
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const region = regionFromCode(c.code);

        return new MatchEntity({
          id: `cdn_ch_${c.code || 'xx'}_${slug}`,
          title,
          region: region || undefined,
          baseTitle: title,
          category: 'networks',
          date: '0',
          popular: '1',
          league: 'Live TV',
          sources: [{ source: 'cdnlive', id: CHANNEL_PREFIX + c.url }]
        });
      });
    } catch (err) {
      console.error(`[${this.name}] Failed to get channels:`, err.message);
      return [];
    }
  }

  async getEventMatches() {
    const matches = [];
    try {
      const data = await this.fetchMain.fire();
      const sportsData = data?.['cdn-live-tv'] || {};
      
      // CDNLive mostly provides Football/Soccer
      const soccerEvents = sportsData['Soccer'] || sportsData['Football'] || [];
      
      if (Array.isArray(soccerEvents)) {
        for (const item of soccerEvents) {
          if (!item.channels || !Array.isArray(item.channels) || item.channels.length === 0) continue;
          const matchId = item.gameID || `${item.homeTeam}-vs-${item.awayTeam}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
          const title = `${item.homeTeam || ''} vs ${item.awayTeam || ''}`;
          
          let status = 'upcoming';
          if (item.status === 'live' || item.status === 'in') status = 'live';

          const matchTime = item.start ? parseTimezone(item.start, 'UTC') : Date.now();

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

  /**
   * Decodes the signed M3U8 URL from a CDNLive player page.
   * Caches the decoded URL until token expiry to minimize latency and requests.
   */
  async decodePlayer(playerUrl) {
    const cached = this._decoded.get(playerUrl);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.url;
    }

    try {
      const { safeFetch } = require('../impitClient');
      const playerRes = await safeFetch(playerUrl, {
        headersTimeout: 15000,
        bodyTimeout: 15000,
        headers: {
          'User-Agent': UA,
          'Referer': 'https://cdnlivetv.tv/'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (playerRes.status >= 200 && playerRes.status < 300) {
        const html = await playerRes.text();
        const decoderMatch = html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{.+?atob/);
        if (!decoderMatch) return '';

        const decoderName = decoderMatch[1];
        const concatRegex = new RegExp(`var\\s+([a-zA-Z0-9_]+)\\s*=\\s*${decoderName}\\([^;]+;`);
        const concatMatch = html.match(concatRegex);
        if (!concatMatch) return '';

        const varRegex = new RegExp(`${decoderName}\\(([a-zA-Z0-9_]+)\\)`, 'g');
        const vars = [];
        let match;
        while ((match = varRegex.exec(concatMatch[0])) !== null) {
          vars.push(match[1]);
        }

        let m3u8Url = '';
        for (const v of vars) {
          const valMatch = html.match(new RegExp(`var\\s+${v}\\s*=\\s*'([^']+)'`));
          if (valMatch && valMatch[1]) {
            let b64 = valMatch[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            try {
              m3u8Url += Buffer.from(b64, 'base64').toString('utf8');
            } catch (e) {}
          }
        }

        if (m3u8Url) {
          const exp = tokenExpiry(m3u8Url);
          const ttlMs = 3 * 60 * 60 * 1000;
          const expiresAt = exp ? Math.min(exp - 60000, Date.now() + ttlMs) : Date.now() + ttlMs;
          if (this._decoded.size >= 500) {
            this._decoded.delete(this._decoded.keys().next().value);
          }
          if (expiresAt > Date.now()) {
            this._decoded.set(playerUrl, { url: m3u8Url, expiresAt });
          }
          return m3u8Url;
        }
      }
    } catch (err) {
      console.warn(`[${this.name}] Failed to decode player ${playerUrl}:`, err.message);
    }
    return '';
  }

  /**
   * Resolves a CDNLive player URL into a direct StreamEntity with proxyHeaders.
   * Zero server relay: player plays direct from CDN.
   */
  async resolvePlayer(playerUrl, name) {
    const m3u8Url = await this.decodePlayer(playerUrl);
    if (m3u8Url) {
      return [new StreamEntity({
        name: 'CDNLiveTV',
        title: `CDNLiveTV (${name})`,
        url: m3u8Url,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'Origin': 'https://cdnlivetv.tv',
              'Referer': 'https://cdnlivetv.tv/',
              'User-Agent': UA
            }
          }
        },
        resolution: 'HD'
      })];
    }

    // Web player fallback
    return [new StreamEntity({
      name: 'CDNLiveTV',
      title: `CDNLiveTV (${name}) (Web Player)`,
      externalUrl: playerUrl,
      resolution: 'HD'
    })];
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    // 24/7 Channel
    if (typeof sourceId === 'string' && sourceId.startsWith(CHANNEL_PREFIX)) {
      const playerUrl = sourceId.slice(CHANNEL_PREFIX.length);
      return this.resolvePlayer(playerUrl, matchTitle || 'Live Channel');
    }

    // Live Event
    const streams = [];
    try {
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
            const playerStreams = await this.resolvePlayer(ch.url, ch.channel_name || `CDNLive Stream ${idx + 1}`);
            streams.push(...playerStreams);
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
