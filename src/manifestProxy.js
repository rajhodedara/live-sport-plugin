/**
 * manifestProxy.js - upstream manifest fetch + short-TTL cache
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const container = require('./container');

const { safeFetch: _safeFetch } = require('./impitClient');

// ─── Manifest proxy: short-TTL cache + request coalescing ───────────────────
// Live HLS players reload /api/manifest every 2-6 s per viewer. A validated
// short-TTL cache removes per-viewer TLS handshakes and repeated upstream
// fetches. Key = url|referer|origin. Only bodies containing #EXT are cached.
const MANIFEST_TTL_MS = 3000;
const MANIFEST_CACHE_MAX = 100;
const MANIFEST_NEGATIVE_TTL_MS = 15 * 1000;
const manifestCache = new Map();      // key -> { body, expiresAt, lastAccess }
const manifestInFlight = new Map();   // key -> Promise (coalesced upstream fetch)

// Returns the stored cache ENTRY (positive or negative), or null when

// missing/expired (expired entries are deleted as before).
function manifestCacheGet(key) {
  const e = manifestCache.get(key);
  if (!e) return null;
  const now = Date.now();
  if (now > e.expiresAt) {
    manifestCache.delete(key);
    return null;
  }
  e.lastAccess = now;
  return e;
}

function manifestCacheSet(key, body, ttlMs = MANIFEST_TTL_MS) {
  const now = Date.now();
  manifestCache.set(key, { body, expiresAt: now + ttlMs, lastAccess: now });
  evictManifestCacheIfNeeded();
}

function evictManifestCacheIfNeeded() {
  if (manifestCache.size > MANIFEST_CACHE_MAX) {
    const byAccess = [...manifestCache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const excess = manifestCache.size - MANIFEST_CACHE_MAX;
    for (let i = 0; i < excess; i++) manifestCache.delete(byAccess[i][0]);
  }
}

// Negative caching: dead upstreams (non-m3u8 body / fetch failure) are stored
// briefly so player polls stop re-fetching them until the entry expires.
function manifestCacheSetNegative(key, status, body) {
  const now = Date.now();
  manifestCache.set(key, { negative: true, status, body, expiresAt: now + MANIFEST_NEGATIVE_TTL_MS, lastAccess: now });
  evictManifestCacheIfNeeded();
}

// When upstream reports a proxied stream dead, the most likely cause is the
// time-limited upstream token embedded in that proxy URL having expired.
// Downgrade the originating resolve-cache entry so the next click re-mints a
// fresh token instead of replaying the same dead URL for the rest of its TTL.
// Takes the incoming request URL (which carries the `rck` param added by
// streams.js), not the cache key. Fully defensive: a missing param, unknown
// key or failed lookup must never affect the response the player receives.
function notifyResolveCacheOfDeadStream(requestUrl) {
  try {
    const rck = new URL('http://localhost' + requestUrl).searchParams.get('rck');
    if (!rck) return;
    container.resolve('streamResolveCache').noteFailure(rck);
  } catch (_) {
    // Recovery hint only — never surface this to the request path.
  }
}

// A playlist that references no URI at all (no segments, no variant streams) is
// unusable. Live providers do serve such headers while a source has no segments
// yet; a player handed one simply stalls. Treat it as dead so the client can
// fail over instead of hanging.
function playlistHasContent(text) {
  return String(text).split('\n').some((line) => {
    const t = line.trim();
    return t.length > 0 && !t.startsWith('#');
  });
}

// Fetch + validate the upstream manifest. Throws on failure so coalesced
// waiters share the same outcome; successful bodies are cached by the caller.
async function fetchUpstreamManifest(targetUrl, referer, origin) {
  const headers = {
    'Referer': referer,
    'Origin': origin,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
  };
  // _safeFetch: impit (browser TLS fingerprint) with automatic undici fallback.
  // A hard 10 s timeout ensures a hung upstream can never hold the viewer's poll.
  const attempt = async () => {
    const result = await _safeFetch(targetUrl, { headers, timeoutMs: 10000 });
    if (!result.ok) {
      // Carry the upstream status so the caller can tell "the token/CDN said no"
      // apart from "our proxy is broken" — they need different HTTP responses.
      const err = new Error(`HTTP ${result.status}`);
      err.statusCode = result.status;
      throw err;
    }
    return await result.text();
  };

  try {
    return await attempt();
  } catch (err) {
    // Transient upstream trouble: these load balancers (lb*.wfty.st, strmd.st) are
    // observed to throw 500/502/503/504 intermittently or reset connections (ECONNRESET)
    // during high load. A single retry after a short pause recovers the large majority.
    const status = err && err.statusCode;
    const isNetworkTransient = err && (
      err.code === 'ECONNRESET' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'UND_ERR_SOCKET' ||
      (err.message && /reset|timeout|socket/i.test(err.message))
    );
    const isTransient = status === 500 || status === 502 || status === 503 || status === 504 || isNetworkTransient;
    if (!isTransient) throw err;
    await new Promise((r) => setTimeout(r, 400));
    console.warn(`[ManifestProxy] Upstream ${status || err.code || 'network glitch'} — retrying once: ${String(targetUrl).slice(0, 90)}`);
    return await attempt(); // a second failure propagates with statusCode intact
  }
}


module.exports = {
  MANIFEST_TTL_MS, MANIFEST_CACHE_MAX, MANIFEST_NEGATIVE_TTL_MS,
  manifestCache, manifestInFlight,
  manifestCacheGet, manifestCacheSet, manifestCacheSetNegative, evictManifestCacheIfNeeded,
  notifyResolveCacheOfDeadStream, playlistHasContent, fetchUpstreamManifest
};
