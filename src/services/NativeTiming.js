'use strict';

const { randomBytes } = require('node:crypto');
const { currentTimingWork } = require('./TimingContext');
const { sharedTimingOutput } = require('./TimingOutput');

// Experiment only: fixed-schema events, no caller-provided fields.
function createNativeTiming({ enabled = false, emitStarts = false, emit = row => sharedTimingOutput().write('native_timing', row), emitSummary = row => console.info('[NativeTimingSummary]', JSON.stringify({ ...row, ...sharedTimingOutput().identity })), now = () => performance.now(), maxEvents = 100000 } = {}) {
  let emitted = 0, dropped = 0, pending = 0;
  const safePoolId = value => typeof value === 'string' && /^[a-f0-9]{8}$/.test(value) ? value : null;
  function publish(row) {
    if (!enabled) return;
    if (emitted + pending >= maxEvents) { dropped++; return; }
    pending++;
    try { if (emit(row) === false) dropped++; else emitted++; } catch (_) { dropped++; } finally { pending--; }
  }
  return {
    get enabled() { return enabled; },
    get stats() { return { emitted, dropped }; },
    report(poolId) {
      if (!enabled) return;
      try { emitSummary({ type: 'native_timing_summary', poolId: safePoolId(poolId), emitted, dropped }); } catch (_) { /* diagnostic only */ }
    },
    start(rawPoolId, rawOwner) {
      if (!enabled) return { enqueued() {}, admitted() {}, spawnAttempt() {}, spawned() {}, spawnObserved() {}, requestReceived() {}, childPhase() {}, childSnapshot() {}, exited() {}, finish() {} };
      const id = randomBytes(8).toString('hex'), started = now(), workId = currentTimingWork();
      const poolId = safePoolId(rawPoolId);
      const owner = ['manifest', 'wasm', 'catalog'].includes(rawOwner) ? rawOwner : 'other';
      if (emitStarts) publish({ type: 'http_start', id, workId, poolId });
      let enqueuedAt, admittedAt, spawnAttemptAt, spawnedAt, finished = false, exited = false, received = false, spawnObserved = false, childDiagnosticSnapshot = null;
      const seenChildPhases = new Set();
      let duplicateChildEvents = 0, invalidChildEvents = 0;
      const elapsed = (begin, end) => Math.max(0, Math.round(end - begin));
      return {
        enqueued() { enqueuedAt = now(); },
        admitted() { admittedAt = now(); },
        spawnAttempt() { spawnAttemptAt = now(); },
        spawned() { spawnedAt = now(); },
        spawnObserved() {
          if (spawnObserved || spawnAttemptAt === undefined) return;
          spawnObserved = true;
          publish({ type: 'child_spawn_observed', id, workId, poolId, sinceSpawnAttemptMs: elapsed(spawnAttemptAt, now()) });
        },
        requestReceived() {
          if (received) { duplicateChildEvents++; return; }
          if (spawnedAt === undefined) { invalidChildEvents++; return; }
          received = true;
          publish({ type: 'child_request_received', id, workId, poolId, sinceSpawnMs: elapsed(spawnedAt, now()) });
        },
        childPhase(phase, hop, childElapsedMs) {
          if (!['fetch_start', 'response_received', 'body_read_end'].includes(phase) ||
              !Number.isInteger(hop) || hop < 0 || hop > 5 || !Number.isSafeInteger(childElapsedMs) || childElapsedMs < 0) {
            invalidChildEvents++; return;
          }
          const phaseKey = `${hop}:${phase}`;
          if (seenChildPhases.has(phaseKey)) { duplicateChildEvents++; return; }
          seenChildPhases.add(phaseKey);
          publish({ type: 'child_http_phase', id, workId, poolId, phase, hop, childElapsedMs });
        },
        childSnapshot(snapshot) {
          if (!snapshot || !['attempted', 'pending', 'failed', 'backpressure'].every(key =>
            Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0 && snapshot[key] <= 32)) return;
          if (snapshot.pending > snapshot.attempted || snapshot.failed > snapshot.attempted || snapshot.backpressure > snapshot.attempted) return;
          childDiagnosticSnapshot = { attempted: snapshot.attempted, pending: snapshot.pending,
            failed: snapshot.failed, backpressure: snapshot.backpressure };
        },
        exited() {
          if (exited || spawnedAt === undefined) return;
          exited = true;
          publish({ type: 'child_exit', id, workId, poolId, childLifetimeMs: elapsed(spawnedAt, now()) });
        },
        finish(failure) {
          if (finished) return;
          finished = true;
          const ended = now();
          const outcome = !failure ? 'success' : failure.name === 'TimeoutError' ? 'timeout' :
            failure.name === 'AbortError' ? 'canceled' : failure.code === 'ERR_NATIVE_POOL_BUSY' ? 'capacity' : 'error';
          publish({ type: 'http_terminal', id, workId, poolId, owner, outcome, childDiagnosticSnapshot,
            duplicateChildEvents, invalidChildEvents, totalMs: elapsed(started, ended),
            queueMs: enqueuedAt === undefined ? null : elapsed(enqueuedAt, admittedAt === undefined ? ended : admittedAt),
            enqueued: enqueuedAt !== undefined, admitted: admittedAt !== undefined,
            spawnCallMs: spawnedAt === undefined || spawnAttemptAt === undefined ? null : elapsed(spawnAttemptAt, spawnedAt),
            spawnReturned: spawnedAt !== undefined });
        }
      };
    }
  };
}

module.exports = { createNativeTiming };
