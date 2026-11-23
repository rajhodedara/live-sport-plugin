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
    if (!item) return null;
    const channelId = item.channelId || item.id;
    if (!channelId) return null;

    const idStr = String(channelId);
    const title = item.title || item.name || item.channelName || idStr;
    const now = String(Date.now());
    const logo = item.logo || (item.countryFlagImage && item.countryFlagImage.url) || '';

    return new MatchEntity({
      id: `moviebox_tv_${idStr}`,
      title,
      category: 'networks',
      date: now,
      timestamp: now,
      league: countryCode || item.countryCode || '',
      poster: logo,
      thumbnail_url: logo,
      sources: [
        {
          source: this.sourceName,
          id: idStr
        }
      ]
    });
  }

  _extractTvStream(detail) {
    if (!detail) return [];

    let streamUrl = detail.liveUrl || detail.url || detail.playUrl;
    if (!streamUrl && Array.isArray(detail.streams) && detail.streams.length > 0) {
      streamUrl = detail.streams[0]?.url;
    }

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

      if (!countryData) return [];
      const countryList = countryData.items || countryData.list || [];
      if (!Array.isArray(countryList)) return [];

      const allChannels = [];

      for (const country of countryList) {
        const countryCode = country && (country.countryCode || country.code);
        if (!countryCode) continue;

        try {
          const channelData = await makeMovieBoxRequest(
            `/wefeed-tv-bff/live/tv-channel-list-by-country?countryCode=${encodeURIComponent(countryCode)}&page=1&perPage=100`,
            boundFetch,
            { token }
          );

          const channelList = channelData && (channelData.items || channelData.list);
          if (Array.isArray(channelList)) {
            for (const ch of channelList) {
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
