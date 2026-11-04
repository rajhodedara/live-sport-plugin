'use strict';

/**
 * Regression tests for the follow-up hardening on 75f166a (leaf rate-limit fix).
 *
 * Covered here, one block per finding:
 *  1. an unreadable/expired leaf signature must not inherit the 4-hour ceiling
 *  2. a dead upstream playlist must evict the resolve-cache entry that fed it
 *  3. carry-forward / source backfill must decay instead of lasting forever
 *  4. spk_<id> + leaf_<id> must still join into ONE card (the alias contract)
 */

const StreamResolveCache = require('../src/services/StreamResolveCache');
const MatchAggregator = require('../src/services/MatchAggregator');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');

const LEAF_MAX_TTL_MS = 4 * 3600 * 1000;

function signedUrl(expSeconds, slug = 'm1') {
  const payload = { slug, iat: Math.floor(Date.now() / 1000), exp: expSeconds };
  const jwt = 'hdr.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.sig';
  return `https://papacito.cfd/m3u/${slug}/live.m3u8?ft=${jwt}`;
}

function proxied(upstream) {
  return `http://localhost:7000/api/leaf/manifest.m3u8?url=${encodeURIComponent(upstream)}`;
}

function leafStream(url, name = 'Leaf 1080p') {
  return new StreamEntity({ name, url, _source: 'leaf' });
}

