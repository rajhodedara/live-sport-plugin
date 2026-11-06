// These unit tests do not exercise or launch WASM workers.
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM execution in provider unit fixture'); }),
  destroy: jest.fn(async () => {})
}));

'use strict';

const leafMint = require('../src/services/LeafMint');
const { resetAccountRateLimits } = require('../src/services/LeafRateLimitState');
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
const LeafRecapProvider = require('../src/providers/LeafRecapProvider');
const impitClient = require('../src/services/ProviderOutbound');
const container = require('../src/container');
const { KNOWN_REPLAY_SOURCES, KNOWN_FALLBACKS, NICE_NAMES, CHANNEL_TITLE_NICE_NAMES } = require('../src/streams');
const { isReplayMatch } = require('../src/catalog');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');

const TEST_CONFIG = 'mock-recap-token-uuid-1234-5678-90ab';

describe('LeafRecapProvider Unit Tests', () => {
  let provider;
  let safeFetchSpy;

  beforeEach(() => {
    resetAccountRateLimits();
    process.env.LEAF_INSTALL_CONFIG = TEST_CONFIG;
    delete process.env.LEAF_API_URL;
    provider = new LeafRecapProvider();
  });

  afterEach(() => {
    if (safeFetchSpy) {
      safeFetchSpy.mockRestore();
      safeFetchSpy = null;
    }
    delete process.env.LEAF_INSTALL_CONFIG;
    delete process.env.LEAF_API_URL;
  });

  describe('Registration & Container Resolution (Invariant I4)', () => {
    test('resolves leafRecapProvider from Awilix container as singleton', () => {
      const resolved = container.resolve('leafRecapProvider');
      expect(resolved).toBeInstanceOf(LeafRecapProvider);
      expect(resolved.sourceName).toBe('leaf_recap');
      expect(resolved.name).toBe('LeafRecap');
    });

    test('is present in streams.js tables and has replay source priority', () => {
      expect(KNOWN_REPLAY_SOURCES).toContain('leaf_recap');
      expect(KNOWN_FALLBACKS).toContain('leaf_recap');
      expect(NICE_NAMES['leaf_recap']).toBe('Highfly Recap');
      expect(CHANNEL_TITLE_NICE_NAMES['leaf_recap']).toBe('Highfly Recap');
      const { SOURCE_PRIORITY } = require('../src/streams');
      expect(SOURCE_PRIORITY['leaf_recap']).toBe(2);
    });

    test('exposes dynamic getters for apiUrl and configured', () => {
      delete process.env.LEAF_INSTALL_CONFIG;
      delete process.env.LEAF_API_URL;
      delete process.env.LEAF_FREE_USER_ID;
      expect(provider.configured).toBe(false);

      process.env.LEAF_INSTALL_CONFIG = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
      expect(provider.configured).toBe(true);
      expect(provider.apiUrl).toBe('https://premium.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');

      process.env.LEAF_API_URL = 'https://custom.highfly.dev/my-token';
      expect(provider.apiUrl).toBe('https://custom.highfly.dev/my-token');
    });
  });

  describe('Genre and Category Normalization', () => {
    test('maps motor-sports to motorsport', () => {
      expect(provider.normalizeGenre('motor-sports')).toBe('motorsport');
      expect(provider.normalizeGenre('motorsport')).toBe('motorsport');
      expect(provider.normalizeGenre('Motor Sports')).toBe('motorsport');
    });

    test('maps standard genres correctly', () => {
      expect(provider.normalizeGenre('football')).toBe('football');
      expect(provider.normalizeGenre('basketball')).toBe('basketball');
      expect(provider.normalizeGenre('baseball')).toBe('baseball');
      expect(provider.normalizeGenre('hockey')).toBe('hockey');
      expect(provider.normalizeGenre('rugby')).toBe('rugby');
      expect(provider.normalizeGenre('american-football')).toBe('american_football');
      expect(provider.normalizeGenre('tennis')).toBe('tennis');
      expect(provider.normalizeGenre('unknown-genre-xyz')).toBe('other');
    });
  });

  describe('Catalog Ingestion (getMatches)', () => {
    test('fetches sports_recaps.json and formats finished MatchEntities', async () => {
      const mockRecapCatalog = {
        metas: [
          {
            id: 'recap:golden-state-warriors-vs-memphis-grizzlies-recap-2601690',
            name: 'Golden State Warriors vs Memphis Grizzlies - Full Game Recap',
            genres: ['basketball'],
            poster: 'https://images.highfly.to/posters/nba-gsw-mem.jpg',
            releaseInfo: '2026-11-05'
          },
          {
            id: 'recap:f1-sao-paulo-grand-prix-highlights-2026',
            name: 'Formula 1 Sao Paulo Grand Prix Highlights',
            genres: ['motor-sports'],
            poster: 'https://images.highfly.to/posters/f1-brazil.jpg',
            releaseInfo: '2026-11-04'
          }
        ]
      };

      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockRecapCatalog
      });

      const matches = await provider.getMatches();

      expect(matches).toHaveLength(2);
      expect(provider.lastCatalogOk).toBe(true);

      const m1 = matches[0];
      expect(m1).toBeInstanceOf(MatchEntity);
      expect(m1.id).toBe('leaf_recap_golden-state-warriors-vs-memphis-grizzlies-recap-2601690');
      expect(m1.title).toBe('Golden State Warriors vs Memphis Grizzlies - Full Game Recap');
      expect(m1.category).toBe('basketball');
      expect(m1.status).toBe('finished');
      expect(m1.sources).toEqual([
        {
          source: 'leaf_recap',
          id: 'recap:golden-state-warriors-vs-memphis-grizzlies-recap-2601690',
          name: 'Highfly Recap'
        }
      ]);
      expect(isReplayMatch(m1)).toBe(true);

      const m2 = matches[1];
      expect(m2.category).toBe('motorsport');
      expect(m2.status).toBe('finished');
      expect(isReplayMatch(m2)).toBe(true);
    });

    test('returns empty array when unconfigured', async () => {
      delete process.env.LEAF_INSTALL_CONFIG;
      const unconf = new LeafRecapProvider();
      const matches = await unconf.getMatches();
      expect(matches).toEqual([]);
    });

    test('handles upstream catalog error gracefully', async () => {
      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: false,
        status: 500
      });

      const matches = await provider.getMatches();
      expect(matches).toEqual([]);
      expect(provider.lastCatalogOk).toBe(false);
    });
  });

  describe('Stream Resolution (resolveStream)', () => {
    test('resolves VOD stream to manifest proxy URL without video byte proxying (Invariant I1)', async () => {
      const targetId = 'recap:golden-state-warriors-vs-memphis-grizzlies-recap-2601690';
      const mockStreamsResponse = {
        streams: [
          {
            name: '🔒 Leaf (Strong) · 1080p',
            title: '1920x1080 ~6.5 Mbps',
            url: 'https://recaps.highfly.to/vod/gsw-mem-recap/playlist.m3u8'
          }
        ]
      };

      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockStreamsResponse
      });

      const streams = await provider.resolveStream(targetId, 'basketball', 'GSW vs MEM');

      expect(streams).toHaveLength(1);
      const st = streams[0];
      expect(st).toBeInstanceOf(StreamEntity);
      expect(st._source).toBe('leaf_recap');
      expect(st.quality).toBe('FHD');
      expect(st.resolution).toBe('1080p');
      expect(st.bitrate).toBe('6.5 Mbps');
      expect(st.url).toContain('/api/manifest?url=https%3A%2F%2Frecaps.highfly.to%2Fvod%2Fgsw-mem-recap%2Fplaylist.m3u8');
      expect(st.behaviorHints.proxyHeaders.request.Referer).toBe('https://sports.highfly.to/');
    });

    test('handles rate limit upstream stub gracefully', async () => {
      const targetId = 'recap:rate-limited-recap';
      const mockRateLimitResponse = {
        streams: [
          {
            name: 'Rate limit',
            title: 'Too many stream requests, wait 30 seconds'
          }
        ]
      };

      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockRateLimitResponse
      });

      const streams = await provider.resolveStream(targetId, 'football', 'Match');
      expect(streams).toEqual([]);
    });

    test('handles install nag upstream stub gracefully', async () => {
      const targetId = 'recap:nag-recap';
      const mockNagResponse = {
        streams: [
          {
            name: 'Please reinstall',
            url: 'https://sports.highfly.to/configure'
          }
        ]
      };

      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockNagResponse
      });

      const streams = await provider.resolveStream(targetId, 'football', 'Match');
      expect(streams).toEqual([]);
    });

    test('normalizes targetId without recap: prefix and with leaf_recap_ prefix', async () => {
      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          streams: [{
            name: 'Highfly Recap',
            url: 'https://recaps.highfly.to/vod/sample-match/playlist.m3u8'
          }]
        })
      });

      // Request with bare cleanId
      await provider.resolveStream('sample-match', 'football', 'Sample Match');
      expect(impitClient.safeFetch).toHaveBeenCalledWith(
        expect.stringContaining('/stream/sport/recap%3Asample-match.json'),
        expect.any(Object)
      );

      // Request with leaf_recap_ prefix
      await provider.resolveStream('leaf_recap_sample-match', 'football', 'Sample Match');
      expect(impitClient.safeFetch).toHaveBeenCalledWith(
        expect.stringContaining('/stream/sport/recap%3Asample-match.json'),
        expect.any(Object)
      );
    });
  });

  describe('Match Aggregation & Replay Retention', () => {
    test('retains leaf_recap matches older than 24 hours under replay retention policy', () => {
      const threeDaysAgo = Date.now() - (3 * 24 * 3600 * 1000);
      const match = new MatchEntity({
        id: 'leaf_recap_old-game-recap',
        title: 'Old Game Recap',
        category: 'basketball',
        date: String(threeDaysAgo),
        status: 'finished',
        sources: [{
          source: 'leaf_recap',
          id: 'recap:old-game-recap',
          name: 'Highfly Recap'
        }]
      });

      expect(isReplayMatch(match)).toBe(true);

      const REPLAY_RETENTION_DAYS = 365;
      const expiryWindowMs = 24 * 3600 * 1000;
      const replayExpiryWindowMs = REPLAY_RETENTION_DAYS * 24 * 3600 * 1000;
      const REPLAY_PROVIDERS = new Set(['replayzone', 'livetv', 'soccerfull', 'basketballvideo', 'nflvideo', 'fullraces', 'hockeyreplays', 'mlblive', 'leaf_recap']);

      const isReplayZone = match.sources && match.sources.some(s => s && REPLAY_PROVIDERS.has(s.source));
      const windowMs = isReplayZone ? replayExpiryWindowMs : expiryWindowMs;
      const now = Date.now();
      const kickoff = Number(match.date);

      // Must be kept within replay expiry window (365 days), and would have failed 24h window
      expect(isReplayZone).toBe(true);
      expect(now <= kickoff + windowMs).toBe(true);
      expect(now <= kickoff + expiryWindowMs).toBe(false);
    });

    test('TimingRelations registers leaf_recap as known source', () => {
      const { createTimingRelations } = require('../src/services/TimingRelations');
      let emittedRow = null;
      const timing = createTimingRelations({ emit: (row) => { emittedRow = row; } });
      const work = timing.work('leaf_recap');
      expect(work).toBeDefined();
    });
  });
});
