'use strict';

// Buffered transport for the local guarded-fetch integration candidate. No retry/fallback
// policy, cookie jar, provider defaults or public media relay is added here.
const { threadId } = require('node:worker_threads');
const { randomBytes } = require('node:crypto');
const { createNativeGuardedSlot } = require('./NativeGuardedSlot');
const { readLimitedBody } = require('../impitClient');
const { OutboundBlockedError, assertOutboundUrl } = require('./GuardedOutbound');
const { filterRedirectHeaders, shouldDropRedirectBody } = require('./RedirectHeaderPolicy');
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_BODY_LIMIT = 1024 * 1024;
const HARD_BODY_LIMIT = 8 * 1024 * 1024;
const error = (code, message) => Object.assign(new Error(message), { code });
const isDamitv = host => host === 'damitv.st' || host.endsWith('.damitv.st');

async function withSignal(operation, signal) {
  let abort;
  try {
    signal.throwIfAborted();
    return await Promise.race([operation, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

function filteredHeaders(value) {
  const headers = new Headers(value);
  const blocked = ['host', 'connection', 'proxy-connection', 'keep-alive', 'proxy-authorization',
    'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'expect'];
  for (const token of (headers.get('connection') || '').split(',')) blocked.push(token.trim());
  for (const name of blocked) if (name) headers.delete(name);
  return Object.fromEntries(headers);
}

function createNativeGuardedFetch({ maxSlots = 4, maxWaiters = 128, admissionWaitMs = 5000, slotOptions = {}, createSlot = createNativeGuardedSlot, onPhase = null,
  recycleMs = Math.max(600000, Number(process.env.IMPIT_RECYCLE_MS) || 5400000), now = Date.now } = {}) {
  if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 4) throw new RangeError('Native pool supports 1–4 slots');
  if (!Number.isFinite(recycleMs) || recycleMs < 600000) throw new RangeError('Invalid native recycle interval');
  if (!Number.isInteger(maxWaiters) || maxWaiters < 1 || maxWaiters > 512 || !Number.isFinite(admissionWaitMs) || admissionWaitMs < 0 || admissionWaitMs > 30000) throw new RangeError('Invalid native admission limits');
  const records = [], waiters = [], shutdown = new AbortController();
  const poolId = randomBytes(4).toString('hex');
  let nextKeyId = 1, nextSlotId = 1;
  let closed = false, closing, wakeInFlight = false;
  const mark = (phase, hop) => { try { onPhase?.(phase, hop); } catch (_) { /* diagnostic only */ } };
  function notifyWaiter() {
    if (wakeInFlight) return;
    const waiter = waiters.shift();
    if (waiter) { wakeInFlight = true; waiter.wake(); }
  }
  function waitForCapacity(signal, until, diagnostic, front = false) {
    signal.throwIfAborted();
    const remaining = until - performance.now();
    if (remaining <= 0 || waiters.length + (wakeInFlight ? 1 : 0) >= maxWaiters) {
      const admission = remaining <= 0 ? 'expired' : 'queue_full';
      return Promise.reject(Object.assign(error('ERR_NATIVE_POOL_BUSY', 'Native pool capacity reached'), { capacityDiagnostic: { ...diagnostic(), admission } }));
    }
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = { wake: () => finish(resolve) };
      const abort = () => finish(reject, signal.reason);
      function finish(fn, value) {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        fn(value);
      }
      if (front) waiters.unshift(waiter); else waiters.push(waiter);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(reject, Object.assign(error('ERR_NATIVE_POOL_BUSY', 'Native pool capacity reached'), { capacityDiagnostic: { ...diagnostic(), admission: 'expired' } })), remaining);
      if (signal.aborted) abort();
    });
  }
  async function acquire(key, configuration, signal, owner, waitUntil, resumed = false) {
    if (closed || signal.aborted) {
      if (resumed) { wakeInFlight = false; notifyWaiter(); }
      if (closed) throw error('ERR_NATIVE_POOL_CLOSED', 'Native pool closed');
      signal.throwIfAborted();
    }
    const keyId = records.find(r => r.key === key)?.keyId || nextKeyId;
    const diagnostic = () => ({ threadId, poolId, requested: { keyId, profile: configuration.profile, egress: configuration.proxyUrl ? 'proxy' : 'direct', owner }, limit: maxSlots, slots: records.map(r => ({ slotId: r.slotId, keyId: r.keyId, profile: r.profile, egress: r.egress, owner: r.owner || 'idle', state: !r.slot ? 'creating' : r.reserved ? 'reserved' : r.slot.busy ? 'busy' : 'idle', phase: r.reserved ? r.phase : r.slot?.busy ? 'draining' : 'idle', ...(r.reserved ? { reservationAgeMs: Math.max(0, now() - r.reservedAt) } : {}), ...(r.slot?.busy && r.operationStartedAt !== undefined ? { operationAgeMs: Math.max(0, now() - r.operationStartedAt) } : {}) })) });
    if (!resumed && (waiters.length || wakeInFlight)) {
      await waitForCapacity(signal, waitUntil, diagnostic);
      return acquire(key, configuration, signal, owner, waitUntil, true);
    }
    let record = records.find(item => item.key === key && item.slot && !item.reserved && !item.slot.busy);
    if (record) {
      record.reserved = true; record.reservedAt = now(); record.phase = 'acquiring'; record.owner = owner;
      if (now() - record.bornAt > recycleMs) {
        wakeInFlight = true;
        // Match the existing recycle policy, but retire only idle clients and
        // never force GC underneath an active native operation.
        record.phase = 'retiring';
        const retiring = Promise.resolve().then(() => record.slot.close()).then(() => {
          const index = records.indexOf(record);
          if (index !== -1) records.splice(index, 1);
          notifyWaiter();
        }, failure => { record.phase = 'retirement_failed'; throw failure; });
        try { await withSignal(retiring, signal); }
        catch (failure) { wakeInFlight = false; notifyWaiter(); throw failure; }
        return acquire(key, configuration, signal, owner, waitUntil, true);
      }
      if (resumed) { wakeInFlight = false; notifyWaiter(); }
      return record;
    }
    // The cap is pool-wide. A different key may reclaim an idle slot;
    // active or initializing slots are never interrupted.
    if (records.length >= maxSlots) {
      const idle = records.find(item => item.key !== key && item.slot && !item.reserved && !item.slot.busy);
      if (!idle) {
        if (resumed) wakeInFlight = false;
        await waitForCapacity(signal, waitUntil, diagnostic, resumed);
        return acquire(key, configuration, signal, owner, waitUntil, true);
      }
      // Reserve synchronously, before awaiting closure, so another request cannot
      // reuse or evict this slot while its native resources are being released.
      idle.reserved = true; idle.reservedAt = now(); idle.phase = 'retiring';
      wakeInFlight = true;
      const retiring = Promise.resolve().then(() => idle.slot.close()).then(() => {
        const index = records.indexOf(idle);
        if (index !== -1) records.splice(index, 1);
        notifyWaiter();
      }, failure => { idle.reserved = false; idle.phase = 'idle'; notifyWaiter(); throw failure; });
      try { await withSignal(retiring, signal); }
      catch (failure) { wakeInFlight = false; notifyWaiter(); throw failure; }
      return acquire(key, configuration, signal, owner, waitUntil, true);
    }
    if (!records.some(r => r.key === key)) nextKeyId++;
    record = { key, keyId, slotId: nextSlotId++, reserved: true, reservedAt: now(), phase: 'creating', owner, profile: configuration.profile, egress: configuration.proxyUrl ? 'proxy' : 'direct' };
    records.push(record);
    if (resumed) { wakeInFlight = false; notifyWaiter(); }
    record.ready = Promise.resolve().then(() => createSlot({ ...slotOptions, ...configuration })).then(async slot => {
      record.slot = slot;
      record.bornAt = now();
      if (closed) { await slot.close(); throw error('ERR_NATIVE_POOL_CLOSED', 'Native pool closed'); }
      return slot;
    }).catch(failure => {
      if (failure.code === 'ERR_NATIVE_SLOT_CAPACITY') failure.capacityDiagnostic = { ...diagnostic(), slotCount: failure.slotCount, slotLimit: failure.slotLimit };
      const index = records.indexOf(record);
      if (index !== -1) records.splice(index, 1);
      throw failure;
    });
    record.ready.then(() => { if (!record.reserved && !record.slot.busy) notifyWaiter(); }, notifyWaiter);
    try {
      await withSignal(record.ready, signal);
      signal.throwIfAborted();
      record.phase = 'acquiring';
      return record;
    } catch (failure) { record.reserved = false; record.phase = 'idle'; if (record.slot && !record.slot.busy) notifyWaiter(); throw failure; }
  }

  return {
    get stats() { return { slots: records.length, busy: records.filter(record => record.reserved || record.slot?.busy).length }; },
    async fetch(rawUrl, options = {}) {
      if (closed) throw error('ERR_NATIVE_POOL_CLOSED', 'Native pool closed');
      const timeoutMs = options.timeoutMs ?? 15000;
      const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new RangeError('Invalid total timeout');
      if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > HARD_BODY_LIMIT) throw new RangeError('Invalid body limit');
      let url;
      try { url = new URL(rawUrl); } catch (_) { throw new OutboundBlockedError('invalid_url'); }
      url.hash = '';
      let headers = filteredHeaders(options.headers), method = String(options.method || 'GET').toUpperCase();
      let body = options.body;
      // Streaming/replayable uploads need a separate design. Small fixed
      // strings/byte buffers suffice for this metadata laboratory.
      if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
        throw new TypeError('Unsupported native laboratory request body');
      }
      if (body != null && Buffer.byteLength(body) > HARD_BODY_LIMIT) throw new RangeError('Request body exceeds laboratory cap');
      if (options.profile !== undefined && !['chrome', 'vanilla'].includes(options.profile)) throw new TypeError('Invalid native profile');
      if (options.redirect !== undefined && !['manual', 'follow', 'error'].includes(options.redirect)) throw new TypeError('Invalid redirect policy');
      // Preserve the selected egress/profile across CDN redirects, as one
      // existing native client does. A redirect must not silently leave WARP.
      const proxyUrl = Object.hasOwn(options, 'proxyUrl') ? options.proxyUrl :
        isDamitv(url.hostname) ? process.env.WARP_PROXY_URL || process.env.DAMITV_PROXY_URL : null;
      const profile = options.profile || (proxyUrl || isDamitv(url.hostname) ? 'vanilla' : 'chrome');
      const deadline = performance.now() + timeoutMs;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new DOMException('Native fetch deadline', 'TimeoutError')), timeoutMs);
      const signal = AbortSignal.any([shutdown.signal, timeout.signal, ...(options.signal ? [options.signal] : [])]);
      try {
        for (let hop = 0; ; hop++) {
          signal.throwIfAborted();
          if (!['http:', 'https:'].includes(url.protocol)) throw new OutboundBlockedError('unsupported_protocol');
          if (url.username || url.password) throw new OutboundBlockedError('url_credentials');
          // Reject before native module/client allocation. The slot and its
          // connector still validate independently at lease and dial time.
          await withSignal(assertOutboundUrl(url.href, { resolve: slotOptions.resolve }), signal);
          const owner = ['catalog', 'manifest', 'wasm'].includes(options.diagnosticOwner) ? options.diagnosticOwner : 'other';
          const record = await acquire(JSON.stringify([profile, proxyUrl || null]), { profile, proxyUrl: proxyUrl || null }, signal, owner, performance.now() + admissionWaitMs);
          let received;
          try {
            signal.throwIfAborted();
            const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
            record.phase = 'running'; record.operationStartedAt = now();
            received = await record.slot.run(url.href, async (client, operationSignal = signal) => {
              // Never pass the caller signal to the native wrapper. The slot
              // owns cancellation and waits for the underlying body operation.
              mark('fetch_start', hop);
              const response = await client.fetch(url.href, { method, headers,
                body, redirect: 'manual', timeout: remaining });
              mark('response_received', hop);
              const abortResponse = () => {
                if (typeof response.abort === 'function') {
                  try { response.abort(); } catch (_) { /* cancellation remains best effort */ }
                }
              };
              operationSignal.addEventListener('abort', abortResponse, { once: true });
              let responseBody, completed = false;
              try {
                if (operationSignal.aborted) { abortResponse(); operationSignal.throwIfAborted(); }
                responseBody = response.body;
                const responseHeaders = new Headers(response.headers);
                const location = responseHeaders.get('location');
                if (REDIRECTS.has(response.status) && location) {
                  if (responseBody) await responseBody.cancel();
                  completed = true;
                  if (options.redirect === 'error') throw new TypeError('Redirect forbidden');
                  if (options.redirect === 'manual') return { status: response.status, headers: responseHeaders,
                    bytes: Buffer.alloc(0), truncated: false };
                  return { status: response.status, location };
                }
                const limited = responseBody ? await readLimitedBody(responseBody, maxBodyBytes) : { buffer: Buffer.alloc(0), truncated: false };
                mark('body_read_end', hop);
                completed = true;
                return { status: response.status, headers: responseHeaders, bytes: Buffer.from(limited.buffer), truncated: limited.truncated };
              } finally {
                operationSignal.removeEventListener('abort', abortResponse);
                if (!completed && responseBody && typeof responseBody.cancel === 'function') {
                  try { await responseBody.cancel(); } catch (_) { /* preserve the original failure */ }
                }
              }
            }, { signal, timeoutMs: remaining });
          } finally {
            record.reserved = false; record.phase = 'idle';
            if (!record.slot.busy) { record.owner = null; record.operationStartedAt = undefined; notifyWaiter(); }
            else if (typeof record.slot.whenIdle === 'function') {
              Promise.resolve(record.slot.whenIdle()).then(notifyWaiter, notifyWaiter);
            }
          }
          signal.throwIfAborted();
          if (!received.location) {
            const bytes = received.bytes;
            return { ok: received.status >= 200 && received.status < 300, status: received.status,
              url: url.href, headers: received.headers, bodyTruncated: received.truncated,
              text: async () => bytes.toString('utf8'), json: async () => JSON.parse(bytes.toString('utf8')),
              arrayBuffer: async () => Uint8Array.from(bytes).buffer };
          }
          if (hop >= 5) throw error('ERR_OUTBOUND_REDIRECT_LIMIT', 'Native redirect limit exceeded');
          let next;
          try { next = new URL(received.location, url); } catch (_) { throw new OutboundBlockedError('invalid_redirect'); }
          next.hash = '';
          if (next.origin !== url.origin) {
            headers = filterRedirectHeaders(headers);
          }
          if (shouldDropRedirectBody(received.status, method)) {
            method = 'GET'; body = undefined;
            for (const name of Object.keys(headers)) if (['content-length', 'content-type', 'content-encoding'].includes(name.toLowerCase())) delete headers[name];
          }
          url = next;
        }
      } catch (failure) {
        if (signal.aborted) throw signal.reason;
        if (performance.now() >= deadline) throw new DOMException('Native fetch deadline', 'TimeoutError');
        throw failure;
      } finally { clearTimeout(timer); }
    },
    close() {
      if (closing) return closing;
      closed = true; shutdown.abort(new DOMException('Native fetch pool shutdown', 'AbortError'));
      closing = (async () => {
        await Promise.allSettled(records.map(async record => {
          const slot = record.slot || await record.ready; await slot.close();
        }));
        records.length = 0;
      })();
      return closing;
    }
  };
}

module.exports = { createNativeGuardedFetch };
