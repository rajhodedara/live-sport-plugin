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

function getImpit() {
  if (_impitInstance !== undefined) return _impitInstance;
  try {
    const { Impit } = require('impit');
    _impitInstance = new Impit({ browser: 'chrome142' });
    console.log('[impitClient] impit native client loaded successfully.');
  } catch (e) {
    _impitInstance = null;
    console.warn(`[impitClient] impit unavailable (${e.message}). All requests will use undici fallback - streams will still work.`);
  }
  return _impitInstance;
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
 * @param {object} opts   - { method, headers, body, signal, timeoutMs, attempts }
 *   attempts: how many times to try the impit path before falling back to
 *   undici (default 3). Callers that run their own retry policy should pass 1,
 *   so the two layers do not multiply: three impit tries at a 5s timeout plus
 *   backoff is ~17s inside a call the caller believes is bounded by timeoutMs.
 * @returns {{ ok, status, text: () => string, json: () => object }}
 */
async function safeFetch(url, opts = {}) {
  const { signal, timeoutMs = 15000, attempts = 3 } = opts;
  // Method, headers and body are reassigned per redirect hop on the undici path
  // (see the redirect loop below), so they cannot be destructured as const.
  let { method = 'GET', headers = {}, body } = opts;
  const impit = getImpit();
  const maxAttempts = Math.max(1, attempts);

  // -- Path A: impit ---------------------------------------------------------
  if (impit) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // The caller gave up (deadline hit upstream); stop burning its budget.
      if (signal && signal.aborted) throw Object.assign(new Error('aborted before impit attempt'), { name: 'AbortError' });
      let timer = null;
      try {
        const res = await Promise.race([
          impit.fetch(url, { method, headers, body }),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`impit timeout ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
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
          console.warn(`[impitClient] impit got 403, trying undici once for: ${url.slice(0, 90)}`);
          try {
            return await undiciPath(method, headers, body, url, signal, timeoutMs);
          } catch (_) {
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
        lastErr = impitErr;
        if (attempt < maxAttempts) {
           await new Promise(r => setTimeout(r, 800 * attempt));
        }
      } finally {
        // Always clear the timeout so a fast response does not leave a pending
        // timer holding the event loop (timer churn under load).
        if (timer) clearTimeout(timer);
      }
    }
    console.warn(`[impitClient] impit fetch failed after ${maxAttempts} attempt(s) (${lastErr.message}), falling back to undici for: ${url}`);
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
  const deadlineAt = Date.now() + timeoutMs;
  let currentUrl = url;
  let res;
  for (let hop = 0; ; hop++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error(`undici timeout ${timeoutMs}ms (redirect chain)`);
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

module.exports = { safeFetch, isImpitAvailable, getImpit };
