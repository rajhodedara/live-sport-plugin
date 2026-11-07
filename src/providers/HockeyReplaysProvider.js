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

function isBridgeUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return false;
    }
    const h = url.hostname.toLowerCase();
    return h === 'nhlgamestoday.com' || h.endsWith('.nhlgamestoday.com') ||
      h === 'nbaontv.com' || h.endsWith('.nbaontv.com') ||
      h === 'guidedesgemmes.com' || h.endsWith('.guidedesgemmes.com') ||
      h === 'guideanimaux.com' || h.endsWith('.guideanimaux.com') ||
      h === 'nflontv.com' || h.endsWith('.nflontv.com');
  } catch (_) {
    return false;
  }
}

/**
 * HockeyReplaysProvider
 *
 * Dedicated NHL full-game replay provider ingesting high-definition game replays
 * from https://hockeyreplays.com/ across NHL regular season and Stanley Cup playoffs.
 *
 * Zero-Egress Architecture:
 * - 0% Server Bandwidth: Direct client CDN playback (okcdn.ru direct MP4/HLS, Dailymotion HLS, Byse CDN).
 * - 0 Cloudflare Workers: Direct client player streaming with behaviorHints.proxyHeaders.
 * - 0 Web Streams: Clean raw streams without site popups or ads.
 */
class HockeyReplaysProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'HockeyReplays';
    this.sourceName = 'hockeyreplays';
    this.baseUrl = 'https://hockeyreplays.com';
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

  _isByseUrl(url) {
    return isByseHost(playerHostname(url));
  }

  _isDailymotionUrl(url) {
    return ['dailymotion.com', 'dai.ly'].some(domain => matchesHost(playerHostname(url), domain));
  }

  _isVidaraUrl(url) {
    return matchesHost(playerHostname(url), 'vidara.so');
  }

  _isDTubeUrl(url) {
    return matchesHost(playerHostname(url), 'd.tube');
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
        const streamTitle = cleanPart ? `HockeyReplays (${cleanPart} - ${resLabel})` : `HockeyReplays (${resLabel})`;

        streams.push(new StreamEntity({
          name: streamTitle,
          title: streamTitle,
          resolution: resLabel,
          url: s.url,
          isDirect: true,
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
      const rawCookies = res.headers['set-cookie'];
      const cookieArr = Array.isArray(rawCookies) ? rawCookies : (typeof rawCookies === 'string' ? [rawCookies] : []);
      const cookies = cookieArr.map(c => c.split(';')[0]).join('; ');
      const meta = await res.body.json();
      if (!meta || meta.error) return [];

      const streams = [];
      const cleanPart = partName.trim();

      if (meta.qualities && meta.qualities.auto && meta.qualities.auto[0] && meta.qualities.auto[0].url) {
        const m3u8Url = meta.qualities.auto[0].url;
        const streamTitle = cleanPart ? `HockeyReplays (${cleanPart} - Auto HLS)` : 'HockeyReplays (Auto HLS)';

        streams.push(new StreamEntity({
          name: streamTitle,
          title: streamTitle,
          resolution: '1080p',
          url: m3u8Url,
          isDirect: true,
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

  /**
   * Parses match listings from hockeyreplays.com HTML index pages.
   */
  _parseMatchCards(html) {
    const matches = [];
    const linkMatches = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const seenUrls = new Set();

    for (const m of linkMatches) {
      const rawUrl = (m[1] || '').trim();
      const rawTitle = (m[2] || '').replace(/<[^>]+>/g, '').trim();

      if (!rawUrl || !rawTitle || seenUrls.has(rawUrl)) continue;

      const isMatchLink = rawUrl.includes('-full-game-replay') ||
                          rawUrl.includes('full-match') ||
                          rawTitle.toLowerCase().includes(' vs ') ||
                          rawTitle.toLowerCase().includes(' @ ');

      if (!isMatchLink) continue;
      if (/-{2,}$/.test(rawUrl)) continue;

      let fullUrl;
      try {
        const parsed = new URL(rawUrl, `${this.baseUrl}/`);
        if (!['http:', 'https:'].includes(parsed.protocol)) continue;
        fullUrl = parsed.href;
      } catch (_) {
        continue;
      }
      if (seenUrls.has(fullUrl)) continue;
      seenUrls.add(fullUrl);

      // Extract match date from title (e.g. October 15, 2026 or September 29, 2026)
      let parsedDate = '';
      const dateMatch = rawTitle.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i);
      if (dateMatch) {
        try {
          const parsed = new Date(`${dateMatch[0]} UTC`);
          if (!isNaN(parsed.getTime())) {
            parsedDate = parsed.toISOString();
          }
        } catch (_) {}
      }

      // League / Competition identification
      let league = 'NHL';
      const lowerTitle = rawTitle.toLowerCase();
      if (lowerTitle.includes('stanley cup') || lowerTitle.includes('playoffs')) {
        league = 'NHL Playoffs';
      } else if (lowerTitle.includes('preseason')) {
        league = 'NHL Preseason';
      } else if (lowerTitle.includes('regular season')) {
        league = 'NHL Regular Season';
      }

      // Extract competitors from title before dashes
      let cleanTitle = rawTitle.replace(/\s+/g, ' ');
      // Standardize @ into vs for clean catalog presentation
      if (cleanTitle.includes(' @ ')) {
        cleanTitle = cleanTitle.replace(' @ ', ' vs ');
      }

      const titleBeforeDashes = cleanTitle.split(/\s+-\s+/)[0] || '';
      const vsParts = titleBeforeDashes.split(/\s+vs\s+/i);
      let team1 = null;
      let team2 = null;
      if (vsParts.length === 2) {
        team1 = { name: vsParts[0].trim() };
        team2 = { name: vsParts[1].trim() };
      }

      // Generate a stable unique ID
      const safeSlug = fullUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
      const id = `hr_${safeSlug}`;

      matches.push(new MatchEntity({
        id,
        title: cleanTitle,
        category: 'hockey',
        date: parsedDate,
        league,
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

  /**
   * Ingests full game replays from season catalogs.
   */
  async getMatches() {
    const endpoints = [
      `${this.baseUrl}/`,
      `${this.baseUrl}/nhl-2026-27`,
      `${this.baseUrl}/nhl-2026-27?page2`,
      `${this.baseUrl}/nhl-2025-26`
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
        console.warn(`[HockeyReplays] Warning fetching ${url}:`, err.message);
      }
    }

    console.log(`[HockeyReplays] Extracted ${allMatches.length} replay matches`);
    return allMatches;
  }

  /**
   * Resolves direct playable streams for a hockey replay page.
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

      // Extract watch, period, quarter, part links
      const linkMatches = [...content.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
      const watchLinks = linkMatches.filter(l => {
        const dest = (l[1] || '').trim();
        const text = l[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        if (!dest) return false;

        // Skip internal navigation and season category links on hockeyreplays.com
        if ((dest.startsWith('/') && !dest.startsWith('//')) || (dest.includes('hockeyreplays.com') && !dest.includes('#'))) {
          if (!this._isByseUrl(dest) && !dest.includes('ok.ru') && !/\.(m3u8|mp4)(?:[?#]|$)/i.test(dest)) {
            return false;
          }
        }

        const isVideoDest = this._isByseUrl(dest) || dest.includes('ok.ru') ||
          this._isDailymotionUrl(dest) || this._isVidaraUrl(dest) || this._isDTubeUrl(dest) ||
          /nhlgamestoday|guidedesgemmes|guideanimaux|nflontv|vidara|dailymotion|dai\.ly|d\.tube/i.test(dest) ||
          /\.(m3u8|mp4)(?:[?#]|$)/i.test(dest);
        const isVideoText = /watch|part|server|period|half|replay|full game|^ok$|^fm$|^dm$/i.test(text);
        return isVideoDest || isVideoText;
      });

      const iframeMatches = [...content.matchAll(/<iframe[^>]+src="([^"]+)"/gi)];
      for (const ifm of iframeMatches) {
        watchLinks.push([null, ifm[1], 'Embed Player']);
      }

      const byseStreams = [];
      const okStreams = [];
      const dmStreams = [];
      const directStreams = [];
      const seenUrls = new Set();

      for (let i = 0; i < watchLinks.length; i++) {
        let dest = watchLinks[i][1];
        const rawPart = watchLinks[i][2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        let partName = rawPart ? rawPart.replace(/\s+/g, ' ') : `Part ${i + 1}`;

        // If partName is generic "Watch", attempt to find preceding server/heading in content HTML
        if (/^watch$/i.test(partName)) {
          const safeDest = dest.split('?')[0].split('#')[0];
          const preIdx = content.indexOf(safeDest);
          if (preIdx > 0) {
            const snippet = content.slice(Math.max(0, preIdx - 500), preIdx);
            const headingMatches = [...snippet.matchAll(/<(?:b|strong|span)[^>]*>([^<]*(?:server|part|period|half|condensed|full)[^<]*)<\/(?:b|strong|span)>/gi)];
            if (headingMatches.length > 0) {
              partName = headingMatches[headingMatches.length - 1][1].trim();
            }
          }
        }

        try {
          const parsed = new URL(dest, targetUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) continue;
          dest = parsed.href;
        } catch (_) {
          continue;
        }

        // Bridge unwrap
        if (isBridgeUrl(dest, targetUrl)) {
          try {
            const bridgeHtml = await this.fetchPage.fire(dest, { 'Referer': 'https://hockeyreplays.com/' });
            const iframeUrl = findBridgeIframe(bridgeHtml, dest, url =>
              /\.(m3u8|mp4)$/i.test(url.pathname) || isByseHost(url.hostname) || matchesHost(url.hostname, 'ok.ru') ||
              ['dailymotion.com', 'dai.ly'].some(domain => matchesHost(url.hostname, domain)));
            if (iframeUrl) dest = iframeUrl;
          } catch (_) {}
        }

        // 1. OK.ru Direct Video Extraction (top priority for hockeyreplays)
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

        // 2. Dailymotion Direct Auto HLS Extraction
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

        // 3. Byse AES-256-GCM Payload Extraction
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

        // 4. Direct Media File (.m3u8 or .mp4)
        if (/\.(m3u8|mp4)(?:[?#]|$)/i.test(dest)) {
          if (!seenUrls.has(dest)) {
            seenUrls.add(dest);
            directStreams.push(new StreamEntity({
              name: this.name,
              title: `${partName} (Direct)`,
              resolution: '1080p',
              url: dest,
              isDirect: true,
              behaviorHints: { notWebReady: false }
            }));
          }
        }
      }

      const streams = [...okStreams, ...dmStreams, ...byseStreams, ...directStreams];

      if (streams.length > 0) {
        this._setCache(this._streamCache, targetUrl, streams);
      }

      return streams;
    } catch (err) {
      console.error(`[HockeyReplays] Error resolving streams for ${targetUrl}:`, err.message);
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

      const html = await this.fetchPage.fire(normUrl, { 'Referer': 'https://hockeyreplays.com/' });
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

      // 1. Direct MP4 videos
      if (Array.isArray(metaObj.videos)) {
        const sortedVideos = [...metaObj.videos].sort((a, b) => {
          const wA = qualityWeight[a.name] || 0;
          const wB = qualityWeight[b.name] || 0;
          return wB - wA;
        });

        for (const v of sortedVideos) {
          if (!v || !v.url) continue;
          const label = qualityMap[v.name] || v.name || 'HD';
          const title = cleanPart ? `HockeyReplays (${cleanPart} - ${label})` : `HockeyReplays (${label})`;

          streams.push(new StreamEntity({
            name: title,
            title: title,
            url: v.url,
            isDirect: true,
            resolution: label,
            behaviorHints: {
              proxyHeaders: okProxyHeaders,
              notWebReady: false
            }
          }));
        }
      }

      // 2. Direct HLS Adaptive Master Manifest
      const hlsUrl = metaObj.hlsManifestUrl || metaObj.hlsMasterPlaylistUrl;
      if (hlsUrl) {
        const title = cleanPart ? `HockeyReplays (${cleanPart} - Adaptive HLS)` : 'HockeyReplays (Adaptive HLS)';
        streams.push(new StreamEntity({
          name: title,
          title: title,
          url: hlsUrl,
          isDirect: true,
          resolution: 'Auto',
          behaviorHints: {
            proxyHeaders: okProxyHeaders,
            notWebReady: false
          }
        }));
      }

      return streams;
    } catch (err) {
      console.warn('[HockeyReplays] Warning extracting OK.ru direct stream:', err.message);
      return [];
    }
  }
}

module.exports = HockeyReplaysProvider;
