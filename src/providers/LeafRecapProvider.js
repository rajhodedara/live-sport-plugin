const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const impitClient = require('../services/ProviderOutbound');
const leafMint = require('../services/LeafMint');
const { normalizeConfigBlob, extractOrigin, isRateLimit } = leafMint;
const { BASE_URL } = require('../config');

const DEFAULT_ORIGIN = 'https://sports.highfly.to';

class LeafRecapProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'LeafRecap';
    this.sourceName = 'leaf_recap';
    this._installNagWarned = false;
    this._streamCache = new Map();
    this._inFlight = new Map();
    this.lastCatalogOk = null;

    if (this.circuitBreaker) {
      this.fetchMatches = this.circuitBreaker.wrapSync(`${this.name}_fetchMatches`, async () => {
        return this._fetchRecapMatchesInternal();
      });

      this.fetchStreams = this.circuitBreaker.wrap(`${this.name}_fetchStreams`, async (targetId) => {
        return this._resolveStreamsInternal(targetId);
      });
    }
  }

  get configured() {
    return Boolean(
      process.env.LEAF_API_URL || process.env.LEAF_INSTALL_CONFIG || process.env.LEAF_FREE_USER_ID
    );
  }

  get isConfigured() {
    return this.configured;
  }

  get apiUrl() {
    return LeafRecapProvider.buildApiUrl();
  }

  static buildApiUrl() {
    const override = process.env.LEAF_API_URL;
    if (override) return override.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');

    const rawConfig = process.env.LEAF_INSTALL_CONFIG || process.env.LEAF_FREE_USER_ID || '';
    const detectedOrigin = extractOrigin(rawConfig);
    const origin = (process.env.LEAF_API_ORIGIN || detectedOrigin || DEFAULT_ORIGIN).replace(/\/+$/, '');

    const config = normalizeConfigBlob(rawConfig);

    return config ? `${origin}/${config}` : origin;
  }

  static isRateLimit(streamsList) {
    return isRateLimit(streamsList);
  }

  static isInstallNag(streamsList) {
    return (streamsList || []).some((st) => st && (
      (/reinstall/i.test(st.name || '') || /\/configure\b/.test(st.url || '')) &&
      !/rate limit/i.test(st.name || '') &&
      !/rate limit/i.test(st.title || '')
    ));
  }

  normalizeGenre(genre) {
    if (!genre) return 'other';
    const raw = String(genre).trim().toLowerCase();
    if (raw === 'motor-sports' || raw === 'motorsport' || raw === 'motor sports') return 'motorsport';
    if (raw === 'american-football' || raw === 'american football' || raw === 'nfl') return 'american_football';
    if (raw === 'football' || raw === 'soccer') return 'football';
    if (raw === 'basketball' || raw === 'nba') return 'basketball';
    if (raw === 'baseball' || raw === 'mlb') return 'baseball';
    if (raw === 'hockey' || raw === 'nhl') return 'hockey';
    if (raw === 'rugby') return 'rugby';
    if (raw === 'tennis') return 'tennis';
    return this.normalizeCategory(genre);
  }

  async getMatches() {
    if (!this.configured) {
      return [];
    }

    try {
      if (this.fetchMatches && typeof this.fetchMatches.fire === 'function') {
        return await this.fetchMatches.fire();
      }
      return await this._fetchRecapMatchesInternal();
    } catch (err) {
      this.lastCatalogOk = false;
      console.warn(`[${this.name}] Failed to fetch recap matches: ${err.code || 'ERR_LEAF_RECAP_CATALOG'}`);
      return [];
    }
  }

  async _fetchRecapMatchesInternal() {
    const url = `${this.apiUrl}/catalog/sport/sports_recaps.json`;
    const res = await impitClient.safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeoutMs: 8000
    });

    if (!res || !res.ok) {
      throw new Error(`HTTP ${res ? res.status : 'No response'}`);
    }

    const data = await res.json();
    this.lastCatalogOk = true;
    const metas = data && Array.isArray(data.metas) ? data.metas : [];
    const matches = [];

    for (const item of metas) {
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name) continue;

      const recapId = item.id;
      const cleanId = item.id.replace(/^recap:/, '');
      const rawGenre = (Array.isArray(item.genres) && item.genres[0]) || item.category || 'other';
      const category = this.normalizeGenre(rawGenre);

      let matchDate = '0';
      if (item.releaseInfo && typeof item.releaseInfo === 'string' && item.releaseInfo !== 'LIVE') {
        const cleaned = item.releaseInfo.replace('·', '').replace(/\s+/g, ' ').trim();
        const d = new Date(cleaned);
        if (!isNaN(d.getTime())) matchDate = String(d.getTime());
      } else {
        const tsMatch = String(item.id).match(/[-_](1\d{9}|1\d{12})$/);
        if (tsMatch) {
          const tsVal = Number(tsMatch[1]);
          const epochMs = tsMatch[1].length === 10 ? tsVal * 1000 : tsVal;
          if (epochMs > 0 && Number.isFinite(epochMs)) matchDate = String(epochMs);
        }
      }

      if (matchDate === '0') {
        matchDate = String(Date.now() - 3600 * 1000);
      }

      const aliasIds = cleanId && cleanId !== item.id ? [item.id, cleanId] : [item.id];
      matches.push(new MatchEntity({
        id: `leaf_recap_${cleanId}`,
        aliasIds,
        title: item.name,
        category,
        date: matchDate,
        status: 'finished',
        thumbnail_url: item.poster || '',
        poster: item.poster || '',
        sources: [{
          source: 'leaf_recap',
          id: recapId,
          name: 'Highfly Recap'
        }]
      }));
    }

    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const targetId = src.id || sourceId;
    if (!targetId) return [];
    if (!this.configured) {
      return [];
    }

    const cached = this._streamCache.get(targetId);
    const ttlMs = Math.min(60 * 60 * 1000, Math.max(30 * 1000, Number(process.env.LEAF_STREAM_CACHE_TTL_MS) || 180 * 1000));
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.streams;
    }

    if (this._inFlight.has(targetId)) {
      return await this._inFlight.get(targetId);
    }

    const pending = (async () => {
      try {
        if (this.fetchStreams && typeof this.fetchStreams.fire === 'function') {
          return await this.fetchStreams.fire(targetId);
        }
        return await this._resolveStreamsInternal(targetId);
      } catch (err) {
        console.warn(`[${this.name}] Failed to resolve streams: ${err.code || 'ERR_LEAF_RECAP_STREAMS'}`);
        if (cached && cached.streams && cached.streams.length > 0) {
          return cached.streams;
        }
        return [];
      } finally {
        this._inFlight.delete(targetId);
      }
    })();

    this._inFlight.set(targetId, pending);
    const result = await pending;
    if (result && result.length > 0) {
      this._streamCache.set(targetId, { streams: result, at: Date.now() });
      if (this._streamCache.size > 200) {
        this._streamCache.delete(this._streamCache.keys().next().value);
      }
    }
    return result;
  }

  async _resolveStreamsInternal(targetId) {
    if (!targetId) return [];
    const cleanTargetId = String(targetId).trim().replace(/^leaf_recap_/, '');
    const fullTargetId = cleanTargetId.startsWith('recap:') ? cleanTargetId : `recap:${cleanTargetId}`;
    const url = `${this.apiUrl}/stream/sport/${encodeURIComponent(fullTargetId)}.json`;
    const res = await impitClient.safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeoutMs: 8000,
      maxBodyBytes: 256 * 1024
    });

    if (!res || !res.ok) {
      throw new Error(`HTTP ${res ? res.status : 'No response'}`);
    }
    if (res.bodyTruncated) {
      throw Object.assign(new Error('Leaf recap stream metadata exceeds its body limit'), { code: 'ERR_LEAF_BODY_LIMIT' });
    }

    const data = await res.json();
    const streamsList = data && Array.isArray(data.streams) ? data.streams : [];

    if (LeafRecapProvider.isRateLimit(streamsList)) {
      console.warn(`[${this.name}] Upstream stream rate limit hit for ${targetId}; backing off`);
      const cached = this._streamCache.get(targetId);
      if (cached && cached.streams && cached.streams.length > 0) {
        return cached.streams;
      }
      return [];
    }

    if (LeafRecapProvider.isInstallNag(streamsList)) {
      return [];
    }

    const resolved = [];

    for (const st of streamsList) {
      if (!st || typeof st.url !== 'string' || !st.url) continue;

      const directUrl = st.url;
      const referer = 'https://sports.highfly.to/';
      const origin = 'https://sports.highfly.to';

      const manifestProxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(directUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;

      const rawName = typeof st.name === 'string' ? st.name : '';
      const rawTitle = typeof st.title === 'string' ? st.title : '';

      let resolution = '1080p';
      let quality = 'FHD';
      if (/3840x2160|4k/i.test(rawTitle) || /4k/i.test(rawName)) {
        resolution = '4K';
        quality = '4K UHD';
      } else if (/1280x720|720p/i.test(rawTitle) || /720p/i.test(rawName)) {
        resolution = '720p';
        quality = 'HD';
      }

      let bitrate = null;
      const bitrateMatch = rawTitle.match(/~?([\d.]+)\s*Mbps/i);
      if (bitrateMatch) {
        const bps = Math.round(parseFloat(bitrateMatch[1]) * 1000000);
        bitrate = bps >= 1000000
          ? `${(bps / 1000000).toFixed(1)} Mbps`
          : `${Math.round(bps / 1000)} kbps`;
      }

      let channelLabel = rawName
        .replace(/🔒/g, '')
        .replace(/^\s*Leaf\b\s*(?:\([^)]*\))?\s*[·:\-–]?\s*/i, '')
        .replace(/\s*\([^)]*\)/g, '')
        .replace(/\bStrong\b/gi, '')
        .replace(/^\s*[:\-–]\s*/, '')
        .replace(/\s*\.{2,}\s*$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      resolved.push(new StreamEntity({
        name: `Highfly Recap [${quality}]`,
        title: channelLabel ? `(${channelLabel}) ${quality} Recap` : `Highfly Recap · ${quality}`,
        url: manifestProxyUrl,
        resolution,
        quality,
        bitrate,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              'Referer': referer,
              'Origin': origin,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
            }
          }
        },
        _source: 'leaf_recap'
      }));
    }

    return resolved;
  }
}

module.exports = LeafRecapProvider;
