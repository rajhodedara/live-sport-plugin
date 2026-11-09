'use strict';

process.env.NODE_ENV = 'test';
process.env.WORKER_POOL_LOG = 'off';

jest.mock('../src/impitClient', () => ({
  safeFetch: jest.fn(),
}));

const { safeFetch } = require('../src/impitClient');
const CdnLiveProvider = require('../src/providers/CdnLiveProvider');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');
const { workerPool } = require('../src/services/HlsRewriteService');
const { DEFAULT_PAID_WORKER } = require('../src/services/WorkerBudget');

describe('CdnLiveProvider — worker budget integration', () => {
  let provider;
  const circuitBreaker = new CircuitBreakerService();

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new CdnLiveProvider({ circuitBreaker });
  });

  test('on 403/429, attempts hit up to 3 distinct free workers on failure', async () => {
    const playerUrl = 'https://cdnlive.stream/player?id=test1';
    const fetchedUrls = [];

    safeFetch.mockImplementation(async (url) => {
      fetchedUrls.push(url);
      // Main player page returns 403
      if (url === playerUrl) {
        return { ok: false, status: 403, text: async () => '' };
      }
      if (url.includes('.m3u8')) {
        return { ok: true, status: 200, text: async () => '#EXTM3U\nsegment.ts' };
      }
      // Workers also fail
      return { ok: false, status: 500, text: async () => '' };
    });

    const res = await provider.decodePlayer(playerUrl);
    expect(res).toBe('');

    // First call was playerUrl, followed by 3 worker calls
    expect(fetchedUrls[0]).toBe(playerUrl);
    const workerUrls = fetchedUrls.slice(1);
    expect(workerUrls).toHaveLength(3);

    // Verify all 3 worker URLs used distinct worker domains
    const workerHosts = workerUrls.map((u) => new URL(u).origin);
    const uniqueHosts = new Set(workerHosts);
    expect(uniqueHosts.size).toBe(3);

    // Paid worker must never be among them
    for (const host of uniqueHosts) {
      expect(host).not.toBe(new URL(DEFAULT_PAID_WORKER).origin);
    }
  });

  test('stops at 3 attempts when all workers fail', async () => {
    const playerUrl = 'https://cdnlive.stream/player?id=test2';
    let workerCallCount = 0;

    safeFetch.mockImplementation(async (url) => {
      if (url === playerUrl) {
        return { ok: false, status: 429, text: async () => '' };
      }
      workerCallCount++;
      return { ok: false, status: 502, text: async () => '' };
    });

    await provider.decodePlayer(playerUrl);
    expect(workerCallCount).toBe(3);
  });

  test('paid worker is never chosen or called even if free pool is exhausted', async () => {
    const playerUrl = 'https://cdnlive.stream/player?id=test3';
    const fetchedUrls = [];

    // Spy on workerPool.pick to simulate free pool exhaustion (returning paid worker)
    jest.spyOn(workerPool, 'pick').mockImplementation(() => {
      return { url: DEFAULT_PAID_WORKER, tier: 'paid', reused: false };
    });

    safeFetch.mockImplementation(async (url) => {
      fetchedUrls.push(url);
      return { ok: false, status: 403, text: async () => '' };
    });

    try {
      await provider.decodePlayer(playerUrl);
      // Only the primary player fetch should have occurred; paid worker must be rejected
      expect(fetchedUrls).toEqual([playerUrl]);
      expect(fetchedUrls.some((u) => u.includes(DEFAULT_PAID_WORKER))).toBe(false);
    } finally {
      workerPool.pick.mockRestore();
    }
  });

  test('breaks early on first successful worker response', async () => {
    const playerUrl = 'https://cdnlive.stream/player?id=test4';
    let workerCallCount = 0;

    safeFetch.mockImplementation(async (url) => {
      if (url === playerUrl) {
        return { ok: false, status: 403, text: async () => '' };
      }
      if (url.includes('.m3u8')) {
        return { ok: true, status: 200, text: async () => '#EXTM3U\nsegment.ts' };
      }
      workerCallCount++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ m3u8: 'https://cdn.example/live/test.m3u8' }),
      };
    });

    const m3u8 = await provider.decodePlayer(playerUrl);
    expect(m3u8).toBe('https://cdn.example/live/test.m3u8');
    expect(workerCallCount).toBe(1);
  });
});
