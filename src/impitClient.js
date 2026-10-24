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
const IMPIT_RECYCLE_MS = Math.max(3 * 60 * 1000, Number(process.env.IMPIT_RECYCLE_MS) || 90 * 60 * 1000);

const IMPIT_RSS_RECYCLE_MB = Number(process.env.IMPIT_RSS_RECYCLE_MB || 900);

function getImpit() {
  // Recycle on schedule, or early when the process crosses an RSS budget
  // (native pools grow with fetch volume; recycling frees them without
  // waiting for the full interval). Minimum 60s age prevents churn.
  const rssOverBudget = process.memoryUsage().rss / 1048576 > IMPIT_RSS_RECYCLE_MB;
  const ageOk = Date.now() - _impitBornAt > 60000;
  if (_impitInstance && (Date.now() - _impitBornAt > IMPIT_RECYCLE_MS || (rssOverBudget && ageOk))) {
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

let _impitVanillaInstance;
let _impitVanillaBornAt = 0;

function getVanillaImpit() {
  if (_impitVanillaInstance && Date.now() - _impitVanillaBornAt > IMPIT_RECYCLE_MS) {
    console.log('[impitClient] recycling vanilla impit instance');
    _impitVanillaInstance = undefined;
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch (_) {}
    }
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

function isDamitvTarget(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('damitv.st');
}

// -- Dead-host blocklist -------------------------------------------------------
// Hosts confirmed dead in production (live-VPS evidence 2026-10-24): prewarm /
// verify / re-mint fetched them on every cycle and they can never answer.
//   welovetocare.shop — Vavoo-family out-N mirror; the domain now presents a
//     dns.google certificate (repointed to a sink), so every fetch pays a full
//     TLS handshake to fail certificate validation, 3 impit attempts + 1
//     undici fallback, and a multi-KB cert-dump log line.
//   ksohls.ru — DaddyLive-family embed mirror (/premiumtv/daddyhd.php);
//     refuses connections outright.
// Both are re-harvested from upstream pages at runtime, so deleting them from
// any static config cannot purge them. Blocking at this fetch choke point
// kills every path (prewarm, verify, re-mint, ingestion) at once.
const DEAD_HOSTS = new Set([
  'welovetocare.shop',
  'ksohls.ru',
]);
// Deploy-time extension without a code change: DEAD_HOSTS="a.com,b.org"
for (const extra of String(process.env.DEAD_HOSTS || '').split(',')) {
  const host = extra.trim().toLowerCase();
  if (host) DEAD_HOSTS.add(host);
}

/**
 * Returns the matched dead registrable domain for a URL (subdomains like
 * out-3.welovetocare.shop count), or null when the URL is not dead. Suffix
 * walking is anchored at the hostname's own labels, so
 * welovetocare.shop.evil.com can never match.
 */
function isDeadHost(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split('.');
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(i).join('.');
      if (DEAD_HOSTS.has(candidate)) return candidate;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function isDembedTarget(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('dembed.st');
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
 *   undici (default 3). Callers that run their own retry policy should pass 1,
 *   so the two layers do not multiply: three impit tries at a 5s timeout plus
 *   backoff is ~17s inside a call the caller believes is bounded by timeoutMs.
 * @returns {{ ok, status, text: () => string, json: () => object }}
 */
async function safeFetch(url, opts = {}) {
  // Dead hosts are rejected before any client selection, socket or TLS work:
  // no impit attempts, no undici fallback, no log line. The error is
  // deliberately non-transient (unknown code, calm message) so the shared
  // retry policy treats it as a verdict, not a blip, and never re-fires it.
  const deadHost = isDeadHost(url);
  if (deadHost) {
    throw Object.assign(
      new Error(`dead host blocked: ${deadHost}`),
      { code: 'ERR_DEAD_HOST', deadHost }
    );
  }
  const { signal, timeoutMs = 15000, attempts = 3 } = opts;
  // Method, headers and body are reassigned per redirect hop on the undici path
  // (see the redirect loop below), so they cannot be destructured as const.
  let { method = 'GET', headers = {}, body } = opts;

  // Selective proxying: route DamiTV requests through local WARP SOCKS5 proxy if configured
  const warpProxyUrl = process.env.WARP_PROXY_URL || process.env.DAMITV_PROXY_URL;
  const isDamitv = isDamitvTarget(url);
  const isDembed = isDembedTarget(url);
  const proxyUrl = opts.proxyUrl || (isDamitv && warpProxyUrl ? warpProxyUrl : null);
  const impit = proxyUrl ? getProxyImpit(proxyUrl) : (isDamitv ? (getVanillaImpit() || getImpit()) : getImpit());
  const maxAttempts = Math.max(1, attempts);

  if (isDamitv) {
    const headerKeys = Object.keys(headers || {});
    const uaKey = headerKeys.find(k => k.toLowerCase() === 'user-agent');
    const currentUa = uaKey ? headers[uaKey] : '';
    const hasValidUa = currentUa && !currentUa.includes('Chrome/127');
    const hasRef = headerKeys.some(k => k.toLowerCase() === 'referer');
    headers = {
      ...headers,
      ...(hasValidUa ? {} : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }),
      ...(hasRef ? {} : { 'Referer': 'https://damitv.st/' }),
    };
  } else if (isDembed) {
    const headerKeys = Object.keys(headers || {});
    const hasUa = headerKeys.some(k => k.toLowerCase() === 'user-agent');
    const hasRef = headerKeys.some(k => k.toLowerCase() === 'referer');
    const hasDest = headerKeys.some(k => k.toLowerCase() === 'sec-fetch-dest');
    headers = {
      ...(hasUa ? {} : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }),
      ...(hasRef ? {} : { 'Referer': 'https://dlive.sx/' }),
      ...(hasDest ? {} : { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site' }),
      ...headers,
    };
  }

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
          if (proxyUrl) {
            // Proxied requests must never fall back to undici (which bypasses proxy)
            return impit403;
          }
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
        const errMsg = String(impitErr);
        if (errMsg.includes('InvalidCertificate') || errMsg.includes('UnknownIssuer') || errMsg.includes('certificate has expired')) {
           break;
        }
        if (attempt < maxAttempts) {
           await new Promise(r => setTimeout(r, 800 * attempt));
        }
      } finally {
        // Always clear the timeout so a fast response does not leave a pending
        // timer holding the event loop (timer churn under load).
        if (timer) clearTimeout(timer);
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

module.exports = { safeFetch, isImpitAvailable, getImpit, isDamitvTarget, isDembedTarget, isDeadHost };
