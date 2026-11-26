'use strict';

const { createAttemptTimeoutError, isTransientError, isTransientStatus } = require('./retry');

const providerJobs = new WeakMap();
const fallbackJobs = new Map();
const providerListeners = new WeakMap();
const fallbackListeners = new Map();

const DEFAULT_JOB_TIMEOUT_MS = 60 * 1000;
const DEFAULT_UPSTREAM_MIN_LOCAL = 6;
const DEFAULT_PROBE_WORKERS = 2;

const RETRYABLE_REASONS = new Set([
  'resolve_timeout',
  'playlist_timeout',
  'segment_timeout',
  'http_429',
  'http_5xx',
  'capacity',
  'unavailable',
  'liveness_inconclusive',
  'timeout'
]);

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
]);

function getProbeConcurrency(provider) {
  const value = typeof provider?.getEventProbeConcurrency === 'function'
    ? provider.getEventProbeConcurrency()
    : DEFAULT_PROBE_WORKERS;
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : DEFAULT_PROBE_WORKERS;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function getJobTimeoutMs() {
  return toPositiveInt(process.env.KAFKA_EVENT_JOB_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS);
}

function getUpstreamMinLocal(provider) {
  if (typeof provider?.upstreamMinLocal === 'function') return provider.upstreamMinLocal();
  const raw = process.env.KAFKA_EVENT_UPSTREAM_MIN_LOCAL;
  if (raw === undefined || raw === '') return DEFAULT_UPSTREAM_MIN_LOCAL;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_UPSTREAM_MIN_LOCAL;
}

function getMaxCandidates() {
  const raw = process.env.KAFKA_EVENT_MAX_CANDIDATES;
  if (raw === undefined || raw === '') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}

function jobStoreFor(provider) {
  if (!provider || typeof provider !== 'object') return fallbackJobs;
  let store = providerJobs.get(provider);
  if (!store) {
    store = new Map();
    providerJobs.set(provider, store);
  }
  return store;
}

function listenerStoreFor(provider) {
  if (!provider || typeof provider !== 'object') return fallbackListeners;
  let store = providerListeners.get(provider);
  if (!store) {
    store = new Map();
    providerListeners.set(provider, store);
  }
  return store;
}

function addKeyListener(provider, key, listener) {
  if (typeof listener !== 'function') return () => {};
  const store = listenerStoreFor(provider);
  let set = store.get(key);
  if (!set) {
    set = new Set();
    store.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) store.delete(key);
  };
}

function fixtureJobKey(match) {
  return JSON.stringify([String(match?.id || ''), String(match?.date || '')]);
}

function normalizeKickoffMs(dateValue) {
  if (typeof dateValue === 'number' && Number.isFinite(dateValue) && dateValue > 0) {
    return String(Math.floor(dateValue));
  }
  if (typeof dateValue === 'string') {
    const trimmed = dateValue.trim();
    if (!trimmed) return '0';
    if (/^\d+$/.test(trimmed)) return trimmed;
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return String(Math.floor(parsed));
  }
  if (dateValue instanceof Date && Number.isFinite(dateValue.getTime()) && dateValue.getTime() > 0) {
    return String(Math.floor(dateValue.getTime()));
  }
  return '0';
}

function kafkaEventCandidateKey(match, candidateId) {
  return `kafka:${String(match?.id || '')}:${String(candidateId || '')}:event-v4:${normalizeKickoffMs(match?.date)}`;
}

function parseKafkaEventCandidateKey(key) {
  if (typeof key !== 'string' || !key.startsWith('kafka:')) return null;
  const marker = ':event-v4:';
  const markerIdx = key.lastIndexOf(marker);
  if (markerIdx <= 'kafka:'.length) return null;
  const kickoffMs = key.slice(markerIdx + marker.length);
  if (!/^\d+$/.test(kickoffMs)) return null;
  const rest = key.slice('kafka:'.length, markerIdx);
  const firstColon = rest.indexOf(':');
  if (firstColon <= 0 || firstColon >= rest.length - 1) return null;
  const fixtureId = rest.slice(0, firstColon);
  const candidateId = rest.slice(firstColon + 1);
  if (!fixtureId || !candidateId) return null;
  return { fixtureId, candidateId, kickoffMs, version: 'event-v4', rest };
}

