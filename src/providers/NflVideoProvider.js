'use strict';

const crypto = require('crypto');
const undici = require('../services/ProviderOutbound');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

function b64Decode(str) {
  return Buffer.from(str, 'base64');
}

/**
 * NflVideoProvider
 *
 * Dedicated American Football replay provider ingesting high-definition full game replays,
 * NFL RedZone, and College Football (CFB) from https://nfl-video.com/.
 *
 * Zero-Egress Architecture:
 * - 0% Server Bandwidth: Direct client CDN playback (okcdn.ru direct MP4/HLS and Byse SprintCDN).
 * - 0 Cloudflare Workers: Direct client player streaming with behaviorHints.proxyHeaders.
 * - 0 Web Streams: Eliminates browser popups, ads, and web players.
 */
class NflVideoProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'NFLVideo';
    this.sourceName = 'nflvideo';
    this.baseUrl = 'https://nfl-video.com';
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    };

    this._matchPageCache = new Map();
    this._streamCache = new Map();
    this._maxCacheEntries = 500;

    if (this.circuitBreaker && typeof this.circuitBreaker.wrapSync === 'function') {
      this.fetchPage = this.circuitBreaker.wrapSync(`${this.name}_fetchPage`, async (url, customHeaders = {}) => {
        const res = await undici.request(url, {
          headers: { ...this.defaultHeaders, ...customHeaders },
          headersTimeout: 10000,
          bodyTimeout: 10000
        });
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        return await res.body.text();
      });
    } else {
      this.fetchPage = {
        fire: async (url, customHeaders = {}) => {
          const res = await undici.request(url, {
            headers: { ...this.defaultHeaders, ...customHeaders },
            headersTimeout: 10000,
            bodyTimeout: 10000
          });
          if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
          return await res.body.text();
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

  /**
   * Parses match listings from nfl-video HTML index pages.
   */
  _parseMatchCards(html) {
    const matches = [];
    const linkMatches = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi)];
    const seenUrls = new Set();

    for (const m of linkMatches) {
      const rawUrl = (m[1] || '').trim();
      const rawTitle = (m[2] || '').trim();

      if (!rawUrl || !rawTitle || seenUrls.has(rawUrl)) continue;

      const lowerUrl = rawUrl.toLowerCase();
      const lowerTitle = rawTitle.toLowerCase();

      const isMatchLink = lowerUrl.includes('-full-game-replay') ||
                          lowerUrl.includes('-full-show-replay') ||
                          lowerUrl.includes('full-match') ||
                          lowerUrl.includes('-vs-') ||
                          lowerUrl.includes('-at-') ||
                          /\b(vs\.?|@)\b/i.test(lowerTitle) ||
                          lowerTitle.includes('redzone');

      // Drop team landing pages and non-fixture links
      if (!isMatchLink || lowerUrl.endsWith('-full-game-replays')) continue;

      const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${this.baseUrl}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
      seenUrls.add(rawUrl);

      // Extract match date from title (e.g. October 11, 2026 or September 5, 2025)
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

      // Identify league / competition
      let league = 'NFL';
      if (lowerTitle.includes('redzone')) {
        league = 'NFL RedZone';
      } else if (lowerTitle.includes('college') || lowerTitle.includes('cfb') || lowerTitle.includes('ncaa')) {
        league = 'NCAA Football';
      } else if (lowerTitle.includes('hard knocks')) {
        league = 'NFL Hard Knocks';
      } else if (lowerTitle.includes('super bowl')) {
        league = 'Super Bowl';
      } else if (lowerTitle.includes('playoff') || lowerTitle.includes('championship')) {
        league = 'NFL Playoffs';
      } else if (lowerTitle.includes('preseason')) {
        league = 'NFL Preseason';
      }

      // Generate a stable unique ID
      const safeSlug = fullUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
      const id = `nfl_${safeSlug}`;

      matches.push(new MatchEntity({
        id,
        title: rawTitle,
        category: 'american_football',
        league,
        date: parsedDate,
        status: 'finished',
        poster: '', // empty poster lets catalog engine generate high-res broadcast cards
        thumbnail_url: '',
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

  /**
   * Ingests full game replays from season and college catalogs.
   */
  async getMatches() {
    const endpoints = [
      `${this.baseUrl}/`,
      `${this.baseUrl}/2026`,
      `${this.baseUrl}/cfb/`
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
        console.warn(`[NFLVideo] Warning fetching ${url}:`, err.message);
      }
    }

    console.log(`[NFLVideo] Extracted ${allMatches.length} replay matches`);
    return allMatches;
  }

  /**
   * Resolves direct playable streams for an NFL replay page.
   */
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

      // Extract watch and server links
      const linkMatches = [...content.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
      const watchLinks = linkMatches.filter(l => {
        const text = l[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        const href = l[1];
        return /watch|part|server|^ok$|^fm$|^dm$/i.test(text) ||
               /ok\.ru|byse|vidara|dailymotion|dai\.ly|d\.tube|nhlgamestoday|nbaontv|nflontv|guideanimaux/i.test(href);
      });

      // Extract direct iframes embedded in page
      const directIframes = [...content.matchAll(/<iframe[^>]+src="([^"]+)"/gi)];
      for (let idx = 0; idx < directIframes.length; idx++) {
        watchLinks.push([null, directIframes[idx][1], `Direct Player ${idx + 1}`]);
      }

      const byseStreams = [];
      const vidaraStreams = [];
      const okStreams = [];
      const dmStreams = [];
      const dtubeStreams = [];
      const directStreams = [];
      const seenUrls = new Set();

      for (let i = 0; i < watchLinks.length; i++) {
        let dest = watchLinks[i][1];
        const rawPart = watchLinks[i][2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        const partName = rawPart ? rawPart.replace(/\s+/g, ' ') : `Part ${i + 1}`;

        // Unwrap bridge page if dest is not a direct video/embed provider
        const isDirectProvider = /ok\.ru|byse|vidara|dailymotion|dai\.ly|d\.tube|\.(?:m3u8|mp4)/i.test(dest);
        if (!isDirectProvider && /^https?:\/\//i.test(dest)) {
          try {
            const bridgeHtml = await this.fetchPage.fire(dest, { 'Referer': 'https://nfl-video.com/' });
            const iframeMatch = bridgeHtml && bridgeHtml.match(/<iframe[^>]+src="([^"]+)"/i);
            if (iframeMatch) {
              dest = iframeMatch[1];
            }
          } catch (_) {}
        }

        // Normalize protocol-relative URLs
        if (dest.startsWith('//')) {
          dest = `https:${dest}`;
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

        // 4. DTube decentralized master HLS
        if (this._isDTubeUrl(dest)) {
          const extracted = await this._extractDTube(dest, partName);
          for (const s of extracted) {
            if (!seenUrls.has(s.url)) {
              seenUrls.add(s.url);
              dtubeStreams.push(s);
            }
          }
          continue;
        }

        // 5. OK.ru Direct Video Extraction (1080p, 720p, 480p, Auto HLS)
        if (dest.includes('ok.ru')) {
          const extracted = await this._extractOkRu(dest, partName);
          for (const s of extracted) {
            if (!seenUrls.has(s.url)) {
              seenUrls.add(s.url);
              okStreams.push(s);
            }
          }
          continue;
        }

        // 6. Direct Media File
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
      }

      const streams = [
        ...byseStreams,
        ...vidaraStreams,
        ...okStreams,
        ...dmStreams,
        ...dtubeStreams,
        ...directStreams
      ];

      if (streams.length > 0) {
        this._setCache(this._streamCache, targetUrl, streams);
      }

      return streams;
    } catch (err) {
      console.error(`[NFLVideo] Error resolving streams for ${targetUrl}:`, err.message);
      return [];
    }
  }

  /**
   * Extracts direct MP4/HLS streams from an OK.ru embed page with zero server bandwidth.
   */
  async _extractOkRu(embedUrl, partName = '') {
    try {
      let normUrl = embedUrl;
      if (/ok\.ru\/video\/\d+/.test(normUrl)) {
        normUrl = normUrl.replace('/video/', '/videoembed/');
      }

      const html = await this.fetchPage.fire(normUrl, { 'Referer': 'https://nfl-video.com/' });
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

      // Add Auto HLS Manifest if available
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
      console.warn(`[NFLVideo] Error extracting OK.ru ${embedUrl}:`, err.message);
      return [];
    }
  }

  _isByseUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /byse[a-z0-9]*\.[a-z]+/i.test(url);
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
      const html = await this.fetchPage.fire(embedUrl, {
        'Referer': `${parsedUrl.protocol}//${host}/`
      });

      let playback;
      const scriptMatch = html && (html.match(/window\.playback\s*=\s*({[\s\S]*?});/i) ||
                                  html.match(/playback\s*=\s*({[\s\S]*?});/i));
      if (scriptMatch) {
        try { playback = JSON.parse(scriptMatch[1]); } catch (_) {}
      }

      if (!playback) {
        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        // bysekoze uses /e/<code>/<slug> — code is segment after /e/, not last segment
        const eIdx = pathParts.indexOf('e');
        const code = (eIdx >= 0 && pathParts[eIdx + 1]) ? pathParts[eIdx + 1] : pathParts[pathParts.length - 1];
        if (code) {
          const apiRes = await undici.request(`https://${host}/api/videos/${code}/`, {
            headers: {
              ...this.defaultHeaders,
              'Referer': `https://${host}/e/${code}`,
              'Origin': `https://${host}`,
              'Accept': 'application/json, text/plain, */*'
            },
            headersTimeout: 10000,
            bodyTimeout: 10000
          });
          if (apiRes.statusCode === 200) {
            const apiJson = await apiRes.body.json();
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

  _isVidaraUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /vidara\.so/i.test(url);
  }

  _isDailymotionUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /(?:dailymotion\.com|dai\.ly|geo\.dailymotion\.com)/i.test(url);
  }

  _isDTubeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /(?:play\.d\.tube|d\.tube)/i.test(url);
  }

  _extractDailymotionVideoId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/[?&]video=([a-zA-Z0-9]+)/i) ||
                  url.match(/(?:dailymotion\.com\/(?:video|embed\/video)|dai\.ly)\/([a-zA-Z0-9]+)/i);
    return match ? match[1] : null;
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

  async _extractDTube(url, partName = '') {
    try {
      const parsed = new URL(url);
      const vidId = parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop();
      if (!vidId) return [];

      // DTube serves master m3u8 from nas1.d.tube (or fallback nas2)
      const nasCandidates = [
        `https://nas1.d.tube/videos/${vidId}/master.m3u8`,
        `https://nas2.d.tube/videos/${vidId}/master.m3u8`
      ];

      for (const m3u8Url of nasCandidates) {
        try {
          const res = await undici.request(m3u8Url, {
            headers: this.defaultHeaders,
            headersTimeout: 4000,
            bodyTimeout: 4000
          });
          if (res.statusCode === 200) {
            const cleanPart = partName.trim();
            const streamTitle = cleanPart ? `${cleanPart} (Auto HLS) [DTube]` : `Full Game (Auto HLS) [DTube]`;
            return [new StreamEntity({
              name: this.name,
              title: streamTitle,
              resolution: '1080p',
              url: m3u8Url,
              behaviorHints: {
                notWebReady: false,
                proxyHeaders: {
                  request: {
                    'User-Agent': this.defaultHeaders['User-Agent']
                  }
                }
              }
            })];
          }
        } catch (_) {}
      }
      return [];
    } catch (_) {
      return [];
    }
  }
}

module.exports = NflVideoProvider;
