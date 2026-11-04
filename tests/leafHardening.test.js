'use strict';

const StreamResolveCache = require('../src/services/StreamResolveCache');
const { prewarmSkipProvidersSet } = require('../src/streams');
const MatchAggregator = require('../src/services/MatchAggregator');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');

describe('Leaf Provider Hardening & Stability Tests', () => {
  describe('StreamResolveCache Leaf Token Handling', () => {
    let cache;

    beforeEach(() => {
      cache = new StreamResolveCache();
    });

    test('_extractTokenRemainingMs extracts expiration from Leaf JWT in /api/leaf/manifest.m3u8?url=', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const expSec = nowSec + 28800; // 8 hours later
      const payload = { slug: '12345', iat: nowSec, exp: expSec, uid: 'test-user' };
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.sig';

      const directUrl = `https://papacito.cfd/m3u/12345/live.m3u8?ft=${jwt}`;
      const proxyUrl = `http://localhost:7000/api/leaf/manifest.m3u8?url=${encodeURIComponent(directUrl)}`;

      const remMs = cache._extractTokenRemainingMs(proxyUrl);
      expect(remMs).toBeGreaterThan(28700 * 1000);
      expect(remMs).toBeLessThanOrEqual(28800 * 1000);
    });

    test('_extractTokenRemainingMs handles direct papacito.cfd URL with ft JWT', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const expSec = nowSec + 7200; // 2 hours later
      const payload = { slug: 'test', iat: nowSec, exp: expSec };
      const jwt = 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.sig';
      const directUrl = `https://papacito.cfd/m3u/test/live.m3u8?ft=${jwt}`;

      const remMs = cache._extractTokenRemainingMs(directUrl);
      expect(remMs).toBeGreaterThan(7100 * 1000);
      expect(remMs).toBeLessThanOrEqual(7200 * 1000);
    });

    test('_ttlFor("leaf") defaults to 4 hours', () => {
      expect(cache._ttlFor('leaf')).toBe(4 * 3600 * 1000);
    });

    test('getOrCreate stores Leaf stream with extended 4-hour TTL instead of 60s', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const expSec = nowSec + 28800; // 8 hours
      const payload = { slug: 'leaf-match', iat: nowSec, exp: expSec };
      const jwt = 'hdr.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.sig';
      const proxyUrl = `http://localhost:7000/api/leaf/manifest.m3u8?url=${encodeURIComponent(`https://papacito.cfd/m3u/leaf-match/live.m3u8?ft=${jwt}`)}`;

      const key = 'leaf:m123:leaf-match';
      const stream = new StreamEntity({
        name: 'Leaf [FHD]',
        url: proxyUrl,
        _source: 'leaf'
      });

      await cache.getOrCreate(key, async () => [stream]);

      // Verify entry exists, status is ok, and TTL > 3.9 hours
      expect(cache.has(key)).toBe(true);
      const remTtl = cache.getRemainingTtl(key);
      expect(remTtl).toBeGreaterThan(3.9 * 3600 * 1000);
      expect(remTtl).toBeLessThanOrEqual(4 * 3600 * 1000);
    });
  });

  describe('Background Prewarm Exclusion', () => {
    test('prewarmSkipProvidersSet includes leaf', () => {
      const skipSet = prewarmSkipProvidersSet();
      expect(skipSet.has('leaf')).toBe(true);
    });
  });

  describe('MatchAggregator Carry-Forward for Leaf', () => {
    test('carries forward Leaf sources when Leaf provider fails on subsequent sync', async () => {
      const prevMatches = [
        new MatchEntity({
          id: 'spk_football-match-1',
          aliasIds: ['football-match-1'],
          title: 'Team A vs Team B',
          category: 'football',
          date: String(Date.now() + 3600000),
          status: 'live',
          sources: [
            { source: 'streamedpk', id: 'football-match-1', name: 'Streamed Feed' },
            { source: 'leaf', id: 'streamed:football-match-1', name: 'Leaf 1080p' }
          ]
        })
      ];

      const mockCacheService = {
        getMatchesReadOnly: () => prevMatches,
        getMatches: () => prevMatches,
        setMatches: jest.fn(),
        isStale: () => false,
        findMatch: () => null
      };

      // Mock StreamedPk provider succeeds with same match, but Leaf provider fails (returns [])
      const mockStreamedPkProvider = {
        name: 'streamedpk',
        sourceName: 'streamedpk',
        getMatches: async () => [
          new MatchEntity({
            id: 'spk_football-match-1',
            aliasIds: ['football-match-1'],
            title: 'Team A vs Team B',
            category: 'football',
            date: String(Date.now() + 3600000),
            status: 'live',
            sources: [
              { source: 'streamedpk', id: 'football-match-1', name: 'Streamed Feed' }
            ]
          })
        ]
      };

      const mockLeafProvider = {
        name: 'Leaf',
        sourceName: 'leaf',
        getMatches: async () => [] // Transient failure / rate limit returns empty
      };

      const aggregator = new MatchAggregator({
        cacheService: mockCacheService,
        streamedPkProvider: mockStreamedPkProvider,
        leafProvider: mockLeafProvider
      });

      const synced = await aggregator.syncMatches();

      // Find the merged match
      const match = synced.find(m => m.id === 'spk_football-match-1' || m.aliasIds.includes('football-match-1'));
      expect(match).toBeDefined();

      // The Leaf source MUST have been carried forward from the previous cache!
      const sources = match.sources.map(s => s.source);
      expect(sources).toContain('streamedpk');
      expect(sources).toContain('leaf');
    });
  });
});
