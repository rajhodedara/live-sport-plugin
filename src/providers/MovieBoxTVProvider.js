'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { getVisitorToken, makeMovieBoxRequest } = require('./movieboxCrypto');

const PRIORITY_CODES = ['US', 'IN', 'CA', 'ES', 'MX', 'DE', 'FR', 'IT', 'NL', 'BR', 'AR', 'PT', 'TR', 'RU'];

class MovieBoxTVProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'MovieBox TV';
    this.sourceName = 'moviebox_tv';
  }

  _parseChannel(item, countryCode, countryName) {
    if (!item) return null;
    const channelId = item.channelId || item.id;
    if (!channelId) return null;

    const idStr = String(channelId);
    const title = item.title || item.name || item.channelName || idStr;
    const isPopular = /abc|cbs|nbc|fox|espn|hbo|cnn|tnt|tbs|discovery|disney|nfl|nba|sport/i.test(title) || countryCode === 'US';
    const league = countryName || countryCode || '';

    return new MatchEntity({
      id: `moviebox_tv_${idStr}`,
      title,
      category: 'networks',
      date: '0', // Evergreen — 24/7 continuous channel
      timestamp: '0',
      popular: isPopular ? '1' : '0',
      league,
      poster: '',
      thumbnail_url: '',
      logo: '',
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
    const ch = detail.channel || detail;

    const streams = [];
    const seenUrls = new Set();

    if (Array.isArray(ch.streams) && ch.streams.length > 0) {
      for (const s of ch.streams) {
        const url = s && (s.url || s.playUrl || s.liveUrl);
        if (url && typeof url === 'string' && !seenUrls.has(url)) {
          seenUrls.add(url);
          const name = s.name || (s.urlType ? s.urlType.toUpperCase() : 'Live TV');
          streams.push(new StreamEntity({
            name,
            title: name,
            url,
            behaviorHints: {
              proxyHeaders: {
                request: {}
              }
            }
          }));
        }
      }
    }

    if (streams.length === 0) {
      const fallbackUrl = ch.liveUrl || ch.url || ch.playUrl;
      if (fallbackUrl && typeof fallbackUrl === 'string' && !seenUrls.has(fallbackUrl)) {
        streams.push(new StreamEntity({
          name: 'Live TV',
          title: 'Live TV',
          url: fallbackUrl,
          behaviorHints: {
            proxyHeaders: {
              request: {}
            }
          }
        }));
      }
    }

    return streams;
  }

  async getMatches() {
    try {
      const boundFetch = this.proxyFetch.bind(this);
      const token = await getVisitorToken(boundFetch);
      const countryData = await makeMovieBoxRequest('/wefeed-tv-bff/live/tv-country-list', boundFetch, { token });

      if (!countryData) return [];
      const countryList = countryData.items || countryData.list || [];
      if (!Array.isArray(countryList)) return [];

      countryList.sort((a, b) => {
        const codeA = a.countryCode || a.code || '';
        const codeB = b.countryCode || b.code || '';
        const idxA = PRIORITY_CODES.indexOf(codeA);
        const idxB = PRIORITY_CODES.indexOf(codeB);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return (b.channelCount || 0) - (a.channelCount || 0);
      });

      const selectedCountries = countryList.slice(0, 20);
      const allChannels = [];

      const CONCURRENCY = 4;
      for (let i = 0; i < selectedCountries.length; i += CONCURRENCY) {
        const chunk = selectedCountries.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(async (country) => {
          const countryCode = country && (country.countryCode || country.code);
          if (!countryCode) return;
          const countryName = country.countryName || countryCode;

          const pagesToFetch = countryCode === 'US' ? [1, 2] : [1];

          for (const page of pagesToFetch) {
            try {
              const channelData = await makeMovieBoxRequest(
                `/wefeed-tv-bff/live/tv-channel-list-by-country?countryCode=${encodeURIComponent(countryCode)}&page=${page}&perPage=100`,
                boundFetch,
                { token }
              );

              const channelList = channelData && (channelData.items || channelData.list);
              if (Array.isArray(channelList)) {
                for (const ch of channelList) {
                  const entity = this._parseChannel(ch, countryCode, countryName);
                  if (entity) {
                    allChannels.push(entity);
                  }
                }
              }
            } catch (err) {
              console.warn(`[MovieBoxTVProvider] Failed to fetch channels for country ${countryCode} page ${page}: ${err.message}`);
            }
          }
        }));
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
