'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const ChannelIdentityService = require('../services/ChannelIdentityService');
const { matchResolver, channelResolver, crypto: skCrypto } = require('../resolver/sktech');

/**
 * SkTechProvider
 *
 * Implements the dual-pillar SK Tech TV provider for Nuvio Live Sports Plugin:
 * - Pillar 1: Live Sports Matches (events.txt -> pro/*.txt)
 * - Pillar 2: 24/7 Continuous TV Networks (categories.txt -> channels/*.txt & .m3u)
 *
 * Operational Constraints:
 * - 0% Server Bandwidth Consumption: Never proxies media chunks through addon server.
 *   Emits direct CDN URLs with client-side behaviorHints.proxyHeaders.
 * - 0 Cloudflare Workers: Zero workers deployed or proxied through.
 */
class SkTechProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'SkTech';
    this.matchResolver = matchResolver;
    this.channelResolver = channelResolver;
    this._cachedChannelEntities = null;
    this._cachedChannelEntitiesTime = 0;
  }

  clearCache() {
    this._cachedChannelEntities = null;
    this._cachedChannelEntitiesTime = 0;
    if (this.channelResolver && typeof this.channelResolver.clearCache === 'function') {
      this.channelResolver.clearCache();
    }
  }

  /**
   * Ingests both Pillar 1 (Live Fixtures) and Pillar 2 (24/7 TV Networks)
   * @returns {Promise<Array<MatchEntity>>}
   */
  async getMatches() {
    const matches = [];

    // ──────────────────────────────────────────────────────────────────────────
    // Pillar 1: Live Sports Fixtures & Matches
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const liveMatches = await this.matchResolver.fetchLiveMatches();
      for (const m of liveMatches) {
        if (/namibia\s*(?:vs?\.?|@|-)\s*uganda/i.test(m.title)) continue;
        const now = Date.now();
        if (m.endDate && now > m.endDate + 30 * 60 * 1000) continue;
        if (m.kickoff && m.kickoff > 0 && (now - m.kickoff) > 4 * 3600 * 1000) continue;

        const isLive = m.kickoff && m.kickoff <= now && (now - m.kickoff) <= 4 * 3600 * 1000;
        const status = isLive ? 'live' : ((m.kickoff && m.kickoff > now) ? 'upcoming' : 'live');

        matches.push(new MatchEntity({
          id: `sktech_${m.id}`,
          title: m.title,
          baseTitle: m.title,
          category: this.normalizeCategory(m.category),
          date: String(m.kickoff || 0),
          status,
          league: m.rawCategory || 'Live Sports',
          team1: m.teamA && m.teamA.name ? { name: m.teamA.name, logo: m.teamA.logo } : null,
          team2: m.teamB && m.teamB.name ? { name: m.teamB.name, logo: m.teamB.logo } : null,
          poster: m.poster || undefined,
          thumbnail_url: m.poster || undefined,
          sources: m.sources || [{
            source: 'sktech',
            id: m.linkPath,
            channelName: m.title,
            type: 'fixture'
          }]
        }));
      }
    } catch (err) {
      console.warn(`[${this.name}] Failed to fetch live matches:`, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Pillar 2: 24/7 Continuous TV Networks (Dual-tiered cache: 5 minutes)
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const now = Date.now();
      const CHANNEL_CACHE_TTL = 5 * 60 * 1000;
      if (this._cachedChannelEntities && (now - this._cachedChannelEntitiesTime < CHANNEL_CACHE_TTL)) {
        matches.push(...this._cachedChannelEntities);
      } else {
        const channelEntities = [];
        const channels = await this.channelResolver.fetchChannels();
        for (const ch of channels) {
        const ident = ChannelIdentityService.parseChannel(ch.title, {
          group: ch.group,
          logo: ch.logo
        });
        const canonicalTitle = ident.canonicalTitle;
        const identityKey = ident.identityKey;
        const channelNumber = ident.channelNumber;

        const entity = new MatchEntity({
          id: `sktech_ch_${ch.id}`,
          title: canonicalTitle,
          baseTitle: canonicalTitle,
          category: 'networks',
          date: '0',
          popular: '1',
          league: ch.group || 'Live TV',
          poster: ch.logo || ch.poster || undefined,
          thumbnail_url: ch.logo || ch.poster || undefined,
          logo: ch.logo || undefined,
          sources: [{
            source: 'sktech',
            id: ch.url || ch.links || ch.api || ch.id,
            channelName: ch.title,
            canonicalChannel: canonicalTitle,
            country: ident.country || '',
            countryCode: ident.countryCode || '',
            countryFlag: ident.countryFlag || '',
            language: ident.language || '',
            resolution: ident.resolution || '',
            isBackup: ident.isBackup || false,
            isTimeshift: ident.isTimeshift || false,
            type: ch.type || 'channel',
            url: ch.url || ch.api || '',
            links: ch.links || '',
            headers: ch.headers || {},
            drmScheme: ch.drmScheme,
            drmLicense: ch.drmLicense,
            group: ch.group
          }]
        });
        entity.channelIdentityKey = identityKey;
        entity.channelNumber = channelNumber;
        entity.canonicalTitle = canonicalTitle;
        channelEntities.push(entity);
      }
      this._cachedChannelEntities = channelEntities;
      this._cachedChannelEntitiesTime = now;
      matches.push(...channelEntities);
    }
  } catch (err) {
      console.warn(`[${this.name}] Failed to fetch 24/7 channels:`, err.message);
    }

    return matches;
  }

  /**
   * Resolves direct playable streams for fixtures, dynamic event feeds, and 24/7 channels
   * Strict Constraints: 0 Server Bandwidth, 0 Cloudflare Workers
   *
   * @param {string} sourceId
   * @param {string} matchCategory
   * @param {string} matchTitle
   * @param {Object} src
   * @returns {Promise<Array<StreamEntity>>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const rawCandidates = [];
    const targetLink = src.links || src.id || sourceId;

    try {
      // Branch A: Direct dynamic event stream (FanCode, Sony LIV, etc.)
      const eventStream = (src.type === 'fancode_direct' || src.streamUrl)
        ? src
        : this.matchResolver.getEventStream(sourceId);

      if (eventStream && eventStream.streamUrl) {
        return [new StreamEntity({
          name: 'SK Tech',
          title: eventStream.streamTitle || `SK Tech (${eventStream.channelName || 'FanCode'})`,
          url: eventStream.streamUrl,
          resolution: eventStream.resolution || '1080p',
          score: 95,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: eventStream.streamHeaders || {
                'User-Agent': 'ReactNativeVideo/9.11.1 (Linux;Android 13) AndroidXMedia3/1.6.1',
                Referer: 'https://fancode.com/'
              }
            }
          },
          clearkey: eventStream.clearkey ? skCrypto.formatClearKey(eventStream.clearkey) : undefined
        })];
      }

      // Branch B: Fixture link path or direct pro/ link
      if (src.type === 'fixture' || (targetLink && targetLink.startsWith('pro/'))) {
        const fixtureStreams = await this.matchResolver.resolveMatchStreams(targetLink, matchTitle);
        rawCandidates.push(...fixtureStreams);
      }
      // Branch C: 24/7 TV Channel item
      else {
        const channelStreams = await this.channelResolver.resolveChannelStream({
          ...src,
          id: sourceId,
          title: matchTitle
        });
        rawCandidates.push(...channelStreams);
      }
    } catch (err) {
      console.warn(`[${this.name}] Stream resolution failed for ${sourceId}:`, err.message);
    }

    // Map candidates to StreamEntity instances (Zero Server Bandwidth compliance)
    const streamEntities = [];
    for (const s of rawCandidates) {
      if (!s.url) continue;

      // Bandwidth policy: /api/dash relays every media segment through this
      // server, so those streams are never offered. Internal proxy routes are
      // dropped for the same reason — this provider promises 0 server bandwidth.
      if (s.url.includes('/api/dash/') || s.url.includes('localhost') || s.url.includes('/api/manifest')) {
        continue;
      }

      streamEntities.push(new StreamEntity({
        name: 'SK Tech',
        title: s.title || matchTitle || 'Live Stream',
        url: s.url,
        resolution: s.resolution || 'HD',
        score: s.score || 85,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: s.behaviorHints?.proxyHeaders || {
            request: s.headers || {}
          }
        },
        clearkey: s.clearkey || undefined,
        language: s.language || src.language || undefined
      }));
    }

    return streamEntities;
  }
}

module.exports = SkTechProvider;
