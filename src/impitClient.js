/**
 * impitClient.js — Safe impit singleton with undici fallback
 *
 * impit is a native Rust/NAPI addon. On some architectures (ARM64 VPS,
 * Alpine/musl Linux, certain Windows Server builds) the native binary may fail
 * to load. This module wraps every call so a missing or broken impit
 * transparently falls back to undici — callers never need to worry about it.
 *
 * Usage:
 *   const { safeFetch } = require('./impitClient');
 *   const { ok, status, text } = await safeFetch(url, { headers, method });
 */

'use strict';

const { request: undiciRequest, Agent } = require('undici');
// -- Singleton -----------------------------------------------------------------
// undefined  = not yet probed
// null       = probed and unavailable (native binary missing / bad arch)
// Impit obj  = ready to use
let _impitInstance;
let _impitBornAt = 0;

// The Impit instance holds Rust-side state (connection pools, TLS sessions,
// per-host buffers) that accumulates with fetch volume and is never released —
// measured on the live server as worker native memory climbing ~250 MB/h and
// never dropping, even at zero demand. impit exposes no close() API, so the
// instance is dropped and re-probed periodically; the Rust side is freed when
// V8 collects the old object (global.gc() right after, when --expose-gc is on).
// In-flight fetches keep their reference and finish safely on the old instance.
const IMPIT_RECYCLE_MS = Math.max(10 * 60 * 1000, Number(process.env.IMPIT_RECYCLE_MS) || 90 * 60 * 1000);

function getImpit() {
  if (_impitInstance && Date.now() - _impitBornAt > IMPIT_RECYCLE_MS) {
    console.log('[impitClient] recycling impit instance (native memory hygiene)');
    _impitInstance = undefined;
    // global.gc omitted during active traffic to prevent SIGBUS/SIGSEGV race
  }
  if (_impitInstance !== undefined) return _impitInstance;
  try {
    const { Impit } = require('impit');
    _impitInstance = new Impit({ browser: 'chrome142' });
    _impitBornAt = Date.now();
    console.log('[impitClient] impit native client loaded successfully.');
  } catch (e) {
    _impitInstance = null;
    console.warn(`[impitClient] impit unavailable (${e.message}). All requests will use undici fallback - streams will still work.`);
  }
  return _impitInstance;
}

let _impitProxyInstance;
let _impitProxyBornAt = 0;
let _impitProxyUrl = null;

function getProxyImpit(proxyUrl) {
  if (!proxyUrl) return getImpit();
  if (_impitProxyInstance && (_impitProxyUrl !== proxyUrl || Date.now() - _impitProxyBornAt > IMPIT_RECYCLE_MS)) {
    console.log('[impitClient] recycling proxy impit instance');
    _impitProxyInstance = undefined;
    // global.gc omitted during active traffic to prevent SIGBUS/SIGSEGV race
  }
  if (_impitProxyInstance !== undefined) return _impitProxyInstance;
  try {
    const { Impit } = require('impit');
    _impitProxyInstance = new Impit({ proxyUrl });
    _impitProxyBornAt = Date.now();
    _impitProxyUrl = proxyUrl;
    console.log(`[impitClient] impit proxy client initialized with ${proxyUrl}`);
  } catch (e) {
    _impitProxyInstance = null;
    console.warn(`[impitClient] impit proxy client unavailable (${e.message}).`);
  }
  return _impitProxyInstance;
}

let _impitVanillaInstance;
let _impitVanillaBornAt = 0;

function getVanillaImpit() {
  if (_impitVanillaInstance && Date.now() - _impitVanillaBornAt > IMPIT_RECYCLE_MS) {
    console.log('[impitClient] recycling vanilla impit instance');
    _impitVanillaInstance = undefined;
    // global.gc omitted during active traffic to prevent SIGBUS/SIGSEGV race
  }
  if (_impitVanillaInstance !== undefined) return _impitVanillaInstance;
  try {
    const { Impit } = require('impit');
    _impitVanillaInstance = new Impit();
    _impitVanillaBornAt = Date.now();
    console.log('[impitClient] vanilla impit client loaded successfully.');
  } catch (e) {
    _impitVanillaInstance = null;
    console.warn(`[impitClient] vanilla impit unavailable (${e.message}).`);
  }
  return _impitVanillaInstance;
}

const { isDamitvTarget, isDembedTarget, providerRequestHeaders } = require('./services/ProviderRequestHeaders');