function _cloneHintsTree(v) {
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i += 1) out[i] = _cloneHintsTree(v[i]);
    return out;
  }
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k in v) out[k] = _cloneHintsTree(v[k]);
    return out;
  }
  return v;
}

function cloneCandidateStream(stream) {
  if (!stream || typeof stream !== 'object') return stream;
  const copy = { ...stream };
  if (stream.behaviorHints && typeof stream.behaviorHints === 'object') {
    copy.behaviorHints = _cloneHintsTree(stream.behaviorHints);
  }
  return copy;
}

function emitCandidateOutcome(job, { candidateId, stage, reason, attempt }) {
  if (!job || !job.outcomeListeners || job.outcomeListeners.size === 0) return;
  const event = {
    fixtureId: job.fixtureId,
    candidateId: String(candidateId || ''),
    stage,
    reason: String(reason || stage),
    attempt: Number(attempt) || 0,
    elapsedMs: Math.max(0, Date.now() - job.startedAt)
  };
  for (const listener of job.outcomeListeners) {
    try { listener(event); } catch (_) {}
  }
}

function classifyFailureReason(err, signal) {
  if (signal?.aborted || err?.name === 'AbortError') {
    return { reason: 'deadline_expired', retryable: false };
  }
  if (err && typeof err.kafkaFailureReason === 'string' && err.kafkaFailureReason) {
    const r = err.kafkaFailureReason;
    return { reason: r, retryable: RETRYABLE_REASONS.has(r) };
  }
  if (err?.code === 'ERR_OUTBOUND_CAPACITY' || /^ERR_NATIVE_(POOL|SLOT)_/.test(err?.code || '')) {
    return { reason: 'capacity', retryable: true };
  }
  if (err?.name === 'TimeoutError' || TIMEOUT_CODES.has(err?.code)) {
    return { reason: 'resolve_timeout', retryable: true };
  }
  if (err?.statusCode === 429) {
    return { reason: 'http_429', retryable: true };
  }
  if (isTransientStatus(err?.statusCode)) {
    return { reason: 'http_5xx', retryable: true };
  }
  if (err?.code === 'ERR_OUTBOUND_BLOCKED' || err?.isFatal || [400, 401, 403, 404, 410].includes(err?.statusCode)) {
    return { reason: 'definitive_rejection', retryable: false };
  }
  if (isTransientError(err)) {
    return { reason: 'unavailable', retryable: true };
  }
  return { reason: 'definitive_rejection', retryable: false };
}

function enqueueCandidates(job, candidates, maxCandidates) {
  for (const candidate of candidates || []) {
    if (!candidate?.id) continue;
    const id = String(candidate.id);
    if (job.queuedIds.has(id) || job.attemptedIds.has(id)) continue;
    if (job.uniqueCandidateIds.size >= maxCandidates) break;
    job.uniqueCandidateIds.add(id);
    job.queuedIds.add(id);
    job.queue.push(candidate);
    emitCandidateOutcome(job, {
      candidateId: id,
      stage: 'queued',
      reason: 'queued',
      attempt: 0
    });
  }
}

function buildMetrics(job, reason, provider) {
  return {
    discovered: job.queue.length,
    localHits: job.localHits,
    sqliteHits: job.searchStats.sqliteHits ?? job.localHits,
    upstreamSearches: job.searchStats.upstreamSearches || 0,
    sharedSearches: job.searchStats.sharedSearches || 0,
    attempts: job.attemptedIds.size,
    verified: job.verifiedByUrl.size,
    reason,
    searchStats: provider?.eventSearch?.stats ? {
      requests: provider.eventSearch.stats.requests || 0,
      sweepRequests: provider.eventSearch.stats.sweepRequests || 0,
      shared: provider.eventSearch.stats.shared || 0
    } : null
  };
}

function emitProgress(provider, job) {
  pruneInvalidVerified(job);
  const listeners = listenerStoreFor(provider).get(job.id);
  if (!listeners || listeners.size === 0) return;
  const snapshot = [...job.verifiedByUrl.values()].map(cloneCandidateStream);
  for (const listener of listeners) {
    try { listener(snapshot); } catch (_) {}
  }
}

