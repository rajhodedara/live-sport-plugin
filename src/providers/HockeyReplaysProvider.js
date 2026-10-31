'use strict';

const crypto = require('crypto');
const undici = require('../services/ProviderOutbound');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

/**
 * HockeyReplaysProvider
 *
 * Dedicated NHL full-game replay provider ingesting high-definition game replays
 * from https://hockeyreplays.com/ across NHL regular season and Stanley Cup playoffs.
 *
 * Zero-Egress Architecture:
 * - 0% Server Bandwidth: Direct client CDN playback (okcdn.ru direct MP4/HLS).
 * - 0 Cloudflare Workers: Direct client player streaming with behaviorHints.proxyHeaders.
 * - 0 Web Streams: Clean raw streams without site popups or ads.
 */
class HockeyReplaysProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'HockeyReplays';
    this.sourceName = 'hockeyreplays';
    this.baseUrl = 'https://hockeyreplays.com';
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    };

    this._matchPageCache = new Map();
    this._streamCache = new Map();
    this._maxCacheEntries = 500;

    if (this.circuitBreaker && typeof this.circuitBreaker.wrapSync === 'function') {
      this.fetchPage = this.circuitBreaker.wrapSync(`${this.name}_fetchPage`, async (url, customHeaders = {}) => {
        const res = await undici.request(url, {
          headers: { ...this.defaultHeaders, ...customHeaders },
          headersTimeout: 10000,
          bodyTimeout: 10000
        });
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        return await res.body.text();
      });
    } else {
      this.fetchPage = {
        fire: async (url, customHeaders = {}) => {
          const res = await undici.request(url, {
            headers: { ...this.defaultHeaders, ...customHeaders },
            headersTimeout: 10000,
            bodyTimeout: 10000
          });
          if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
          return await res.body.text();
        }
      };
    }
  }

  _setCache(cache, key, value, ttlMs = 30 * 60 * 1000) {
    if (cache.size >= this._maxCacheEntries) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  _getCache(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Parses match listings from hockeyreplays.com HTML index pages.
   */
  _parseMatchCards(html) {
    const matches = [];
    const linkMatches = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const seenUrls = new Set();

    for (const m of linkMatches) {
      const rawUrl = (m[1] || '').trim();
      const rawTitle = (m[2] || '').replace(/<[^>]+>/g, '').trim();

      if (!rawUrl || !rawTitle || seenUrls.has(rawUrl)) continue;

      const isMatchLink = rawUrl.includes('-full-game-replay') ||
                          rawUrl.includes('full-match') ||
                          rawTitle.toLowerCase().includes(' vs ') ||
                          rawTitle.toLowerCase().includes(' @ ');

      if (!isMatchLink) continue;
      if (/-{2,}$/.test(rawUrl)) continue;

      const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${this.baseUrl}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
      seenUrls.add(rawUrl);

      // Extract match date from title (e.g. October 15, 2026 or September 29, 2026)
      let parsedDate = '';
      const dateMatch = rawTitle.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i);
      if (dateMatch) {
        try {
          const parsed = new Date(`${dateMatch[0]} UTC`);
          if (!isNaN(parsed.getTime())) {
            parsedDate = parsed.toISOString();
          }
        } catch (_) {}
      }

      // League / Competition identification
      let league = 'NHL';
      const lowerTitle = rawTitle.toLowerCase();
      if (lowerTitle.includes('stanley cup') || lowerTitle.includes('playoffs')) {
        league = 'NHL Playoffs';
      } else if (lowerTitle.includes('preseason')) {
        league = 'NHL Preseason';
      } else if (lowerTitle.includes('regular season')) {
        league = 'NHL Regular Season';
      }

      // Extract competitors from title before dashes
      let cleanTitle = rawTitle.replace(/\s+/g, ' ');
      // Standardize @ into vs for clean catalog presentation
      if (cleanTitle.includes(' @ ')) {
        cleanTitle = cleanTitle.replace(' @ ', ' vs ');
      }

      const titleBeforeDashes = cleanTitle.split(/\s+-\s+/)[0] || '';
      const vsParts = titleBeforeDashes.split(/\s+vs\s+/i);
      let team1 = null;
      let team2 = null;
      if (vsParts.length === 2) {
        team1 = { name: vsParts[0].trim() };
        team2 = { name: vsParts[1].trim() };
      }

      // Generate a stable unique ID
      const safeSlug = fullUrl.replace(/^https?:\/\/[^\/]+\//, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
      const id = `hr_${safeSlug}`;

      matches.push(new MatchEntity({
        id,
        title: cleanTitle,
        category: 'hockey',
        date: parsedDate,
        league,
        team1,
        team2,
        sources: [
          {
            source: this.sourceName,
            id: fullUrl,
            name: 'Full Game Replay',
            url: fullUrl
          }
        ]
      }));
    }

    return matches;
  }

  /**
   * Ingests full game replays from season catalogs.
   */
  async getMatches() {
    const endpoints = [
      `${this.baseUrl}/`,
      `${this.baseUrl}/nhl-2026-27`,
      `${this.baseUrl}/nhl-2025-26`
    ];

    const allMatches = [];
    const seenIds = new Set();

    for (const url of endpoints) {
      try {
        const html = await this.fetchPage.fire(url);
        const parsed = this._parseMatchCards(html);
        for (const m of parsed) {
          if (!seenIds.has(m.id)) {
            seenIds.add(m.id);
            allMatches.push(m);
          }
        }
      } catch (err) {
        console.warn(`[HockeyReplays] Warning fetching ${url}:`, err.message);
      }
    }

    console.log(`[HockeyReplays] Extracted ${allMatches.length} replay matches`);
    return allMatches;
  }

  /**
   * Resolves direct playable streams for a hockey replay page.
   */
  async resolveStream(url, category, team, srcObj) {
    const targetUrl = url || (srcObj && srcObj.url) || '';
    if (!targetUrl) return [];

    const cached = this._getCache(this._streamCache, targetUrl);
    if (cached) return cached;

    try {
      const html = await this.fetchPage.fire(targetUrl);
      if (!html) return [];

      const okRuMatches = [];

      // 1. Check iframes for ok.ru
      const iframeMatches = [...html.matchAll(/<iframe[^>]+src="([^"]+)"/gi)];
      for (const ifm of iframeMatches) {
        let src = ifm[1];
        if (src.startsWith('//')) src = `https:${src}`;
        if (src.includes('ok.ru/videoembed/') || src.includes('ok.ru/video/')) {
          okRuMatches.push(src);
        }
      }

      // 2. Check anchor links for ok.ru
      const linkMatches = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>/gi)];
      for (const lm of linkMatches) {
        let href = lm[1];
        if (href.startsWith('//')) href = `https:${href}`;
        if (href.includes('ok.ru/videoembed/') || href.includes('ok.ru/video/')) {
          okRuMatches.push(href);
        }
      }

      const streams = [];
      const seenEmbeds = new Set();

      for (let i = 0; i < okRuMatches.length; i++) {
        const embedUrl = okRuMatches[i];
        if (seenEmbeds.has(embedUrl)) continue;
        seenEmbeds.add(embedUrl);

        const partLabel = okRuMatches.length > 1 ? `Part ${i + 1}` : 'Full Game';
        const okStreams = await this._extractOkRu(embedUrl, partLabel);
        streams.push(...okStreams);
      }

      if (streams.length > 0) {
        this._setCache(this._streamCache, targetUrl, streams);
      }

      return streams;
    } catch (err) {
      console.error(`[HockeyReplays] Error resolving streams for ${targetUrl}:`, err.message);
      return [];
    }
  }

  /**
   * Extracts direct MP4/HLS streams from an OK.ru embed page with zero server bandwidth.
   */
  async _extractOkRu(embedUrl, partName = '') {
    try {
      let normUrl = embedUrl;
      if (/ok\.ru\/video\/\d+/.test(normUrl)) {
        normUrl = normUrl.replace('/video/', '/videoembed/');
      }

      const html = await this.fetchPage.fire(normUrl, { 'Referer': 'https://hockeyreplays.com/' });
      if (!html) return [];
      const optionsMatch = html.match(/data-options="([^"]+)"/i) ||
                           html.match(/data-module="OKVideo"\s+data-options="([^"]+)"/i);

      if (!optionsMatch) return [];

      const rawJson = optionsMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const parsed = JSON.parse(rawJson);
      const meta = parsed.flashvars && parsed.flashvars.metadata;
      let metaObj = meta;
      if (typeof meta === 'string') {
        try { metaObj = JSON.parse(meta); } catch (_) {}
      }

      if (!metaObj) return [];

      const streams = [];
      const cleanPart = partName.trim();

      const qualityMap = {
        'full': '1080p',
        'hd': '720p',
        'sd': '480p',
        'low': '360p',
        'lowest': '240p',
        'mobile': '144p'
      };

      const okProxyHeaders = {
        request: {
          'User-Agent': this.defaultHeaders['User-Agent'],
          'Referer': 'https://ok.ru/'
        }
      };

      const qualityWeight = {
        'full': 1080,
        '1080p': 1080,
        'hd': 720,
        '720p': 720,
        'sd': 480,
        '480p': 480,
        'low': 360,
        '360p': 360,
        'lowest': 240,
        '240p': 240,
        'mobile': 144,
        '144p': 144
      };

      // 1. Direct MP4 videos
      if (Array.isArray(metaObj.videos)) {
        const sortedVideos = [...metaObj.videos].sort((a, b) => {
          const wA = qualityWeight[a.name] || 0;
          const wB = qualityWeight[b.name] || 0;
          return wB - wA;
        });

        for (const v of sortedVideos) {
          if (!v || !v.url) continue;
          const label = qualityMap[v.name] || v.name || 'HD';
          const title = cleanPart ? `HockeyReplays (${cleanPart} - ${label})` : `HockeyReplays (${label})`;

          streams.push(new StreamEntity({
            name: title,
            title: title,
            url: v.url,
            isDirect: true,
            resolution: label,
            behaviorHints: {
              proxyHeaders: okProxyHeaders,
              notWebReady: false
            }
          }));
        }
      }

      // 2. Direct HLS Adaptive Master Manifest
      if (metaObj.hlsMasterPlaylistUrl) {
        const title = cleanPart ? `HockeyReplays (${cleanPart} - Adaptive HLS)` : 'HockeyReplays (Adaptive HLS)';
        streams.push(new StreamEntity({
          name: title,
          title: title,
          url: metaObj.hlsMasterPlaylistUrl,
          isDirect: true,
          behaviorHints: {
            proxyHeaders: okProxyHeaders,
            notWebReady: false
          }
        }));
      }

      return streams;
    } catch (err) {
      console.warn('[HockeyReplays] Warning extracting OK.ru direct stream:', err.message);
      return [];
    }
  }
}

module.exports = HockeyReplaysProvider;
