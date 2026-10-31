const { BASE_URL } = require('../config');
const crypto = require('crypto');
const undici = require('../services/ProviderOutbound');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { unpack } = require('./deanEdwardsUnpack');

function b64Decode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const rem = b64.length % 4;
  if (rem !== 0) b64 += '='.repeat(4 - rem);
  return Buffer.from(b64, 'base64');
}

class SoccerFullProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'SoccerFull';
    this.sourceName = 'soccerfull';
    this.baseUrl = 'https://soccerfull.net';
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    };

    // In-memory bounded caches to prevent repeated network hops
    this._matchPageCache = new Map();
    this._streamCache = new Map();
    this._byseCache = new Map();
    this._maxCacheEntries = 500;

    // Circuit breaker wrappers if circuit breaker is available
    if (this.circuitBreaker && typeof this.circuitBreaker.wrapSync === 'function') {
      this.fetchPage = this.circuitBreaker.wrapSync(`${this.name}_fetchPage`, async (url) => {
        const res = await undici.request(url, {
          headers: this.defaultHeaders,
          headersTimeout: 10000,
          bodyTimeout: 10000
        });
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        return await res.body.text();
      });
    } else {
      this.fetchPage = {
        fire: async (url) => {
          const res = await undici.request(url, {
            headers: this.defaultHeaders,
            headersTimeout: 10000,
            bodyTimeout: 10000
          });
          if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
          return await res.body.text();
        }
      };
    }
  }

  /**
   * Bounded Map cache helper with LRU-style eviction
   */
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
   * Parses soccerfull HTML pages for replay match listings.
   */
  _parseMatchCards(html, pageIndex = 0) {
    const matches = [];
    const itemRegex = /<li class="item-movie">([\s\S]*?)<\/li>/gi;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(html)) !== null) {
      const block = itemMatch[1];

      // Extract relative match URL and title
      const linkMatch = block.match(/<a\s+href="([^"]+)"[^>]*title="([^"]*)"/i) ||
                         block.match(/<a\s+href="([^"]+)"/i);
      if (!linkMatch) continue;

      const rawUrl = linkMatch[1];
      if (!rawUrl.endsWith('.html')) continue;

      const matchUrl = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
      const slug = matchUrl.replace(/^\//, '').replace(/\.html$/, '');

      // Title
      let title = linkMatch[2] ? linkMatch[2].trim() : '';
      if (!title) {
        const titleTag = block.match(/<div class="title-movie"><h3>([^<]+)<\/h3><\/div>/i);
        if (titleTag) title = titleTag[1].trim();
      }
      if (!title) {
        title = slug.replace(/-\d+$/, '').replace(/-/g, ' ');
      }

      // Thumbnail
      let thumbnail = '';
      const imgMatch = block.match(/(?:src|data-original)="([^"]*\/imgs\/[^"]+)"/i);
      if (imgMatch) {
        thumbnail = imgMatch[1].startsWith('http') ? imgMatch[1] : `${this.baseUrl}${imgMatch[1]}`;
      }

      // League / Competition tag
      let league = '';
      const leagueMatch = block.match(/<span class="code[^"]*">([^<]+)<\/span>/i);
      if (leagueMatch) {
        league = leagueMatch[1].trim();
      }

      // Kickoff / Past event date parsing
      // Try to parse DD-MM-YYYY from URL/slug e.g. "crystal-palace-vs-nottingham-forest-08-02-2026.html"
      let dateMs = 0;
      const dateInSlug = slug.match(/(\d{2})-(\d{2})-(\d{4})/);
      if (dateInSlug) {
        const day = parseInt(dateInSlug[1], 10);
        const month = parseInt(dateInSlug[2], 10) - 1;
        const year = parseInt(dateInSlug[3], 10);
        const d = new Date(Date.UTC(year, month, day, 12, 0, 0));
        if (!isNaN(d.getTime())) {
          dateMs = d.getTime();
        }
      }

      // If no explicit date in slug, leave empty for unanchored upstream fixture merge
      const matchDate = dateMs ? String(dateMs) : '';

      // Extract numeric ID if present
      const idMatch = slug.match(/-(\d+)$/);
      const matchId = idMatch ? `sf_${idMatch[1]}` : `sf_${slug}`;

      matches.push(new MatchEntity({
        id: matchId,
        title,
        category: 'football', // SoccerFull is 100% football replays
        league,
        status: 'finished', // Authoritative replay flag
        date: matchDate,
        thumbnail_url: thumbnail,
        poster: '', // Normalized: leave empty so catalog always renders default cinematic card
        background: thumbnail,
        sources: [{
          source: this.sourceName,
          id: matchUrl,
          name: 'SoccerFull',
          url: `${this.baseUrl}${matchUrl}`
        }]
      }));
    }

    return matches;
  }

  /**
   * Fetch replays from SoccerFull (scrapes first 3 pages: /, /new/2, /new/3).
   */
  async getMatches() {
    const urls = [
      `${this.baseUrl}/`,
      `${this.baseUrl}/new/2`,
      `${this.baseUrl}/new/3`
    ];

    try {
      const pagePromises = urls.map(async (url, idx) => {
        try {
          const html = await this.fetchPage.fire(url);
          return this._parseMatchCards(html, idx);
        } catch (err) {
          console.warn(`[SoccerFull] Failed to fetch page ${url}:`, err.message);
          return [];
        }
      });

      const settled = await Promise.allSettled(pagePromises);
      const seenIds = new Set();
      const allMatches = [];

      for (const res of settled) {
        if (res.status === 'fulfilled' && Array.isArray(res.value)) {
          for (const match of res.value) {
            if (!seenIds.has(match.id)) {
              seenIds.add(match.id);
              allMatches.push(match);
            }
          }
        }
      }

      console.log(`[SoccerFull] Extracted ${allMatches.length} replay matches`);
      return allMatches;
    } catch (error) {
      console.error('[SoccerFull] Error fetching matches:', error.message);
      return [];
    }
  }

  /**
   * Resolves replay streams for a match.
   * Scrapes match page buttons, ignores live broadcasts, resolves Vixeo & Vidara direct HLS.
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src) {
    const targetPath = (src && src.url) || sourceId || '';
    if (!targetPath) return [];

    const fullUrl = targetPath.startsWith('http') ? targetPath : `${this.baseUrl}${targetPath.startsWith('/') ? '' : '/'}${targetPath}`;

    try {
      // Check cached stream list for this match URL
      const cachedStreams = this._getCache(this._matchPageCache, fullUrl);
      if (cachedStreams) {
        return cachedStreams;
      }

      const matchHtml = await this.fetchPage.fire(fullUrl);
      const servers = this._extractServerOptions(matchHtml);

      if (servers.length === 0) {
        return [];
      }

      // Resolve each server option concurrently
      const resolvePromises = servers.map(server => this._resolveServerStream(server, fullUrl));
      const results = await Promise.allSettled(resolvePromises);

      const streams = [];
      const seenUrls = new Set();

      for (const r of results) {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          for (const s of r.value) {
            if (s && s.url && !seenUrls.has(s.url)) {
              seenUrls.add(s.url);
              streams.push(s);
            }
          }
        }
      }

      // Prioritize reliable, zero-bandwidth CDN streams (OK.ru, Vixeo)
      streams.sort((a, b) => {
        const getScore = (s) => {
          if (s.title && s.title.includes('OK.ru')) return 100;
          if (s.title && s.title.includes('Vixeo')) return 80;
          return 10;
        };
        return getScore(b) - getScore(a);
      });

      if (streams.length > 0) {
        this._setCache(this._matchPageCache, fullUrl, streams, 30 * 60 * 1000);
      }

      return streams;
    } catch (err) {
      console.error(`[SoccerFull] Error resolving streams for ${fullUrl}:`, err.message);
      return [];
    }
  }

  /**
   * Extracts server options from match page HTML, strictly ignoring live matches.
   */
  _extractServerOptions(html) {
    const servers = [];
    const seenSids = new Set();

    // 1. Extract modern post-id or data-id from the main player container
    const postIdMatch = html.match(/id="video"[^>]*\s+post-id="(\d+)"/i) ||
                        html.match(/post-id="(\d+)"/i) ||
                        html.match(/data-id="(\d+)"/i);
    if (postIdMatch && !seenSids.has(postIdMatch[1])) {
      seenSids.add(postIdMatch[1]);
      servers.push({ sid: postIdMatch[1], label: 'Full Match' });
    }

    // 2. Parse video-server buttons: <a href="...?sid=16484" class="video-server ...">1st Half</a>
    const btnRegex = /<a\s+[^>]*href=["'][^"']*[?&]sid=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = btnRegex.exec(html)) !== null) {
      const sid = m[1];
      const label = m[2].replace(/<[^>]+>/g, '').trim();

      // STRICT USER REQUIREMENT: NO live matches!
      // Filter out any button that mentions "live"
      if (/\blive\b/i.test(label)) {
        continue;
      }

      if (!seenSids.has(sid)) {
        seenSids.add(sid);
        servers.push({ sid, label: label || 'Replay' });
      }
    }

    // 3. Also check if the default iframe has an SID not yet captured
    const defaultIframe = html.match(/<iframe[^>]+src=["']\/play\/(\d+)["']/i);
    if (defaultIframe && !seenSids.has(defaultIframe[1])) {
      seenSids.add(defaultIframe[1]);
      servers.unshift({ sid: defaultIframe[1], label: 'Highlights' });
    }

    return servers;
  }

  /**
   * Resolves a single server SID into StreamEntity objects.
   */
  async _resolveServerStream(server, refererUrl) {
    const { sid, label } = server;
    const playUrl = `${this.baseUrl}/play/${sid}`;

    const cached = this._getCache(this._streamCache, playUrl);
    if (cached) return cached;

    try {
      const res = await undici.request(playUrl, {
        headers: {
          ...this.defaultHeaders,
          Referer: refererUrl
        },
        headersTimeout: 6000,
        bodyTimeout: 6000
      });

      if (res.statusCode !== 200) return [];
      const html = await res.body.text();

      // Extract iframe src
      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (!iframeMatch) {
        // Shape A: ArtPlayer app with var m3u8Url = "/hls/<sid>.m3u8"
        const m3u8Match = html.match(/var\s+m3u8Url\s*=\s*["']([^"']+)["']/i);
        if (m3u8Match) {
          const rawM3u8 = m3u8Match[1].trim();
          if (rawM3u8.includes('.m3u8')) {
            const fullM3u8 = new URL(rawM3u8, this.baseUrl).toString();
            const cleanLabel = this._formatPartLabel(label);
            // The upstream playlist is served without CORS headers, so it is
            // published through the addon (playlist text only - every segment
            // stays a direct CDN URI, see routes/soccerFullManifest.js).
            const playlistUrl = `${BASE_URL}/api/soccerfull/manifest?url=${encodeURIComponent(fullM3u8)}`;
            const artStream = new StreamEntity({
              name: 'SoccerFull',
              title: `SoccerFull | ${cleanLabel} (Auto)`,
              resolution: 'Auto',
              url: playlistUrl,
              isTikTok: true,
              behaviorHints: {
                notWebReady: false
              }
            });
            this._setCache(this._streamCache, playUrl, [artStream], 30 * 60 * 1000);
            return [artStream];
          }
        }
        return [];
      }

      const iframeSrc = iframeMatch[1];

      // Disallow any live embed hosts (like embed.st)
      if (/embed\.st/i.test(iframeSrc) || /\blive\b/i.test(iframeSrc)) {
        return [];
      }

      const streams = [];

      // A. OK.ru embed (direct high-speed CDN, zero VPS bandwidth)
      if (/ok\.ru/i.test(iframeSrc)) {
        const okStreams = await this._resolveOkRu(iframeSrc, label);
        if (Array.isArray(okStreams) && okStreams.length > 0) {
          streams.push(...okStreams);
        }
      }
      // B. HGCloud host (hgcloud.to, audinifer.com, vibuxer.com, hanerix.com)
      else if (/hgcloud|audinifer|vibuxer|hanerix/i.test(iframeSrc)) {
        const hgStreams = await this.extractHgCloud(iframeSrc, label);
        if (Array.isArray(hgStreams) && hgStreams.length > 0) {
          streams.push(...hgStreams);
        }
      }
      // C. Vixeo host (vixeo.io)
      else if (iframeSrc.includes('vixeo.io')) {
        const streamUrl = await this.extractVixeo(iframeSrc);
        if (streamUrl) {
          const cleanLabel = this._formatPartLabel(label);
          streams.push(new StreamEntity({
            name: 'SoccerFull',
            title: `[VOD] ${cleanLabel} (1080p)`,
            resolution: '1080p',
            url: streamUrl,
            behaviorHints: {
              notWebReady: false
            }
          }));
        }
      }
      // C. Vidara host (vidaraa.cc / gbsagbo.com)
      else if (iframeSrc.includes('vidaraa.cc') || iframeSrc.includes('gbsagbo.com')) {
        const streamUrl = await this.extractVidara(iframeSrc);
        if (streamUrl) {
          const cleanLabel = this._formatPartLabel(label);
          streams.push(new StreamEntity({
            name: 'SoccerFull',
            title: `[VOD] ${cleanLabel} (1080p)`,
            resolution: '1080p',
            url: streamUrl,
            behaviorHints: {
              notWebReady: false
            }
          }));
        }
      }
      // D. Byse / SprintCDN host (bysefujedu.com, bysesukior.com, byse*, filemoon)
      else if (/byse|bysesukior|bysefujedu|filemoon/i.test(iframeSrc)) {
        const byseStreams = await this.extractByse(iframeSrc, label);
        if (Array.isArray(byseStreams) && byseStreams.length > 0) {
          streams.push(...byseStreams);
        }
      }

      if (streams.length > 0) {
        this._setCache(this._streamCache, playUrl, streams, 30 * 60 * 1000);
      }

      return streams;
    } catch (err) {
      return [];
    }
  }

  /**
   * Resolves direct high-speed okcdn.ru streams from OK.ru embeds.
   * Zero VPS bandwidth consumed, direct edge CDN playback.
   */
  async _resolveOkRu(url, partName = '') {
    try {
      const match = url.match(/videoembed\/(\d+)/) || url.match(/video\/(\d+)/);
      if (!match) return [];
      const videoId = match[1];

      const normUrl = `https://ok.ru/videoembed/${videoId}`;
      const res = await undici.request(normUrl, {
        headers: {
          ...this.defaultHeaders,
          Referer: 'https://ok.ru/'
        },
        headersTimeout: 6000,
        bodyTimeout: 6000
      });

      if (res.statusCode !== 200) return [];
      const html = await res.body.text();

      const optionsMatch = html.match(/data-options="([^"]+)"/i) ||
                           html.match(/data-options='([^']+)'/i) ||
                           html.match(/data-module="OKVideo"[^>]*data-options="([^"]+)"/i) ||
                           html.match(/data-module="OKVideo"[^>]*data-options='([^']+)'/i);
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
      const cleanPart = this._formatPartLabel(partName);
      const qualityMap = { 'full': '1080p', 'hd': '720p', 'sd': '480p', 'low': '360p', 'lowest': '240p', 'mobile': '144p' };
      const qualityWeight = { 'full': 1080, '1080p': 1080, 'hd': 720, '720p': 720, 'sd': 480, '480p': 480, 'low': 360, 'lowest': 240, 'mobile': 144 };

      const okProxyHeaders = {
        request: {
          'User-Agent': this.defaultHeaders['User-Agent'],
          Referer: 'https://ok.ru/'
        }
      };

      if (Array.isArray(metaObj.videos) && metaObj.videos.length > 0) {
        const validVideos = metaObj.videos.filter(v => v && v.url);
        validVideos.sort((a, b) => (qualityWeight[b.name] || 0) - (qualityWeight[a.name] || 0));
        const bestVideo = validVideos[0];
        if (bestVideo) {
          const label = qualityMap[bestVideo.name] || bestVideo.name || '1080p';
          const title = cleanPart ? `[VOD] ${cleanPart} (${label}) [OK.ru]` : `[VOD] Full Match (${label}) [OK.ru]`;
          streams.push(new StreamEntity({
            name: 'SoccerFull',
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

      if (metaObj.hlsManifestUrl) {
        streams.push(new StreamEntity({
          name: 'SoccerFull',
          title: cleanPart ? `[VOD] ${cleanPart} (Auto HLS) [OK.ru]` : '[VOD] Full Match (Auto HLS) [OK.ru]',
          resolution: 'Auto',
          url: metaObj.hlsManifestUrl,
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: okProxyHeaders
          }
        }));
      }

      return streams;
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
    // Reject any source where url includes sprintcdn (token is IP/ASN bound to minting server, fails with 404 / X-Token-Status: denied on client)
    const validSources = sources.filter(s => s && s.url && !s.url.includes('sprintcdn'));
    if (validSources.length === 0) return [];
    const best = validSources.find(s => s.label === '1080p') || validSources[0];
    if (!best || !best.url) return [];

    const cleanPart = this._formatPartLabel(partName);
    const title = cleanPart ? `SoccerFull | ${cleanPart} (1080p)` : `SoccerFull | Full Match (1080p)`;

    return [new StreamEntity({
      name: 'SoccerFull',
      title,
      resolution: best.label || '1080p',
      url: best.url,
      behaviorHints: {
        notWebReady: false,
        proxyHeaders: {
          request: {
            'Origin': `https://${host}`,
            'Referer': `https://${host}/`
          }
        }
      }
    })];
  }

  /**
   * Normalizes part labels: "1st Half in En" -> "1st Half (EN)", "Highlight" -> "Highlights"
   */
  _formatPartLabel(label) {
    if (!label) return 'Full Match';
    let clean = label.trim();
    clean = clean.replace(/\bin\s+en\b/gi, '(EN)');
    clean = clean.replace(/\bhighlight\b/gi, 'Highlights');
    clean = clean.replace(/\b2st\b/gi, '2nd');
    return clean;
  }

  /**
   * Extracts direct CDN HLS URL from Vixeo (vixeo.io/e/<id>)
   * Zero server proxying, native open CORS.
   */
  async extractVixeo(vixeoUrl) {
    try {
      const res = await undici.request(vixeoUrl, {
        headers: {
          ...this.defaultHeaders,
          Referer: `${this.baseUrl}/`
        },
        headersTimeout: 6000,
        bodyTimeout: 6000
      });
      if (res.statusCode !== 200) return null;

      const html = await res.body.text();
      const match = html.match(/data-config=["']([^"']+)["']/i);
      if (!match) return null;

      const jsonStr = Buffer.from(match[1], 'base64').toString('utf8');
      const config = JSON.parse(jsonStr);
      if (!config.source) return null;

      // Hex string deobfuscation
      const p = config.source.replaceAll('|', '');
      let ascii = '';
      for (let i = 0; i < p.length; i += 2) {
        ascii += String.fromCharCode(parseInt(p.slice(i, i + 2), 16));
      }
      const streamUrl = [...ascii].reverse().join('');
      return streamUrl.startsWith('http') ? streamUrl : null;
    } catch (err) {
      console.warn(`[SoccerFull] Vixeo extraction failed for ${vixeoUrl}:`, err.message);
      return null;
    }
  }

  /**
   * Extracts direct CDN HLS URL from Vidara (vidaraa.cc/v/<filecode> or gbsagbo.com/e/<filecode>)
   * Zero server proxying, native open CORS.
   */
  async extractVidara(vidaraUrl) {
    try {
      const u = new URL(vidaraUrl);
      const pathParts = u.pathname.split('/').filter(Boolean);
      const filecode = pathParts[pathParts.length - 1];
      if (!filecode) return null;

      const apiUrl = 'https://gbsagbo.com/api/stream';
      const res = await undici.request(apiUrl, {
        method: 'POST',
        headers: {
          ...this.defaultHeaders,
          Referer: `https://gbsagbo.com/e/${filecode}`,
          Origin: 'https://gbsagbo.com',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filecode, device: 'desktop', codecs: ['h264', 'aac'] }),
        headersTimeout: 6000,
        bodyTimeout: 6000
      });

      if (res.statusCode !== 200) return null;
      const json = await res.body.json();
      if (json && json.streaming_url) {
        return json.streaming_url;
      }
      return null;
    } catch (err) {
      console.warn(`[SoccerFull] Vidara extraction failed for ${vidaraUrl}:`, err.message);
      return null;
    }
  }

  /**
   * Extracts direct CDN HLS URL from HGCloud / StreamCloud mirror hosts
   * Host in {hgcloud.to, audinifer.com, vibuxer.com, hanerix.com}.
   * Extracts <code> from /e/<code>. Unpacks Dean Edwards packed script and extracts links.hls2.
   */
  async extractHgCloud(iframeSrc, label = '') {
    try {
      const codeMatch = iframeSrc.match(/\/e\/([a-zA-Z0-9_-]+)/);
      const code = codeMatch ? codeMatch[1] : '';
      if (!code) return [];

      const mirrorHosts = ['hgcloud.to', 'audinifer.com', 'vibuxer.com', 'hanerix.com'];
      try {
        const uHost = new URL(iframeSrc.startsWith('http') ? iframeSrc : `https://${iframeSrc}`).hostname;
        if (uHost && !mirrorHosts.includes(uHost)) {
          mirrorHosts.unshift(uHost);
        }
      } catch (_) {}

      for (const host of mirrorHosts) {
        try {
          const embedUrl = `https://${host}/e/${code}`;
          const res = await undici.request(embedUrl, {
            headers: {
              ...this.defaultHeaders,
              Referer: host === 'hgcloud.to' ? `${this.baseUrl}/` : 'https://hgcloud.to/'
            },
            headersTimeout: 6000,
            bodyTimeout: 6000
          });
          if (res.statusCode !== 200) continue;
          const html = await res.body.text();

          // If the body has no packed payload (it is the 819-byte JS shell on hgcloud.to), try each mirror host in turn
          if (!html.includes('function(p,a,c,k,e,d)')) {
            continue;
          }

          const packerBlock = html.match(/(?:eval\s*)?\(\s*function\(p,a,c,k,e,d\)[\s\S]*?\.split\(['"]\|['"]\)\s*\)\s*\)?/);
          if (!packerBlock) continue;

          const unpacked = unpack(packerBlock[0]);
          if (!unpacked) continue;

          const linksMatch = unpacked.match(/var\s+links\s*=\s*(\{[^;]+\});/);
          if (!linksMatch) continue;

          let links;
          try {
            links = JSON.parse(linksMatch[1]);
          } catch (_) {
            continue;
          }

          // Emit links.hls2 ONLY (ACAO '*', notWebReady: false)
          if (links && links.hls2 && typeof links.hls2 === 'string') {
            const cleanLabel = this._formatPartLabel(label);
            return [new StreamEntity({
              name: 'SoccerFull',
              title: `SoccerFull | ${cleanLabel} (Auto)`,
              resolution: 'Auto',
              url: links.hls2,
              behaviorHints: {
                notWebReady: false,
                proxyHeaders: {
                  request: {
                    'User-Agent': this.defaultHeaders['User-Agent'],
                    'Referer': `https://${host}/`,
                    'Origin': `https://${host}`
                  }
                }
              }
            })];
          }
        } catch (_) {
          continue;
        }
      }
      return [];
    } catch (_) {
      return [];
    }
  }
}

module.exports = SoccerFullProvider;
