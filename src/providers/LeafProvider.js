const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const impitClient = require('../services/ProviderOutbound');
const { BASE_URL } = require('../config');

// Upstream replaced the old shared-token API with a per-install config path:
//   https://sports.highfly.to/<base64url(config)>/{catalog,stream}/sport/...
// The config blob is what the official configure page issues
// (sports.highfly.to/configure -> Turnstile -> install link) and decodes to
// {"freeUserId":"<uuid>.<hash>"}. That blob is the account selector, so it is
// read from LEAF_INSTALL_CONFIG - never hardcoded. A shared literal is exactly
// what upstream revokes, and it is a per-install identity, not a build input.
//
// The old shared master token is deliberately gone: papacito.cfd answers 403
// "Authentication required" to it and the stream route replies with the
// "please reinstall" stub, so a locally minted signed URL could only ever
// produce a broken stream.
const DEFAULT_ORIGIN = 'https://sports.highfly.to';

function toBase64Url(json) {
  return Buffer.from(JSON.stringify(json))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
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
   * Build the upstream base for the per-install config path.
   *
   * LEAF_API_URL stays a whole-base override on purpose: production parks the
   * source on a dead local port (http://127.0.0.1:9/leaf-disabled) to disable
   * leaf without shipping code, and that kill switch must keep working
   * verbatim - every request fails fast and the provider returns [].
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
   * Upstream retires the free stream API by answering every stream id with a
   * single fake entry that points at /configure ("Please reinstall the addon /
   * we have updated our free addon"). That payload used to reach the player and
   * is what renders as the "this stream is stolen, install the official addon"
   * notice, so it is dropped here: an empty list is the honest answer, never a
   * stream tile that is really an advert.
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
   * Fetch live sporting matches from Highfly live catalog.
   * Strictly filters OUT all 24/7 TV channels.
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
    const url = `${this.apiUrl}/catalog/sport/sports_live.json`;
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
    const metas = data && Array.isArray(data.metas) ? data.metas : [];
    const matches = [];

    for (const item of metas) {
      if (!item || !item.id || !item.name) continue;

      // Strictly exclude 24/7 channels (IDs starting with leaf: or networks category)
      if (item.id.startsWith('leaf:') || item.category === 'networks' || item.isChannel) {
        continue;
      }

      const cleanId = item.id.replace(/^streamed:/, '');
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

      matches.push(new MatchEntity({
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

    return matches;
  }

  /**
   * Resolve live streams for a match.
   * Strictly isolates Leaf (papacito.cfd) streams and forwards the upstream
   * signed playback URL untouched, because the signature is the only
   * authorisation the CDN accepts and it cannot be minted locally.
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

      // STRICT ISOLATION: Discard any stream that is not papacito.cfd (no streamed.pk, no paywalled redirects)
      if (!st.url.includes('papacito.cfd')) continue;

      // Forward the upstream signed playback URL only. A papacito URL without a
      // query string carries no signature, and the signature cannot be minted
      // locally, so it would answer 403 "Authentication required" at the CDN.
      if (!st.url.includes('?')) continue;
      const directUrl = st.url;
      const referer = 'https://sports.highfly.to/';
      const origin = 'https://sports.highfly.to';
      const manifestProxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(directUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;

      const rawName = st.name || '';
      const rawTitle = st.title || '';

      // Determine resolution & quality
      let resolution = '1080p';
      let quality = 'FHD';
      if (/3840x2160|4k/i.test(rawTitle) || /4k/i.test(rawName)) {
        resolution = '4K';
        quality = '4K UHD';
      } else if (/1280x720|720p/i.test(rawTitle) || /720p/i.test(rawName)) {
        resolution = '720p';
        quality = 'HD';
      }

      // Bitrate as display label ("6.2 Mbps") matching the addon-wide
      // convention in streams.js — raw bps renders as "6200000" in the UI.
      let bitrate = null;
      const bitrateMatch = rawTitle.match(/~?([\d.]+)\s*Mbps/i);
      if (bitrateMatch) {
        const bps = Math.round(parseFloat(bitrateMatch[1]) * 1000000);
        bitrate = bps >= 1000000
          ? `${(bps / 1000000).toFixed(1)} Mbps`
          : `${Math.round(bps / 1000)} kbps`;
      }

      // Channel label cleanup: strip the upstream "🔒 Leaf (Strong) ·" branding
      // entirely (no lock emoji, no "Strong") plus parenthetical junk like
      // "(A)..." so streams.js' first-parens extraction picks the broadcaster.
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
        name: `Leaf [${quality}]`,
        title: channelLabel ? `(${channelLabel}) ${quality}` : `Leaf Stream · ${quality}`,
        url: manifestProxyUrl,
        resolution,
        quality,
        bitrate,
        behaviorHints: {
          notWebReady: false
        },
        _source: 'leaf'
      }));
    }

    return resolved;
  }
}

module.exports = LeafProvider;