function pruneInvalidVerified(job, overrideValidator = null) {
  const isValid = typeof overrideValidator === 'function' ? overrideValidator : job?.isStreamValid;
  if (!job || typeof isValid !== 'function' || job.verifiedByUrl.size === 0) return 0;
  let evicted = 0;
  for (const [url, stream] of job.verifiedByUrl.entries()) {
    let ok = false;
    try { ok = Boolean(isValid(stream)); } catch (_) { ok = false; }
    if (!ok) {
      job.verifiedByUrl.delete(url);
      evicted += 1;
    }
  }
  if (evicted > 0 && job.done) job.consumedComplete = true;
  return evicted;
}

function wakeWaiters(job) {
  for (const wake of job.waiters) {
    try { wake(); } catch (_) {}
  }
}

function wakeQueueWaiters(job) {
  for (const wake of job.queueWaiters) {
    try { wake(); } catch (_) {}
  }
  job.queueWaiters.clear();
}

function runWithProbeSlot(provider, fn, signal) {
  if (typeof provider?.withEventProbe === 'function') {
    return provider.withEventProbe(fn, signal);
  }
  return Promise.resolve().then(fn);
}

function normalizeProbeOutcome(rawOutcome) {
  if (Array.isArray(rawOutcome)) {
    return { streams: rawOutcome, retryableReason: null, rejectReason: null, cacheHit: false };
  }
  if (rawOutcome && typeof rawOutcome === 'object') {
    return {
      streams: Array.isArray(rawOutcome.streams) ? rawOutcome.streams : [],
      retryableReason: rawOutcome.retryableReason || null,
      rejectReason: rawOutcome.rejectReason || null,
      cancelledBeforeStart: Boolean(rawOutcome.cancelledBeforeStart),
      cacheHit: Boolean(rawOutcome.cacheHit)
    };
  }
  return { streams: [], retryableReason: null, rejectReason: null, cacheHit: false };
}

