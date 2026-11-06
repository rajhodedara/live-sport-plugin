'use strict';

// A small liveness sample, not a playback guarantee or a media relay. The body
// caps below bound retained application bytes, not TLS/HTTP/TCP wire traffic.
const { inconclusiveErrorReason } = require('./StreamResolutionOutcome');

const PLAYLIST_BYTES = 64 * 1024;
const SEGMENT_BYTES = 512;
const inconclusive = reason => ({ status: 'inconclusive', reason });
const rejected = reason => ({ status: 'rejected', reason });

function validatedUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch (_) {}
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error('Unsupported media probe URL'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true });
  }
  return parsed.toString();
}

function resolveUri(uri, base) {
  const raw = String(uri).trim();
  const target = new URL(raw, base);
  const parent = new URL(base);
  // Match the existing HLS rewriting policy: never copy signed parameters to a
  // different origin or to an explicitly absolute reference.
  if (!/^[a-z][a-z\d+.-]*:/i.test(raw) && !raw.startsWith('//') && target.origin === parent.origin) {
    parent.searchParams.forEach((value, key) => {
      if (!target.searchParams.has(key)) target.searchParams.set(key, value);
    });
  }
  return validatedUrl(target.toString());
}

function parsePlaylist(text) {
  const lines = String(text).replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U') return { invalid: true };
  const segments = [];
  let variant = false, complete = false, gap = false, unsupported = false, partial = false;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) { variant = true; continue; }
    if (line.startsWith('#EXT-X-PART:') || line.startsWith('#EXT-X-PRELOAD-HINT:')) { partial = true; continue; }
    if (line.startsWith('#EXT-X-KEY:') && !/(?:^|,)METHOD=NONE(?:,|$)/.test(line.slice(11))) unsupported = true;
    if (line.startsWith('#EXT-X-MAP:') || line.startsWith('#EXT-X-BYTERANGE:')) unsupported = true;
    if (line.startsWith('#EXT-X-GAP')) { gap = true; continue; }
    if (line.startsWith('#EXTINF:')) {
      complete = Number.isFinite(Number(line.slice(8).split(',')[0])) && Number(line.slice(8).split(',')[0]) > 0;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (variant) return { variant: line };
    if (complete && !gap) segments.push(line);
    complete = false; gap = false;
  }
  if (unsupported || !segments.length) return { unavailable: true, partial };
  return { segment: segments[Math.max(0, segments.length - 2)] };
}

function fatalFailure(error) {
  // Local capacity may set isFatal to disable transport fallback. It remains a
  // retryable control outcome; a guard refusal hidden in cause still wins.
  if (inconclusiveErrorReason(error)) return false;
  try {
    const seen = new Set();
    for (let current = error; current && typeof current === 'object'; current = current.cause) {
      if (seen.has(current) || seen.size >= 8) return true;
      seen.add(current);
      if (current.code === 'ERR_OUTBOUND_BLOCKED' || current.isFatal === true) return true;
    }
    return false;
  } catch (_) { return true; }
}

function bodyReader(body) {
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    return { read: () => reader.read(), cancel: reason => reader.cancel(reason), release: () => reader.releaseLock() };
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const iterator = body[Symbol.asyncIterator]();
    return {
      read: () => iterator.next(),
      async cancel() {
        if (typeof body.destroy === 'function') body.destroy();
        if (typeof iterator.return === 'function') await iterator.return();
      },
      release() {}
    };
  }
  return null;
}

async function prefix(body, limit, signal) {
  const reader = bodyReader(body);
  if (!reader) return { bytes: Buffer.alloc(0), atLimit: false };
  const chunks = [];
  let length = 0, atLimit = false, exhausted = false, cancellation;
  const cancel = () => {
    if (!cancellation) cancellation = Promise.resolve().then(() => reader.cancel(signal.reason)).catch(() => {});
    return cancellation;
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (length < limit) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) { exhausted = true; break; }
      if (!value || !value.byteLength) continue;
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const retained = bytes.subarray(0, limit - length);
      chunks.push(Buffer.from(retained)); length += retained.length;
      if (length === limit) {
        atLimit = true;
        // Do not wait for EOF or another chunk after an exact-size prefix.
        await cancel();
        break;
      }
    }
    return { bytes: Buffer.concat(chunks, length), atLimit };
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!exhausted) await cancel();
    try { reader.release(); } catch (_) {}
  }
}

async function discard(body) {
  const reader = bodyReader(body);
  if (!reader) return;
  try { await reader.cancel(); } catch (_) {}
  try { reader.release(); } catch (_) {}
}

function defaultRequest(url, options) {
  const { selectGuardedEgress } = require('./GuardedEgressPolicy');
  const { providerRequestHeaders } = require('./ProviderRequestHeaders');
  return require('./ProviderOutbound').streamingFetch(url, {
    ...options, ...selectGuardedEgress(url, options),
    headers: providerRequestHeaders(url, options.headers)
  });
}

