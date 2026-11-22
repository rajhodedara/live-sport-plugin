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
   * Parse SportzX start time format:
   * e.g. "2026/11/22 13:00:00 +0000", epoch seconds, or epoch ms.
   */
  _parseStartTime(val) {
    if (!val) return Date.now();
    if (typeof val === 'number') {
      return val > 1e11 ? val : val * 1000;
    }
    if (typeof val === 'string') {
      const parsed = Date.parse(val.replace(/\//g, '-'));
      if (!Number.isNaN(parsed)) return parsed;
      const num = Number(val);
      if (!Number.isNaN(num) && num > 0) {
        return num > 1e11 ? num : num * 1000;
      }
    }
    return Date.now();
  }

  /**
   * Split a stream link of the form:
   * url|Header1=Val1&Header2=Val2
   */
  _parseStreamLinkAndHeaders(linkStr) {
    if (!linkStr || typeof linkStr !== 'string') return { url: '', headers: {} };
    const parts = linkStr.split('|');
    const url = parts[0].trim();
    const headers = {};

    if (parts.length > 1) {
      const qs = parts.slice(1).join('|').trim();
      const pairs = qs.split('&');
      for (const pair of pairs) {
        if (!pair) continue;
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          const k = pair.substring(0, eqIdx).trim();
          const v = pair.substring(eqIdx + 1).trim();
          if (k && v) {
            headers[k] = v;
          }
        }
      }
    }

    return { url, headers };
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

          const info = (item.eventInfo && typeof item.eventInfo === 'object') ? item.eventInfo : {};
          const startTime = this._parseStartTime(info.startTime || item.startTime);
          const rawTitle = info.eventName || item.eventName || item.title || (info.teamA && info.teamB ? `${info.teamA} vs ${info.teamB}` : (item.teamA && item.teamB ? `${item.teamA} vs ${item.teamB}` : 'Live Event'));
          const category = this.normalizeCategory(info.eventType || item.eventType || item.cat || item.category || 'other');
          const eventId = String(item.id || item.eventId || Math.random().toString(36).slice(2));

          // Extract channels & stream formats if embedded (legacy / fixture mode)
          const sources = [];
          const channels = Array.isArray(item.channels) ? item.channels : [];

          for (let cIdx = 0; cIdx < channels.length; cIdx++) {
            const ch = channels[cIdx];
            if (!ch) continue;

            const formats = Array.isArray(ch.formatsNew) ? ch.formatsNew : (Array.isArray(ch.formats) ? ch.formats : []);
            if (formats.length === 0) continue;

            sources.push({
              id: `${eventId}_${cIdx}`,
              eventId,
              source: 'sportzx',
              channelName: ch.cat || ch.name || 'SportzX Live',
              formats
            });
          }

          // Production SportzX mode: channels are served on-demand via /channels/<eventId>.json
          if (sources.length === 0) {
            sources.push({
              id: `sportzx_${eventId}`,
              eventId,
              source: 'sportzx',
              channelName: item.cat || 'SportzX Live'
            });
          }

          matches.push(new MatchEntity({
            id: `sportzx_${eventId}`,
            title: rawTitle,
            category,
            timestamp: startTime,
            status: item.status || 'LIVE',
            popular: item.isPopular || item.popular || (info.isHot === '1' || info.isHot === 1),
            team1: info.teamA || item.teamA || null,
            team2: info.teamB || item.teamB || null,
            thumbnail_url: info.teamAFlag || item.thumbnail || item.banner || '',
            poster: info.teamBFlag || item.poster || '',
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
    if (!src && !sourceId) return [];

    const streamEntities = [];

    // Case 1: Formats are pre-embedded in src (legacy/fixtures)
    if (src && Array.isArray(src.formats) && src.formats.length > 0) {
      for (const fmt of src.formats) {
        if (!fmt || !fmt.streamUrl) continue;
        const rawUrl = fmt.streamUrl.trim();

        if (
          fmt.drmType ||
          rawUrl.includes('.mpd') ||
          rawUrl.includes('/api/dash/') ||
          rawUrl.includes('/api/manifest') ||
          rawUrl.includes('localhost') ||
          !rawUrl.includes('.m3u8')
        ) {
          continue;
        }

        const reqHeaders = {};
        if (fmt.headers && typeof fmt.headers === 'object') {
          Object.assign(reqHeaders, fmt.headers);
        }
        if (!reqHeaders['User-Agent'] && !reqHeaders['user-agent']) {
          reqHeaders['User-Agent'] = DALVIK_UA;
        }
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

    // Case 2: Production SportzX on-demand channel resolution
    const eventId = (src && src.eventId) ? String(src.eventId) : (sourceId ? String(sourceId).replace(/^sportzx_/, '').split('_')[0] : null);
    if (!eventId) return [];

    let channelsList = null;
    for (const gw of GATEWAYS) {
      const endpoints = [
        `${gw}channels/${eventId}.json`,
        `${gw}channels/${eventId}e.json`
      ];

      for (const ep of endpoints) {
        try {
          const resp = await this.proxyFetch(ep, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
              'Accept': 'application/json, text/plain, */*'
            },
            timeoutMs: 8000
          });

          if (!resp || !resp.ok) continue;
          const json = await resp.json();
          if (!json || !json.data) continue;

          const decoded = this._decryptPayload(json.data);
          if (Array.isArray(decoded) && decoded.length > 0) {
            channelsList = decoded;
            break;
          }
        } catch (err) {
          // try next endpoint/gateway
        }
      }

      if (channelsList) break;
    }

    if (!Array.isArray(channelsList)) return [];

    for (const ch of channelsList) {
      if (!ch || !ch.link) continue;

      // Extract raw URL and pipe-delimited headers
      const { url: streamUrl, headers: parsedHeaders } = this._parseStreamLinkAndHeaders(ch.link);
      if (!streamUrl) continue;

      const isHls = streamUrl.includes('.m3u8') || streamUrl.includes('/playlist/') || streamUrl.includes('load-playlist');

      // Invariant I1 & I8: drop DASH, .mpd, DRM, local proxy routes
      if (
        ch.drmType ||
        ch.type === 'cenc' ||
        streamUrl.includes('.mpd') ||
        streamUrl.includes('/api/dash/') ||
        streamUrl.includes('/api/manifest') ||
        streamUrl.includes('localhost') ||
        !isHls
      ) {
        continue;
      }

      const reqHeaders = {};
      Object.assign(reqHeaders, parsedHeaders);

      if (!reqHeaders['User-Agent'] && !reqHeaders['user-agent']) {
        reqHeaders['User-Agent'] = DALVIK_UA;
      }
      if (streamUrl.includes('chatgpt.hereisman.net') && !reqHeaders['Referer'] && !reqHeaders['referer']) {
        reqHeaders['Referer'] = 'https://gooz.aapmains.net';
      }

      const qualityTag = ch.title || 'HD';
      let resolution = 'HD';
      if (/\b1080p?\b|FHD/i.test(qualityTag)) resolution = '1080p';
      else if (/\b720p?\b|HD/i.test(qualityTag)) resolution = '720p';
      else if (/\b480p?\b|SD/i.test(qualityTag)) resolution = '480p';

      streamEntities.push(new StreamEntity({
        name: 'SportzX',
        title: `${qualityTag}`,
        url: streamUrl,
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
