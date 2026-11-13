'use strict';

const { createLookupGate, isCapacityError } = require('../src/services/OutboundLookupGate');

const clock = (start = 1000000) => { let t = start; const now = () => t; now.advance = (ms) => { t += ms; }; return now; };

describe('createLookupGate: concurrency', () => {
  test('never runs more lookups than the limit, and hands slots over in order', async () => {
    const gate = createLookupGate({ concurrency: 2 });
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    expect(gate.stats().active).toBe(2);
    const order = [];
    const p3 = gate.acquire().then(r => { order.push(3); return r; });
    const p4 = gate.acquire().then(r => { order.push(4); return r; });
    await Promise.resolve();
    expect(gate.stats().queued).toBe(2);
    expect(order.length).toBe(0);
    r1();
    const r3 = await p3;
    expect(order.join(',')).toBe('3');
    expect(gate.stats().active).toBe(2);   // handed over, not freed
    r2();
    const r4 = await p4;
    expect(order.join(',')).toBe('3,4');
    r3(); r4();
    expect(gate.stats().active).toBe(0);
  });

  test('a full wait queue refuses instead of growing', async () => {
    const gate = createLookupGate({ concurrency: 1, maxQueue: 2 });
    const first = await gate.acquire();
    gate.acquire(); gate.acquire();                  // two waiters
    expect(await gate.acquire()).toBe(null);
    expect(gate.stats().queued).toBe(2);
    first();
  });

  test('release is idempotent: a double release cannot free a slot it does not own', async () => {
    const gate = createLookupGate({ concurrency: 1 });
    const release = await gate.acquire();
    release(); release();
    expect(gate.stats().active).toBe(0);
    const again = await gate.acquire();
    expect(gate.stats().active).toBe(1);
    again();
  });
});

describe('createLookupGate: per-key backoff', () => {
  test('doubles after each failure, is capped, and expires', () => {
    const now = clock();
    const gate = createLookupGate({ now, keyBackoffBaseMs: 1000, keyBackoffMaxMs: 4000 });
    expect(gate.blockedReason('a')).toBe(null);
    gate.recordFailure('a');
    expect(gate.blockedReason('a')).toBe('backoff');
    expect(gate.blockedReason('b')).toBe(null);       // other keys are unaffected
    now.advance(1001);
    expect(gate.blockedReason('a')).toBe(null);
    gate.recordFailure('a');                           // 2nd failure: 2000 ms
    now.advance(1500);
    expect(gate.blockedReason('a')).toBe('backoff');
    now.advance(600);
    expect(gate.blockedReason('a')).toBe(null);
    gate.recordFailure('a'); now.advance(4001);        // 3rd would be 4000, cap holds
    expect(gate.blockedReason('a')).toBe(null);
    gate.recordFailure('a');                           // 4th: still capped at 4000
    now.advance(3999);
    expect(gate.blockedReason('a')).toBe('backoff');
  });

  test('a success clears the key', () => {
    const now = clock();
    const gate = createLookupGate({ now });
    gate.recordFailure('a');
    gate.recordSuccess('a');
    expect(gate.blockedReason('a')).toBe(null);
  });

  test('the number of tracked keys is bounded', () => {
    const gate = createLookupGate({ maxKeys: 10 });
    for (let i = 0; i < 100; i++) gate.recordFailure(`k${i}`);
    expect(gate.stats().trackedKeys).toBe(10);
  });
});

describe('createLookupGate: breaker', () => {
  test('a tripping failure pauses every key, then reopens, and doubles on repeats', () => {
    const now = clock();
    const gate = createLookupGate({ now, breakerBaseMs: 1000, breakerMaxMs: 3000, keyBackoffBaseMs: 1 });
    gate.recordFailure('a', { trip: true });
    expect(gate.blockedReason('other-key')).toBe('breaker');
    now.advance(1001);
    expect(gate.blockedReason('other-key')).toBe(null);
    gate.recordFailure('b', { trip: true });           // 2nd trip: 2000 ms
    now.advance(1500);
    expect(gate.blockedReason('other-key')).toBe('breaker');
    now.advance(600);
    expect(gate.blockedReason('other-key')).toBe(null);
  });

  test('failures while it is already open do not extend or re-count it', () => {
    const now = clock();
    const gate = createLookupGate({ now, breakerBaseMs: 1000, keyBackoffBaseMs: 1 });
    gate.recordFailure('a', { trip: true });
    const until = gate.stats().breakerUntil;
    now.advance(200);
    gate.recordFailure('b', { trip: true });
    expect(gate.stats().breakerUntil).toBe(until);
    expect(gate.stats().breakerCount).toBe(1);
  });

  test('a success resets the escalation', () => {
    const now = clock();
    const gate = createLookupGate({ now, breakerBaseMs: 1000, keyBackoffBaseMs: 1 });
    gate.recordFailure('a', { trip: true });
    now.advance(1001);
    gate.recordSuccess('x');
    expect(gate.stats().breakerCount).toBe(0);
  });
});

describe('isCapacityError', () => {
  test('recognises pool refusals anywhere in the cause chain, and nothing else', () => {
    expect(isCapacityError({ code: 'ERR_OUTBOUND_CAPACITY' })).toBe(true);
    expect(isCapacityError({ code: 'ERR_NATIVE_POOL_BUSY' })).toBe(true);
    expect(isCapacityError({ code: 'ERR_NATIVE_SLOT_CAPACITY' })).toBe(true);
    expect(isCapacityError({ code: 'X', cause: { code: 'ERR_OUTBOUND_CAPACITY' } })).toBe(true);
    expect(isCapacityError({ code: 'ECONNRESET' })).toBe(false);
    expect(isCapacityError(null)).toBe(false);
    const loop = { code: 'X' }; loop.cause = loop;
    expect(isCapacityError(loop)).toBe(false);
  });
});
