'use strict';

const crypto = require('crypto');
const undici = require('../services/ProviderOutbound');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { findBridgeIframe, matchesHost, isByseHost, playerHostname } = require('./bridgeIframe');
const { safeFetch } = require('../services/ProviderOutbound');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');

function b64Decode(str) {
  return Buffer.from(str, 'base64');
}

const MLB_TEAM_NORM = Object.freeze({
  'arizona diamondbacks': 'Arizona Diamondbacks',
  'diamondbacks': 'Arizona Diamondbacks',
  'd-backs': 'Arizona Diamondbacks',
  'atlanta braves': 'Atlanta Braves',
  'braves': 'Atlanta Braves',
  'baltimore orioles': 'Baltimore Orioles',
  'orioles': 'Baltimore Orioles',
  'boston red sox': 'Boston Red Sox',
  'red sox': 'Boston Red Sox',
  'chicago cubs': 'Chicago Cubs',
  'cubs': 'Chicago Cubs',
  'chicago white sox': 'Chicago White Sox',
  'white sox': 'Chicago White Sox',
  'cincinnati reds': 'Cincinnati Reds',
  'reds': 'Cincinnati Reds',
  'cleveland guardians': 'Cleveland Guardians',
  'guardians': 'Cleveland Guardians',
  'cleveland indians': 'Cleveland Guardians',
  'indians': 'Cleveland Guardians',
  'colorado rockies': 'Colorado Rockies',
  'rockies': 'Colorado Rockies',
  'detroit tigers': 'Detroit Tigers',
  'tigers': 'Detroit Tigers',
  'houston astros': 'Houston Astros',
  'astros': 'Houston Astros',
  'kansas city royals': 'Kansas City Royals',
  'royals': 'Kansas City Royals',
  'los angeles angels': 'Los Angeles Angels',
  'la angels': 'Los Angeles Angels',
  'angels': 'Los Angeles Angels',
  'anaheim': 'Los Angeles Angels',
  'los angeles dodgers': 'Los Angeles Dodgers',
  'la dodgers': 'Los Angeles Dodgers',
  'dodgers': 'Los Angeles Dodgers',
  'miami marlins': 'Miami Marlins',
  'marlins': 'Miami Marlins',
  'milwaukee brewers': 'Milwaukee Brewers',
  'brewers': 'Milwaukee Brewers',
  'minnesota twins': 'Minnesota Twins',
  'twins': 'Minnesota Twins',
  'new york mets': 'New York Mets',
  'ny mets': 'New York Mets',
  'mets': 'New York Mets',
  'new york yankees': 'New York Yankees',
  'ny yankees': 'New York Yankees',
  'yankees': 'New York Yankees',
  'oakland athletics': 'Oakland Athletics',
  'athletics': 'Oakland Athletics',
  'philadelphia phillies': 'Philadelphia Phillies',
  'phillies': 'Philadelphia Phillies',
  'pittsburgh pirates': 'Pittsburgh Pirates',
  'pirates': 'Pittsburgh Pirates',
  'san diego padres': 'San Diego Padres',
  'padres': 'San Diego Padres',
  'san francisco giants': 'San Francisco Giants',
  'giants': 'San Francisco Giants',
  'sf giants': 'San Francisco Giants',
  'seattle mariners': 'Seattle Mariners',
  'mariners': 'Seattle Mariners',
  'st. louis cardinals': 'St. Louis Cardinals',
  'st louis cardinals': 'St. Louis Cardinals',
  'cardinals': 'St. Louis Cardinals',
  'tampa bay rays': 'Tampa Bay Rays',
  'rays': 'Tampa Bay Rays',
  'devil rays': 'Tampa Bay Rays',
  'texas rangers': 'Texas Rangers',
  'rangers': 'Texas Rangers',
  'toronto blue jays': 'Toronto Blue Jays',
  'blue jays': 'Toronto Blue Jays',
  'washington nationals': 'Washington Nationals',
  'nationals': 'Washington Nationals'
});