// -- impit TLS skip list ------------------------------------------------------
// rustls (impit's TLS) validates certificates against a curated root store and
// deterministically rejects some sites Node accepts (livetv.sx serves a chain
// rustls flags as UnknownIssuer on every handshake). That failure cannot
// change on retry, yet every new request still paid one doomed TLS handshake
// plus a warn log before the undici fallback succeeded. Remember such hosts
// for a cooldown window and route them straight to undici; the TTL self-heals
// when the site rotates its certificate or impit updates its root store.
const IMPIT_TLS_SKIP_TTL_MS = Math.max(60 * 1000, Number(process.env.IMPIT_TLS_SKIP_TTL_MS) || 30 * 60 * 1000);
const IMPIT_TLS_SKIP_MAX = 64;
const _impitTlsSkipHosts = new Map(); // lowercase hostname -> expiresAt

function isTlsValidationError(errMsg) {
  return errMsg.includes('InvalidCertificate') || errMsg.includes('UnknownIssuer') || errMsg.includes('certificate has expired');
}

function impitTlsBlocked(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return false; }
  const until = _impitTlsSkipHosts.get(host);
  if (until === undefined) return false;
  if (Date.now() > until) {
    _impitTlsSkipHosts.delete(host);
    return false;
  }
  return true;
}

function recordImpitTlsFailure(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return; }
  const isNew = !_impitTlsSkipHosts.has(host);
  if (isNew && _impitTlsSkipHosts.size >= IMPIT_TLS_SKIP_MAX) {
    _impitTlsSkipHosts.delete(_impitTlsSkipHosts.keys().next().value);
  }
  _impitTlsSkipHosts.set(host, Date.now() + IMPIT_TLS_SKIP_TTL_MS);
  if (isNew) {
    console.warn(`[impitClient] impit TLS validation deterministically fails for ${host}; using undici directly for ~${Math.round(IMPIT_TLS_SKIP_TTL_MS / 60000)} min`);
  }
}

// -- Shared undici keep-alive agent -------------------------------------------
const _undiciAgent = new Agent({
  connect: { timeout: 20000, rejectUnauthorized: false },
  keepAliveTimeout: 15000,
  keepAliveMaxTimeout: 30000,
});

// Enough for the mirror 301s observed in production, small enough that a rogue
// redirect loop costs about what a single timed-out request costs.
const MAX_REDIRECT_HOPS = 5;

const { filterRedirectHeaders, removeBodyHeaders, shouldDropRedirectBody } = require('./services/RedirectHeaderPolicy');

/**
 * Read at most maxBytes from a Fetch-style or Undici response body.
 * The caller can distinguish a complete body from a prefix sample.
 */
async function readLimitedBody(body, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
  if (!body) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks = [];
  let total = 0;
  let truncated = false;

  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        // Keep a view while inspecting the chunk; copy only the accepted prefix
        // if one transport chunk is larger than the remaining budget.
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        const remaining = maxBytes - total;
        if (chunk.byteLength > remaining) {
          if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
          total += Math.max(0, remaining);
          truncated = true;
          try { await reader.cancel(); } catch (_) {}
          break;
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  } else if (body[Symbol.asyncIterator]) {
    for await (const value of body) {
      if (!value || value.byteLength === 0) continue;
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const remaining = maxBytes - total;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
        total += Math.max(0, remaining);
        truncated = true;
        if (typeof body.destroy === 'function') {
          try { body.destroy(); } catch (_) {}
        }
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } else {
    throw new TypeError('Response body is not a readable stream');
  }
  return { buffer: Buffer.concat(chunks, total), truncated };
}

// -- Core helper --------------------------------------------------------------
/**
 * safeFetch - fetches a URL using impit when available, falls back to undici.
 *
 * @param {string} url
 * @param {object} opts   - { method, headers, body, signal, timeoutMs, attempts, proxyUrl, maxBodyBytes }
 *   attempts: how many times to try the impit path before falling back to
 *   undici (default 3). timeoutMs is one total budget across headers, body,
 *   retries, backoff and fallback. External retry policies still add calls;
 *   those callers should pass attempts: 1 and retain their own outer deadline.
 * @returns {{ ok, status, bodyTruncated: boolean, text: () => string, json: () => object }}
 */
// -- Dead-host blocklist -------------------------------------------------------
// Hosts confirmed dead in production: prewarm / verify / re-mint fetched them
// on every cycle and they can never answer.
const DEAD_HOSTS = new Set([
  'welovetocare.shop',
  'ksohls.ru',
]);
for (const extra of String(process.env.DEAD_HOSTS || '').split(',')) {
  const host = extra.trim().toLowerCase();
  if (host) DEAD_HOSTS.add(host);
}

function isDeadHost(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split('.');
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(i).join('.');
      if (DEAD_HOSTS.has(candidate)) return candidate;
    }
  } catch (_) {}
  return null;
}