function createDaddyLiveMediaCheck({ request = defaultRequest, timeoutMs = 1200, maxConcurrent = 2, maxWaiters = 32 } = {}) {
  if (typeof request !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 1200 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2 ||
      !Number.isInteger(maxWaiters) || maxWaiters < 0 || maxWaiters > 32) throw new RangeError('Invalid bounded media-check configuration');
  const inFlight = new Map(), queue = [];
  let active = 0;

  async function inspect(url, context, operation) {
    const signal = operation.controller.signal;
    const remaining = () => {
      signal.throwIfAborted();
      const left = Math.ceil(operation.deadline - performance.now());
      if (left <= 0) throw new DOMException('Media check deadline', 'TimeoutError');
      return left;
    };
    const headers = { 'User-Agent': context.userAgent || 'Mozilla/5.0' };
    if (context.referer) headers.Referer = context.referer;
    if (context.origin) headers.Origin = context.origin;
    async function fetchResponse(target, sample) {
      const response = await request(validatedUrl(target), {
        headers: sample ? { ...headers, Range: 'bytes=0-511' } : headers,
        signal, timeoutMs: remaining(), attempts: 1,
        maxBodyBytes: sample ? SEGMENT_BYTES : PLAYLIST_BYTES
      });
      if (signal.aborted || performance.now() >= operation.deadline) {
        await discard(response?.body);
        remaining();
      }
      const status = Number(response?.status);
      if (status === 404 || status === 410) { await discard(response?.body); return { verdict: rejected('http' + status) }; }
      if (!(status >= 200 && status < 300) || status === 204) {
        await discard(response?.body); return { verdict: inconclusive('unavailable') };
      }
      const read = await prefix(response.body, sample ? SEGMENT_BYTES : PLAYLIST_BYTES, signal);
      remaining();
      return { ...read, url: validatedUrl(response.url || target) };
    }
    let playlist = await fetchResponse(url, false);
    if (playlist.verdict) return playlist.verdict;
    if (playlist.atLimit) return inconclusive('unavailable');
    let parsed = parsePlaylist(playlist.bytes.toString('utf8'));
    if (parsed.variant) {
      // This samples one deterministic rendition, not every variant's health.
      playlist = await fetchResponse(resolveUri(parsed.variant, playlist.url), false);
      if (playlist.verdict) return playlist.verdict;
      if (playlist.atLimit) return inconclusive('unavailable');
      parsed = parsePlaylist(playlist.bytes.toString('utf8'));
      if (parsed.variant) return inconclusive('unavailable');
    }
    if (parsed.invalid) return rejected('invalidPlaylist');
    if (!parsed.segment) return inconclusive('unavailable');
    const segment = await fetchResponse(resolveUri(parsed.segment, playlist.url), true);
    if (segment.verdict) return segment.verdict;
    const bytes = segment.bytes;
    // Plain TS is the DaddyLive contract. An unexpected body is inconclusive,
    // rather than proof a channel is dead or a reason to add a decoder.
    if (bytes.length < 189 || bytes[0] !== 0x47 || bytes[188] !== 0x47 || (bytes.length >= 377 && bytes[376] !== 0x47)) return inconclusive('unavailable');
    return { status: 'ok' };
  }

  function finish(operation, value, error) {
    if (operation.settled) return;
    operation.settled = true;
    clearTimeout(operation.timer);
    operation.context.signal?.removeEventListener('abort', operation.abort);
    if (error) operation.reject(error); else operation.resolve(value);
  }
  function remove(operation) {
    const index = queue.indexOf(operation);
    if (index !== -1) queue.splice(index, 1);
    if (inFlight.get(operation.key) === operation) inFlight.delete(operation.key);
  }
  function stop(operation, reason) {
    if (!operation.controller.signal.aborted) operation.controller.abort(reason === 'timeout'
      ? new DOMException('Media check deadline', 'TimeoutError') : operation.context.signal?.reason || new DOMException('Media check cancelled', 'AbortError'));
    finish(operation, inconclusive(reason));
    if (!operation.started) remove(operation);
  }
  function drain() {
    while (active < maxConcurrent && queue.length) {
      const operation = queue.shift();
      if (operation.settled) continue;
      if (performance.now() >= operation.deadline) { stop(operation, 'timeout'); continue; }
      operation.started = true; active++;
      Promise.resolve().then(() => inspect(operation.url, operation.context, operation)).then(
        value => finish(operation, value),
        error => {
          if (fatalFailure(error)) finish(operation, null, error);
          else finish(operation, inconclusive(inconclusiveErrorReason(error) || 'unavailable'));
        }
      ).finally(() => {
        active--; remove(operation); drain();
      });
    }
  }
  function check(url, context = {}) {
    if (context.signal?.aborted) return Promise.resolve(inconclusive(inconclusiveErrorReason(context.signal.reason) || 'cancelled'));
    const budget = Number.isFinite(context.timeoutMs) ? Math.min(timeoutMs, Math.max(0, context.timeoutMs)) : timeoutMs;
    if (budget <= 0) return Promise.resolve(inconclusive('timeout'));
    // A separately cancelled caller never owns another caller's transport.
    const key = context.signal ? Symbol('cancelable media check') : JSON.stringify([url, context.referer || '', context.origin || '', context.userAgent || '', budget]);
    if (inFlight.has(key)) return inFlight.get(key).promise;
    if (active >= maxConcurrent && queue.length >= maxWaiters) return Promise.resolve(inconclusive('capacity'));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const operation = { key, url, context, resolve, reject, promise, controller: new AbortController(), deadline: performance.now() + budget };
    operation.abort = () => stop(operation, inconclusiveErrorReason(context.signal?.reason) || 'cancelled');
    operation.timer = setTimeout(() => stop(operation, 'timeout'), budget);
    context.signal?.addEventListener('abort', operation.abort, { once: true });
    inFlight.set(key, operation); queue.push(operation);
    if (context.signal?.aborted) operation.abort();
    drain();
    return promise;
  }
  return { check, get active() { return active; }, get queued() { return queue.length; }, get inFlightSize() { return inFlight.size; } };
}

let singleton;
function checkDaddyLiveMedia(url, context) {
  if (!singleton) singleton = createDaddyLiveMediaCheck();
  return singleton.check(url, context);
}

module.exports = { checkDaddyLiveMedia, createDaddyLiveMediaCheck };
