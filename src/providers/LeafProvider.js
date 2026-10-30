const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const impitClient = require('../services/ProviderOutbound');

class LeafProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'Leaf';
    this.apiUrl = process.env.LEAF_API_URL || 'https://sports.highfly.to';
    this.masterToken = process.env.LEAF_MASTER_TOKEN || 'E4V7FE6H6nBzANT35Q2rR7JmTz1a5nCi';

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
   * Fetch live sporting matches from Highfly live catalog.
   * Strictly filters OUT all 24/7 TV channels.
   *
   * @returns {Promise<Array<MatchEntity>>}
   */
  async getMatches() {
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
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name) continue;

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
   * Strictly isolates Leaf (papacito.cfd) streams and replaces temporary tokens
   * with the master bearer token for direct, 4K/FHD unthrottled playback.
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
    const resolved = [];

    for (const st of streamsList) {
      if (!st || typeof st.url !== 'string' || !st.url) continue;

      // Match the actual host rather than a domain-looking substring in a
      // path, query, credentials, or an unrelated hostname.
      let sourceUrl;
      try { sourceUrl = new URL(st.url); } catch (_) { continue; }
      const host = sourceUrl.hostname.toLowerCase();
      if (!['http:', 'https:'].includes(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password ||
          (host !== 'papacito.cfd' && !host.endsWith('.papacito.cfd'))) continue;

      // Preserve upstream signed playback URL (which includes the valid ?ft= JWT).
      // Fallback to minted master token only if upstream URL has no query parameters.
      let directUrl = st.url;
      if (!st.url.includes('?')) {
        const slugMatch = st.url.match(/\/m3u\/([^/?#]+)\/live\.m3u8/);
        if (!slugMatch || !slugMatch[1]) continue;
        const slug = slugMatch[1];
        directUrl = `https://papacito.cfd/m3u/${slug}/live.m3u8?token=${this.masterToken}`;
      }

      const rawName = typeof st.name === 'string' ? st.name : '';
      const rawTitle = typeof st.title === 'string' ? st.title : '';

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
        url: directUrl,
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
