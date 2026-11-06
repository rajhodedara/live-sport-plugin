'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { BASE_URL } = require('../config');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

class PitSportProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'PitSport';
    this.sourceName = 'pitsport';
    this.baseUrl = 'https://pitsport.st';
    this.watchApiUrl = 'https://api.embdlol.st/watch';
  }

  /**
   * Fetch live and upcoming matches from PitSport home catalog.
   *
   * @returns {Promise<Array<MatchEntity>>}
   */
  async getMatches() {
    const matches = [];
    try {
      const res = await this.proxyFetch(`${this.baseUrl}/api/v1/home`, {
        headers: {
          'User-Agent': UA,
          'Referer': `${this.baseUrl}/`,
          'Origin': this.baseUrl,
          'Accept': 'application/json'
        },
        timeoutMs: 15000,
        diagnosticOwner: 'catalog'
      });

      if (!res || !res.ok) {
        return matches;
      }

      const json = typeof res.json === 'function' ? await res.json() : JSON.parse(res.text || '{}');
      if (!json || !json.data) {
        return matches;
      }

      const rawItems = [
        ...(Array.isArray(json.data.live) ? json.data.live : []),
        ...(Array.isArray(json.data.upcoming) ? json.data.upcoming : []),
        ...(Array.isArray(json.data.carousel) ? json.data.carousel : [])
      ];

      const seenProgramIds = new Set();
      const now = Date.now();

      for (const item of rawItems) {
        if (!item || !item.programId) continue;
        const programId = String(item.programId);
        if (seenProgramIds.has(programId)) continue;
        seenProgramIds.add(programId);

        const title = (item.titleText || (Array.isArray(item.title) && item.title[0]?.text) || item.slug || '').trim();
        if (!title) continue;

        const slug = (item.slug || title)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 50)
          .replace(/^-|-$/g, '');

        let rawCategory = (item.competitionSlug || item.footer || '').toLowerCase();
        if (/formula|rally|supercar|motocross|karting|motor/i.test(rawCategory)) {
          rawCategory = 'motorsport';
        }
        const category = this.normalizeCategory(rawCategory);

        // sessionStart in PitSport is in epoch seconds
        const sessionStartSec = Number(item.sessionStart);
        const startTimeMs = Number.isFinite(sessionStartSec) && sessionStartSec > 0 ? sessionStartSec * 1000 : 0;
        const date = startTimeMs > 0 ? String(startTimeMs) : '0';

        let status = 'upcoming';
        if (item.liveState === 'live' || (startTimeMs > 0 && startTimeMs <= now)) {
          status = 'live';
        }

        let team1 = null;
        let team2 = null;
        const extracted = extractTeamsFromTitle(title);
        if (extracted) {
          team1 = { name: extracted[0] };
          team2 = { name: extracted[1] };
        }

        matches.push(new MatchEntity({
          id: `pitsport_${programId}_${slug}`,
          title: title,
          baseTitle: title,
          category: category,
          date: date,
          status: status,
          league: item.footer || (item.competitionSlug ? item.competitionSlug.toUpperCase() : 'PitSport'),
          logo: item.logo || null,
          thumbnail_url: item.background || null,
          poster: item.background || null,
          team1: team1,
          team2: team2,
          sources: [
            {
              source: this.sourceName,
              id: programId,
              programId: item.programId,
              playHref: item.playHref || `/programs/${item.programId}/play`,
              slug: item.slug,
              channelName: item.footer || item.competitionSlug || 'PitSport',
              name: title
            }
          ]
        }));
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  /**
   * Resolve a specific stream source by programId.
   *
   * @param {string|number} sourceId
   * @param {string} matchCategory
   * @param {string} matchTitle
   * @param {Object} [src]
   * @returns {Promise<Array<StreamEntity>>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];
    let programId = (src && src.programId) || sourceId;
    if (!programId) return streams;

    if (typeof programId === 'string' && programId.startsWith('pitsport_')) {
      const parts = programId.split('_');
      if (parts[1]) programId = parts[1];
    }

    let playData = null;
    try {
      const playRes = await this.proxyFetch(`${this.baseUrl}/api/v1/programs/${programId}/play`, {
        headers: {
          'User-Agent': UA,
          'Referer': `${this.baseUrl}/`,
          'Origin': this.baseUrl,
          'Accept': 'application/json'
        },
        timeoutMs: 10000
      });

      if (!playRes || !playRes.ok) {
        return streams;
      }

      playData = typeof playRes.json === 'function' ? await playRes.json() : JSON.parse(playRes.text || '{}');
    } catch (err) {
      console.warn(`[${this.name}] Play API request failed for ${programId}: ${err.message}`);
      return streams;
    }

    const videos = [];
    const seenEmbedUrls = new Set();
    const candidateVideos = [
      ...(Array.isArray(playData?.data?.videos) ? playData.data.videos : []),
      ...(playData?.data?.video ? [playData.data.video] : [])
    ];
    for (const v of candidateVideos) {
      if (v && typeof v.embedUrl === 'string' && v.embedUrl.trim()) {
        const u = v.embedUrl.trim();
        if (!seenEmbedUrls.has(u)) {
          seenEmbedUrls.add(u);
          videos.push(v);
        }
      }
    }

    if (videos.length === 0) {
      return streams;
    }

    const streamReferer = 'https://embdlol.st/';
    const streamOrigin = 'https://embdlol.st';

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      const embedUrl = video.embedUrl.trim();
      const label = video.label || (videos.length > 1 ? `Feed ${i + 1}` : 'PitSport');
      const streamLabel = matchTitle ? `${matchTitle} (${label})` : `PitSport - ${label}`;

      // Extract watchId UUID from embedUrl (e.g. https://embdlol.st/embed/{watchId})
      const watchMatch = embedUrl.match(/(?:\/embed\/|\/watch\/|\bv=|\bwatchId=)([a-zA-Z0-9_-]+)/);
      const watchId = watchMatch ? watchMatch[1] : null;

      if (watchId) {
        try {
          const watchRes = await this.proxyFetch(this.watchApiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Origin': streamOrigin,
              'Referer': streamReferer,
              'User-Agent': UA,
              'Accept': 'application/json'
            },
            body: JSON.stringify({ watchId }),
            timeoutMs: 10000
          });

          if (watchRes && watchRes.ok) {
            const watchJson = typeof watchRes.json === 'function' ? await watchRes.json() : JSON.parse(watchRes.text || '{}');
            if (watchJson && typeof watchJson.url === 'string' && watchJson.url.trim()) {
              const m3u8Url = watchJson.url.trim();
              const channelName = watchJson.channel?.channelname || label;
              const title = `PitSport - ${channelName} (${matchTitle || 'Live Event'})`;
              const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(streamReferer)}&origin=${encodeURIComponent(streamOrigin)}`;

              const s = new StreamEntity({
                name: 'PitSport',
                title: title,
                url: proxyUrl,
                behaviorHints: {
                  notWebReady: true,
                  proxyHeaders: {
                    request: {
                      'Referer': streamReferer,
                      'Origin': streamOrigin,
                      'User-Agent': UA
                    }
                  }
                },
                resolution: '1080p',
                isTikTok: true
              });
              s._isTikTok = true;
              s._source = this.sourceName;
              s.sourceName = this.sourceName;
              s.channelName = channelName;
              streams.push(s);
            }
          }
        } catch (watchErr) {
          console.warn(`[${this.name}] Watch resolver failed for ${watchId}: ${watchErr.message}`);
        }
      }

      // Always append Web Player fallback
      const webStream = new StreamEntity({
        name: 'PitSport',
        title: `${streamLabel} (Web Player)`,
        externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
      });
      webStream._source = this.sourceName;
      webStream.sourceName = this.sourceName;
      webStream.channelName = label;
      streams.push(webStream);
    }

    return streams;
  }
}

module.exports = PitSportProvider;
