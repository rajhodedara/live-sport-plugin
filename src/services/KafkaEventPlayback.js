'use strict';

const providerJobs = new WeakMap();
const fallbackJobs = new Map();
const providerListeners = new WeakMap();
const fallbackListeners = new Map();

const DEFAULT_JOB_TIMEOUT_MS = 60 * 1000;
const DEFAULT_UPSTREAM_MIN_LOCAL = 6;
const DEFAULT_PROBE_WORKERS = 2;

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

function enqueueCandidates(job, candidates, maxCandidates) {
  for (const candidate of candidates || []) {
    if (!candidate?.id) continue;
    const id = String(candidate.id);
    if (job.queuedIds.has(id) || job.attemptedIds.has(id)) continue;
    if (job.queue.length >= maxCandidates) break;
    job.queuedIds.add(id);
    job.queue.push(candidate);
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
  const listeners = listenerStoreFor(provider).get(job.id);
  if (!listeners || listeners.size === 0) return;
  const snapshot = [...job.verifiedByUrl.values()];
  for (const listener of listeners) {
    try { listener(snapshot); } catch (_) {}
  }
}

function wakeWaiters(job) {
  for (const wake of job.waiters) {
    try { wake(); } catch (_) {}
  }
}

function runWithProbeSlot(provider, candidate, probe, signal) {
  if (typeof provider?.withEventProbe === 'function') {
    return provider.withEventProbe(() => probe(candidate, signal), signal);
  }
  return Promise.resolve().then(() => probe(candidate, signal));
}

async function pumpFixtureJob(job, { provider, match, probe }) {
  if (job.running || job.done) return;
  job.running = true;
  const maxCandidates = getMaxCandidates();
  const minLocal = getUpstreamMinLocal(provider);
  let upstreamInFlight = null;

  try {
    if (!job.localLoaded) {
      job.localLoaded = true;
      const local = (await provider.eventCandidates(match, {
        upstream: false,
        stats: job.searchStats
      })) || [];
      job.localHits = local.length;
      enqueueCandidates(job, local, maxCandidates);
    }

    const ensureUpstream = async () => {
      if (job.upstreamTried || Date.now() >= job.workDeadlineAt) return;
      if (job.localHits >= minLocal && job.verifiedByUrl.size > 0) return;
      if (upstreamInFlight) return upstreamInFlight;
      job.upstreamTried = true;
      upstreamInFlight = Promise.resolve()
        .then(() => provider.eventCandidates(match, { upstream: true, stats: job.searchStats }))
        .then((extra) => {
          enqueueCandidates(job, extra, maxCandidates);
        })
        .catch((err) => {
          if (!job.verifiedByUrl.size && !job.queue.length) job.lastError = err;
        })
        .finally(() => { upstreamInFlight = null; });
      return upstreamInFlight;
    };

    const nextCandidate = async () => {
      for (;;) {
        if (Date.now() >= job.workDeadlineAt) return null;
        if (job.nextIndex < job.queue.length && job.attemptedIds.size < maxCandidates) {
          const candidate = job.queue[job.nextIndex++];
          if (!candidate?.id || job.attemptedIds.has(String(candidate.id))) continue;
          return candidate;
        }
        if (upstreamInFlight) {
          await upstreamInFlight;
          continue;
        }
        if (!job.upstreamTried && job.attemptedIds.size < maxCandidates && job.localHits < minLocal) {
          await ensureUpstream();
          continue;
        }
        return null;
      }
    };

    const worker = async () => {
      for (;;) {
        const candidate = await nextCandidate();
        if (!candidate) break;
        const id = String(candidate.id);
        job.attemptedIds.add(id);
        try {
          const streams = await runWithProbeSlot(provider, candidate, probe, undefined);
          let added = false;
          for (const stream of Array.isArray(streams) ? streams : []) {
            if (!stream?.url || job.verifiedByUrl.has(stream.url)) continue;
            job.verifiedByUrl.set(stream.url, stream);
            added = true;
          }
          if (added) emitProgress(provider, job);
        } catch (_) {
          // Probe failures skip the candidate without stopping the rolling queue.
        }
      }
    };

    const probeWorkers = getProbeConcurrency(provider);
    await Promise.all(Array.from({ length: probeWorkers }, worker));

    // Re-check fallback upstream once all initial workers drain if nothing verified locally.
    if (!job.upstreamTried && job.verifiedByUrl.size === 0 && Date.now() < job.workDeadlineAt && job.attemptedIds.size < maxCandidates) {
      await ensureUpstream();
      if (job.nextIndex < job.queue.length) {
        await Promise.all(Array.from({ length: probeWorkers }, worker));
      }
    }

    const drained = job.nextIndex >= job.queue.length || job.attemptedIds.size >= maxCandidates;
    if (drained) {
      job.done = true;
      job.lastStopReason = job.verifiedByUrl.size > 0 ? 'complete' : 'exhausted';
    } else {
      job.lastStopReason = 'deadline';
    }
  } catch (err) {
    job.lastError = err;
    if (!job.verifiedByUrl.size) {
      job.done = true;
      job.lastStopReason = 'exhausted';
    }
  } finally {
    job.running = false;
    wakeWaiters(job);
  }
}

function getOrCreateJob(provider, match) {
  const store = jobStoreFor(provider);
  const key = fixtureJobKey(match);
  let job = store.get(key);
  if (!job || (job.done && job.consumedComplete)) {
    job = {
      id: key,
      queue: [],
      queuedIds: new Set(),
      attemptedIds: new Set(),
      verifiedByUrl: new Map(),
      nextIndex: 0,
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
      workDeadlineAt: Date.now() + getJobTimeoutMs()
    };
    store.set(key, job);
  } else if (!job.done) {
    job.workDeadlineAt = Date.now() + getJobTimeoutMs();
  }
  return job;
}

// A single fixture coordinator runs rolling probe workers up to the job budget,
// exposes verified rows immediately at HTTP deadlines, and resumes pending items
// cleanly on later clicks without re-probing completed candidates.
async function collectEventStreams({ provider, match, probe, signal, metrics, onProgress }) {
  const job = getOrCreateJob(provider, match);
  const removeProgress = typeof onProgress === 'function' ? addKeyListener(provider, job.id, onProgress) : null;
  if (removeProgress && job.verifiedByUrl.size > 0) {
    try { onProgress([...job.verifiedByUrl.values()]); } catch (_) {}
  }

  let finishedCleanly = false;
  try {
    if (!job.done && !signal?.aborted) {
      const pumpPromise = job.running ? null : pumpFixtureJob(job, { provider, match, probe });
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
    const reason = job.done ? job.lastStopReason : (signal?.aborted ? 'deadline' : job.lastStopReason);
    if (job.done) job.consumedComplete = true;
    try {
      metrics?.(buildMetrics(job, reason, provider));
    } catch (_) {
      // Missing or throwing metrics must never break playback.
    }
  }

  const streams = [...job.verifiedByUrl.values()];
  return {
    streams,
    incomplete: !job.done,
    reason: finishedCleanly && job.done ? job.lastStopReason : 'deadline'
  };
}

function subscribeEventProgress(provider, match, listener) {
  if (typeof listener !== 'function') return () => {};
  const key = fixtureJobKey(match);
  const remove = addKeyListener(provider, key, listener);
  const job = jobStoreFor(provider).get(key);
  if (job && job.verifiedByUrl.size > 0) {
    try { listener([...job.verifiedByUrl.values()]); } catch (_) {}
  }
  return remove;
}

module.exports = { collectEventStreams, subscribeEventProgress };