describe('Leaf follow-up hardening', () => {
  const originalShared = process.env.RESOLVE_CACHE_SHARED;

  beforeAll(() => {
    // Keep these tests off the resolver-hosted L2: they assert local behaviour.
    process.env.RESOLVE_CACHE_SHARED = 'false';
  });

  afterAll(() => {
    if (originalShared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
    else process.env.RESOLVE_CACHE_SHARED = originalShared;
  });

  describe('1. cache TTL never exceeds what the signature allows', () => {
    let cache;
    beforeEach(() => {
      cache = new StreamResolveCache();
    });

    test('a readable 8h signature still caps at the 4h ceiling', async () => {
      const key = 'leaf:m1:leaf-m1';
      const url = proxied(signedUrl(Math.floor(Date.now() / 1000) + 8 * 3600));
      await cache.getOrCreate(key, async () => [leafStream(url)]);

      const ttl = cache.getRemainingTtl(key);
      expect(ttl).toBeGreaterThan(0.99 * LEAF_MAX_TTL_MS);
      expect(ttl).toBeLessThanOrEqual(LEAF_MAX_TTL_MS);
    });

    test('an already-expired signature is cached for seconds, not hours', async () => {
      const key = 'leaf:m2:leaf-m2';
      const url = proxied(signedUrl(Math.floor(Date.now() / 1000) - 120, 'm2'));
      await cache.getOrCreate(key, async () => [leafStream(url)]);

      const ttl = cache.getRemainingTtl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(35 * 1000);
    });

    test('an unreadable signature falls back to the generic TTL, not the ceiling', async () => {
      const key = 'leaf:m3:leaf-m3';
      const url = proxied('https://papacito.cfd/m3u/m3/live.m3u8');
      await cache.getOrCreate(key, async () => [leafStream(url)]);

      const ttl = cache.getRemainingTtl(key);
      // defaultTtlMs is 60s; allow a little slack for the write itself.
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(61 * 1000);
    });

    test('_extractTokenRemainingMs distinguishes "expired" from "not found"', () => {
      expect(cache._extractTokenRemainingMs(proxied(signedUrl(Math.floor(Date.now() / 1000) - 60)))).toBeLessThan(0);
      expect(cache._extractTokenRemainingMs(proxied('https://papacito.cfd/m3u/m/live.m3u8'))).toBeNull();
    });
  });

  describe('2. a dead upstream playlist evicts its resolve-cache entry', () => {
    test('only the entry carrying the dead signed URL is dropped', async () => {
      const cache = new StreamResolveCache();
      const deadUpstream = signedUrl(Math.floor(Date.now() / 1000) + 8 * 3600, 'dead');
      const liveUpstream = signedUrl(Math.floor(Date.now() / 1000) + 8 * 3600, 'alive');

      await cache.getOrCreate('leaf:md:leaf-md', async () => [leafStream(proxied(deadUpstream))]);
      await cache.getOrCreate('leaf:ma:leaf-ma', async () => [leafStream(proxied(liveUpstream))]);

      expect(cache.has('leaf:md:leaf-md')).toBe(true);
      expect(cache.has('leaf:ma:leaf-ma')).toBe(true);

      const evicted = cache.invalidateUpstreamUrl(deadUpstream);

      expect(evicted).toBe(1);
      expect(cache.has('leaf:md:leaf-md')).toBe(false);
      expect(cache.has('leaf:ma:leaf-ma')).toBe(true);
    });

    test('an unknown URL evicts nothing and never throws', async () => {
      const cache = new StreamResolveCache();
      await cache.getOrCreate('leaf:mx:leaf-mx', async () => [leafStream(proxied(signedUrl(Date.now() / 1000 + 3600, 'x')))]);
      expect(cache.invalidateUpstreamUrl('https://papacito.cfd/m3u/other/live.m3u8')).toBe(0);
      expect(cache.invalidateUpstreamUrl('')).toBe(0);
      expect(cache.has('leaf:mx:leaf-mx')).toBe(true);
    });
  });

  describe('3. carry-forward decays instead of lasting the whole retention window', () => {
    const originalLimit = process.env.CARRY_FORWARD_MAX_SILENCE_MIN;

    afterEach(() => {
      if (originalLimit === undefined) delete process.env.CARRY_FORWARD_MAX_SILENCE_MIN;
      else process.env.CARRY_FORWARD_MAX_SILENCE_MIN = originalLimit;
    });

    function build(previous) {
      const cacheService = {
        getMatchesReadOnly: () => previous,
        getMatches: () => previous,
        setMatches: () => {},
        isStale: () => false,
        findMatch: () => null,
      };
      const streamedPkProvider = {
        name: 'streamedpk',
        sourceName: 'streamedpk',
        getMatches: async () => [new MatchEntity({
          id: 'spk_fixture1',
          aliasIds: ['fixture1'],
          title: 'Team A vs Team B',
          category: 'football',
          status: 'live',
          date: String(Date.now() + 3600000),
          sources: [{ source: 'streamedpk', id: 'fixture1' }],
        })],
      };
      const leafProvider = {
        name: 'Leaf',
        sourceName: 'leaf',
        getMatches: async () => [],
      };
      return new MatchAggregator({ cacheService, streamedPkProvider, leafProvider });
    }

    const previousWithLeaf = () => [new MatchEntity({
      id: 'spk_fixture1',
      aliasIds: ['fixture1', 'leaf_fixture1'],
      title: 'Team A vs Team B',
      category: 'football',
      status: 'live',
      date: String(Date.now() + 3600000),
      sources: [
        { source: 'streamedpk', id: 'fixture1' },
        { source: 'leaf', id: 'streamed:fixture1', name: 'Leaf 1080p' },
      ],
    })];

    test('inside the silence window the leaf source is backfilled', async () => {
      delete process.env.CARRY_FORWARD_MAX_SILENCE_MIN;
      const aggregator = build(previousWithLeaf());
      const synced = await aggregator.syncMatches();
      const match = synced.find((m) => m.id === 'spk_fixture1');
      expect(match).toBeDefined();
      expect(match.sources.map((s) => s.source)).toContain('leaf');
    });

    test('past the silence limit the leaf source is no longer re-attached', async () => {
      // 0.0001 min == 6 ms, so the second sync is already past the limit.
      process.env.CARRY_FORWARD_MAX_SILENCE_MIN = '0.0001';
      const aggregator = build(previousWithLeaf());

      const first = await aggregator.syncMatches();
      expect(first.find((m) => m.id === 'spk_fixture1').sources.map((s) => s.source)).toContain('leaf');

      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await aggregator.syncMatches();
      const match = second.find((m) => m.id === 'spk_fixture1');
      expect(match).toBeDefined();
      expect(match.sources.map((s) => s.source)).not.toContain('leaf');
    });
  });

  describe('4. streamedpk and leaf rows still join into one card', () => {
    test('spk_<id> and leaf_<id> merge, keeping both sources', async () => {
      const cacheService = {
        getMatchesReadOnly: () => [],
        getMatches: () => [],
        setMatches: () => {},
        isStale: () => false,
        findMatch: () => null,
      };
      const fixtureId = 'fixturejoin1';
      const streamedPkProvider = {
        name: 'streamedpk',
        sourceName: 'streamedpk',
        getMatches: async () => [new MatchEntity({
          id: `spk_${fixtureId}`,
          aliasIds: [fixtureId],
          title: 'Team A vs Team B',
          category: 'football',
          status: 'live',
          date: String(Date.now() + 3600000),
          sources: [{ source: 'streamedpk', id: fixtureId }],
        })],
      };
      const leafProvider = {
        name: 'Leaf',
        sourceName: 'leaf',
        getMatches: async () => [new MatchEntity({
          id: `leaf_${fixtureId}`,
          aliasIds: [`streamed:${fixtureId}`, fixtureId],
          title: 'Team A vs Team B',
          category: 'football',
          status: 'live',
          date: String(Date.now() + 3600000),
          sources: [{ source: 'leaf', id: `streamed:${fixtureId}`, name: 'Leaf 1080p' }],
        })],
      };

      const aggregator = new MatchAggregator({ cacheService, streamedPkProvider, leafProvider });
      const synced = await aggregator.syncMatches();

      const matching = synced.filter((m) => Array.isArray(m.aliasIds) && m.aliasIds.includes(fixtureId));
      // One fixture, one card: the leaf row must not survive as a second entry.
      const withSources = matching.filter((m) => Array.isArray(m.sources) && m.sources.length > 0);
      expect(withSources).toHaveLength(1);
      const sources = withSources[0].sources.map((s) => s.source);
      expect(sources).toContain('streamedpk');
      expect(sources).toContain('leaf');
    });
  });
});