async function safeFetch(url, opts = {}) {
  // Local integration candidate: public metadata callers share guarded native
  // and Undici transports; neither fallback can bypass destination validation.
  if (opts.guardExternal === true) {
    return require('./services/SharedOutboundFetch').fetchSharedOutbound(url, opts);
  }
  const deadMatch = isDeadHost(url);
  if (deadMatch) {
    return {
      ok: false,
      status: 410,
      bodyTruncated: false,
      text: async () => '',
      json: async () => ({})
    };
  }

  const { signal: callerSignal, timeoutMs = 15000 } = opts;
  const abortReason = () => callerSignal.reason instanceof Error ? callerSignal.reason :
    Object.assign(new Error('safeFetch aborted'), { name: 'AbortError', cause: callerSignal.reason });
  if (callerSignal?.aborted) throw abortReason();
  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  const cancel = reason => { controller.abort(reason); rejectCancelled(reason); };
  const onCallerAbort = () => cancel(abortReason());
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => cancel(Object.assign(
    new Error('safeFetch timeout ' + timeoutMs + 'ms'), { name: 'TimeoutError', code: 'ETIMEDOUT' }
  )), timeoutMs);
  try {
    return await Promise.race([
      fetchWithinDeadline(url, { ...opts, signal: controller.signal }, deadlineAt),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithinDeadline(url, opts, deadlineAt) {
  const { signal, timeoutMs = 15000, attempts = 3 } = opts;
  // Method, headers and body are reassigned per redirect hop on the undici path
  // (see the redirect loop below), so they cannot be destructured as const.
  let { method = 'GET', headers = {}, body } = opts;

  // Selective proxying: route DamiTV requests through local WARP SOCKS5 proxy if configured
  const warpProxyUrl = process.env.WARP_PROXY_URL || process.env.DAMITV_PROXY_URL;
  const isDamitv = isDamitvTarget(url);
  const isDembed = isDembedTarget(url);
  const proxyUrl = opts.proxyUrl || (isDamitv && warpProxyUrl ? warpProxyUrl : null);
  // Direct (non-proxied) requests to hosts whose certificate chain impit
  // deterministically rejects skip the doomed TLS handshake entirely and go
  // straight to the undici path below.
  const impit = proxyUrl ? getProxyImpit(proxyUrl)
    : (isDamitv ? (getVanillaImpit() || getImpit()) : (impitTlsBlocked(url) ? null : getImpit()));
  const maxAttempts = Math.max(1, attempts);

  headers = providerRequestHeaders(url, headers);

  // -- Path A: impit ---------------------------------------------------------
  if (impit) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // The caller gave up (deadline hit upstream); stop burning its budget.
      if (signal.aborted) throw signal.reason;
      try {
        const res = await impit.fetch(url, {
          method, headers, body, signal,
          timeout: Math.max(1, Math.ceil(deadlineAt - performance.now())),
        });
        const { buffer: buf, truncated: bodyTruncated } = Number.isSafeInteger(opts.maxBodyBytes) && opts.maxBodyBytes > 0
          ? await readLimitedBody(res.body, opts.maxBodyBytes)
          : { buffer: await res.arrayBuffer(), truncated: false };
        if (res.status === 400 && url.includes('ok.ru')) {
           throw new Error('ok.ru blocked impit');
        }
        // Some CDNs intermittently refuse impit's browser TLS fingerprint
        // with a 403 while accepting undici on the SAME token (observed on
        // messi.damitv.st: impit 8/30 403, undici 0/30, interleaved in one
        // process). A 403 is a real answer, but which client asked is part
        // of the question. Break out of the impit loop (retrying the same
        // fingerprint cannot change the answer) and let the undici path try
        // the identical request once; if undici throws, the original 403 is
        // returned so "both engines agree it is blocked" still surfaces.
        if (res.status === 403) {
          const impit403 = {
            ok: false,
            status: res.status,
            url: res.url || url,
            headers: res.headers,
            bodyTruncated,
            text: async () => Buffer.from(buf).toString('utf8'),
            json: async () => JSON.parse(Buffer.from(buf).toString('utf8')),
            arrayBuffer: async () => Buffer.isBuffer(buf) ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf,
          };
          if (proxyUrl) {
            // Proxied requests must never fall back to undici (which bypasses proxy)
            return impit403;
          }
          console.warn(`[impitClient] impit got 403, trying undici once for: ${url.slice(0, 90)}`);
          try {
            return await undiciPath(method, headers, body, url, signal, timeoutMs);
          } catch (err) {
            if (signal.aborted) throw signal.reason || err;
            return impit403;
          }
        }
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          url: res.url || url,
          headers: res.headers,
          bodyTruncated,
          text: async () => Buffer.from(buf).toString('utf8'),
          json: async () => JSON.parse(Buffer.from(buf).toString('utf8')),
          arrayBuffer: async () => Buffer.isBuffer(buf) ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf,
        };
      } catch (impitErr) {
        if (signal.aborted) throw signal.reason || impitErr;
        lastErr = impitErr;
        const errMsg = String(impitErr);
        if (isTlsValidationError(errMsg)) {
          // Deterministic failure: the same handshake cannot succeed on retry.
          // Record the host for direct requests only — a proxied failure may
          // be the proxy's fault, and the proxied path must never fall back
          // to undici anyway (it would bypass the proxy).
          if (!proxyUrl) recordImpitTlsFailure(url);
          break;
        }
        if (attempt < maxAttempts) {
           await abortableDelay(800 * attempt, signal);
        }
      }
    }
    if (proxyUrl) {
      throw lastErr || new Error(`[impitClient] impit proxy fetch failed for ${url}`);
    }
    const cleanErr = lastErr && lastErr.message 
      ? lastErr.message.replace(/\s+/g, ' ').trim() 
      : String(lastErr);
    console.warn(`[impitClient] impit fetch failed after ${maxAttempts} attempt(s) (${cleanErr}), falling back to undici for: ${url.slice(0, 90)}`);
  }

  // The undici path, callable directly from the impit 403 branch so the same
  // request can be retried with a different TLS fingerprint.
  // Declared as a function (hoisted) so the impit 403 branch above can call it
  // before this line is reached. A `const` arrow would sit in the temporal
  // dead zone there, and the ReferenceError would be swallowed by that
  // branch's catch, silently disabling the fallback.
  async function undiciPath(method, headers, body, url, signal, timeoutMs) {

  // -- Path B: undici --------------------------------------------------------
  // undici.request() does NOT follow redirects the way fetch/impit do. Several
  // upstreams bounce their primary host to a mirror with a 301 (dlstreams.st ->
  // dlive.sx is the observed case), so without following them the caller saw
  // `ok:false, status:301` and silently recorded a healthy primary domain as a
  // failure. Follow the chain here:
  //   - 301/302 convert POST to a bodyless GET; 303 converts every method
  //     except HEAD. Other methods retain their method and body on 301/302.
  //   - 307/308 "relocated": method and body are preserved, the resource is
  //     still the same one;
  //   - missing/empty Location is not followable, so the redirect response is
  //     returned as-is rather than retried forever;
  //   - the hop count is bounded, and the timeoutMs budget covers the WHOLE
  //     chain (each hop only gets the time left), so a redirect loop cannot
  //     multiply the caller's deadline.
  let currentUrl = url;
  let res;
  for (let hop = 0; ; hop++) {
    const remainingMs = Math.ceil(deadlineAt - performance.now());
    if (remainingMs <= 0) throw Object.assign(new Error(`safeFetch timeout ${timeoutMs}ms (redirect chain)`), { name: 'TimeoutError', code: 'ETIMEDOUT' });
    res = await undiciRequest(currentUrl, {
      method,
      headers,
      body,
      signal,
      headersTimeout: remainingMs,
      bodyTimeout: remainingMs,
      dispatcher: _undiciAgent,
    });

    const isRedirect = res.statusCode === 301 || res.statusCode === 302
      || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308;
    if (!isRedirect || hop >= MAX_REDIRECT_HOPS) break;

    const rawLocation = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
    // Drain the redirect body: an unconsumed one holds the keep-alive socket.
    try { await res.body.dump(); } catch (_) { /* nothing to release */ }
    if (!rawLocation) break;

    let nextUrl;
    try {
      // A Location may be relative, so resolve it against the current hop.
      nextUrl = new URL(rawLocation, currentUrl);
    } catch (_) { break; }
    if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') break;

    // Compare full origins (scheme, host, effective port), not hostname alone.
    // Credentials remain removed if a later redirect returns to the old host.
    if (nextUrl.origin !== new URL(currentUrl).origin) {
      headers = filterRedirectHeaders(headers);
    }

    if (shouldDropRedirectBody(res.statusCode, method)) {
      method = 'GET';
      body = undefined;
      // Remove body-specific headers in every supported header representation.
      headers = removeBodyHeaders(headers);
    }
    currentUrl = nextUrl.toString();
  }
  const { buffer: buf, truncated: bodyTruncated } = Number.isSafeInteger(opts.maxBodyBytes) && opts.maxBodyBytes > 0
    ? await readLimitedBody(res.body, opts.maxBodyBytes)
    : { buffer: await res.body.arrayBuffer(), truncated: false };
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    url: currentUrl,
    headers: res.headers,
    bodyTruncated,
    text: async () => Buffer.from(buf).toString('utf8'),
    json: async () => JSON.parse(Buffer.from(buf).toString('utf8')),
    arrayBuffer: async () => Buffer.isBuffer(buf) ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf,
  };
  };

  return undiciPath(method, headers, body, url, signal, timeoutMs);
}

/**
 * isImpitAvailable - quick runtime check, useful for startup logs.
 */
function isImpitAvailable() {
  return getImpit() !== null;
}

module.exports = { safeFetch, isImpitAvailable, getImpit, isDamitvTarget, isDembedTarget, readLimitedBody };
