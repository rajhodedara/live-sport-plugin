'use strict';

/**
 * Regression tests for the 24/7-channel prewarm guard and the cache-sizing
 * constants that stopped the VPS re-mint treadmill.
 *
 * Background (measured on live VPS 2026-10-24): prewarm tick = 180s, daddylive
 * TTL clamp was 150s → every tick re-minted every priority-1 match (~2MB/s of
 * resolveStream .text() allocations per worker), and MAX_ENTRIES=200 was
 * smaller than one tick's key count (~240), so the LRU evicted the previous
 * tick's warm entries and the warm-check never hit.
 */

jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));

describe('StreamResolveCache sizing constants', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    jest.resetModules();
  });

  test('MAX_ENTRIES default covers a full prewarm tick (>= 600)', () => {
    const Cache = require('../src/services/StreamResolveCache');
    const cache = new Cache();
    expect(cache.maxEntries).toBeGreaterThanOrEqual(600);
  });

  test('negative TTL default is at least 5 minutes (no dead-mirror re-scrape every cycle)', () => {
    const Cache = require('../src/services/StreamResolveCache');
    const cache = new Cache();
    expect(cache.negativeTtlMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  test('daddylive TTL ceiling exceeds the 180s prewarm tick', () => {
    const Cache = require('../src/services/StreamResolveCache');
    const cache = new Cache();
    cache.ttl.set('daddylive', 10 * 60 * 1000); // uncapped learned value
    expect(cache._ttlFor('daddylive')).toBeGreaterThan(180 * 1000);
  });

  test('env overrides are honored', () => {
    process.env.STREAM_CACHE_MAX_ENTRIES = '900';
    process.env.STREAM_NEGATIVE_TTL_MS = '600000';
    const Cache = require('../src/services/StreamResolveCache');
    const cache = new Cache();
    expect(cache.maxEntries).toBe(900);
    expect(cache.negativeTtlMs).toBe(600000);
  });
});

describe('prewarmMatch 24/7 channel guard', () => {
  test('returns before any mint for channel cards (category, flag, or _ch_ id)', async () => {
    const mod = require('../src/streams');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const channelCards = [
        { id: 'dlv_ch_5_tv-1-slovenia', category: 'football', sources: [{ source: 'daddylive', id: 'x' }] }, // mis-categorized channel id
        { id: 'cdn_ch_us_bein-sports', category: 'networks', sources: [{ source: 'cdnlive', id: 'x' }] },
        { id: 'whatever', category: 'other', isChannel: true, sources: [{ source: 'daddylive', id: 'x' }] }
      ];
      for (const card of channelCards) {
        await expect(mod.prewarmMatch(card, null)).resolves.toBeUndefined();
      }
      // The guard returns before the "[Prewarm] minting" log line can fire.
      const mintingCalls = consoleSpy.mock.calls.filter((c) => String(c[0]).includes('[Prewarm] minting'));
      expect(mintingCalls).toHaveLength(0);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
