const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const impitClient = require('../impitClient');
const { BASE_URL } = require('../config');
const staticChannels = require('../data/leafChannels.json');

// Upstream per-install config path:
//   https://sports.highfly.to/<base64url(config)>/{catalog,stream}/sport/...
const DEFAULT_ORIGIN = 'https://sports.highfly.to';
const LEARNED_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const RAW_REGEX = /\bRAW\b|[\u1D3F][\u1D2C][\u1D42]/i;

function toBase64Url(json) {
  return Buffer.from(JSON.stringify(json))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class LeafProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'Leaf';
    this.apiUrl = LeafProvider.buildApiUrl();
    this.configured = Boolean(
      process.env.LEAF_API_URL || process.env.LEAF_INSTALL_CONFIG || process.env.LEAF_FREE_USER_ID
    );
    this._installNagWarned = false;

    // Build static alias map and sorted keys for token matching
    this.staticAliasMap = new Map();
    for (const ch of staticChannels) {
      if (!ch || !ch.id) continue;
      for (const alias of ch.aliases || []) {
        const norm = LeafProvider.normalizeBroadcasterName(alias);
        if (norm && !this.staticAliasMap.has(norm)) {
          this.staticAliasMap.set(norm, ch.id);
        }
      }
    }
    this.sortedStaticKeys = [...this.staticAliasMap.keys()].sort((a, b) => b.length - a.length);

    // Dynamic caches
    this.catalogChannelMap = new Map(); // alias -> slug
    this.learnedChannelMap = new Map(); // alias -> { slug, timestamp }

    if (this.circuitBreaker) {
      this.fetchMatches = this.circuitBreaker.wrapSync(`${this.name}_fetchMatches`, async () => {
        return this._fetchLiveMatchesInternal();
      });

      this.fetchStreams = this.circuitBreaker.wrap(`${this.name}_fetchStreams`, async (targetId) => {
        return this._resolveStreamsInternal(targetId);
      });
    }
  }

  /**
   * Normalize raw broadcaster string into a canonical search token.
   * Strips lock emojis, Leaf branding, country/source prefixes (UK:, VIP:, RO:, etc.),
   * Unicode superscripts (RAW, HD, FHD), and quality tags.
   *
   * @param {string} rawStr
   * @returns {string}
   */
  static normalizeBroadcasterName(rawStr) {
    if (!rawStr || typeof rawStr !== 'string') return '';
    return rawStr
      .replace(/[\u{1F512}\u{1F513}]/gu, '') // lock emojis
      .replace(/^\s*Leaf\b\s*(?:\([^)]*\))?\s*[·:\-–]?\s*/i, '') // "Leaf (Strong) ·"
      .replace(/\bStrong\b/gi, '')
      .replace(/^\s*(?:TV|UK|VIP|RO|CH|CZ|US|NOW|4K|ES|FR|DE|IT|PL|PT)\s*[:|-]\s*/i, '')
      .replace(/\s*\([a-z0-9\s]*\)/gi, '') // parentheticals like (A), (FHD)
      .replace(/\s*\[[a-z0-9\s]*\]/gi, '')
      .replace(/[\u1D3F\u1D2C\u1D42]/g, '') // ᴿᴬᵂ
      .replace(/[\u1D34\u1D30]/g, '')       // ᴴᴰ
      .replace(/[\u028F\u029C\u1D05]/g, '') // ғʜᴅ
      .replace(/[\u1D05\u1D07]/g, '')      // ᴅᴇ
      .replace(/\b(?:raw|fhd|hd|4k|uhd)\b/gi, '')
      .replace(/[^a-z0-9+]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Clean channel display label for StreamEntity title.
   * Strips lock emojis, Leaf branding, parenthetical junk, but keeps country/channel name.
   *
   * @param {string} rawName
   * @returns {string}
   */
  static cleanDisplayLabel(rawName) {
    if (!rawName || typeof rawName !== 'string') return '';
    return rawName
      .replace(/[\u{1F512}\u{1F513}]/gu, '')
      .replace(/^\s*Leaf\b\s*(?:\([^)]*\))?\s*[·:\-–]?\s*/i, '')
      .replace(/\s*\([a-z0-9\s]*\)/gi, '')
      .replace(/\bStrong\b/gi, '')
      .replace(/^\s*[:\-–]\s*/, '')
      .replace(/\s*\.{2,}\s*$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * Build the upstream base for the per-install config path.
   *
   * @returns {string}
   */
  static buildApiUrl() {
    const override = process.env.LEAF_API_URL;
    if (override) return override.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');

    const origin = (process.env.LEAF_API_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
    const config = process.env.LEAF_INSTALL_CONFIG ||
      (process.env.LEAF_FREE_USER_ID ? toBase64Url({ freeUserId: process.env.LEAF_FREE_USER_ID }) : '');

    return config ? `${origin}/${config}` : origin;
  }

  /**
   * Upstream install nag detector.
   *
   * @param {Array} streamsList
   * @returns {boolean}
   */
  static isInstallNag(streamsList) {
    return (streamsList || []).some((st) => st && (
      /reinstall/i.test(st.name || '') ||
      /\/configure\b/.test(st.url || '')
    ));
  }

  _warnInstallNag() {
    if (this._installNagWarned) return;
    this._installNagWarned = true;
    console.warn(
      `[${this.name}] Upstream answered with the install-nag stub instead of streams. ` +
      'The free stream API is not served for this install config; leaf stays dormant until ' +
      'a fresh link is issued at sports.highfly.to/configure.'
    );
  }

  _warnUnconfigured() {
    if (this._installNagWarned) return;
    this._installNagWarned = true;
    console.warn(
      `[${this.name}] Skipped: no LEAF_INSTALL_CONFIG / LEAF_FREE_USER_ID set. ` +
      'Leaf needs the per-install config blob from sports.highfly.to/configure.'
    );
  }

  /**
   * Fetch live sporting matches across Highfly catalogues (sports_live, sports_today, sports_football).
   * Strictly filters OUT all 24/7 TV channels and deduplicates matches by clean event ID.
   *
   * @returns {Promise<Array<MatchEntity>>}
   */
  async getMatches() {
    if (!this.configured) {
      this._warnUnconfigured();
      return [];
    }

    try {
      if (this.fetchMatches && typeof this.fetchMatches.fire === 'function') {
        return await this.fetchMatches.fire();
      }
      return await this._fetchLiveMatchesInternal();
    } catch (err) {
      console.warn(`[${this.name}] Failed to fetch live matches: ${err.message}`);
      return [];
    }
  }

  async _fetchLiveMatchesInternal() {
    const catalogNames = ['sports_live', 'sports_today', 'sports_football'];
    const fetchPromises = catalogNames.map(async (cat) => {
      const url = `${this.apiUrl}/catalog/sport/${cat}.json`;
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

      return res.json();
    });

    const results = await Promise.allSettled(fetchPromises);
    const seenMatches = new Map();

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const metas = Array.isArray(r.value.metas) ? r.value.metas : [];

      for (const item of metas) {
        if (!item || !item.id || !item.name) continue;

        // Phase 3: Ingest 24/7 leaf:* channels into dynamic catalog channel map
        if (item.id.startsWith('leaf:')) {
          const slug = item.id.replace(/^leaf:/, '');
          const norm = LeafProvider.normalizeBroadcasterName(item.name);
          if (norm) {
            this.catalogChannelMap.set(norm, slug);
          }
          continue;
        }

        // Exclude networks and 24/7 channels
        if (item.category === 'networks' || item.isChannel) {
          continue;
        }

        const cleanId = item.id.replace(/^streamed:/, '');
        if (seenMatches.has(cleanId)) continue;

        const category = this.normalizeCategory(item.category || (Array.isArray(item.genres) ? item.genres[0] : 'other'));

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

        seenMatches.set(cleanId, new MatchEntity({
          id: `leaf_${cleanId}`,
          aliasIds: [item.id, cleanId],
          title: item.name,
          category,
          date: matchDate,
          status: 'live',
          sources: [{
            source: 'leaf',
            id: item.id,
            name: item.name
          }]
        }));
      }
    }

    // If all catalog queries failed and no matches were gathered, raise error for circuit breaker
    if (seenMatches.size === 0 && results.every((r) => r.status === 'rejected')) {
      const firstErr = results[0]?.reason;
      throw new Error(firstErr ? firstErr.message : 'All catalog queries failed');
    }

    return Array.from(seenMatches.values());
  }

  /**
   * Resolve live streams for a match.
   * Strictly isolates Leaf (papacito.cfd) streams and forwards the upstream
   * signed playback URL untouched.
   *
   * @param {string} sourceId
   * @param {string} matchCategory
   * @param {string} matchTitle
   * @param {Object} src
   * @returns {Promise<Array<StreamEntity>>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const targetId = src.id || sourceId;
    if (!targetId) return [];
    if (!this.configured) {
      this._warnUnconfigured();
      return [];
    }

    try {
      if (this.fetchStreams && typeof this.fetchStreams.fire === 'function') {
        return await this.fetchStreams.fire(targetId);
      }
      return await this._resolveStreamsInternal(targetId);
    } catch (err) {
      console.warn(`[${this.name}] Failed to resolve streams for ${targetId}: ${err.message}`);
      return [];
    }
  }

  /**
   * Find channel slug for a paywalled stream using the 3-tier architecture:
   * Tier 1: Static Master Dictionary (leafChannels.json)
   * Tier 2: Dynamic Catalog Ingest (sports_live leaf:* entries)
   * Tier 3: Opportunistic Learning Cache
   *
   * Uses deterministic word-boundary token matching.
   *
   * @param {string} rawName
   * @returns {string|null}
   */
  _findChannelSlug(rawName) {
    const norm = LeafProvider.normalizeBroadcasterName(rawName);
    if (!norm) return null;

    // 1. Direct O(1) Hash Map lookups
    if (this.staticAliasMap.has(norm)) {
      return this.staticAliasMap.get(norm);
    }
    if (this.catalogChannelMap.has(norm)) {
      return this.catalogChannelMap.get(norm);
    }
    const learned = this.learnedChannelMap.get(norm);
    if (learned && Date.now() - learned.timestamp < LEARNED_CACHE_TTL_MS) {
      return learned.slug;
    }

    // 2. Deterministic word-boundary token matching (longest key first)
    for (const key of this.sortedStaticKeys) {
      const boundaryRegex = new RegExp(`(?:^|\\s)${escapeRegex(key)}(?:\\s|$)`);
      if (boundaryRegex.test(norm)) {
        return this.staticAliasMap.get(key);
      }
    }

    // Check dynamic catalog keys with word boundary
    for (const [key, slug] of this.catalogChannelMap.entries()) {
      const boundaryRegex = new RegExp(`(?:^|\\s)${escapeRegex(key)}(?:\\s|$)`);
      if (boundaryRegex.test(norm)) {
        return slug;
      }
    }

    // Fallback to compatibility map if provided statically
    for (const [k, slug] of Object.entries(LeafProvider.CHANNEL_SLUG_MAP)) {
      const boundaryRegex = new RegExp(`(?:^|\\s)${escapeRegex(k)}(?:\\s|$)`);
      if (boundaryRegex.test(norm)) return slug;
    }

    return null;
  }

  async _resolveStreamsInternal(targetId) {
    const url = `${this.apiUrl}/stream/sport/${encodeURIComponent(targetId)}.json`;
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
    const streamsList = data && Array.isArray(data.streams) ? data.streams : [];

    if (LeafProvider.isInstallNag(streamsList)) {
      this._warnInstallNag();
      return [];
    }

    const resolved = [];

    for (const st of streamsList) {
      if (!st || !st.url) continue;

      let directUrl = st.url;

      // When upstream returns a paywalled redirect (e.g. google.com), attempt direct channel resolution
      if (!directUrl.includes('papacito.cfd') || directUrl.includes('google.com')) {
        const slug = this._findChannelSlug(st.name || st.title || '');
        if (slug) {
          try {
            const chanUrl = `${this.apiUrl}/stream/sport/leaf:${encodeURIComponent(slug)}.json`;
            const chanRes = await impitClient.safeFetch(chanUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
                'Accept': 'application/json'
              },
              timeoutMs: 4000
            });
            if (chanRes && chanRes.ok) {
              const chanData = await chanRes.json();
              const firstValid = (chanData.streams || []).find((s) => s && s.url && s.url.includes('papacito.cfd') && s.url.includes('?'));
              if (firstValid) {
                directUrl = firstValid.url;
              }
            }
          } catch (_) {}
        }
      }

      // STRICT ISOLATION: Discard any stream that is not papacito.cfd (no streamed.pk, no paywalled redirects)
      if (!directUrl.includes('papacito.cfd')) continue;

      // Forward upstream signed playback URL only
      if (!directUrl.includes('?')) continue;

      // Phase 4: Opportunistic Learning from unredacted Papacito stream URLs
      const papMatch = directUrl.match(/papacito\.cfd\/m3u\/([a-zA-Z0-9_-]+)\/live\.m3u8\?ft=/);
      if (papMatch) {
        const discoveredSlug = papMatch[1];
        const norm = LeafProvider.normalizeBroadcasterName(st.name || st.title || '');
        if (norm && norm.length >= 4 && !/^(stream|live|match|video|link)\b/i.test(norm)) {
          if (!this.staticAliasMap.has(norm) && !this.catalogChannelMap.has(norm)) {
            const existing = this.learnedChannelMap.get(norm);
            if (!existing || existing.slug === discoveredSlug) {
              this.learnedChannelMap.set(norm, { slug: discoveredSlug, timestamp: Date.now() });
            }
          }
        }
      }

      const referer = 'https://sports.highfly.to/';
      const origin = 'https://sports.highfly.to';
      const manifestProxyUrl = `${BASE_URL}/api/leaf/manifest.m3u8?url=${encodeURIComponent(directUrl)}`;

      const rawName = st.name || '';
      const rawTitle = st.title || '';

      // Determine resolution & quality (supporting superscripts 4K, FHD, HD)
      let resolution = '1080p';
      let quality = 'FHD';
      if (/3840x2160|4k|uhd/i.test(rawTitle) || /\b4k\b/i.test(rawName)) {
        resolution = '4K';
        quality = '4K UHD';
      } else if (/1280x720|720p|hd|[\u1D34][\u1D30]/i.test(rawTitle) || /\b(720p|hd)\b|[\u1D34][\u1D30]/i.test(rawName)) {
        resolution = '720p';
        quality = 'HD';
      }

      // Bitrate as display label ("6.2 Mbps")
      let bitrate = null;
      const bitrateMatch = rawTitle.match(/~?([\d.]+)\s*Mbps/i);
      if (bitrateMatch) {
        const bps = Math.round(parseFloat(bitrateMatch[1]) * 1000000);
        bitrate = bps >= 1000000
          ? `${(bps / 1000000).toFixed(1)} Mbps`
          : `${Math.round(bps / 1000)} kbps`;
      }

      // Channel label cleanup
      const channelLabel = LeafProvider.cleanDisplayLabel(rawName);

      // Unicode superscript RAW support (ᴿᴬᵂ)
      const isRaw = RAW_REGEX.test(rawName) || RAW_REGEX.test(rawTitle);
      const qualityTag = isRaw ? `${quality} RAW` : quality;

      resolved.push(new StreamEntity({
        name: `Leaf [${qualityTag}]`,
        title: channelLabel ? `(${channelLabel}) ${qualityTag}` : `Leaf Stream · ${qualityTag}`,
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
        _source: 'leaf'
      }));
    }

    return resolved;
  }
}

// Backward compatibility export with all verified channels
LeafProvider.CHANNEL_SLUG_MAP = {};
for (const ch of staticChannels) {
  for (const alias of ch.aliases || []) {
    LeafProvider.CHANNEL_SLUG_MAP[alias.toLowerCase().trim()] = ch.id;
  }
}

module.exports = LeafProvider;
