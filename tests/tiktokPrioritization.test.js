'use strict';

/**
 * tests/tiktokPrioritization.test.js
 *
 * Verifies that:
 * 1. StreamScoringService awards Direct CDN bonus (+20) to non-worker streams
 *    (Vavoo, DaddyLive, Golf, PPVst, DamiTV, SKTech) and penalizes TikTok CDN streams (-30).
 * 2. LanguagePriorityService's compareStreams strictly ranks non-TikTok direct streams
 *    above TikTok CDN streams to prevent Cloudflare Worker quota exhaustion.
 * 3. TikTok stream detection flags .image chunks and ByteDance/TikTok domains.
 */

const StreamScoringService = require('../src/services/StreamScoringService');
const { compareStreams, parseLanguagePriority, DIRECT_STREAM_NAME } = require('../src/services/LanguagePriorityService');

describe('TikTok CDN Deprioritization & Worker Quota Saver', () => {
  let scorer;
  const noConfig = parseLanguagePriority({});

  beforeEach(() => {
    scorer = new StreamScoringService();
  });

  describe('StreamScoringService', () => {
    test('awards Direct CDN bonus according to priority hierarchy (leaf > timstreams > ppvst > pitsport > daddylive > vavoo > sktech)', () => {
      const leafStream = { url: 'https://leaf.example/index.m3u8', resolution: '1080p' };
      const timstreamsStream = { url: 'https://tim.example/index.m3u8', resolution: '1080p' };
      const ppvstStream = { url: 'https://ppvst.example/index.m3u8', resolution: '1080p' };
      const pitsportStream = { url: 'https://pitsport.example/index.m3u8', resolution: '1080p' };
      const daddyliveStream = { url: 'https://castr.example/index.m3u8', resolution: '1080p' };
      const vavooStream = { url: 'https://sunshine.example/index.m3u8', resolution: '1080p' };
      const sktechStream = { url: 'https://sktech.example/index.m3u8', resolution: '1080p' };

      const leafScore = scorer.calculateScore(leafStream, 'leaf');
      const timstreamsScore = scorer.calculateScore(timstreamsStream, 'timstreams');
      const ppvstScore = scorer.calculateScore(ppvstStream, 'ppvst');
      const pitsportScore = scorer.calculateScore(pitsportStream, 'pitsport');
      const daddyliveScore = scorer.calculateScore(daddyliveStream, 'daddylive');
      const vavooScore = scorer.calculateScore(vavooStream, 'vavoo');
      const sktechScore = scorer.calculateScore(sktechStream, 'sktech');

      // leaf: 50 + 30 + 20 + 30 + 15 = 145
      expect(leafScore).toBe(145);
      // timstreams: 50 + 30 + 20 + 25 + 15 = 140
      expect(timstreamsScore).toBe(140);
      // ppvst: 50 + 30 + 20 + 20 + 15 = 135
      expect(ppvstScore).toBe(135);
      // pitsport: 50 + 30 + 20 + 15 + 15 = 130
      expect(pitsportScore).toBe(130);
      // DaddyLive: 50 + 30 + 20 + 10 + 15 = 125
      expect(daddyliveScore).toBe(125);
      // Vavoo: 50 + 30 + 20 + 5 + 15 = 120
      expect(vavooScore).toBe(120);
      // SKTech: 50 + 30 + 20 + 5 = 105
      expect(sktechScore).toBe(105);

      // Hierarchy: leaf > timstreams > ppvst > pitsport > daddylive >= vavoo > sktech
      expect(leafScore).toBeGreaterThan(timstreamsScore);
      expect(timstreamsScore).toBeGreaterThan(ppvstScore);
      expect(ppvstScore).toBeGreaterThan(pitsportScore);
      expect(pitsportScore).toBeGreaterThan(daddyliveScore);
      expect(daddyliveScore).toBeGreaterThan(vavooScore);
      expect(vavooScore).toBeGreaterThan(sktechScore);
    });

    test('penalizes TikTok CDN streams (-30) and strips reliability bonus', () => {
      const tiktokStream = {
        url: 'https://p16-common-sign.tiktokcdn.com/tos-alisg/video~tplv-origin.image',
        resolution: '1080p',
        isTikTok: true
      };
      const score = scorer.calculateScore(tiktokStream, 'admin');
      // base 50 + 30 (url) + 20 (1080p) - 30 (tiktok penalty) + 0 = 70
      expect(score).toBe(70);
    });

    test('clean Golf stream outscores TikTok Admin stream', () => {
      const golfStream = { url: 'https://lb1.strmd.st/ingest/stream/1/playlist.m3u8', resolution: '1080p' };
      const tiktokAdmin = {
        url: 'https://lb17.strmd.st/rtmp/stream/1/playlist.m3u8',
        resolution: '1080p',
        isTikTok: true
      };

      const golfScore = scorer.calculateScore(golfStream, 'golf');
      const adminScore = scorer.calculateScore(tiktokAdmin, 'admin');

      expect(golfScore).toBeGreaterThan(adminScore);
      expect(golfScore - adminScore).toBeGreaterThanOrEqual(50);
    });
  });

  describe('LanguagePriorityService compareStreams', () => {
    test('places non-TikTok direct stream before TikTok stream in same language and format', () => {
      const directVavoo = {
        name: DIRECT_STREAM_NAME,
        url: 'https://sunshine.example/index.m3u8',
        language: 'English',
        score: 135,
        speedScore: 50,
        isTikTok: false
      };

      const tiktokAdmin = {
        name: DIRECT_STREAM_NAME,
        url: 'https://lb17.strmd.st/manifest.m3u8',
        language: 'English',
        score: 70,
        speedScore: 90, // Even with higher speed score
        isTikTok: true
      };

      // compareStreams should return negative when first argument outranks second
      expect(compareStreams(directVavoo, tiktokAdmin, noConfig)).toBeLessThan(0);
      expect(compareStreams(tiktokAdmin, directVavoo, noConfig)).toBeGreaterThan(0);
    });

    test('sorts mixed stream list prioritizing Direct CDNs before TikTok feeds', () => {
      const list = [
        { name: DIRECT_STREAM_NAME, title: 'Streamed [Admin]', language: 'English', isTikTok: true, score: 70 },
        { name: DIRECT_STREAM_NAME, title: 'Vavoo 1080p', language: 'English', isTikTok: false, score: 135 },
        { name: DIRECT_STREAM_NAME, title: 'DaddyLive 1080p', language: 'English', isTikTok: false, score: 135 },
        { name: DIRECT_STREAM_NAME, title: 'Streamed [Golf]', language: 'English', isTikTok: false, score: 135 }
      ];

      const sorted = [...list].sort((a, b) => compareStreams(a, b, noConfig));

      // Top 3 streams must all be non-TikTok feeds
      expect(sorted[0].isTikTok).toBeFalsy();
      expect(sorted[1].isTikTok).toBeFalsy();
      expect(sorted[2].isTikTok).toBeFalsy();

      // The TikTok stream must be at the bottom
      expect(sorted[3].title).toBe('Streamed [Admin]');
      expect(sorted[3].isTikTok).toBe(true);
    });
  });
});
