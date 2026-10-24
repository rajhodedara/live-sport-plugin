'use strict';

/**
 * Tests for the global mint semaphore in StreamResolveCache.getOrCreate.
 *
 * Background (live VPS, 2026-10-24): 250+ concurrent mints saturated the box
 * (heap tracked in-flight mints 1:1; 7,500 TCP sockets). The semaphore caps
 * mintFn executions globally: on-demand callers wait up to mintQueueWaitMs,
 * prewarm callers (opts.skipIfBusy) shed instantly. A shed mint writes NO
 * cache entry — not even negative — so the next request retries naturally.
 */

jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));

// Isolate from the shared L2 (resolver on 127.0.0.1:7003) — a locally running
// dev resolver would answer the L2 lookups and bypass the shed path entirely.
process.env.RESOLVE_CACHE_SHARED = 'false';

const StreamResolveCache = require('../src/services/StreamResolveCache');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('mint semaphore (StreamResolveCache.getOrCreate)', () => {
  let cache;

  beforeEach(() => {
    cache = new StreamResolveCache({ mintMaxConcurrent: 1, mintQueueWaitMs: 100 });
  });

  afterEach(() => {
    cache.entries.clear();
  });

  test('skipIfBusy sheds instantly when full: no entry, no negative cache', async () => {
    cache._mintActive = cache.mintMaxConcurrent; // simulate full
    const res = await cache.getOrCreate('k1', async () => [{ url: 'x' }], { skipIfBusy: true });

    expect(res).toEqual([]);
    expect(cache.entries.size).toBe(0);                 // nothing cached — not even negative
    expect(cache.stats().shedMints).toBe(1);
    expect(cache._mintActive).toBe(cache.mintMaxConcurrent); // slot accounting untouched
  });

  test('a shed key mints normally once a slot frees (no poison)', async () => {
    cache._mintActive = cache.mintMaxConcurrent;
    await cache.getOrCreate('k1', async () => [{ url: 'x' }], { skipIfBusy: true });

    cache._mintActive = 0;
    const res = await cache.getOrCreate('k1', async () => [{ url: 'x' }], { skipIfBusy: true });
    expect(res).toHaveLength(1);
    expect(cache.entries.get('k1').status).toBe('ok');
  });

  test('on-demand caller waits for a slot and then mints', async () => {
    cache._mintActive = 1; // full
    let released = false;

    const waiter = cache.getOrCreate('k2', async () => {
      expect(released).toBe(true);
      return [{ url: 'y' }];
    });
    await sleep(5); // let getOrCreate reach the parking spot (microtask chain)
    expect(cache._mintWaitersLo.length).toBe(1); // parked, not running

    setTimeout(() => {
      released = true;
      // Simulate the slot holder finishing: with slot-transfer semantics the
      // release hands ownership straight to the waiter (count stays 1 — the
      // waiter's own finally decrements when its mint completes).
      cache._mintWaitersLo.shift()?.();
    }, 20);

    const res = await waiter;
    expect(res).toHaveLength(1);
    expect(cache.entries.get('k2').status).toBe('ok');
    expect(cache._mintActive).toBe(0);                  // drained cleanly
    expect(cache._mintWaitersLo.length).toBe(0);
  });

  test('on-demand caller sheds after the wait window (no entry written)', async () => {
    cache._mintActive = 1; // full, nobody ever releases
    let mintRan = false;
    const res = await cache.getOrCreate('k3', async () => { mintRan = true; return [{ url: 'z' }]; });

    expect(res).toEqual([]);
    expect(mintRan).toBe(false);
    expect(cache.entries.size).toBe(0);                 // no negative cache on shed
    expect(cache.stats().shedMints).toBe(1);
  });

  test('isMintPressureHigh trips at 75% of capacity', () => {
    const c = new StreamResolveCache({ mintMaxConcurrent: 4 });
    c._mintActive = 2;
    expect(c.isMintPressureHigh()).toBe(false);
    c._mintActive = 3;
    expect(c.isMintPressureHigh()).toBe(true);
  });

  test('queued waiters are handed slots on release (no over-cap race)', async () => {
    const c = new StreamResolveCache({ mintMaxConcurrent: 2, mintQueueWaitMs: 500 });
    let hold1 = () => {}, hold2 = () => {};
    const gate1 = new Promise((r) => { hold1 = r; });
    const gate2 = new Promise((r) => { hold2 = r; });

    const p1 = c.getOrCreate('w1', async () => { await gate1; return [{ url: '1' }]; });
    await sleep(5);
    const p2 = c.getOrCreate('w2', async () => { await gate2; return [{ url: '2' }]; });
    await sleep(5);
    expect(c._mintActive).toBe(2);          // both slots held by real mints

    const p3 = c.getOrCreate('w3', async () => [{ url: '3' }]);
    await sleep(5);
    expect(c._mintWaitersLo.length).toBe(1);  // w3 parked

    hold1();                                // release → slot hands off to w3
    const r1 = await p1;
    expect(c._mintWaitersLo.length).toBe(0);
    hold2();
    const [r2, r3] = await Promise.all([p2, p3]);

    expect(r1.length).toBe(1);
    expect(r2.length).toBe(1);
    expect(r3.length).toBe(1);
    expect(c._mintActive).toBe(0);
  });
});
