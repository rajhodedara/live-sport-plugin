const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const impitClient = require('../impitClient');
const ChannelIdentityService = require('../services/ChannelIdentityService');
const { getChannelLogo } = require('../services/ChannelLogoService');

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
   * Fetch live sporting matches and 24/7 sports channels from Highfly catalog.
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
      if (!item || !item.id || !item.name) continue;

      const isChannel = item.id.startsWith('leaf:') || item.category === 'networks' || item.isChannel;

      if (isChannel) {
        const ident = ChannelIdentityService.parseChannel(item.name);
        const canonicalTitle = ident.canonicalTitle || item.name;
        const identityKey = ident.identityKey;
        const channelNumber = ident.channelNumber;
        const slug = canonicalTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const logoUrl = getChannelLogo(canonicalTitle) || getChannelLogo(item.name);

        const entity = new MatchEntity({
          id: `leaf_ch_${item.id.replace(/^leaf:/, '')}_${slug}`,
          title: canonicalTitle,
          baseTitle: canonicalTitle,
          category: 'networks',
          date: '0',
          popular: '1',
          league: ident.country || 'Live TV',
          logo: logoUrl || item.poster || undefined,
          thumbnail_url: logoUrl || item.poster || undefined,
          sources: [{
            source: 'leaf',
            id: item.id,
            channelName: item.name,
            canonicalChannel: canonicalTitle,
            country: ident.country || '',
            countryCode: ident.countryCode || '',
            countryFlag: ident.countryFlag || '',
            language: ident.language || '',
            resolution: ident.resolution || '',
            isBackup: ident.isBackup || false,
            isTimeshift: ident.isTimeshift || false,
            type: 'channel'
          }]
        });
        entity.channelIdentityKey = identityKey;
        entity.channelNumber = channelNumber;
        matches.push(entity);
      } else {
        const cleanId = item.id.replace(/^streamed:/, '');
        const category = this.normalizeCategory(item.category || (Array.isArray(item.genres) ? item.genres[0] : 'other'));

        matches.push(new MatchEntity({
          id: `leaf_${cleanId}`,
          aliasIds: [item.id, cleanId],
          title: item.name,
          category,
          status: 'live',
          sources: [{
            source: 'leaf',
            id: item.id,
            name: item.name
          }]
        }));
      }
    }

    return matches;
  }

  /**
   * Resolve live streams for a match.
   * Strictly isolates Leaf (papacito.cfd) streams, preserves upstream dynamically signed JWT tokens,
   * and falls back to master token for bare URLs.
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
      if (!st || !st.url) continue;

      // STRICT ISOLATION: Discard any stream that is not papacito.cfd (no streamed.pk, no paywalled redirects)
      if (!st.url.includes('papacito.cfd')) continue;

      // Extract slug from /m3u/<slug>/live.m3u8
      const slugMatch = st.url.match(/\/m3u\/([^/?#]+)\/live\.m3u8/);
      if (!slugMatch || !slugMatch[1]) continue;
      const slug = slugMatch[1];

      // Preserve dynamic signed JWT (?ft=...) which returns HTTP 200 OK.
      // Fall back to master token only if upstream provides an unsigned bare URL.
      let directUrl = st.url;
      if (!directUrl.includes('ft=') && !directUrl.includes('token=')) {
        directUrl = `https://papacito.cfd/m3u/${slug}/live.m3u8?token=${this.masterToken}`;
      }

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
        url: directUrl,
        resolution,
        quality,
        bitrate,
        behaviorHints: {
          notWebReady: true
        },
        _source: 'leaf'
      }));
    }

    return resolved;
  }
}

module.exports = LeafProvider;