/**
 * MlbLiveProvider
 *
 * Dedicated Major League Baseball (MLB) replay provider ingesting full game replays,
 * playoffs, and World Series matchups from https://mlblive.net/.
 *
 * Perimeter & Stream Architecture:
 * - Cloudflare TLS Bypass: Routes catalog queries through native impitClient (Chrome TLS impersonation).
 * - 0% Server Bandwidth: Direct client CDN playback (okcdn.ru direct MP4/HLS and Byse SprintCDN).
 * - Multi-Server Redundancy: Extracts OK.ru (1080p-144p + Auto HLS), Byse (1080p), and Dailymotion.
 */
class MlbLiveProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'MLBLive';
    this.sourceName = 'mlblive';
    this.baseUrl = 'https://mlblive.net';
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Referer': 'https://mlblive.net/'
    };

    this._matchPageCache = new Map();
    this._streamCache = new Map();
    this._maxCacheEntries = 500;

    if (this.circuitBreaker && typeof this.circuitBreaker.wrapSync === 'function') {
      this.fetchPage = this.circuitBreaker.wrapSync(`${this.name}_fetchPage`, async (url, customHeaders = {}) => {
        const res = await safeFetch(url, {
          headers: { ...this.defaultHeaders, ...customHeaders }
        });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      });
    } else {
      this.fetchPage = {
        fire: async (url, customHeaders = {}) => {
          const res = await safeFetch(url, {
            headers: { ...this.defaultHeaders, ...customHeaders }
          });
          if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
          return await res.text();
        }
      };
    }
  }

  _setCache(cache, key, value, ttlMs = 30 * 60 * 1000) {
    if (cache.size >= this._maxCacheEntries) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  _getCache(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  _normalizeTitle(rawTitle) {
    let t = (rawTitle || '').trim();
    // Replace @ or - with vs
    const vsMatch = t.match(/^(.+?)\s+(?:@|vs\.?|-)\s+(.+?)(?:\s+Full Game Replay|\s+MLB|\s+Game \d+|$)/i);
    if (vsMatch) {
      const t1 = vsMatch[1].trim().toLowerCase();
      const t2 = vsMatch[2].trim().toLowerCase();
      const norm1 = MLB_TEAM_NORM[t1] || vsMatch[1].trim();
      const norm2 = MLB_TEAM_NORM[t2] || vsMatch[2].trim();
      t = `${norm1} vs ${norm2} - MLB`;
    }
    return t;
  }

  _parseMatchCards(html) {
    const matches = [];
    const linkMatches = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const seenUrls = new Set();

    for (const m of linkMatches) {
      const rawUrl = (m[1] || '').trim();
      const rawTitle = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

      if (!rawUrl || !rawTitle || seenUrls.has(rawUrl)) continue;

      const lowerUrl = rawUrl.toLowerCase();
      const lowerTitle = rawTitle.toLowerCase();

      const isMatchLink = (lowerTitle.includes(' @ ') ||
                          lowerTitle.includes(' vs ') ||
                          lowerTitle.includes(' vs. ') ||
                          lowerTitle.includes(' v ') ||
                          lowerUrl.includes('-vs-') ||
                          lowerTitle.includes('all-star') ||
                          lowerTitle.includes('home run derby') ||
                          lowerTitle.includes('world series game')) &&
                          !lowerUrl.endsWith('-full-game-replays') &&
                          !lowerUrl.endsWith('-replays') &&
                          !lowerUrl.includes('/2026-mlb-full-game-replays') &&
                          !lowerUrl.includes('/world-series-replays');

      if (!isMatchLink || rawTitle.length < 5) continue;
      if (/-{2,}$/.test(rawUrl)) continue;

      const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${this.baseUrl}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
      seenUrls.add(rawUrl);

      // Extract match date from title (e.g. October 15, 2026 or April 15, 2026)
      let parsedDate = '';
      const dateMatch = rawTitle.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i);
      if (dateMatch) {
        try {
          const parsed = new Date(dateMatch[0]);
          if (!isNaN(parsed.getTime())) {
            parsedDate = parsed.toISOString();
          }
        } catch (_) {}
      }

      let league = 'MLB';
      if (lowerTitle.includes('world series') || lowerUrl.includes('world-series')) {
        league = 'MLB World Series';
      } else if (lowerTitle.includes('all-star') || lowerUrl.includes('all-star')) {
        league = 'MLB All-Star';
      } else if (lowerTitle.includes('nlcs') || lowerTitle.includes('alcs') || lowerTitle.includes('division series') || lowerTitle.includes('wild card') || lowerTitle.includes('playoff')) {
        league = 'MLB Playoffs';
      }

      const safeSlug = fullUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
      const id = `mlb_${safeSlug}`;

      const extractedTeams = extractTeamsFromTitle(rawTitle);
      const team1 = extractedTeams ? { name: extractedTeams[0] } : null;
      const team2 = extractedTeams ? { name: extractedTeams[1] } : null;

      matches.push(new MatchEntity({
        id,
        title: rawTitle,
        category: 'baseball',
        league,
        date: parsedDate,
        status: 'finished',
        poster: '',
        thumbnail_url: '',
        team1,
        team2,
        sources: [
          {
            source: this.sourceName,
            id: fullUrl,
            name: 'Full Game Replay',
            url: fullUrl
          }
        ]
      }));
    }

    return matches;
  }

  async getMatches() {
    const endpoints = [
      `${this.baseUrl}/2026-mlb-full-game-replays`,
      `${this.baseUrl}/world-series-replays`
    ];

    const allMatches = [];
    const seenIds = new Set();

    for (const url of endpoints) {
      try {
        const html = await this.fetchPage.fire(url);
        if (!html) continue;
        const parsed = this._parseMatchCards(html);
        for (const m of parsed) {
          if (!seenIds.has(m.id)) {
            seenIds.add(m.id);
            allMatches.push(m);
          }
        }
      } catch (err) {
        console.warn(`[MLBLive] Warning fetching ${url}:`, err.message);
      }
    }

    console.log(`[MLBLive] Extracted ${allMatches.length} replay matches`);
    return allMatches;
  }

  async resolveStream(url, category, team, srcObj) {
    const targetUrl = url || (srcObj && srcObj.url) || '';
    if (!targetUrl) return [];

    const cached = this._getCache(this._streamCache, targetUrl);
    if (cached) return cached;

    try {
      const html = await this.fetchPage.fire(targetUrl);
      if (!html) return [];

      const bodyMatch = html.match(/<!--\s*<body>\s*-->([\s\S]*?)<!--\s*<\/body>\s*-->/i);
      const content = bodyMatch ? bodyMatch[1] : html;

      const linkMatches = [...content.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
      const watchLinks = linkMatches.filter(l => {
        const text = l[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        const href = l[1];
        return /watch|part|server|^ok$|^fm$|^dm$/i.test(text) ||
               /ok\.ru|byse|vidara|dailymotion|dai\.ly|d\.tube|nhlgamestoday|nbaontv|nflontv|guideanimaux/i.test(href);
      });

      const directIframes = [...content.matchAll(/<iframe[^>]+src="([^"]+)"/gi)];
      for (let idx = 0; idx < directIframes.length; idx++) {
        watchLinks.push([null, directIframes[idx][1], `Direct Player ${idx + 1}`]);
      }

      const byseStreams = [];
      const vidaraStreams = [];
      const okStreams = [];
      const dmStreams = [];
      const directStreams = [];
      const seenUrls = new Set();

      for (let i = 0; i < watchLinks.length; i++) {
        let dest = watchLinks[i][1];
        const rawPart = watchLinks[i][2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        const partName = rawPart ? rawPart.replace(/\s+/g, ' ') : `Part ${i + 1}`;

        try {
          const parsed = new URL(dest, targetUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) continue;
          dest = parsed.href;
        } catch (_) {
          continue;
        }

        try {
          const isDirectProvider = /ok\.ru|byse|vidara|dailymotion|dai\.ly|d\.tube|\.(?:m3u8|mp4)/i.test(dest);
          if (!isDirectProvider && /^https?:\/\//i.test(dest)) {
            try {
              const bridgeHtml = await this.fetchPage.fire(dest, { 'Referer': 'https://mlblive.net/' });
              const iframeUrl = findBridgeIframe(bridgeHtml, dest, url =>
                /\.(m3u8|mp4)$/i.test(url.pathname) || isByseHost(url.hostname) ||
                ['vidara.so', 'dailymotion.com', 'dai.ly', 'ok.ru'].some(domain => matchesHost(url.hostname, domain)));
              if (iframeUrl) dest = iframeUrl;
            } catch (_) {}
          }

          // 1. Vidara API resolution
          if (this._isVidaraUrl(dest)) {
            const extracted = await this._extractVidara(dest, partName);
            for (const s of extracted) {
              if (!seenUrls.has(s.url)) {
                seenUrls.add(s.url);
                vidaraStreams.push(s);
              }
            }
            continue;
          }

          // 2. Byse AES-256-GCM Payload Extraction (SprintCDN Edge)
          if (this._isByseUrl(dest)) {
            const extracted = await this._extractByse(dest, partName);
            for (const s of extracted) {
              if (!seenUrls.has(s.url)) {
                seenUrls.add(s.url);
                byseStreams.push(s);
              }
            }
            continue;
          }

          // 3. Dailymotion Direct HLS / Player metadata
          if (this._isDailymotionUrl(dest)) {
            const extracted = await this._extractDailymotion(dest, partName);
            for (const s of extracted) {
              if (!seenUrls.has(s.url)) {
                seenUrls.add(s.url);
                dmStreams.push(s);
              }
            }
            continue;
          }

          // 4. OK.ru Direct Video Extraction (1080p, 720p, 480p, Auto HLS)
          if (matchesHost(playerHostname(dest), 'ok.ru')) {
            const extracted = await this._extractOkRu(dest, partName);
            for (const s of extracted) {
              if (!seenUrls.has(s.url)) {
                seenUrls.add(s.url);
                okStreams.push(s);
              }
            }
            continue;
          }

          // 5. Direct Media File
          if (/\.(m3u8|mp4)(?:[?#]|$)/i.test(dest)) {
            if (!seenUrls.has(dest)) {
              seenUrls.add(dest);
              directStreams.push(new StreamEntity({
                name: this.name,
                title: `${partName} (Direct)`,
                resolution: '1080p',
                url: dest,
                behaviorHints: { notWebReady: false }
              }));
            }
          }
        } catch (_) {
          // A broken candidate should not hide later replay sources.
          continue;
        }
      }

      const streams = [
        ...byseStreams,
        ...vidaraStreams,
        ...okStreams,
        ...dmStreams,
        ...directStreams
      ];

      if (streams.length > 0) {
        this._setCache(this._streamCache, targetUrl, streams);
      }

      return streams;
    } catch (err) {
      console.error(`[MLBLive] Error resolving streams for ${targetUrl}:`, err.message);
      return [];
    }
  }

  async _extractOkRu(embedUrl, partName = '') {
    try {
      let normUrl = embedUrl;
      if (normUrl.startsWith('//')) {
        normUrl = 'https:' + normUrl;
      }
      if (/ok\.ru\/video\/\d+/.test(normUrl)) {
        normUrl = normUrl.replace('/video/', '/videoembed/');
      }

      const html = await this.fetchPage.fire(normUrl, { 'Referer': 'https://mlblive.net/' });
      if (!html) return [];

      const optionsMatch = html.match(/data-options="([^"]+)"/i) ||
                           html.match(/data-module="OKVideo"\s+data-options="([^"]+)"/i);

      if (!optionsMatch) return [];

      const rawJson = optionsMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const parsed = JSON.parse(rawJson);
      const meta = parsed.flashvars && parsed.flashvars.metadata;
      let metaObj = meta;
      if (typeof meta === 'string') {
        try { metaObj = JSON.parse(meta); } catch (_) {}
      }

      if (!metaObj) return [];

      const streams = [];
      const cleanPart = partName.trim();

      const qualityMap = {
        'full': '1080p',
        'hd': '720p',
        'sd': '480p',
        'low': '360p',
        'lowest': '240p',
        'mobile': '144p'
      };

      const okProxyHeaders = {
        request: {
          'User-Agent': this.defaultHeaders['User-Agent'],
          'Referer': 'https://ok.ru/'
        }
      };

      if (Array.isArray(metaObj.videos)) {
        for (const v of metaObj.videos) {
          if (!v.url) continue;
          const label = qualityMap[v.name] || v.name || 'HD';
          const title = cleanPart ? `${cleanPart} (${label}) [OK.ru]` : `Full Game (${label}) [OK.ru]`;

          streams.push(new StreamEntity({
            name: this.name,
            title,
            resolution: label,
            url: v.url,
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: okProxyHeaders
            }
          }));
        }
      }

      if (metaObj.hlsManifestUrl) {
        streams.push(new StreamEntity({
          name: this.name,
          title: cleanPart ? `${cleanPart} (Auto HLS) [OK.ru]` : 'Full Game (Auto HLS) [OK.ru]',
          resolution: 'Auto',
          url: metaObj.hlsManifestUrl,
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: okProxyHeaders
          }
        }));
      }

      return streams;
    } catch (err) {
      console.warn(`[MLBLive] Error extracting OK.ru ${embedUrl}:`, err.message);
      return [];
    }
  }

  _isByseUrl(url) {
    return isByseHost(playerHostname(url));
  }

  _isVidaraUrl(url) {
    return matchesHost(playerHostname(url), 'vidara.so');
  }

  _isDailymotionUrl(url) {
    return ['dailymotion.com', 'dai.ly'].some(domain => matchesHost(playerHostname(url), domain));
  }

  _extractDailymotionVideoId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/[?&]video=([a-zA-Z0-9]+)/i) ||
                  url.match(/(?:dailymotion\.com\/(?:video|embed\/video)|dai\.ly)\/([a-zA-Z0-9]+)/i);
    return match ? match[1] : null;
  }

  _decryptBysePlayback(playback) {
    if (!playback || !playback.payload || !playback.iv || !Array.isArray(playback.key_parts)) {
      return null;
    }
    try {
      const version = parseInt(playback.version, 10);
      let keyParts = playback.key_parts;
      if (!isNaN(version) && version >= 1 && version <= 20) {
        const idx1 = version - 1;
        const idx2 = (31 - version) - 1;
        if (playback.key_parts[idx1] && playback.key_parts[idx2]) {
          keyParts = [playback.key_parts[idx1], playback.key_parts[idx2]];
        }
      }
      const key = Buffer.concat(keyParts.map(b64Decode));
      if (key.length !== 32) return null;

      const iv = b64Decode(playback.iv);
      const payload = b64Decode(playback.payload);
      if (payload.length < 16) return null;

      const ciphertext = payload.subarray(0, payload.length - 16);
      const authTag = payload.subarray(payload.length - 16);

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (_) {
      return null;
    }
  }

  async _extractByse(embedUrl, partName = '') {
    try {
      const parsedUrl = new URL(embedUrl);
      const host = parsedUrl.host;
      const res = await safeFetch(embedUrl, {
        headers: { 'Referer': `${parsedUrl.protocol}//${host}/` }
      });
      if (res.status !== 200) return [];
      const html = await res.text();

      let playback;
      const scriptMatch = html && (html.match(/window\.playback\s*=\s*({[\s\S]*?});/i) ||
                                  html.match(/playback\s*=\s*({[\s\S]*?});/i));
      if (scriptMatch) {
        try { playback = JSON.parse(scriptMatch[1]); } catch (_) {}
      }

      if (!playback) {
        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const eIdx = pathParts.indexOf('e');
        const code = (eIdx >= 0 && pathParts[eIdx + 1]) ? pathParts[eIdx + 1] : pathParts[pathParts.length - 1];
        if (code) {
          const apiRes = await safeFetch(`https://${host}/api/videos/${code}/`, {
            headers: {
              ...this.defaultHeaders,
              'Referer': `https://${host}/e/${code}`,
              'Origin': `https://${host}`,
              'Accept': 'application/json, text/plain, */*'
            }
          });
          if (apiRes.status === 200) {
            const apiJson = await apiRes.json();
            playback = apiJson && apiJson.playback;
          }
        }
      }

      if (!playback) return [];

      const decrypted = this._decryptBysePlayback(playback);
      if (!decrypted || !Array.isArray(decrypted.sources)) return [];

      const streams = [];
      const cleanPart = partName.trim();

      for (const s of decrypted.sources) {
        if (!s.url) continue;
        const resLabel = s.label || (s.height ? `${s.height}p` : '1080p');
        const streamTitle = cleanPart ? `${cleanPart} (${resLabel}) [SprintCDN]` : `Full Game (${resLabel}) [SprintCDN]`;

        streams.push(new StreamEntity({
          name: this.name,
          title: streamTitle,
          resolution: resLabel,
          url: s.url,
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: {
              request: {
                'Origin': `https://${host}`,
                'Referer': `https://${host}/`,
                'User-Agent': this.defaultHeaders['User-Agent']
              }
            }
          }
        }));
      }

      return streams;
    } catch (_) {
      return [];
    }
  }

  async _extractVidara(embedUrl, partName = '') {
    try {
      const parsed = new URL(embedUrl);
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      const eIdx = pathParts.indexOf('e');
      const filecode = (eIdx >= 0 && pathParts[eIdx + 1]) ? pathParts[eIdx + 1] : pathParts[pathParts.length - 1];
      if (!filecode) return [];

      const postUrl = `https://${parsed.host}/api/stream`;
      const res = await undici.request(postUrl, {
        method: 'POST',
        headers: {
          ...this.defaultHeaders,
          'Referer': `https://${parsed.host}/e/${filecode}`,
          'Origin': `https://${parsed.host}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filecode: filecode,
          device: 'desktop',
          codecs: ['avc', 'mp4a']
        }),
        headersTimeout: 6000,
        bodyTimeout: 6000
      });

      if (res.statusCode !== 200) return [];
      const data = await res.body.json();
      if (!data || !data.streaming_url) return [];

      const cleanPart = partName.trim();
      const streamTitle = cleanPart ? `${cleanPart} (1080p) [Vidara]` : `Full Game (1080p) [Vidara]`;

      return [new StreamEntity({
        name: this.name,
        title: streamTitle,
        resolution: '1080p',
        url: data.streaming_url,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              'User-Agent': this.defaultHeaders['User-Agent']
            }
          }
        }
      })];
    } catch (_) {
      return [];
    }
  }

  async _extractDailymotion(url, partName = '') {
    const videoId = this._extractDailymotionVideoId(url);
    if (!videoId) return [];

    try {
      const metaUrl = `https://www.dailymotion.com/player/metadata/video/${videoId}`;
      const res = await undici.request(metaUrl, {
        headers: {
          ...this.defaultHeaders,
          'Referer': `https://geo.dailymotion.com/player.html?video=${videoId}`,
          'Origin': 'https://geo.dailymotion.com'
        },
        headersTimeout: 6000,
        bodyTimeout: 6000
      });

      if (res.statusCode !== 200) return [];
      const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      const meta = await res.body.json();
      if (!meta || meta.error) return [];

      const streams = [];
      const cleanPart = partName.trim();

      if (meta.qualities && meta.qualities.auto && meta.qualities.auto[0] && meta.qualities.auto[0].url) {
        const m3u8Url = meta.qualities.auto[0].url;
        const streamTitle = cleanPart ? `${cleanPart} (Auto HLS) [Dailymotion]` : `Full Game (Auto HLS) [Dailymotion]`;

        streams.push(new StreamEntity({
          name: this.name,
          title: streamTitle,
          resolution: '1080p',
          url: m3u8Url,
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: {
              request: {
                'User-Agent': this.defaultHeaders['User-Agent'],
                'Referer': 'https://geo.dailymotion.com/',
                'Origin': 'https://geo.dailymotion.com',
                ...(cookies ? { 'Cookie': cookies } : {})
              }
            }
          }
        }));
      }

      return streams;
    } catch (_) {
      return [];
    }
  }
}

module.exports = MlbLiveProvider;