async function pumpFixtureJob(job, { provider, match, probe, probeOwnsSlot = false }) {
  if (job.running || job.done) return;
  job.running = true;
  const maxCandidates = getMaxCandidates();
  const minLocal = getUpstreamMinLocal(provider);
  let upstreamInFlight = null;

  const remainingMs = Math.max(0, job.workDeadlineAt - Date.now());
  let jobTimer = null;
  if (remainingMs <= 0) {
    job.controller.abort(createAttemptTimeoutError());
  } else {
    jobTimer = setTimeout(() => {
      job.controller.abort(createAttemptTimeoutError());
      wakeQueueWaiters(job);
    }, remainingMs);
  }

  try {
    if (!job.localLoaded && !job.controller.signal.aborted && Date.now() < job.workDeadlineAt) {
      job.localLoaded = true;
      const local = (await provider.eventCandidates(match, {
        upstream: false,
        stats: job.searchStats
      })) || [];
      job.localHits = local.length;
      enqueueCandidates(job, local, maxCandidates);
    }

    const ensureUpstream = async () => {
      if (job.upstreamTried || job.controller.signal.aborted || Date.now() >= job.workDeadlineAt) return;
      if (job.localHits >= minLocal && job.verifiedByUrl.size > 0) return;
      if (upstreamInFlight) return upstreamInFlight;
      job.upstreamTried = true;
      upstreamInFlight = Promise.resolve()
        .then(() => provider.eventCandidates(match, {
          upstream: true,
          signal: job.controller.signal,
          stats: job.searchStats
        }))
        .then((extra) => {
          enqueueCandidates(job, extra, maxCandidates);
        })
        .catch((err) => {
          if (!job.verifiedByUrl.size && !job.queue.length) job.lastError = err;
        })
        .finally(() => {
          upstreamInFlight = null;
          wakeQueueWaiters(job);
        });
      return upstreamInFlight;
    };

    const waitQueueChange = () => new Promise((resolve) => {
      const done = () => {
        job.queueWaiters.delete(done);
        job.controller.signal.removeEventListener('abort', done);
        resolve();
      };
      if (job.controller.signal.aborted) {
        resolve();
        return;
      }
      job.queueWaiters.add(done);
      job.controller.signal.addEventListener('abort', done, { once: true });
    });

    const nextWorkItem = async () => {
      for (;;) {
        if (job.controller.signal.aborted || Date.now() >= job.workDeadlineAt) return null;
        if (job.nextIndex < job.queue.length && job.attemptedIds.size < maxCandidates) {
          const candidate = job.queue[job.nextIndex++];
          const id = candidate?.id ? String(candidate.id) : '';
          if (!id || job.attemptedIds.has(id)) continue;
          job.attemptedIds.add(id);
          return { candidate, attempt: 1, retryReason: null };
        }
        if (upstreamInFlight) {
          await upstreamInFlight;
          continue;
        }
        if (!job.upstreamTried && job.attemptedIds.size < maxCandidates && job.localHits < minLocal) {
          await ensureUpstream();
          continue;
        }
        if (job.retryQueue.length > 0) {
          return job.retryQueue.shift();
        }
        if (job.inFlightProbes > 0) {
          await waitQueueChange();
          continue;
        }
        return null;
      }
    };

    const worker = async () => {
      for (;;) {
        const item = await nextWorkItem();
        if (!item) break;
        const { candidate, attempt, retryReason } = item;
        const id = String(candidate.id);
        job.inFlightProbes += 1;
        try {
          const invokeProbe = async () => {
            if (job.controller.signal.aborted || Date.now() >= job.workDeadlineAt) {
              return { streams: [], retryableReason: null, rejectReason: 'deadline_expired', cancelledBeforeStart: true };
            }
            const onProbeStarted = () => {
              emitCandidateOutcome(job, {
                candidateId: id,
                stage: 'probe_started',
                reason: attempt > 1 ? (retryReason || 'retry') : 'initial',
                attempt
              });
            };
            if (!probeOwnsSlot) onProbeStarted();
            return probe(candidate, job.controller.signal, {
              attempt,
              retryReason,
              workDeadlineAt: job.workDeadlineAt,
              onProbeStarted
            });
          };
          const rawOutcome = probeOwnsSlot
            ? await invokeProbe()
            : await runWithProbeSlot(provider, invokeProbe, job.controller.signal);

          const outcome = normalizeProbeOutcome(rawOutcome);
          if (outcome.cancelledBeforeStart) {
            emitCandidateOutcome(job, {
              candidateId: id,
              stage: 'rejected',
              reason: 'deadline_expired',
              attempt
            });
            continue;
          }

          let added = false;
          let hadAnyUrl = false;
          let rejectedInvalidated = false;
          for (const stream of outcome.streams) {
            if (!stream?.url) continue;
            const candidateStream = cloneCandidateStream({ ...stream, _kafkaCandidateId: id });
            if (typeof job.isStreamValid === 'function' && !job.isStreamValid(candidateStream)) {
              rejectedInvalidated = true;
              continue;
            }
            hadAnyUrl = true;
            if (job.verifiedByUrl.has(candidateStream.url)) continue;
            job.verifiedByUrl.set(candidateStream.url, candidateStream);
            added = true;
          }

          if (added) {
            emitCandidateOutcome(job, {
              candidateId: id,
              stage: outcome.cacheHit ? 'cache_hit' : 'verified',
              reason: outcome.cacheHit ? 'shared_cache_hit' : 'verified',
              attempt: outcome.cacheHit ? 0 : attempt
            });
            emitProgress(provider, job);
            continue;
          }

          if (rejectedInvalidated && !hadAnyUrl) {
            emitCandidateOutcome(job, {
              candidateId: id,
              stage: 'rejected',
              reason: 'definitive_rejection',
              attempt
            });
            continue;
          }

          if (hadAnyUrl) {
            emitCandidateOutcome(job, {
              candidateId: id,
              stage: 'rejected',
              reason: 'url_deduplicated',
              attempt
            });
            continue;
          }

          const retryableReason = outcome.retryableReason && RETRYABLE_REASONS.has(outcome.retryableReason)
            ? outcome.retryableReason
            : null;
          if (retryableReason && attempt < 2 && !job.controller.signal.aborted && Date.now() < job.workDeadlineAt) {
            job.retryQueue.push({ candidate, attempt: 2, retryReason: retryableReason });
            emitCandidateOutcome(job, {
              candidateId: id,
              stage: 'retry_scheduled',
              reason: retryableReason,
              attempt
            });
            wakeQueueWaiters(job);
            continue;
          }

          const finalReason = job.controller.signal.aborted || Date.now() >= job.workDeadlineAt
            ? 'deadline_expired'
            : (outcome.rejectReason || outcome.retryableReason || 'definitive_rejection');
          emitCandidateOutcome(job, {
            candidateId: id,
            stage: 'rejected',
            reason: finalReason,
            attempt
          });
        } catch (err) {
          const { reason, retryable } = classifyFailureReason(err, job.controller.signal);
          if (retryable && attempt < 2 && !job.controller.signal.aborted && Date.now() < job.workDeadlineAt) {
            job.retryQueue.push({ candidate, attempt: 2, retryReason: reason });
            emitCandidateOutcome(job, {
              candidateId: id,
              stage: 'retry_scheduled',
              reason,
              attempt
            });
            wakeQueueWaiters(job);
          } else {
            emitCandidateOutcome(job, {
              candidateId: id,
              stage: 'rejected',
              reason,
              attempt
            });
          }
        } finally {
          job.inFlightProbes -= 1;
          wakeQueueWaiters(job);
        }
      }
    };

    const probeWorkers = getProbeConcurrency(provider);
    await Promise.all(Array.from({ length: probeWorkers }, worker));

    // Re-check fallback upstream once all initial workers drain if nothing verified locally.
    if (!job.upstreamTried && job.verifiedByUrl.size === 0 && !job.controller.signal.aborted && Date.now() < job.workDeadlineAt && job.attemptedIds.size < maxCandidates) {
      await ensureUpstream();
      if (job.nextIndex < job.queue.length || job.retryQueue.length > 0) {
        await Promise.all(Array.from({ length: probeWorkers }, worker));
      }
    }

    const timedOut = job.controller.signal.aborted || Date.now() >= job.workDeadlineAt;
    if (timedOut) {
      while (job.nextIndex < job.queue.length && job.attemptedIds.size < maxCandidates) {
        const candidate = job.queue[job.nextIndex++];
        const id = candidate?.id ? String(candidate.id) : '';
        if (!id || job.attemptedIds.has(id)) continue;
        job.attemptedIds.add(id);
        emitCandidateOutcome(job, {
          candidateId: id,
          stage: 'rejected',
          reason: 'deadline_expired',
          attempt: 0
        });
      }
      while (job.retryQueue.length > 0) {
        const item = job.retryQueue.shift();
        emitCandidateOutcome(job, {
          candidateId: item.candidate?.id,
          stage: 'rejected',
          reason: 'deadline_expired',
          attempt: item.attempt
        });
      }
    }

    const drained = job.nextIndex >= job.queue.length || job.attemptedIds.size >= maxCandidates;
    if (!timedOut && drained && job.retryQueue.length === 0) {
      job.done = true;
      job.lastStopReason = job.verifiedByUrl.size > 0 ? 'complete' : 'exhausted';
    } else {
      job.done = true;
      job.lastStopReason = 'deadline';
    }
  } catch (err) {
    job.lastError = err;
    if (!job.verifiedByUrl.size) {
      job.done = true;
      job.lastStopReason = 'exhausted';
    }
  } finally {
    if (jobTimer) clearTimeout(jobTimer);
    job.running = false;
    if (job.done) job.outcomeListeners.clear();
    wakeQueueWaiters(job);
    wakeWaiters(job);
  }
}

