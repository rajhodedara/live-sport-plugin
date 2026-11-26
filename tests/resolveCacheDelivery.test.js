'use strict';

const StreamResolveCache = require('../src/services/StreamResolveCache');

const direct = (name, extra = {}) => ({
  title: name,
  url: `https://cdn.fixture.test/${name}.m3u8`,
  behaviorHints: { proxyHeaders: { request: { Referer: 'https://ref.fixture.test/' } } },
  ...extra
});

describe('StreamResolveCache active-caller media delivery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-27T02:00:00Z'));
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('201 simultaneous successful direct-media mints yield 201 nonempty responses while keeping entries <= 200', async () => {
    const cache = new StreamResolveCache({
      sharedResolver: { available: () => false, request: () => { throw new Error('Unexpected L2'); } }
    });

    const results = await Promise.all(
      Array.from({ length: 201 }, (_, idx) => {
        const key = `kafka:m${idx}:ch${idx}`;
        return cache.getOrCreate(key, async () => [direct(`feed-${idx}`)]);
      })
    );

    expect(results).toHaveLength(201);
    for (let idx = 0; idx < 201; idx += 1) {
      expect(results[idx]).toHaveLength(1);
      expect(results[idx][0].url).toBe(`https://cdn.fixture.test/feed-${idx}.m3u8`);
    }
    expect(cache.entries.size).toBeLessThanOrEqual(200);
    expect(cache.stats().evictions).toBeGreaterThan(0);
  });

  test('maxEntries:1 with two callers on a blocked mint and another key evicting during L2 publication delivers independent clones to both callers', async () => {
    let releasePost;
    const sharedResolver = {
      available: () => true,
      request: jest.fn(async (raw, opts = {}) => {
        const url = new URL(raw);
        if (url.searchParams.get('claim') === '1') {
          return { ok: true, json: async () => ({ ok: true, ownerToken: '11111111-1111-4111-8111-111111111111' }) };
        }
        if (opts.method === 'POST' && url.pathname !== '/api/cache/prune') {
          return new Promise((resolve) => {
            releasePost = () => resolve({ ok: true, json: async () => ({ ok: true, revision: '22222222-2222-4222-8222-222222222222' }) });
          });
        }
        return { ok: true, json: async () => ({ status: 'miss' }) };
      })
    };

    const cache = new StreamResolveCache({ maxEntries: 1, sharedResolver });
    const keyA = 'kafka:mA:chA';
    const keyB = 'kafka:mB:chB';
    const mintA = jest.fn(async () => [direct('alpha')]);
    const outcomes = [];
    mintA.onResolveOutcome = (event) => outcomes.push(event);

    const p1 = cache.getOrCreate(keyA, mintA);
    const p2 = cache.getOrCreate(keyA, () => { throw new Error('Duplicate mint'); });

    await jest.advanceTimersByTimeAsync(0);
    expect(releasePost).toBeTypeOf ? null : expect(typeof releasePost).toBe('function');

    // Another key evicts keyA while keyA's L2 POST is still in flight.
    cache._set(keyB, 'kafka', 'mB', [direct('beta')], 'ok', 60000);
    expect(cache.entries.has(keyA)).toBe(false);
    expect(cache.entries.has(keyB)).toBe(true);
    expect(outcomes).toContainEqual(expect.objectContaining({
      source: 'kafka', matchId: 'mA', candidateId: 'chA', stage: 'cache', reason: 'lru_evicted'
    }));

    releasePost();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mintA).toHaveBeenCalledTimes(1);
    expect(r1).toEqual([direct('alpha')]);
    expect(r2).toEqual([direct('alpha')]);
    // Independent clones: mutating r1 must not affect r2.
    r1[0].behaviorHints.proxyHeaders.request.Referer = 'https://mutated.invalid/';
    expect(r2[0].behaviorHints.proxyHeaders.request.Referer).toBe('https://ref.fixture.test/');
    // Unrelated entry survives and evicted key remains absent.
    expect(cache.entries.has(keyB)).toBe(true);
    expect(cache.entries.has(keyA)).toBe(false);
  });

  test('explicit invalidation after eviction but before delivery revokes the retained delivery copy', async () => {
    let releasePost;
    const sharedResolver = {
      available: () => true,
      request: jest.fn(async (raw, opts = {}) => {
        const url = new URL(raw);
        if (url.searchParams.get('claim') === '1') {
          return { ok: true, json: async () => ({ ok: true, ownerToken: '11111111-1111-4111-8111-111111111111' }) };
        }
        if (opts.method === 'POST' && url.pathname !== '/api/cache/prune') {
          return new Promise((resolve) => {
            releasePost = () => resolve({ ok: true, json: async () => ({ ok: true, revision: '22222222-2222-4222-8222-222222222222' }) });
          });
        }
        if (opts.method === 'PATCH') {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: true, json: async () => ({ status: 'miss' }) };
      })
    };

    const cache = new StreamResolveCache({ maxEntries: 1, sharedResolver });
    const keyA = 'kafka:mA:chA';
    const p1 = cache.getOrCreate(keyA, async () => [direct('alpha')]);
    await jest.advanceTimersByTimeAsync(0);

    // Evict keyA, then explicitly invalidate it before POST finishes.
    cache._set('kafka:mB:chB', 'kafka', 'mB', [direct('beta')], 'ok', 60000);
    expect(cache.entries.has(keyA)).toBe(false);
    cache.noteFailure(keyA);

    releasePost();
    const r1 = await p1;
    expect(r1).toEqual([]);
  });

  test('pruneEnded before completion revokes retained media even after eviction', async () => {
    let releasePost;
    const sharedResolver = {
      available: () => true,
      request: jest.fn(async (raw, opts = {}) => {
        const url = new URL(raw);
        if (url.searchParams.get('claim') === '1') {
          return { ok: true, json: async () => ({ ok: true, ownerToken: '11111111-1111-4111-8111-111111111111' }) };
        }
        if (opts.method === 'POST' && url.pathname !== '/api/cache/prune') {
          return new Promise((resolve) => {
            releasePost = () => resolve({ ok: true, json: async () => ({ ok: true, revision: '22222222-2222-4222-8222-222222222222' }) });
          });
        }
        return { ok: true, json: async () => ({ status: 'miss' }) };
      })
    };

    const cache = new StreamResolveCache({ maxEntries: 1, sharedResolver });
    const keyA = 'kafka:mA:chA';
    const p1 = cache.getOrCreate(keyA, async () => [direct('alpha')]);
    await jest.advanceTimersByTimeAsync(0);
    expect(typeof releasePost).toBe('function');

    cache._set('kafka:mB:chB', 'kafka', 'mB', [direct('beta')], 'ok', 60000);
    cache.pruneEnded(['mB']);

    releasePost();
    const r1 = await p1;
    expect(r1).toEqual([]);
  });

  test('expiry before delivery prevents stale retained media from escaping', async () => {
    let releasePost;
    const sharedResolver = {
      available: () => true,
      request: jest.fn(async (raw, opts = {}) => {
        const url = new URL(raw);
        if (url.searchParams.get('claim') === '1') {
          return { ok: true, json: async () => ({ ok: true, ownerToken: '11111111-1111-4111-8111-111111111111' }) };
        }
        if (opts.method === 'POST' && url.pathname !== '/api/cache/prune') {
          return new Promise((resolve) => {
            releasePost = () => resolve({ ok: true, json: async () => ({ ok: true, revision: '22222222-2222-4222-8222-222222222222' }) });
          });
        }
        return { ok: true, json: async () => ({ status: 'miss' }) };
      })
    };

    const cache = new StreamResolveCache({ maxEntries: 1, defaultTtlMs: 1000, sharedResolver });
    const keyA = 'kafka:mA:chA';
    const p1 = cache.getOrCreate(keyA, async () => [direct('alpha')]);
    await jest.advanceTimersByTimeAsync(0);

    cache._set('kafka:mB:chB', 'kafka', 'mB', [direct('beta')], 'ok', 60000);
    await jest.advanceTimersByTimeAsync(1500);

    releasePost();
    const r1 = await p1;
    expect(r1).toEqual([]);
  });

  test('newer same-key result wins over older evicted snapshot', async () => {
    let releasePost;
    const sharedResolver = {
      available: () => true,
      request: jest.fn(async (raw, opts = {}) => {
        const url = new URL(raw);
        if (url.searchParams.get('claim') === '1') {
          return { ok: true, json: async () => ({ ok: true, ownerToken: '11111111-1111-4111-8111-111111111111' }) };
        }
        if (opts.method === 'POST' && url.pathname !== '/api/cache/prune') {
          return new Promise((resolve) => {
            releasePost = () => resolve({ ok: true, json: async () => ({ ok: true, revision: '22222222-2222-4222-8222-222222222222' }) });
          });
        }
        return { ok: true, json: async () => ({ status: 'miss' }) };
      })
    };

    const cache = new StreamResolveCache({ maxEntries: 1, sharedResolver });
    const keyA = 'kafka:mA:chA';
    const p1 = cache.getOrCreate(keyA, async () => [direct('older')]);
    await jest.advanceTimersByTimeAsync(0);

    cache._set('kafka:mB:chB', 'kafka', 'mB', [direct('beta')], 'ok', 60000);
    const newer = cache._set(keyA, 'kafka', 'mA', [direct('newer')], 'ok', 60000);

    releasePost();
    const r1 = await p1;
    expect(r1).toEqual([direct('newer')]);
    expect(cache.entries.get(keyA)).toBe(newer);
  });

  test('L2-adopted result evicted during shared I/O still delivers to registered callers, while post-completion caller uses normal cache', async () => {
    let releaseGet;
    const keyA = 'kafka:mA:chA';
    const keyB = 'kafka:mB:chB';
    let l2Calls = 0;
    const sharedResolver = {
      available: () => true,
      request: jest.fn(async (raw) => {
        l2Calls += 1;
        const url = new URL(raw);
        if (url.pathname.includes(encodeURIComponent(keyA))) {
          return new Promise((resolve) => {
            releaseGet = () => resolve({
              ok: true,
              json: async () => ({
                status: 'ok',
                streams: [direct('adopted')],
                expiresAt: Date.now() + 60000,
                revision: '33333333-3333-4333-8333-333333333333'
              })
            });
          });
        }
        return { ok: true, json: async () => ({ status: 'miss' }) };
      })
    };

    const cache = new StreamResolveCache({ maxEntries: 1, sharedResolver });
    const p1 = cache.getOrCreate(keyA, () => { throw new Error('Should adopt L2'); });
    const p2 = cache.getOrCreate(keyA, () => { throw new Error('Should join inFlight'); });
    for (let i = 0; i < 10 && !releaseGet; i += 1) await Promise.resolve();
    expect(typeof releaseGet).toBe('function');

    // Resolve keyA from L2, then immediately evict keyA with keyB before p1/p2 consume it.
    releaseGet();
    // Wait just enough microtasks for _adoptRemote to run, then evict keyA before p1/p2 resolve?
    // Even better: keyB's getOrCreate runs concurrently and evicts keyA on its own completion,
    // or we evict keyA right after _adoptRemote via a microtask hook on entries.set.
    const origSet = cache.entries.set.bind(cache.entries);
    cache.entries.set = (k, v) => {
      const res = origSet(k, v);
      if (k === keyA) {
        cache.entries.set = origSet;
        cache._set(keyB, 'kafka', 'mB', [direct('beta')], 'ok', 60000);
      }
      return res;
    };

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual([direct('adopted')]);
    expect(r2).toEqual([direct('adopted')]);
    expect(cache.entries.has(keyA)).toBe(false);
    expect(cache.entries.has(keyB)).toBe(true);

    // A caller arriving AFTER delivery completes must use normal cache/claim rules (not retained delivery copy).
    const beforeCalls = l2Calls;
    sharedResolver.request.mockImplementation(async (raw) => {
      l2Calls += 1;
      const url = new URL(raw);
      if (url.searchParams.get('claim') === '1') {
        return { ok: true, json: async () => ({ ok: true, ownerToken: '11111111-1111-4111-8111-111111111111' }) };
      }
      if (url.pathname.startsWith('/api/cache/')) {
        return { ok: true, json: async () => ({ status: 'miss' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const afterMint = jest.fn(async () => [direct('fresh-after')]);
    const r3 = await cache.getOrCreate(keyA, afterMint);
    expect(l2Calls).toBeGreaterThan(beforeCalls);
    expect(afterMint).toHaveBeenCalledTimes(1);
    expect(r3).toEqual([direct('fresh-after')]);
  });
});
