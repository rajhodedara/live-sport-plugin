'use strict';

// Gate for best-effort background lookups against ONE upstream (team crests from
// TheSportsDB). It exists because those lookups are fire-and-forget from several
// hot paths (catalog build, poster route, post-sync enrichment) and failures were
// not remembered, so under pressure every request re-issued them and they came to
// monopolise the shared 4-slot native pool.
//
// It does three independent things:
//   - caps how many lookups run at once (and how many may wait),
//   - backs off per key after a failure, with exponential growth,
//   - opens a process-wide breaker on signals that the upstream or the pool is
//     overloaded (capacity rejection, 429, 5xx, timeout), so everything pauses
//     instead of retrying in lockstep.
// A skipped lookup returns "unknown" to the caller; nothing is cached as a miss.

function createLookupGate({
  concurrency = 2,
  maxQueue = 200,
  breakerBaseMs = 30000,
  breakerMaxMs = 300000,
  keyBackoffBaseMs = 60000,
  keyBackoffMaxMs = 1800000,
  maxKeys = 5000,
  now = Date.now,
} = {}) {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const queueLimit = Math.max(0, Math.floor(maxQueue) || 0);
  const failures = new Map();            // key -> { count, until }
  const breaker = { count: 0, until: 0 };
  const waiters = [];
  let active = 0;

  const growth = (base, max, count) => Math.min(max, base * 2 ** Math.min(Math.max(count - 1, 0), 20));

  function blockedReason(key) {
    const t = now();
    if (breaker.until > t) return 'breaker';
    const entry = failures.get(key);
    if (entry && entry.until > t) return 'backoff';
    return null;
  }

  // Resolves to an idempotent release function, or null when the wait queue is full
  // (the caller should drop the lookup; it will be retried by a later request).
  async function acquire() {
    if (active < limit) active++;
    else if (waiters.length >= queueLimit) return null;
    else { await new Promise(resolve => waiters.push(resolve)); }
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) next();          // the slot is handed over, `active` stays the same
      else active--;
    };
  }

  function recordSuccess(key) {
    failures.delete(key);
    breaker.count = 0;
  }

  function recordFailure(key, { trip = false } = {}) {
    const t = now();
    const prev = failures.get(key);
    const count = (prev ? prev.count : 0) + 1;
    failures.delete(key);                                  // refresh insertion order
    failures.set(key, { count, until: t + growth(keyBackoffBaseMs, keyBackoffMaxMs, count) });
    while (failures.size > maxKeys) failures.delete(failures.keys().next().value);
    if (trip && breaker.until <= t) {
      breaker.count++;
      breaker.until = t + growth(breakerBaseMs, breakerMaxMs, breaker.count);
    }
  }

  return {
    blockedReason, acquire, recordSuccess, recordFailure,
    stats: () => ({ active, queued: waiters.length, trackedKeys: failures.size, breakerUntil: breaker.until, breakerCount: breaker.count }),
  };
}

// True for a refusal by the local native pool (as opposed to an upstream answer).
function isCapacityError(error) {
  const seen = new Set();
  for (let e = error; e && typeof e === 'object' && !seen.has(e) && seen.size < 8; e = e.cause) {
    seen.add(e);
    if (e.code === 'ERR_OUTBOUND_CAPACITY' || /^ERR_NATIVE_(POOL|SLOT)_/.test(e.code || '')) return true;
  }
  return false;
}

module.exports = { createLookupGate, isCapacityError };
