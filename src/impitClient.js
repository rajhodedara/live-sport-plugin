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
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch (_) {}
    }
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
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch (_) {}
    }
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

function isDamitvTarget(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('damitv.st');
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

// -- Core helper --------------------------------------------------------------
/**
 * safeFetch - fetches a URL using impit when available, falls back to undici.
 *
 * @param {string} url
 * @param {object} opts   - { method, headers, body, signal, timeoutMs, attempts, proxyUrl }
 *   attempts: how many times to try the impit path before falling back to
 *   undici (default 3). timeoutMs is one total budget across headers, body,
 *   retries, backoff and fallback. External retry policies still add calls;
 *   those callers should pass attempts: 1 and retain their own outer deadline.
 * @returns {{ ok, status, text: () => string, json: () => object }}
 */
async function safeFetch(url, opts = {}) {
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
    new Error(`safeFetch timeout ${timeoutMs}ms`), { name: 'TimeoutError', code: 'ETIMEDOUT' }
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
  const proxyUrl = opts.proxyUrl || (isDamitv && warpProxyUrl ? warpProxyUrl : null);
  const impit = proxyUrl ? getProxyImpit(proxyUrl) : getImpit();
  const maxAttempts = Math.max(1, attempts);

  if (isDamitv) {
    const headerKeys = Object.keys(headers || {});
    const hasUa = headerKeys.some(k => k.toLowerCase() === 'user-agent');
    const hasRef = headerKeys.some(k => k.toLowerCase() === 'referer');
    headers = {
      ...(hasUa ? {} : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }),
      ...(hasRef ? {} : { 'Referer': 'https://damitv.st/' }),
      ...headers,
    };
  }

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
        const buf = await res.arrayBuffer();
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
            headers: res.headers,
            text: async () => Buffer.from(buf).toString('utf8'),
            json: async () => JSON.parse(Buffer.from(buf).toString('utf8')),
            arrayBuffer: async () => buf,
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
          headers: res.headers,
          text: async () => Buffer.from(buf).toString('utf8'),
          json: async () => JSON.parse(Buffer.from(buf).toString('utf8')),
          arrayBuffer: async () => buf,
        };
      } catch (impitErr) {
        if (signal.aborted) throw signal.reason || impitErr;
        lastErr = impitErr;
        const errMsg = String(impitErr);
        if (errMsg.includes('InvalidCertificate') || errMsg.includes('UnknownIssuer') || errMsg.includes('certificate has expired')) {
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
  //   - 301/302/303 "moved": the request becomes a bodyless GET, as a browser
  //     would send it (HEAD stays HEAD, since it has no body to drop);
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

    if (method !== 'HEAD' && res.statusCode !== 307 && res.statusCode !== 308) {
      method = 'GET';
      body = undefined;
      // A framing header describing a body that no longer exists corrupts the
      // request, so drop it when the body is dropped. (Plain-object headers are
      // what every caller in this codebase passes.)
      if (headers && headers.constructor === Object && 'content-length' in headers) {
        headers = Object.assign({}, headers);
        delete headers['content-length'];
      }
    }
    currentUrl = nextUrl.toString();
  }
  const buf = await res.body.arrayBuffer();
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    headers: res.headers,
    text: async () => Buffer.from(buf).toString('utf8'),
    json: async () => JSON.parse(Buffer.from(buf).toString('utf8')),
    arrayBuffer: async () => buf,
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

module.exports = { safeFetch, isImpitAvailable, getImpit, isDamitvTarget };
