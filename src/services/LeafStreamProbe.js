'use strict';

// Playlist metadata only. A successful sample does not promise playback, and
// no URI found in the playlist is ever fetched by this checker.
const { validateLeafManifestUrl } = require('./GuardedEgressPolicy');
const { inconclusiveErrorReason } = require('./StreamResolutionOutcome');

const MAX_PLAYLIST_BYTES = 16 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const inconclusive = reason => ({ status: 'inconclusive', reason });

function defaultFetch(url, options) {
  // Retain the existing guarded native transport, Leaf egress and fingerprint.
  // Loading this module does not load a native client or start a worker.
  return require('./ProviderOutbound').safeFetch(url, options);
}

function fatalFailure(error) {
  // Capacity may be marked fatal only to prevent immediate transport fallback.
  // The shared classifier first checks the entire bounded cause chain for a
  // guard/fatal refusal, so a timeout wrapper cannot turn one into a retry.
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

function deniedContent(value) {
  return /antipiracy|anti[-_ ]piracy|stream_notice|this stream is stolen|install the official addon|please reinstall|\/configure\b/i.test(value);
}

function isPlaylist(text, base) {
  if (!/^\uFEFF?#EXTM3U(?:\r?\n|$)/.test(text) || deniedContent(text)) return false;
  let expectsUri = false, foundUri = false;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(1)) {
    const value = line.trim();
    if (!value) continue;
    if (value.startsWith('#EXT-X-STREAM-INF:')) {
      expectsUri = value.slice(18).trim().length > 0;
      continue;
    }
    if (value.startsWith('#EXTINF:')) {
      const duration = Number(value.slice(8).split(',')[0]);
      expectsUri = Number.isFinite(duration) && duration > 0;
      continue;
    }
    if (value.startsWith('#')) continue;
    if (!expectsUri || /\s|[\u0000-\u001f\u007f]/.test(value)) return false;
    try {
      const uri = new URL(value, base);
      let decoded = value;
      try { decoded = decodeURIComponent(value); } catch (_) {}
      if (!['https:', 'http:'].includes(uri.protocol) || uri.username || uri.password || deniedContent(decoded)) return false;
    } catch (_) { return false; }
    foundUri = true;
    expectsUri = false;
  }
  return foundUri && !expectsUri;
}

function createLeafStreamProbe({ fetch = defaultFetch, timeoutMs = 1500, maxConcurrent = 2, maxWaiters = 32 } = {}) {
  if (typeof fetch !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 1500 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2 ||
      !Number.isInteger(maxWaiters) || maxWaiters < 0 || maxWaiters > 32) throw new RangeError('Invalid bounded Leaf probe configuration');
  const inFlight = new Map(), queue = [];
  let active = 0;

  async function inspect(operation) {
    const { url, context, controller } = operation;
    const signal = controller.signal;
    const remaining = () => {
      signal.throwIfAborted();
      const left = Math.ceil(operation.deadline - performance.now());
      if (left <= 0) throw new DOMException('Leaf probe deadline', 'TimeoutError');
      return left;
    };
    const headers = { 'User-Agent': context.userAgent, Referer: context.referer, Accept: '*/*' };
    if (context.origin) headers.Origin = context.origin;
    const response = await fetch(url, {
      headers, signal, timeoutMs: remaining(), attempts: 1, maxBodyBytes: MAX_PLAYLIST_BYTES
    });
    if (response?.url) {
      try { validateLeafManifestUrl(response.url); }
      catch (cause) {
        throw Object.assign(new Error('Invalid Leaf probe redirect', { cause }), {
          code: 'ERR_LEAF_MANIFEST_REDIRECT', isFatal: true
        });
      }
    }
    remaining();
    const status = Number(response?.status);
    if ([401, 403, 404, 410].includes(status)) return { status: 'rejected' };
    if (status !== 200 || response.bodyTruncated || typeof response.text !== 'function') return inconclusive('unavailable');
    // The default transport already buffers at most the requested body cap.
    // Awaiting injected readers keeps the lease until they actually settle.
    const text = await response.text();
    remaining();
    if (typeof text !== 'string') return { status: 'rejected' };
    if (Buffer.byteLength(text, 'utf8') > MAX_PLAYLIST_BYTES) return inconclusive('unavailable');
    return { status: isPlaylist(text, response.url || url) ? 'ok' : 'rejected' };
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
    const error = reason === 'timeout'
      ? new DOMException('Leaf probe deadline', 'TimeoutError')
      : operation.context.signal?.reason || new DOMException('Leaf probe cancelled', 'AbortError');
    if (!operation.controller.signal.aborted) operation.controller.abort(error);
    if (fatalFailure(error)) finish(operation, null, error);
    else finish(operation, inconclusive(reason));
    if (!operation.started) remove(operation);
  }
  function drain() {
    while (active < maxConcurrent && queue.length) {
      const operation = queue.shift();
      if (operation.settled) continue;
      if (performance.now() >= operation.deadline) { stop(operation, 'timeout'); continue; }
      operation.started = true;
      active++;
      Promise.resolve().then(() => inspect(operation)).then(
        value => finish(operation, value),
        error => {
          if (fatalFailure(error)) finish(operation, null, error);
          else finish(operation, inconclusive(inconclusiveErrorReason(error) || 'unavailable'));
        }
      ).finally(() => {
        active--;
        remove(operation);
        drain();
      });
    }
  }
  function check(url, options = {}) {
    try { validateLeafManifestUrl(url); }
    catch (error) { return Promise.reject(error); }
    const context = {
      signal: options.signal,
      referer: options.referer || 'https://sports.highfly.to/',
      origin: options.origin || '',
      userAgent: options.userAgent || USER_AGENT
    };
    if (context.signal?.aborted) {
      const error = context.signal.reason;
      return fatalFailure(error) ? Promise.reject(error) : Promise.resolve(inconclusive(inconclusiveErrorReason(error) || 'cancelled'));
    }
    const budget = Number.isFinite(options.timeoutMs) ? Math.min(timeoutMs, Math.max(0, options.timeoutMs)) : timeoutMs;
    if (budget <= 0) return Promise.resolve(inconclusive('timeout'));
    // A cancellable caller owns its own request and never another caller's.
    const key = context.signal ? Symbol('cancelable Leaf probe') : JSON.stringify([url, context.referer, context.origin, context.userAgent, budget]);
    if (inFlight.has(key)) return inFlight.get(key).promise;
    if (active >= maxConcurrent && queue.length >= maxWaiters) return Promise.resolve(inconclusive('capacity'));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const operation = { key, url, context, resolve, reject, promise, controller: new AbortController(), deadline: performance.now() + budget };
    operation.abort = () => stop(operation, inconclusiveErrorReason(context.signal?.reason) || 'cancelled');
    operation.timer = setTimeout(() => stop(operation, 'timeout'), budget);
    context.signal?.addEventListener('abort', operation.abort, { once: true });
    inFlight.set(key, operation);
    queue.push(operation);
    if (context.signal?.aborted) operation.abort();
    drain();
    return promise;
  }
  return { check };
}

let singleton;
function checkLeafStream(url, options) {
  if (!singleton) singleton = createLeafStreamProbe();
  return singleton.check(url, options);
}

module.exports = { createLeafStreamProbe, checkLeafStream };
