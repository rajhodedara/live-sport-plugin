'use strict';

// Experimental, opt-in supervisor. A child owns one native request; capacity
// returns only after its exit is observed.
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { threadId } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const { createNativeTiming } = require('./NativeTiming');
const error = (code, message) => Object.assign(new Error(message), { code });
const trackedChildren = new Set();
let exitHookInstalled = false;
function killTrackedChildren() {
  for (const child of trackedChildren) { try { child.kill('SIGKILL'); } catch (_) {} }
}
function trackChild(child) {
  trackedChildren.add(child);
  const remove = () => trackedChildren.delete(child);
  child.once('exit', remove); child.once('close', remove);
  if (!exitHookInstalled) { exitHookInstalled = true; process.once('exit', killTrackedChildren); }
}
function configuredSlots(raw = process.env.GUARDED_NATIVE_MAX_SLOTS) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 8 ? value : 4;
}

function childScriptPath(base = __dirname, exists = fs.existsSync) {
  const local = path.join(base, 'isolated-native-child.cjs');
  const bundled = path.join(base, 'services', 'isolated-native-child.cjs');
  return exists(local) ? local : bundled;
}

function createIsolatedNativePoolCandidate({ maxSlots = configuredSlots(), admissionWaitMs = 5000, maxWaiters = 128, now = () => performance.now(), timing = createNativeTiming({ enabled: process.env.NATIVE_TIMING_DIAGNOSTICS === 'true', emitStarts: true }), spawn = () => fork(
  childScriptPath(), [],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' }) } = {}) {
  if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 8) throw new RangeError('Invalid native pool size');
  if (!Number.isFinite(admissionWaitMs) || admissionWaitMs < 0 || admissionWaitMs > 30000 || !Number.isInteger(maxWaiters) || maxWaiters < 1 || maxWaiters > 512) throw new RangeError('Invalid native admission limits');
  const children = new Map(), waiters = [], poolId = randomBytes(4).toString('hex');
  let closed = false, closing, nextSlotId = 1, admitted = 0;
  const stopTimingSnapshots = timing.enabled ? require('./TimingSnapshotTimer').startTimingSnapshotTimer(() => timing.report?.(poolId)) : () => {};
  const capacityError = () => {
    const diagnostic = { threadId, poolId, limit: maxSlots, waiting: waiters.length, slots: [...children.values()].map(record => ({
      slotId: record.slotId, phase: record.phase, profile: record.profile, egress: record.egress,
      owner: record.owner, ageMs: Math.max(0, Math.round(now() - record.startedAt))
    })) };
    return Object.assign(error('ERR_NATIVE_POOL_BUSY', 'Native pool capacity reached'), { capacityDiagnostic: diagnostic });
  };
  const drain = () => {
    while (!closed && admitted < maxSlots && waiters.length) {
      const proxyIndex = waiters.findIndex(waiter => waiter.priority === 2);
      const catalogIndex = proxyIndex < 0 ? waiters.findIndex(waiter => waiter.priority === 1) : -1;
      const waiter = waiters.splice(proxyIndex >= 0 ? proxyIndex : catalogIndex >= 0 ? catalogIndex : 0, 1)[0];
      waiter.cleanup(); admitted++; waiter.resolve();
    }
  };
  const release = () => { admitted--; drain(); };
  function admit(signal, timeoutMs, priority) {
    if (!waiters.length && admitted < maxSlots) { admitted++; return null; }
    const proxyReserve = Math.min(8, Math.floor(maxWaiters / 4));
    if (admissionWaitMs === 0 || waiters.length >= maxWaiters || (priority === 0 && waiters.filter(w => w.priority === 0).length >= maxWaiters - proxyReserve)) return Promise.reject(capacityError());
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = { priority, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
      const fail = failure => { const index = waiters.indexOf(waiter); if (index < 0) return; waiters.splice(index, 1); waiter.cleanup(); reject(failure); };
      const onAbort = () => fail(signal.reason);
      waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => fail(timeoutMs <= admissionWaitMs ? new DOMException('Native fetch deadline', 'TimeoutError') : capacityError()), Math.min(admissionWaitMs, timeoutMs));
      if (signal?.aborted) onAbort();
      drain();
    });
  }
  const pool = {
    get occupied() { return children.size; },
    get timingStats() { return timing.stats; },
    async fetch(url, options = {}) {
      const trace = timing.start(poolId, options.diagnosticOwner);
      try {
        const result = await pool.fetchWithTrace(url, options, trace);
        trace.finish(); return result;
      } catch (failure) { trace.finish(failure); throw failure; }
    },
    async fetchWithTrace(url, options, trace) {
      if (closed) throw error('ERR_NATIVE_POOL_CLOSED', 'Native pool closed');
      const { signal, timeoutMs = 15000 } = options;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new RangeError('Invalid native deadline');
      signal?.throwIfAborted();
      const startedAt = performance.now();
      trace.enqueued();
      const admission = admit(signal, timeoutMs, options.proxyUrl ? 2 : options.diagnosticOwner === 'catalog' ? 1 : 0);
      if (admission) await admission;
      trace.admitted();
      if (closed || signal?.aborted) { release(); if (signal?.aborted) throw signal.reason; throw error('ERR_NATIVE_POOL_CLOSED', 'Native pool closed'); }
      if (performance.now() - startedAt >= timeoutMs) { release(); throw new DOMException('Native fetch deadline', 'TimeoutError'); }
      const remaining = Math.max(1, Math.ceil(timeoutMs - (performance.now() - startedAt)));
      let child;
      trace.spawnAttempt();
      try { child = spawn(); }
      catch (_) { release(); throw error('ERR_NATIVE_UNAVAILABLE', 'Native child unavailable'); }
      trace.spawned();
      const record = { slotId: nextSlotId++, startedAt: now(), phase: 'running',
        profile: ['chrome', 'vanilla'].includes(options.profile) ? options.profile : 'default',
        egress: options.proxyUrl ? 'proxy' : 'direct',
        owner: ['manifest', 'wasm', 'catalog'].includes(options.diagnosticOwner) ? options.diagnosticOwner : 'other' };
      children.set(child, record);
      trackChild(child);
      if (timing.enabled) child.once('spawn', () => trace.spawnObserved());
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (failure, response) => {
          if (settled) return;
          settled = true;
          record.phase = 'terminating';
          clearTimeout(timer);
          signal?.removeEventListener('abort', aborted);
          child.removeListener('message', onMessage);
          try { child.kill('SIGKILL'); } catch (_) { /* retain capacity until exit */ }
          if (failure) reject(failure); else resolve(response);
        };
        const aborted = () => finish(signal.reason);
        const timer = setTimeout(() => finish(new DOMException('Native fetch deadline', 'TimeoutError')), remaining);
        signal?.addEventListener('abort', aborted, { once: true });
        const exited = () => {
          if (children.delete(child)) { trace.exited(); release(); }
          finish(error('ERR_NATIVE_CHILD_EXIT', 'Native child exited before response'));
        };
        child.once('exit', exited);
        child.once('close', exited);
        child.once('error', () => finish(error(child.pid ? 'ERR_NATIVE_CHILD' : 'ERR_NATIVE_UNAVAILABLE', 'Native child failed')));
        const onMessage = message => {
          if (timing.enabled && message?.type === 'diagnostic' && message.phase === 'request_received') {
            trace.requestReceived();
            return;
          }
          if (timing.enabled && message?.type === 'diagnostic' && ['fetch_start', 'response_received', 'body_read_end'].includes(message.phase)) {
            trace.childPhase(message.phase, message.hop, message.childElapsedMs);
            return;
          }
          if (!message || message.type !== 'result') return finish(error('ERR_NATIVE_CHILD', 'Invalid native child response'));
          if (timing.enabled) trace.childSnapshot(message.diagnosticSnapshot);
          if (message.error) {
            const kind = message.error.kind;
            const failure = kind === 'TypeError' ? new TypeError('Native child request failed') :
              kind === 'RangeError' ? new RangeError('Native child request failed') : new Error('Native child request failed');
            failure.code = typeof message.error.code === 'string' && /^ERR_[A-Z0-9_]{1,80}$/.test(message.error.code)
              ? message.error.code : 'ERR_NATIVE_CHILD';
            if (message.error.isFatal === true) failure.isFatal = true;
            if (failure.code === 'ERR_OUTBOUND_BLOCKED') { failure.isFatal = true; failure.statusCode = 403; }
            return finish(failure);
          }
          try {
            const bytes = Buffer.from(message.bytes), headers = new Headers(message.headers);
            finish(null, { ok: message.status >= 200 && message.status < 300, status: message.status,
              url: message.url, headers, bodyTruncated: !!message.bodyTruncated,
              text: async () => bytes.toString('utf8'), json: async () => JSON.parse(bytes.toString('utf8')),
              arrayBuffer: async () => Uint8Array.from(bytes).buffer });
          } catch (_) { finish(error('ERR_NATIVE_CHILD', 'Invalid native child response')); }
        };
        child.on('message', onMessage);
        if (signal?.aborted) return aborted();
        const requestOptions = { timeoutMs: remaining };
        for (const key of ['method', 'body', 'redirect', 'maxBodyBytes', 'profile', 'proxyUrl', 'diagnosticOwner']) {
          if (Object.hasOwn(options, key)) requestOptions[key] = options[key];
        }
        try {
          if (options.headers !== undefined) requestOptions.headers = [...new Headers(options.headers)];
          child.send({ url, options: requestOptions, ...(timing.enabled ? { diagnostic: true } : {}) }, failure => {
          if (failure) finish(error('ERR_NATIVE_CHILD', 'Native child IPC failed'));
          });
        } catch (failure) { finish(failure instanceof TypeError ? failure : error('ERR_NATIVE_CHILD', 'Native child IPC failed')); }
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      stopTimingSnapshots();
      for (const waiter of waiters.splice(0)) { waiter.cleanup(); waiter.reject(error('ERR_NATIVE_POOL_CLOSED', 'Native pool closed')); }
      closing = Promise.all([...children.keys()].map(child => new Promise(resolve => {
        children.get(child).phase = 'terminating';
        child.once('exit', resolve);
        child.once('close', resolve);
        try { child.kill('SIGKILL'); } catch (_) { /* wait for observed exit */ }
      // Snapshot at close; other pending promise callbacks may still emit later.
      }))).finally(() => { try { timing.report?.(poolId); } catch (_) { /* diagnostic only */ } });
      return closing;
    }
  };
  return pool;
}

module.exports = { createIsolatedNativePoolCandidate, childScriptPath, configuredSlots, killTrackedChildren };