function getOrCreateJob(provider, match, isStreamValid = null) {
  const store = jobStoreFor(provider);
  const key = fixtureJobKey(match);
  let job = store.get(key);
  if (job && !job.running) {
    const evicted = pruneInvalidVerified(job, isStreamValid);
    if (evicted > 0 && job.done) {
      job.consumedComplete = true;
    }
  } else if (job) {
    pruneInvalidVerified(job, isStreamValid);
  }
  if (!job || (job.done && job.consumedComplete) || (!job.running && Date.now() >= job.workDeadlineAt)) {
    const startedAt = Date.now();
    job = {
      id: key,
      fixtureId: String(match?.id || ''),
      startedAt,
      queue: [],
      queuedIds: new Set(),
      uniqueCandidateIds: new Set(),
      attemptedIds: new Set(),
      retryQueue: [],
      verifiedByUrl: new Map(),
      nextIndex: 0,
      inFlightProbes: 0,
      upstreamTried: false,
      localLoaded: false,
      localHits: 0,
      searchStats: {},
      running: false,
      done: false,
      consumedComplete: false,
      lastStopReason: 'exhausted',
      lastError: null,
      waiters: new Set(),
      queueWaiters: new Set(),
      outcomeListeners: new Set(),
      isStreamValid,
      controller: new AbortController(),
      workDeadlineAt: startedAt + getJobTimeoutMs()
    };
    store.set(key, job);
  } else if (typeof isStreamValid === 'function') {
    job.isStreamValid = isStreamValid;
  }
  return job;
}

