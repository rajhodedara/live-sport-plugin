'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { decodeV3 } = require('../resolver/sportzx/SportzXCrypto');

const PENGU_GATEWAY = 'https://pengu.uk/%7B%22auth_token%22%3A%22yBSvBuRv6cCwX6ElzFJxUjKsHb0w7ZjsLusoE6t8Co4%22%7D';
const CATALOGS = ['pp-live-now', 'pp-live-basketball', 'pp-live-football', 'pp-live-american_football', 'pp-live-motorsport', 'pp-live-hockey'];

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
   * Ingest live matches from SportzX mirror or direct backend
   * @returns {Promise<Array<MatchEntity>>}
   */
  async getMatches() {
    // 1. Primary Strategy: Ingest active SportzX events from live sports catalogs
    try {
      const catalogPromises = CATALOGS.map(cat => 
        this.proxyFetch(`${PENGU_GATEWAY}/catalog/tv/${cat}.json`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          timeoutMs: 8000
        }).then(r => r && r.ok ? r.json() : null).catch(() => null)
      );

      const catalogResponses = await Promise.all(catalogPromises);
      const uniqueEvents = new Map();

      for (const res of catalogResponses) {
        if (!res || !Array.isArray(res.metas)) continue;
        for (const meta of res.metas) {
          if (!meta || !meta.id || uniqueEvents.has(meta.id)) continue;
          const desc = meta.description || '';
          if (desc.includes('SportzX') || desc.toLowerCase().includes('sportzx')) {
            uniqueEvents.set(meta.id, meta);
          }
        }
      }

      if (uniqueEvents.size > 0) {
        const matches = [];
        for (const [id, m] of uniqueEvents.entries()) {
          const rawName = (m.name || '').replace(/^[🔴⏱️📺\s]*(LIVE:?\s*)?/i, '').trim() || 'Live Match';
          const catLine = (m.description || '').split('\n')[0] || 'other';
          const category = this.normalizeCategory(catLine);

          // Extract team names
          let team1 = null;
          let team2 = null;
          const vsSplit = rawName.split(/\s+(?:vs\.?|@|-)\s+/i);
          if (vsSplit.length === 2) {
            team1 = vsSplit[0].trim();
            team2 = vsSplit[1].trim();
          }

          matches.push(new MatchEntity({
            id: `sportzx_${id}`,
            title: rawName,
            category,
            timestamp: Date.now(),
            status: 'LIVE',
            popular: false,
            team1,
            team2,
            thumbnail_url: m.background || m.poster || '',
            poster: m.poster || '',
            sources: [
              {
                id: `sportzx_${id}_stream`,
                source: 'sportzx',
                streamId: id,
                channelName: 'SportzX Live'
              }
            ]
          }));
        }

        return matches;
      }
    } catch (_) {
      // Fallback to direct gateways
    }

    // 2. Secondary Strategy: Fallback to direct APK gateways
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
    if (!src) return [];

    const streamEntities = [];

    // Case A: Mirror streamId resolution
    if (src.streamId) {
      try {
        const streamUrl = `${PENGU_GATEWAY}/stream/tv/${encodeURIComponent(src.streamId)}.json`;
        const resp = await this.proxyFetch(streamUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          timeoutMs: 8000
        });

        if (resp && resp.ok) {
          const data = await resp.json();
          const streams = Array.isArray(data?.streams) ? data.streams : [];

          for (const s of streams) {
            const sName = s.name || '';
            if (!sName.includes('SportzX') && !sName.toLowerCase().includes('sportzx')) {
              continue;
            }

            let targetUrl = s.url || '';
            let reqHeaders = {};

            if (targetUrl.includes('/playlist/')) {
              try {
                const b64Part = targetUrl.split('/playlist/')[1].split('/index.m3u8')[0];
                const padded = b64Part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64Part.length % 4)) % 4);
                const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
                if (decoded && decoded.url) {
                  targetUrl = decoded.url;
                  reqHeaders = decoded.headers || {};
                }
              } catch (_) {
                // Keep raw URL if decode fails
              }
            }

            // Invariant I8 / D2: Drop DASH, .mpd, or ClearKey streams
            if (
              targetUrl.includes('.mpd') ||
              targetUrl.includes('/api/dash/') ||
              targetUrl.includes('/api/manifest') ||
              targetUrl.includes('localhost')
            ) {
              continue;
            }

            if (!targetUrl.includes('.m3u8')) {
              continue;
            }

            // Ensure Dalvik User-Agent
            if (!reqHeaders['User-Agent'] && !reqHeaders['user-agent']) {
              reqHeaders['User-Agent'] = DALVIK_UA;
            }

            if (targetUrl.includes('chatgpt.hereisman.net') && !reqHeaders['Referer'] && !reqHeaders['referer']) {
              reqHeaders['Referer'] = 'https://gooz.aapmains.net';
            }

            let resolution = 'HD';
            if (/\b1080p?\b/i.test(s.title || sName)) resolution = '1080p';
            else if (/\b720p?\b/i.test(s.title || sName)) resolution = '720p';

            streamEntities.push(new StreamEntity({
              name: 'SportzX',
              title: s.title || `${src.channelName || 'SportzX Live'} • ${resolution}`,
              url: targetUrl,
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
        }
      } catch (err) {
        // Return empty on error
      }

      if (streamEntities.length > 0) return streamEntities;
    }

    // Case B: Direct formats array resolution
    const formats = Array.isArray(src.formats) ? src.formats : [];
    for (const fmt of formats) {
      if (!fmt || !fmt.streamUrl) continue;

      const rawUrl = fmt.streamUrl.trim();

      // Bandwidth Policy (Invariant I1 & I8 / D2)
      if (
        fmt.drmType ||
        rawUrl.includes('.mpd') ||
        rawUrl.includes('/api/dash/') ||
        rawUrl.includes('/api/manifest') ||
        rawUrl.includes('localhost')
      ) {
        continue;
      }

      if (!rawUrl.includes('.m3u8')) {
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
}

module.exports = SportzXProvider;
