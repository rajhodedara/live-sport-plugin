'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { getVisitorToken, makeMovieBoxRequest } = require('./movieboxCrypto');

class MovieBoxSportsProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'MovieBox Sports';
    this.sourceName = 'moviebox_sports';
  }

  _parseAggregate(list) {
    if (!Array.isArray(list)) return [];

    const matches = [];
    for (const item of list) {
      if (!item || !item.matchId) continue;

      const home = item.homeTeam || '';
      const away = item.awayTeam || '';
      const title = home && away ? `${home} vs ${away}` : (home || away || 'Sports Event');
      const category = this.normalizeCategory(item.sportType);
      const matchTime = item.matchTime ? String(Number(item.matchTime)) : String(Date.now());

      const entity = new MatchEntity({
        id: String(item.matchId),
        title,
        homeTeam: home,
        awayTeam: away,
        team1: home,
        team2: away,
        league: item.leagueName || '',
        category,
        date: matchTime,
        timestamp: matchTime,
        status: item.matchStatus || '',
        poster: item.thumbnail || '',
        sources: [
          {
            source: this.sourceName,
            id: String(item.matchId)
          }
        ]
      });

      matches.push(entity);
    }

    return matches;
  }

  _extractStreams(detail) {
    if (!detail || detail.matchStatus !== 'MatchIng') {
      return [];
    }

    const streams = [];
    const seenUrls = new Set();

    if (Array.isArray(detail.playSource)) {
      for (const src of detail.playSource) {
        const url = src && (src.url || src.playUrl);
        if (url && typeof url === 'string' && !seenUrls.has(url)) {
          seenUrls.add(url);
          streams.push(new StreamEntity({
            name: src.quality || 'Live',
            title: src.quality || 'Live',
            url,
            behaviorHints: {
              proxyHeaders: {
                request: {
                  Referer: 'https://sportslive.wine'
                }
              }
            }
          }));
        }
      }
    }

    if (streams.length === 0 && detail.playPath && typeof detail.playPath === 'string' && !seenUrls.has(detail.playPath)) {
      streams.push(new StreamEntity({
        name: 'Live',
        title: 'Live',
        url: detail.playPath,
        behaviorHints: {
          proxyHeaders: {
            request: {
              Referer: 'https://sportslive.wine'
            }
          }
        }
      }));
    }

    return streams;
  }

  async getMatches() {
    try {
      const boundFetch = this.proxyFetch.bind(this);
      const token = await getVisitorToken(boundFetch);
      const data = await makeMovieBoxRequest('/wefeed-tv-bff/sport/aggregate-v1', boundFetch, { token });

      if (!data || !Array.isArray(data.list)) {
        return [];
      }
      return this._parseAggregate(data.list);
    } catch (err) {
      console.warn(`[MovieBoxSportsProvider] getMatches failed: ${err.message}`);
      return [];
    }
  }

  async resolveStream(sourceId, matchCategory, matchTitle, _src) {
    if (!sourceId) return [];

    try {
      const boundFetch = this.proxyFetch.bind(this);
      const token = await getVisitorToken(boundFetch);
      const data = await makeMovieBoxRequest(`/wefeed-tv-bff/sport/detail-v1?matchId=${encodeURIComponent(sourceId)}`, boundFetch, { token });

      return this._extractStreams(data);
    } catch (err) {
      console.warn(`[MovieBoxSportsProvider] resolveStream failed for ${sourceId}: ${err.message}`);
      return [];
    }
  }
}

module.exports = MovieBoxSportsProvider;
