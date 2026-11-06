const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const impitClient = require('../services/ProviderOutbound');
const leafMint = require('../services/LeafMint');
const { isRateLimit } = leafMint;
const { resolveLeafInstallConfig } = require('../services/LeafInstallConfig');
const { rateLimitDelay, recordAccountRateLimit, accountCooldownRemaining } = require('../services/LeafRateLimitState');
const { isInconclusiveResolutionError, inconclusiveErrorReason, markInconclusiveStreams, inconclusiveStreamsReason } = require('../services/StreamResolutionOutcome');
const { BASE_URL } = require('../config');

const STALE_GRACE_MS = 60 * 1000;
const LOCAL_RETRY_MS = 2000;

function isDefinitiveStreamFailure(error) {
  try {
    const seen = new Set();
    for (let current = error; current && typeof current === 'object'; current = current.cause) {
      if (seen.has(current) || seen.size >= 8) return false;
      seen.add(current);
      const capacity = current.code === 'ERR_OUTBOUND_CAPACITY' || /^ERR_NATIVE_(POOL|SLOT)_(BUSY|CAPACITY)$/.test(current.code || '');
      if (current.code === 'ERR_OUTBOUND_BLOCKED' || (current.isFatal === true && !capacity) ||
          [401, 403, 404, 410].includes(current.upstreamStatus) || [401, 403, 404, 410].includes(current.statusCode)) return true;
    }
  } catch (_) {}
  return false;
}

// Expiry claims only shorten metadata reuse. Existing player URLs keep their
// original lifetime, and untrusted claims never establish media validity.
function mediaExpiry(url) {
  let expiresAt = Infinity;
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams) {
      if (/^(?:exp|expires|expiry)$/i.test(key) && /^\d+(?:\.\d+)?$/.test(value)) {
        const expiry = Number(value);
        if (Number.isFinite(expiry) && expiry > 0) expiresAt = Math.min(expiresAt, expiry > 1e12 ? expiry : expiry * 1000);
      }
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value)) continue;
      try {
        const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
        if (typeof claims?.exp === 'number' && Number.isFinite(claims.exp) && claims.exp > 0) {
          expiresAt = Math.min(expiresAt, claims.exp * 1000);
        }
      } catch (_) {}
    }
  } catch (_) {}
  return expiresAt;
}

class LeafRecapProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'LeafRecap';
    this.sourceName = 'leaf_recap';
    this._installNagWarned = false;
    this._streamCache = new Map();
    this._inFlight = new Map();
    this._retryControls = new Map();
    this.lastCatalogOk = null;

    if (this.circuitBreaker) {
      this.fetchMatches = this.circuitBreaker.wrapSync(`${this.name}_fetchMatches`, async () => {
        return this._fetchRecapMatchesInternal();
      });

      this.fetchStreams = this.circuitBreaker.wrap(`${this.name}_fetchStreams`, async (targetId, apiBase) => {
        return this._resolveStreamsInternal(targetId, apiBase);
      }, {
        // Preserve definitive refusals through the breaker's null fallback so
        // the public resolver can discard stale credentials for this recap.
        errorFilter: error => isDefinitiveStreamFailure(error) || isInconclusiveResolutionError(error)
      });
    }
  }

  get configured() {
    return resolveLeafInstallConfig().configured;
  }

  get isConfigured() {
    return this.configured;
  }

  get apiUrl() {
    return LeafRecapProvider.buildApiUrl();
  }

  static buildApiUrl() {
    return resolveLeafInstallConfig().apiBase;
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
    try {
      if (!this.configured) return [];
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
    const targetId = String(src.id || sourceId || '').trim().replace(/^leaf_recap_/, '').replace(/^recap:/, '');
    if (!targetId) return [];
    let apiBase;
    let cooldown;
    try {
      const config = resolveLeafInstallConfig();
      if (!config.configured) return [];
      apiBase = config.apiBase;
      cooldown = accountCooldownRemaining(apiBase);
    } catch (_) {
      return [];
    }

    const key = JSON.stringify([apiBase, targetId]);
    const cached = this._streamCache.get(key);
    const now = Date.now();
    if (cached && now < cached.expiresAt) return cached.streams;
    const fallback = () => cached && Date.now() < cached.staleUntil ? cached.streams : null;
    if (cached && now >= cached.staleUntil) this._streamCache.delete(key);

    if (cooldown > 0) {
      return fallback() || markInconclusiveStreams([], 'unavailable');
    }

    const retry = this._retryControls.get(key);
    if (retry && now < retry.until) return fallback() || markInconclusiveStreams([], retry.reason);
    this._retryControls.delete(key);

    if (this._inFlight.has(key)) return await this._inFlight.get(key);
    if (this._inFlight.size >= 32) {
      return fallback() || markInconclusiveStreams([], 'capacity');
    }

    const pending = (async () => {
      try {
        let result;
        if (this.fetchStreams && typeof this.fetchStreams.fire === 'function') {
          result = await this.fetchStreams.fire(targetId, apiBase);
        } else {
          result = await this._resolveStreamsInternal(targetId, apiBase);
        }
        const reason = inconclusiveStreamsReason(result);
        if (reason) return fallback() || result;
        if (Array.isArray(result) && result.length > 0) {
          const fetchedAt = Date.now();
          const ttlMs = Math.min(60 * 60 * 1000, Math.max(30 * 1000, Number(process.env.LEAF_STREAM_CACHE_TTL_MS) || 180 * 1000));
          let mediaExpiresAt = Infinity;
          for (const stream of result) {
            try {
              mediaExpiresAt = Math.min(mediaExpiresAt, mediaExpiry(new URL(stream.url).searchParams.get('url') || stream.url));
            } catch (_) {}
          }
          const expiresAt = Math.min(fetchedAt + ttlMs, mediaExpiresAt);
          const staleUntil = Math.min(expiresAt + STALE_GRACE_MS, mediaExpiresAt);
          this._streamCache.set(key, Object.freeze({ streams: result, expiresAt, staleUntil }));
          if (this._streamCache.size > 200) this._streamCache.delete(this._streamCache.keys().next().value);
        }
        // A breaker fallback is not evidence of a permanently empty recap.
        return result || fallback() || markInconclusiveStreams([], 'unavailable');
      } catch (err) {
        console.warn(`[${this.name}] Failed to resolve streams: ${err.code || 'ERR_LEAF_RECAP_STREAMS'}`);
        if (isDefinitiveStreamFailure(err)) {
          this._streamCache.delete(key);
          this._retryControls.delete(key);
          return [];
        }
        const reason = inconclusiveErrorReason(err);
        if (reason) {
          this._retryControls.set(key, { until: Date.now() + LOCAL_RETRY_MS, reason });
          if (this._retryControls.size > 200) this._retryControls.delete(this._retryControls.keys().next().value);
          return fallback() || markInconclusiveStreams([], reason);
        }
        return fallback() || [];
      } finally {
        this._inFlight.delete(key);
      }
    })();

    this._inFlight.set(key, pending);
    return await pending;
  }

  async _resolveStreamsInternal(targetId, apiBase = this.apiUrl) {
    if (!targetId) return [];
    if (accountCooldownRemaining(apiBase) > 0) return markInconclusiveStreams([], 'unavailable');
    const cleanTargetId = String(targetId).trim().replace(/^leaf_recap_/, '');
    const fullTargetId = cleanTargetId.startsWith('recap:') ? cleanTargetId : `recap:${cleanTargetId}`;
    const url = `${apiBase}/stream/sport/${encodeURIComponent(fullTargetId)}.json`;
    const res = await impitClient.safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeoutMs: 8000,
      maxBodyBytes: 256 * 1024
    });

    if (res?.status === 429) {
      let streams = [];
      try {
        if (!res.bodyTruncated && typeof res.json === 'function') {
          const body = await res.json();
          if (Array.isArray(body?.streams)) streams = body.streams;
        }
      } catch (_) {}
      recordAccountRateLimit(apiBase, rateLimitDelay(res, streams));
      return markInconclusiveStreams([], 'unavailable');
    }
    if (!res || !res.ok) {
      throw Object.assign(new Error(`HTTP ${res ? res.status : 'No response'}`), { upstreamStatus: res?.status });
    }
    if (res.bodyTruncated) {
      throw Object.assign(new Error('Leaf recap stream metadata exceeds its body limit'), { code: 'ERR_LEAF_BODY_LIMIT' });
    }

    const data = await res.json();
    const streamsList = data && Array.isArray(data.streams) ? data.streams : [];

    if (LeafRecapProvider.isRateLimit(streamsList)) {
      recordAccountRateLimit(apiBase, rateLimitDelay(res, streamsList));
      console.warn(`[${this.name}] Upstream stream rate limit hit; backing off`);
      return markInconclusiveStreams([], 'unavailable');
    }

    if (LeafRecapProvider.isInstallNag(streamsList)) {
      return [];
    }

    const resolved = [];

    for (const st of streamsList) {
      if (!st || typeof st.url !== 'string' || !st.url) continue;

      const directUrl = st.url;
      if (mediaExpiry(directUrl) <= Date.now()) continue;
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
