'use strict';

const crypto = require('crypto');
const undici = require('undici');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { safeFetch } = require('../impitClient');
const { parseTimezone } = require('../timezone');

function b64Decode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const rem = b64.length % 4;
  if (rem !== 0) b64 += '='.repeat(4 - rem);
  return Buffer.from(b64, 'base64');
}

/**
 * FullRacesProvider
 *
 * Dedicated motorsport replay provider ingesting high-definition full race replays
 * from https://fullraces.com/ across Formula 1, IndyCar, NASCAR, MotoGP/WSBK, and Formula 2.
 *
 * Zero-Egress Architecture:
 * - 0% Server Bandwidth: Direct client CDN playback (okcdn.ru direct MP4/HLS and Byse/SprintCDN HLS).
 * - 0 Cloudflare Workers: Direct player playback with behaviorHints / client proxyHeaders.
 */
class FullRacesProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'FullRaces';
    this.sourceName = 'fullraces';
    this.baseUrl = 'https://fullraces.com';
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    };

    this.categoryUrls = [
      'https://fullraces.com/',
      'https://fullraces.com/f1-race-replays',
      'https://fullraces.com/2026',
      'https://fullraces.com/indycar',
      'https://fullraces.com/nascar',
      'https://fullraces.com/wsbk',
      'https://fullraces.com/f2-full-races'
    ];

    this._matchesCache = null;
    this._matchesCacheTime = 0;
    this._matchesCacheTtl = 60 * 60 * 1000; // 1 hour

    this._byseCache = new Map();
    this._dmCache = new Map();
    this._streamCache = new Map();
    this._maxCacheEntries = 500;
  }

  /**
   * Fetches an HTML document using impitClient to bypass Cloudflare Turnstile.
   */
  async _fetchHtml(url) {
    const res = await safeFetch(url, {
      headers: this.defaultHeaders,
      timeoutMs: 12000,
      attempts: 2
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  }

  /**
   * Parses race listing cards from fullraces.com category HTML pages.
   */
  _parseListingHtml(html, fallbackLeague = 'Motorsport') {
    const matches = [];
    const itemRegex = /<div class="short_item block_elem">[\s\S]*?<div class="poster">\s*<a href="([^"]+)">\s*<img src="([^"]+)"[\s\S]*?<h3>\s*<a[^>]*>([^<]+)<\/a>\s*<\/h3>[\s\S]*?<div class="short_cat">\s*<a[^>]*>([^<]+)<\/a>\s*<\/div>[\s\S]*?<div class="short_descr">\s*<p>([^<]*)<\/p>/gi;

    let m;
    while ((m = itemRegex.exec(html)) !== null) {
      const rawUrl = (m[1] || '').trim();
      if (!rawUrl) continue;
      const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${this.baseUrl}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;

      const rawThumb = (m[2] || '').trim();
      const thumbUrl = rawThumb.startsWith('http') ? rawThumb : `${this.baseUrl}${rawThumb.startsWith('/') ? '' : '/'}${rawThumb}`;

      const title = (m[3] || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      const rawCat = (m[4] || '').replace(/&nbsp;/g, ' ').trim();
      const desc = (m[5] || '').replace(/&nbsp;/g, ' ').trim();

      // Derive specific league name
      let league = fallbackLeague;
      const titleLower = title.toLowerCase();
      const catLower = rawCat.toLowerCase();
      if (titleLower.includes('formula 1') || titleLower.includes('f1') || catLower.includes('formula 1') || catLower.includes('f1')) {
        league = 'Formula 1';
      } else if (titleLower.includes('indycar') || catLower.includes('indycar')) {
        league = 'IndyCar';
      } else if (titleLower.includes('nascar') || catLower.includes('nascar')) {
        league = 'NASCAR';
      } else if (titleLower.includes('motogp') || catLower.includes('motogp')) {
        league = 'MotoGP';
      } else if (titleLower.includes('wsbk') || catLower.includes('wsbk') || catLower.includes('superbike')) {
        league = 'WSBK';
      } else if (titleLower.includes('formula 2') || titleLower.includes('f2') || catLower.includes('formula 2')) {
        league = 'Formula 2';
      }

      // Extract ISO date (YYYY-MM-DD) from description or title in UTC
      const dateMatch = desc.match(/([a-zA-Z]+ \d{1,2}, \d{4})/i) || title.match(/([a-zA-Z]+ \d{1,2}, \d{4})/i);
      let dateStr = '';
      if (dateMatch) {
        const parsed = parseTimezone(dateMatch[1], 'UTC');
        if (parsed) {
          dateStr = new Date(parsed).toISOString().slice(0, 10);
        }
      }

      const idSafe = fullUrl.replace(/https?:\/\/fullraces\.com\//i, '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
      matches.push(new MatchEntity({
        id: `fr_${idSafe}`,
        title,
        category: 'motorsport',
        league,
        date: dateStr,
        status: 'finished',
        thumbnail_url: thumbUrl,
        poster: thumbUrl,
        sources: [{
          source: this.sourceName,
          id: fullUrl,
          name: 'FullRaces',
          url: fullUrl,
          type: 'fullraces'
        }]
      }));
    }

    return matches;
  }

  /**
   * Main catalog fetcher: scrapes all key motorsport disciplines and aggregates them.
   */
  async getMatches() {
    const now = Date.now();
    if (this._matchesCache && (now - this._matchesCacheTime < this._matchesCacheTtl)) {
      return this._matchesCache;
    }

    console.log('[FullRaces] Ingesting motorsport replays from fullraces.com...');
    const allMatches = [];
    const seenIds = new Set();

    for (const url of this.categoryUrls) {
      try {
        let fallbackLeague = 'Motorsport';
        if (url.includes('2026')) fallbackLeague = 'Formula 1';
        else if (url.includes('indycar')) fallbackLeague = 'IndyCar';
        else if (url.includes('nascar')) fallbackLeague = 'NASCAR';
        else if (url.includes('wsbk')) fallbackLeague = 'MotoGP';
        else if (url.includes('f2')) fallbackLeague = 'Formula 2';

        const html = await this._fetchHtml(url);
        const parsed = this._parseListingHtml(html, fallbackLeague);

        for (const m of parsed) {
          if (!seenIds.has(m.id)) {
            seenIds.add(m.id);
            allMatches.push(m);
          }
        }
      } catch (err) {
        console.warn(`[FullRaces] Failed to fetch category ${url}: ${err.message}`);
      }
    }

    console.log(`[FullRaces] Successfully ingested ${allMatches.length} motorsport replays.`);
    this._matchesCache = allMatches;
    this._matchesCacheTime = now;
    return allMatches;
  }

  /**
   * Resolves playable video streams from a race detail page.
   */
  async resolveStream(url, category, team, srcObj) {
    url = url || (srcObj && srcObj.url) || (srcObj && srcObj.id) || '';
    if (!url) return [];

    const cached = this._streamCache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.streams;
    }

    try {
      const html = await this._fetchHtml(url);
      const extractedSources = this._extractSourcesFromHtml(html);

      const resolvedStreams = [];
      for (const src of extractedSources) {
        try {
          if (src.type === 'ok' || src.url.includes('ok.ru')) {
            const okStreams = await this._resolveOkRu(src.url, src.name);
            resolvedStreams.push(...okStreams);
          } else if (src.type === 'byse' || this._isByseUrl(src.url)) {
            const byseStreams = await this.extractByse(src.url, src.name);
            resolvedStreams.push(...byseStreams);
          } else if (src.type === 'dailymotion' || this._isDailymotionUrl(src.url)) {
            const dmStreams = await this._resolveDailymotion(src.url, src.name);
            resolvedStreams.push(...dmStreams);
          }
        } catch (err) {
          console.warn(`[FullRaces] Error resolving sub-stream ${src.url}: ${err.message}`);
        }
      }

      if (resolvedStreams.length > 0) {
        if (this._streamCache.size >= this._maxCacheEntries) {
          this._streamCache.delete(this._streamCache.keys().next().value);
        }
        this._streamCache.set(url, {
          streams: resolvedStreams,
          expiresAt: Date.now() + 30 * 60 * 1000 // 30 min cache
        });
      }

      return resolvedStreams;
    } catch (err) {
      console.error(`[FullRaces] Error resolving race page ${url}: ${err.message}`);
      return [];
    }
  }

  /**
   * Extracts all embed links, OK.ru iframes, Byse buttons, and Dailymotion parts from race page HTML.
   */
  _extractSourcesFromHtml(html) {
    const extractedSources = [];
    const seenUrls = new Set();

    // 1. Direct iframes: <iframe ... src="(...)">
    const iframeRegex = /<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = iframeRegex.exec(html)) !== null) {
      let srcUrl = m[1].trim();
      if (srcUrl.startsWith('//')) srcUrl = 'https:' + srcUrl;
      if (!seenUrls.has(srcUrl) && !srcUrl.includes('google') && !srcUrl.includes('ads')) {
        seenUrls.add(srcUrl);
        extractedSources.push({
          name: 'Player Embed',
          url: srcUrl,
          type: srcUrl.includes('ok.ru') ? 'ok' : (srcUrl.includes('dailymotion') ? 'dailymotion' : (this._isByseUrl(srcUrl) ? 'byse' : 'iframe'))
        });
      }
    }

    // 2. Section buttons: <p><strong>Header</strong></p> ... <a href="...">Button</a>
    const sections = html.split(/<p[^>]*style="text-align:\s*center;"[^>]*>\s*<span[^>]*><strong>(.*?)<\/strong><\/span>\s*<\/p>/gi);

    for (let i = 1; i < sections.length; i += 2) {
      const headerText = sections[i].replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim();
      const content = sections[i + 1] || '';

      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let lm;
      while ((lm = linkRegex.exec(content)) !== null) {
        let href = lm[1].trim();
        if (href.startsWith('//')) href = 'https:' + href;
        const btnText = lm[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

        if (!seenUrls.has(href) && /ok\.ru|dailymotion|byse|bysesukior|bysefujedu|filemoon/i.test(href)) {
          seenUrls.add(href);
          extractedSources.push({
            name: `${headerText} - ${btnText}`,
            url: href,
            type: href.includes('dailymotion') ? 'dailymotion' : (href.includes('ok.ru') ? 'ok' : 'byse')
          });
        }
      }
    }

    return extractedSources;
  }

  // ─── Stream Decoders (OK.ru, Filemoon/Byse, Dailymotion) ────────────────────

  _isByseUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /byse[a-z0-9]*\.[a-z]+/i.test(url) || /filemoon\.[a-z]+/i.test(url);
  }

  _isDailymotionUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /(?:dailymotion\.com|dai\.ly)/i.test(url);
  }

  _extractDailymotionVideoId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/[?&]video=([a-zA-Z0-9]+)/i) ||
                  url.match(/(?:dailymotion\.com\/(?:video|embed\/video)|dai\.ly)\/([a-zA-Z0-9]+)/i);
    return match ? match[1] : null;
  }

  async _resolveDailymotion(url, partName = '') {
    const videoId = this._extractDailymotionVideoId(url);
    if (!videoId) return [];

    try {
      const apiUrl = `https://www.dailymotion.com/player/metadata/video/${videoId}`;
      const res = await undici.request(apiUrl, {
        headers: {
          'User-Agent': this.defaultHeaders['User-Agent'],
          'Referer': 'https://www.dailymotion.com/'
        },
        headersTimeout: 4000,
        bodyTimeout: 4000
      });
      if (res.statusCode !== 200) return [];
      const json = await res.body.json();
      if (json && json.error) return [];

      return [{
        name: 'FullRaces',
        title: partName ? `${partName} (Dailymotion)` : 'Watch in Browser',
        externalUrl: url,
        _frWeb: true
      }];
    } catch (_) {
      return [];
    }
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

  async extractByse(embedUrl, partName = '') {
    try {
      const u = new URL(embedUrl);
      const host = u.hostname;
      const pathParts = u.pathname.split('/').filter(Boolean);
      // bysekoze uses /e/<code>/<slug> — code is segment after /e/, not last segment
      const eIdx = pathParts.indexOf('e');
      const code = (eIdx >= 0 && pathParts[eIdx + 1]) ? pathParts[eIdx + 1] : pathParts[pathParts.length - 1];
      if (!code) return [];

      const cacheKey = `${host}:${code}`;
      const cached = this._byseCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return this._formatByseStreams(cached.sources, host, partName);
      }

      const apiUrl = `https://${host}/api/videos/${code}/`;
      const res = await undici.request(apiUrl, {
        headers: {
          'User-Agent': this.defaultHeaders['User-Agent'],
          'Referer': `https://${host}/e/${code}`,
          'Origin': `https://${host}`,
          'Accept': 'application/json, text/plain, */*'
        }
      });

      if (res.statusCode !== 200) return [];
      const json = await res.body.json();
      if (!json || !json.playback) return [];

      const decrypted = this._decryptBysePlayback(json.playback);
      if (!decrypted || !Array.isArray(decrypted.sources)) return [];

      this._byseCache.set(cacheKey, {
        sources: decrypted.sources,
        expiresAt: Date.now() + 10 * 60 * 1000
      });

      return this._formatByseStreams(decrypted.sources, host, partName);
    } catch (_) {
      return [];
    }
  }

  _formatByseStreams(sources, host, partName) {
    if (!Array.isArray(sources) || sources.length === 0) return [];
    const best = sources.find(s => s.label === '1080p') || sources[0];
    if (!best || !best.url) return [];

    const cleanPart = (partName || '').replace(/&nbsp;/g, ' ').trim();
    const title = cleanPart ? `${cleanPart} (${best.label || '1080p'}) [SprintCDN]` : `FullRaces (${best.label || '1080p'}) [SprintCDN]`;

    return [{
      name: 'FullRaces',
      title,
      resolution: best.label || '1080p',
      url: best.url,
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
    }];
  }

  async _resolveOkRu(url, partName = '') {
    try {
      const match = url.match(/videoembed\/(\d+)/) || url.match(/video\/(\d+)/);
      if (!match) return [];
      const videoId = match[1];

      const embedUrl = `https://ok.ru/videoembed/${videoId}`;
      const res = await undici.request(embedUrl, {
        headers: this.defaultHeaders
      });

      if (res.statusCode !== 200) return [];
      const html = await res.body.text();

      const optionsMatch = html.match(/data-options="([^"]+)"/);
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
      const cleanPart = (partName || '').replace(/&nbsp;/g, ' ').trim();
      const qualityMap = { 'full': '1080p', 'hd': '720p', 'sd': '480p', 'low': '360p' };
      const qualityWeight = { 'full': 1080, '1080p': 1080, 'hd': 720, '720p': 720, 'sd': 480 };

      const okProxyHeaders = {
        request: {
          'User-Agent': this.defaultHeaders['User-Agent'],
          'Referer': 'https://ok.ru/'
        }
      };

      if (Array.isArray(metaObj.videos) && metaObj.videos.length > 0) {
        const validVideos = metaObj.videos.filter(v => v && v.url);
        validVideos.sort((a, b) => (qualityWeight[b.name] || 0) - (qualityWeight[a.name] || 0));
        const bestVideo = validVideos[0];
        if (bestVideo) {
          const label = qualityMap[bestVideo.name] || bestVideo.name || '1080p';
          const title = cleanPart ? `${cleanPart} (${label}) [OK.ru]` : `FullRaces (${label}) [OK.ru]`;
          streams.push({
            name: 'FullRaces',
            title,
            resolution: label,
            url: bestVideo.url,
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: okProxyHeaders
            }
          });
        }
      }

      if (metaObj.hlsManifestUrl) {
        streams.push({
          name: 'FullRaces',
          title: cleanPart ? `${cleanPart} (Auto HLS) [OK.ru]` : 'FullRaces (Auto HLS) [OK.ru]',
          resolution: 'Auto',
          url: metaObj.hlsManifestUrl,
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: okProxyHeaders
          }
        });
      }

      return streams;
    } catch (_) {
      return [];
    }
  }
}

module.exports = FullRacesProvider;
