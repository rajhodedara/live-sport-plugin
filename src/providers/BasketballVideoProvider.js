'use strict';

const crypto = require('crypto');
const undici = require('../services/ProviderOutbound');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { findBridgeIframe, matchesHost, isByseHost, playerHostname } = require('./bridgeIframe');

function b64Decode(str) {
  return Buffer.from(str, 'base64');
}

function isNbaOnTvUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      (url.hostname === 'nbaontv.com' || url.hostname.endsWith('.nbaontv.com'));
  } catch (_) {
    return false;
  }
}

/**
 * BasketballVideoProvider
 *
 * Dedicated basketball replay provider ingesting high-definition full game replays
 * from https://basketball-video.com/ across NBA, WNBA, NCAA, and Euroleague.
 *
 * Zero-Egress Architecture:
 * - 0% Server Bandwidth: Direct client CDN playback (okcdn.ru direct MP4/HLS and Byse CDNs).
 * - 0 Cloudflare Workers: Direct player playback with behaviorHints / client proxyHeaders.
 */
class BasketballVideoProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'BasketballVideo';
    this.sourceName = 'basketballvideo';
    this.baseUrl = 'https://basketball-video.com';
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
   * Parses match listings from basketball-video HTML index pages.
   */
  _parseMatchCards(html) {
    const matches = [];
    const linkMatches = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi)];
    const seenUrls = new Set();

    for (const m of linkMatches) {
      const rawUrl = (m[1] || '').trim();
      const rawTitle = (m[2] || '').trim();

      if (!rawUrl || !rawTitle || seenUrls.has(rawUrl)) continue;

      const isMatchLink = rawUrl.includes('-full-game-replay') ||
                          rawUrl.includes('full-match') ||
                          rawTitle.toLowerCase().includes(' vs ') ||
                          rawTitle.toLowerCase().includes(' @ ');

      if (!isMatchLink) continue;
      // Drop broken placeholder links that end in multiple dashes (e.g. --- or ----)
      if (/-{2,}$/.test(rawUrl)) continue;

      const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${this.baseUrl}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
      seenUrls.add(rawUrl);

      // Extract match date from title (e.g. October 9, 2026 or June 22, 2025)
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
      let league = 'NBA';
      const lowerTitle = rawTitle.toLowerCase();
      if (lowerTitle.includes('wnba')) {
        league = 'WNBA';
      } else if (lowerTitle.includes('college') || lowerTitle.includes('ncaa') || lowerTitle.includes('cbb')) {
        league = 'NCAA';
      } else if (lowerTitle.includes('euroleague')) {
        league = 'Euroleague';
      } else if (lowerTitle.includes('finals')) {
        league = 'NBA Finals';
      } else if (lowerTitle.includes('playoffs')) {
        league = 'NBA Playoffs';
      } else if (lowerTitle.includes('summer league')) {
        league = 'NBA Summer League';
      } else if (lowerTitle.includes('preseason')) {
        league = 'NBA Preseason';
      }

      // Generate a stable unique ID
      const safeSlug = fullUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
      const id = `bv_${safeSlug}`;

      matches.push(new MatchEntity({
        id,
        title: rawTitle,
        category: 'basketball',
        league,
        date: parsedDate, // unanchored fallback '' merges cleanly with existing fixtures
        status: 'finished',
        poster: '', // empty poster lets catalog engine generate high-res cinematic broadcast cards
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
   * Ingests full game replays from season catalogs.
   */
  async getMatches() {
    const endpoints = [
      `${this.baseUrl}/`,
      `${this.baseUrl}/2024-25`,
      `${this.baseUrl}/2025-26`,
      `${this.baseUrl}/wnba-video-fulll`,
      `${this.baseUrl}/college-basketball`
    ];

    const allMatches = [];
    const seenIds = new Set();

    for (const url of endpoints) {
      try {
        const html = await this.fetchPage.fire(url);
        const parsed = this._parseMatchCards(html);
        for (const m of parsed) {
          if (!seenIds.has(m.id)) {
            seenIds.add(m.id);
            allMatches.push(m);
          }
        }
      } catch (err) {
        console.warn(`[BasketballVideo] Warning fetching ${url}:`, err.message);
      }
    }

    console.log(`[BasketballVideo] Extracted ${allMatches.length} replay matches`);
    return allMatches;
  }

  /**
   * Resolves direct playable streams for a basketball replay page.
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

      // Extract watch, quarter, and part links
      const linkMatches = [...content.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
      const watchLinks = linkMatches.filter(l => {
        const dest = l[1] || '';
        const text = l[2].replace(/<[^>]+>/g, '').trim();
        const isVideoDest = this._isByseUrl(dest) || dest.includes('ok.ru') || isNbaOnTvUrl(dest, targetUrl) || /\.(m3u8|mp4)(?:[?#]|$)/i.test(dest);
        const isVideoText = /watch|part|server|quarter|half|replay|full game/i.test(text);
        return isVideoDest || isVideoText;
      });

      const iframeMatches = [...content.matchAll(/<iframe[^>]+src="([^"]+)"/gi)];
      for (const ifm of iframeMatches) {
        watchLinks.push([null, ifm[1], 'Embed Player']);
      }

      const byseStreams = [];
      const okStreams = [];
      const directStreams = [];

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

        // Unwrap nbaontv.com bridge wrappers
        if (isNbaOnTvUrl(dest)) {
          try {
            const bridgeHtml = await this.fetchPage.fire(dest);
            const iframeUrl = findBridgeIframe(bridgeHtml, dest, url =>
              /\.(m3u8|mp4)$/i.test(url.pathname) || isByseHost(url.hostname) || matchesHost(url.hostname, 'ok.ru'));
            if (iframeUrl) dest = iframeUrl;
          } catch (_) {}
        }

        // 1. Byse AES-256-GCM Payload Extraction (Top Priority - SprintCDN Edge)
        if (this._isByseUrl(dest)) {
          const extracted = await this._extractByse(dest, partName);
          if (extracted && extracted.length > 0) {
            byseStreams.push(...extracted);
            continue;
          }
        }

        // 2. OK.ru Direct Video Extraction (1080p, 720p, 480p, Auto HLS)
        if (matchesHost(playerHostname(dest), 'ok.ru')) {
          const extracted = await this._extractOkRu(dest, partName);
          if (extracted && extracted.length > 0) {
            okStreams.push(...extracted);
            continue;
          }
        }

        // 3. Direct Media File
        if (/\.(m3u8|mp4)(?:[?#]|$)/i.test(dest)) {
          directStreams.push(new StreamEntity({
            name: this.name,
            title: `${partName} (Direct)`,
            resolution: '1080p',
            url: dest,
            behaviorHints: { notWebReady: false }
          }));
        }
      }

      const streams = [...byseStreams, ...okStreams, ...directStreams];

      if (streams.length > 0) {
        this._setCache(this._streamCache, targetUrl, streams);
      }

      return streams;
    } catch (err) {
      console.error(`[BasketballVideo] Error resolving streams for ${targetUrl}:`, err.message);
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

      const html = await this.fetchPage.fire(normUrl, { 'Referer': 'https://nbaontv.com/' });
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

      const qualityWeight = {
        'full': 1080,
        '1080p': 1080,
        'hd': 720,
        '720p': 720,
        'sd': 480,
        '480p': 480,
        'low': 360,
        '360p': 360,
        'lowest': 240,
        '240p': 240,
        'mobile': 144,
        '144p': 144
      };

      if (Array.isArray(metaObj.videos) && metaObj.videos.length > 0) {
        const validVideos = metaObj.videos.filter(v => v && v.url);
        validVideos.sort((a, b) => (qualityWeight[b.name] || 0) - (qualityWeight[a.name] || 0));
        const bestVideo = validVideos[0];
        if (bestVideo) {
          const label = qualityMap[bestVideo.name] || bestVideo.name || 'HD';
          const title = cleanPart ? `${cleanPart} (${label}) [OK.ru]` : `Full Game (${label}) [OK.ru]`;

          streams.push(new StreamEntity({
            name: this.name,
            title,
            resolution: label,
            url: bestVideo.url,
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
      console.warn(`[BasketballVideo] Error extracting OK.ru ${embedUrl}:`, err.message);
      return [];
    }
  }

  _isByseUrl(url) {
    return isByseHost(playerHostname(url));
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

      const validSources = decrypted.sources.filter(s => s && s.url);
      if (validSources.length === 0) return [];

      validSources.sort((a, b) => {
        const hA = parseInt(a.height || (a.label ? a.label.replace(/\D/g, '') : 0), 10) || 0;
        const hB = parseInt(b.height || (b.label ? b.label.replace(/\D/g, '') : 0), 10) || 0;
        return hB - hA;
      });

      const best = validSources[0];
      const resLabel = best.label || (best.height ? `${best.height}p` : '1080p');
      const cleanPart = partName.trim();
      const streamTitle = cleanPart ? `${cleanPart} (${resLabel}) [SprintCDN]` : `Full Game (${resLabel}) [SprintCDN]`;

      return [new StreamEntity({
        name: this.name,
        title: streamTitle,
        resolution: resLabel,
        url: best.url,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              'Origin': `https://${host}`,
              'Referer': `https://${host}/`,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
            }
          }
        }
      })];
    } catch (_) {
      return [];
    }
  }
}

module.exports = BasketballVideoProvider;