// A single fixture coordinator runs rolling probe workers up to the job budget,
// exposes verified rows immediately at HTTP deadlines, and resumes pending items
// cleanly on later clicks without re-probing completed candidates or extending
// the original job window.
async function collectEventStreams({ provider, match, probe, signal, metrics, onProgress, onCandidateOutcome, isStreamValid, probeOwnsSlot = false }) {
  const job = getOrCreateJob(provider, match, isStreamValid);
  const removeProgress = typeof onProgress === 'function' ? addKeyListener(provider, job.id, onProgress) : null;
  const hasOutcomeListener = typeof onCandidateOutcome === 'function';
  if (hasOutcomeListener) job.outcomeListeners.add(onCandidateOutcome);

  pruneInvalidVerified(job, isStreamValid);

  if (hasOutcomeListener && job.verifiedByUrl.size > 0) {
    const seenCandidates = new Set();
    for (const stream of job.verifiedByUrl.values()) {
      const candidateId = stream?._kafkaCandidateId;
      if (!candidateId || seenCandidates.has(candidateId)) continue;
      seenCandidates.add(candidateId);
      emitCandidateOutcome(job, {
        candidateId,
        stage: 'cache_hit',
        reason: 'worker_job_hit',
        attempt: 0
      });
    }
  }

  if (removeProgress && job.verifiedByUrl.size > 0) {
    try { onProgress([...job.verifiedByUrl.values()].map(cloneCandidateStream)); } catch (_) {}
  }

  let finishedCleanly = false;
  try {
    if (!job.done && !signal?.aborted) {
      const pumpPromise = job.running ? null : pumpFixtureJob(job, { provider, match, probe, probeOwnsSlot });
      if (!job.done) {
        await new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            job.waiters.delete(onDone);
            signal?.removeEventListener('abort', done);
            resolve();
          };
          const onDone = () => done();
          job.waiters.add(onDone);
          if (signal) {
            if (signal.aborted) { done(); return; }
            signal.addEventListener('abort', done, { once: true });
          }
          if (job.done && !job.running) done();
        });
      }
      if (pumpPromise && !job.running && job.done) await pumpPromise;
    }

    if (job.lastError && !signal?.aborted && !job.verifiedByUrl.size) {
      throw job.lastError;
    }
    finishedCleanly = true;
  } finally {
    if (removeProgress) removeProgress();
    if (hasOutcomeListener && job.done) job.outcomeListeners.delete(onCandidateOutcome);
    pruneInvalidVerified(job, isStreamValid);
    const reason = job.done ? job.lastStopReason : (signal?.aborted ? 'deadline' : job.lastStopReason);
    if (job.done) job.consumedComplete = true;
    try {
      metrics?.(buildMetrics(job, reason, provider));
    } catch (_) {
      // Missing or throwing metrics must never break playback.
    }
  }

  pruneInvalidVerified(job, isStreamValid);
  const streams = [...job.verifiedByUrl.values()].map(cloneCandidateStream);
  return {
    streams,
    incomplete: !job.done,
    reason: finishedCleanly && job.done ? job.lastStopReason : 'deadline'
  };
}

function subscribeEventProgress(provider, match, listener, isStreamValid = null) {
  if (typeof listener !== 'function') return () => {};
  const key = fixtureJobKey(match);
  const remove = addKeyListener(provider, key, listener);
  const job = jobStoreFor(provider).get(key);
  if (job) {
    pruneInvalidVerified(job, isStreamValid);
    if (job.verifiedByUrl.size > 0) {
      try { listener([...job.verifiedByUrl.values()].map(cloneCandidateStream)); } catch (_) {}
    }
  }
  return remove;
}

module.exports = {
  collectEventStreams,
  subscribeEventProgress,
  normalizeKickoffMs,
  kafkaEventCandidateKey,
  parseKafkaEventCandidateKey
};
