'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { decodeV3 } = require('../resolver/sportzx/SportzXCrypto');

const GATEWAYS = [
  'https://in.dotmatrixstream.us/',
  'https://android.onlystream.stream/',
  'https://cdn-stream.top/'
];

const DALVIK_UA = 'Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7 Pro Build/TQ3A.230901.001)';

class SportzXProvider extends BaseProvider {
  constructor({ circuitBreaker } = {}) {
    super({ circuitBreaker });
    this.name = 'SportzX';
  }

  /**
   * Internal decryptor helper
   */
  _decryptPayload(base64Data) {
    return decodeV3(base64Data);
  }

  /**
   * Ingest live matches from SportzX backend
   * @returns {Promise<Array<MatchEntity>>}
   */
  async getMatches() {
    for (const gw of GATEWAYS) {
      try {
        const url = `${gw}events.json`;
        const resp = await this.proxyFetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
          },
          timeoutMs: 10000
        });

        if (!resp || !resp.ok) continue;

        const json = await resp.json();
        if (!json || !json.data) continue;

        const rawEvents = this._decryptPayload(json.data);
        if (!Array.isArray(rawEvents)) continue;

        const matches = [];

        for (const item of rawEvents) {
          if (!item) continue;

          const startTime = item.startTime ? (Number(item.startTime) * (item.startTime > 1e11 ? 1 : 1000)) : Date.now();
          const rawTitle = item.eventName || item.title || (item.teamA && item.teamB ? `${item.teamA} vs ${item.teamB}` : 'Live Event');
          const category = this.normalizeCategory(item.eventType || item.category || 'other');
          const eventId = String(item.id || item.eventId || Math.random().toString(36).slice(2));

          // Extract channels & stream formats
          const sources = [];
          const channels = Array.isArray(item.channels) ? item.channels : [];

          for (let cIdx = 0; cIdx < channels.length; cIdx++) {
            const ch = channels[cIdx];
            if (!ch) continue;

            const formats = Array.isArray(ch.formatsNew) ? ch.formatsNew : (Array.isArray(ch.formats) ? ch.formats : []);
            if (formats.length === 0) continue;

            sources.push({
              id: `${eventId}_${cIdx}`,
              source: 'sportzx',
              channelName: ch.cat || ch.name || 'SportzX Live',
              formats
            });
          }

          matches.push(new MatchEntity({
            id: `sportzx_${eventId}`,
            title: rawTitle,
            category,
            timestamp: startTime,
            status: item.status || 'LIVE',
            popular: item.isPopular || item.popular || false,
            team1: item.teamA || null,
            team2: item.teamB || null,
            thumbnail_url: item.thumbnail || item.banner || '',
            poster: item.poster || '',
            sources
          }));
        }

        return matches;
      } catch (err) {
        // Continue to failover gateway
      }
    }

    return [];
  }

  /**
   * Resolve a specific stream source with strict DASH dropping and zero server egress.
   * @param {string} sourceId
   * @param {string} matchCategory
   * @param {string} matchTitle
   * @param {object} src - The source object from MatchEntity
   * @returns {Promise<Array<StreamEntity>>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src) {
    if (!src || !Array.isArray(src.formats)) return [];

    const streamEntities = [];

    for (const fmt of src.formats) {
      if (!fmt || !fmt.streamUrl) continue;

      const rawUrl = fmt.streamUrl.trim();

      // Bandwidth Policy (Invariant I1 & I8 / D2):
      // Drop any relayed DASH, .mpd manifest, ClearKey stream, or local proxy route.
      if (
        fmt.drmType ||
        rawUrl.includes('.mpd') ||
        rawUrl.includes('/api/dash/') ||
        rawUrl.includes('/api/manifest') ||
        rawUrl.includes('localhost')
      ) {
        continue;
      }

      // We only accept valid .m3u8 playlists
      if (!rawUrl.includes('.m3u8')) {
        continue;
      }

      // Assemble client-side proxy headers for Zero VPS Egress
      const reqHeaders = {};

      // Preserve any upstream headers
      if (fmt.headers && typeof fmt.headers === 'object') {
        Object.assign(reqHeaders, fmt.headers);
      }

      // Default or enrich User-Agent
      if (!reqHeaders['User-Agent'] && !reqHeaders['user-agent']) {
        reqHeaders['User-Agent'] = DALVIK_UA;
      }

      // chatgpt.hereisman.net requires Referer: https://gooz.aapmains.net
      if (rawUrl.includes('chatgpt.hereisman.net') && !reqHeaders['Referer'] && !reqHeaders['referer']) {
        reqHeaders['Referer'] = 'https://gooz.aapmains.net';
      }

      const qualityTag = fmt.title || 'HD';
      let resolution = 'HD';
      if (/\b1080p?\b/i.test(qualityTag)) resolution = '1080p';
      else if (/\b720p?\b/i.test(qualityTag)) resolution = '720p';
      else if (/\b480p?\b/i.test(qualityTag)) resolution = '480p';

      const channelLabel = src.channelName || 'SportzX Live';

      streamEntities.push(new StreamEntity({
        name: 'SportzX',
        title: `${channelLabel} • ${qualityTag}`,
        url: rawUrl,
        resolution,
        score: 85,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: reqHeaders
          }
        },
        _source: 'sportzx'
      }));
    }

    return streamEntities;
  }
}

module.exports = SportzXProvider;
