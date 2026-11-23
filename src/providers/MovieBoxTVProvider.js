'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { getVisitorToken, makeMovieBoxRequest } = require('./movieboxCrypto');

class MovieBoxTVProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'MovieBox TV';
    this.sourceName = 'moviebox_tv';
  }

  _parseChannel(item, countryCode) {
    if (!item || !item.channelId) return null;

    const channelId = String(item.channelId);
    const title = item.name || item.channelName || channelId;
    const now = String(Date.now());

    return new MatchEntity({
      id: `moviebox_tv_${channelId}`,
      title,
      category: 'networks',
      date: now,
      timestamp: now,
      league: countryCode || '',
      poster: item.logo || '',
      thumbnail_url: item.logo || '',
      sources: [
        {
          source: this.sourceName,
          id: channelId
        }
      ]
    });
  }

  _extractTvStream(detail) {
    if (!detail) return [];

    const streamUrl = detail.liveUrl || detail.url || detail.playUrl;
    if (!streamUrl || typeof streamUrl !== 'string') {
      return [];
    }

    return [
      new StreamEntity({
        name: 'Live TV',
        title: 'Live TV',
        url: streamUrl,
        behaviorHints: {
          proxyHeaders: {
            request: {}
          }
        }
      })
    ];
  }

  async getMatches() {
    try {
      const boundFetch = this.proxyFetch.bind(this);
      const token = await getVisitorToken(boundFetch);
      const countryData = await makeMovieBoxRequest('/wefeed-tv-bff/live/tv-country-list', boundFetch, { token });

      if (!countryData || !Array.isArray(countryData.list)) {
        return [];
      }

      const allChannels = [];

      for (const country of countryData.list) {
        const countryCode = country && (country.countryCode || country.code);
        if (!countryCode) continue;

        try {
          const channelData = await makeMovieBoxRequest(
            `/wefeed-tv-bff/live/tv-channel-list-by-country?countryCode=${encodeURIComponent(countryCode)}&page=1&perPage=100`,
            boundFetch,
            { token }
          );

          if (channelData && Array.isArray(channelData.list)) {
            for (const ch of channelData.list) {
              const entity = this._parseChannel(ch, countryCode);
              if (entity) {
                allChannels.push(entity);
              }
            }
          }
        } catch (err) {
          console.warn(`[MovieBoxTVProvider] Failed to fetch channels for country ${countryCode}: ${err.message}`);
        }

        // 50ms stagger between countries to avoid edge rate-limiting
        await new Promise(r => setTimeout(r, 50));
      }

      return allChannels;
    } catch (err) {
      console.warn(`[MovieBoxTVProvider] getMatches failed: ${err.message}`);
      return [];
    }
  }

  async resolveStream(sourceId, matchCategory, matchTitle, _src) {
    if (!sourceId) return [];

    try {
      const boundFetch = this.proxyFetch.bind(this);
      const token = await getVisitorToken(boundFetch);
      const data = await makeMovieBoxRequest(`/wefeed-tv-bff/live/tv-channel?channelId=${encodeURIComponent(sourceId)}`, boundFetch, { token });

      return this._extractTvStream(data);
    } catch (err) {
      console.warn(`[MovieBoxTVProvider] resolveStream failed for ${sourceId}: ${err.message}`);
      return [];
    }
  }
}

module.exports = MovieBoxTVProvider;
