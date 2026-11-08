'use strict';

/**
 * services/LeafMint.js - mint a papacito playback URL at the moment it is needed.
 *
 * Upstream (`sports.highfly.to/<install-config>/stream/sport/<matchId>.json`) answers
 * with stream objects whose `url` is `https://papacito.cfd/m3u/<slug>/live.m3u8?ft=<JWT>`.
 * That JWT is bound to the IP that asked for it. Mint and manifest fetch use the same
 * guarded Leaf egress policy. A bounded server-side cache avoids mint storms; the URL
 * is never stored in a player tile and a denied manifest invalidates this cache.
 *
 * Failure handling:
 *
 * Upstream throttles this endpoint - observed `HTTP 429` in production - and a naive
 * client turns that into a self-sustaining storm: every playlist request retries the
 * mint immediately, so the 429 never decays. Failed mints are remembered per
 * `(matchId, slug)` and block normal attempts for a backoff window.
 *
 * Explicit force can refresh a cached credential, but an active upstream rate
 * limit is honored. A still-valid cached URL can be reused without extending its
 * expiry. Invalidation discards the credential and supersedes older requests.
 */

const providerOutbound = require('./ProviderOutbound');
const { validateLeafManifestUrl } = require('./GuardedEgressPolicy');
const { resolveLeafInstallConfig, normalizeConfigBlob, extractOrigin, UUID_REGEX } = require('./LeafInstallConfig');
const { inconclusiveErrorReason } = require('./StreamResolutionOutcome');
const { rateLimitDelay, recordAccountRateLimit, accountCooldownRemaining, resetAccountRateLimits } = require('./LeafRateLimitState');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const MINT_TTL_MS = Math.min(8 * 60 * 60 * 1000, Math.max(5 * 1000, num(process.env.LEAF_MINT_TTL_MS, 4 * 60 * 60 * 1000)));
const MINT_TIMEOUT_MS = Math.min(30000, Math.max(2000, num(process.env.LEAF_MINT_TIMEOUT_MS, 8000)));
const MAX_MINT_BYTES = 256 * 1024;

// Backoff: base delay per failure class, doubling per consecutive failure, capped.
const NEG_BASE_MS = num(process.env.LEAF_MINT_BACKOFF_MS, 15 * 1000); // transport errors / 5xx
const NEG_BASE_429_MS = 30 * 1000;   // explicit throttling
const NEG_BASE_NOMEDIA_MS = 60 * 1000; // no signed URL
const NEG_BASE_HONEYPOT_MS = 10 * 1000; // playlist denied or returned invalid media
const NEG_MAX_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_MS = 10 * 60 * 1000;
const TRANSIENT_RETRY_MS = 2000;

const CACHE_MAX = 500;

/**
 * Check if upstream returned rate limit stub.
 */
function isRateLimit(streamsList) {
  return Array.isArray(streamsList) && streamsList.some(stream => stream &&
    [stream.name, stream.title, stream.description].some(value =>
      typeof value === 'string' && /rate limit|too many stream requests/i.test(value)));
}

function apiBase() {
  return resolveLeafInstallConfig().apiBase;
}

/** @type {Map<string, {url: string, expiresAt: number}>} success cache */
const mintCache = new Map();
/** @type {Map<string, {until: number, count: number, reason: string, error: Error}>} failure backoff */
const fails = new Map();
const inFlightMints = new Map();

// A changed install or API kill switch must never reuse the previous credential.
const keyOf = (matchId, slug, base = apiBase()) => JSON.stringify([base, matchId, slug || '']);

function evictOldest(map) {
  if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

function cooldownRemaining(matchId, slug, opts = {}) {
  const base = opts.base ?? apiBase();
  const f = fails.get(keyOf(matchId, slug, base));
  return Math.max(f ? f.until - Date.now() : 0, accountCooldownRemaining(base));
}

function isCoolingDown(matchId, slug, opts = {}) {
  return cooldownRemaining(matchId, slug, opts) > 0;
}

function recordFailure(matchId, slug, error, baseMs, base = apiBase(), fixedDelayMs) {
  if (!Number.isFinite(fixedDelayMs) || fixedDelayMs < 0) fixedDelayMs = undefined;
  const key = keyOf(matchId, slug, base);
  const now = Date.now();
  const prev = fails.get(key);
  const reason = error.code;
  const count = fixedDelayMs === undefined && prev && now < prev.until && prev.reason === reason ? prev.count + 1 : 1;
  const maxDelay = error.upstreamStatus === 429 ? RATE_LIMIT_MAX_MS : NEG_MAX_MS;
  const delay = Math.max(1000, Math.min(fixedDelayMs ?? baseMs * 2 ** (count - 1), maxDelay));
  error.retryAfterMs = delay;
  fails.set(key, { until: now + delay, count, reason, error });
  evictOldest(fails);
  // Neither install paths nor upstream exception messages belong in logs.
  console.warn(`[LeafMint] cooling down ${Math.round(delay / 1000)}s after ${count} consecutive failure(s); class: ${reason}`);
  return delay;
}

function noteFailure(matchId, slug, opts = {}) {
  const reason = typeof opts.reason === 'string' && /^ERR_[A-Z0-9_]{1,80}$/.test(opts.reason) ? opts.reason : 'ERR_LEAF_PLAYLIST';
  const error = opts.error ? requestFailure(opts.error) : Object.assign(new Error('Leaf playlist request failed'), { code: reason });
  return recordFailure(matchId, slug, error, Math.max(1000, num(opts.baseMs, NEG_BASE_HONEYPOT_MS)), opts.base,
    error.leafTransient ? TRANSIENT_RETRY_MS : opts.retryAfterMs);
}

// exp is untrusted metadata, used only to shorten storage. It never establishes
// token validity, expands URL admission, or extends the ordinary mint TTL.
function mediaCandidate(url, slug) {
  try {
    validateLeafManifestUrl(url);
    const parsed = new URL(url);
    const isPapacito = parsed.hostname === 'papacito.cfd' || parsed.hostname.endsWith('.papacito.cfd');
    if (isPapacito) {
      if (!parsed.search || (slug && parsed.pathname !== `/m3u/${slug}/live.m3u8`)) return null;
    } else {
      if (slug && parsed.pathname.includes('/m3u/')) {
        if (parsed.pathname !== `/m3u/${slug}/live.m3u8`) return null;
      }
    }
    const now = Date.now();
    let expiresAt = now + MINT_TTL_MS;
    for (const value of parsed.searchParams.values()) {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value)) continue;
      try {
        const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
        if (payload && typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
          expiresAt = Math.min(expiresAt, payload.exp * 1000);
        }
      } catch (_) {}
    }
    return expiresAt > now ? { url, expiresAt } : null;
  } catch (_) { return null; }
}

function supersede(key) {
  const flight = inFlightMints.get(key);
  if (flight) {
    flight.superseded = true;
    inFlightMints.delete(key);
  }
}

// Internal eligibility check for a previously emitted state tile. Reading must
// never refresh the credential or move its absolute lifetime forward.
function peekCachedUrl(matchId, slug, opts = {}) {
  const key = keyOf(matchId, slug, opts.base);
  const cached = mintCache.get(key);
  if (!cached) return undefined;
  if (Date.now() < cached.expiresAt) return cached.url;
  mintCache.delete(key);
  return undefined;
}

function seed(matchId, slug, url, opts = {}) {
  if (!matchId || !url) return;
  const candidate = mediaCandidate(url, slug);
  if (!candidate) return;
  const key = keyOf(matchId, slug, opts.base);
  supersede(key);
  mintCache.set(key, candidate);
  fails.delete(key);
  evictOldest(mintCache);
}

function invalidate(matchId, slug, opts = {}) {
  if (matchId === undefined) {
    for (const key of inFlightMints.keys()) supersede(key);
    mintCache.clear();
    fails.clear();
    resetAccountRateLimits();
    return;
  }
  const key = keyOf(matchId, slug, opts.base);
  supersede(key);
  mintCache.delete(key);
  fails.delete(key);
}

function isConfigured() {
  try { return resolveLeafInstallConfig().configured; }
  catch (_) { return false; }
}

/**
 * @param {string} matchId upstream match id, e.g. `streamed:cricket-nz-ind-odi1`
 * @param {string} [slug] papacito slug, e.g. `441094`
 * @param {{force?: boolean, signal?: AbortSignal}} [opts]
 * @returns {Promise<string>} signed papacito playlist URL
 */
async function mintUrl(matchId, slug, opts = {}) {
  if (typeof matchId !== 'string' || !matchId.trim() || matchId.length > 1024 || /[\u0000-\u001f\u007f]/.test(matchId) ||
      (slug !== undefined && (typeof slug !== 'string' || slug.length > 256 || !/^[a-z0-9-]*$/i.test(slug)))) {
    throw Object.assign(new Error('Leaf mint input is invalid'), { code: 'ERR_LEAF_MINT_INPUT' });
  }
  const config = resolveLeafInstallConfig();
  if (!config.configured) throw Object.assign(new Error('Leaf mint is not configured'), { code: 'ERR_LEAF_MINT_UNCONFIGURED' });
  const base = config.apiBase;
  const key = keyOf(matchId, slug, base);
  if (opts.signal?.aborted) {
    const cancelled = Object.assign(new Error('Leaf mint was cancelled'), { name: 'AbortError', cause: opts.signal.reason });
    throw requestFailure(cancelled);
  }

  const hit = mintCache.get(key);
  const validHit = hit && Date.now() < hit.expiresAt ? hit : null;
  if (hit && !validHit) mintCache.delete(key);
  // A current credential remains useful during upstream throttling. Its absolute
  // expiry is immutable; a denial never renews this cache record.
  if (!opts.force && validHit) return validHit.url;
  if (validHit && accountCooldownRemaining(base) > 0) return validHit.url;
  assertAccountAvailable(base);
  const failure = fails.get(key);
  const remaining = failure ? Math.max(0, failure.until - Date.now()) : 0;
  const rateLimited = failure?.error.upstreamStatus === 429;
  if (remaining > 0 && (!opts.force || rateLimited)) {
    if (rateLimited && validHit) return validHit.url;
    const err = Object.assign(new Error('Leaf mint is cooling down'), {
      code: 'ERR_LEAF_MINT_COOLDOWN', cause: failure.error,
      ...(failure.error.leafTransient ? { leafTransient: true, reason: failure.error.reason } : {}),
      ...(failure.error.upstreamStatus ? { upstreamStatus: failure.error.upstreamStatus } : {})
    });
    err.cooldown = true;
    err.retryAfterMs = remaining;
    throw err;
  }
  if (opts.force) {
    // If forcing, clear prior failure state for this key
    fails.delete(key);
  }

  if (inFlightMints.has(key)) return inFlightMints.get(key).promise;
  // Set the promise before entering I/O, including synchronous dependency throws.
  const flight = { superseded: false, promise: null };
  flight.promise = Promise.resolve().then(async () => {
    try { return await fetchMint(matchId, slug, opts, key, base, flight); }
    catch (error) {
      assertCurrent(flight);
      const cached = mintCache.get(key);
      if (error.upstreamStatus === 429 && cached && Date.now() < cached.expiresAt) return cached.url;
      throw error;
    }
  })
    .finally(() => { if (inFlightMints.get(key) === flight) inFlightMints.delete(key); });
  inFlightMints.set(key, flight);
  return flight.promise;
}

function requestFailure(cause) {
  const code = typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(cause.code) ? cause.code : 'ERR_LEAF_MINT_TRANSPORT';
  const error = Object.assign(new Error('Leaf mint request failed'), { code, cause });
  const reason = inconclusiveErrorReason(cause);
  if (reason) Object.assign(error, { leafTransient: true, reason, retryAfterMs: TRANSIENT_RETRY_MS });
  return error;
}

function assertCurrent(flight) {
  if (flight.superseded) {
    throw Object.assign(new Error('Leaf mint was superseded'), {
      code: 'ERR_LEAF_MINT_SUPERSEDED', leafTransient: true, reason: 'unavailable', retryAfterMs: TRANSIENT_RETRY_MS
    });
  }
}

function assertAccountAvailable(base) {
  const remaining = accountCooldownRemaining(base);
  if (remaining > 0) {
    throw Object.assign(new Error('Leaf account stream quota is cooling down'), {
      code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429, rateLimit: true,
      cooldown: true, retryAfterMs: remaining
    });
  }
}

async function fetchMint(matchId, slug, opts, key, base, flight) {
  assertCurrent(flight);
  assertAccountAvailable(base);
  const qs = opts.force ? `?cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : '';
  const url = `${base}/stream/sport/${encodeURIComponent(matchId)}.json${qs}`;

  let res;
  try {
    res = await providerOutbound.safeFetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeoutMs: MINT_TIMEOUT_MS,
      maxBodyBytes: MAX_MINT_BYTES,
      diagnosticOwner: 'provider',
      attempts: 1,
      signal: opts.signal,
    });
  } catch (err) {
    assertCurrent(flight);
    const error = requestFailure(err);
    recordFailure(matchId, slug, error, NEG_BASE_MS, base, error.leafTransient ? TRANSIENT_RETRY_MS : undefined);
    throw error;
  }
  assertCurrent(flight);

  if (!res || !res.ok) {
    const status = res ? res.status : 0;
    const err = Object.assign(new Error('Leaf mint upstream request failed'), {
      code: status === 401 || status === 403 ? 'ERR_LEAF_MINT_ACCOUNT_DENIED' : 'ERR_LEAF_MINT_STATUS'
    });
    err.upstreamStatus = status;
    recordFailure(matchId, slug, err, status === 429 ? NEG_BASE_429_MS : NEG_BASE_MS, base,
      status === 429 ? rateLimitDelay(res) : undefined);
    if (status === 429) recordAccountRateLimit(base, err.retryAfterMs);
    throw err;
  }

  if (res.bodyTruncated) {
    const error = Object.assign(new Error('Leaf mint metadata exceeds its body limit'), { code: 'ERR_LEAF_MINT_BODY_LIMIT' });
    recordFailure(matchId, slug, error, NEG_BASE_MS, base);
    throw error;
  }
  let body;
  try { body = await res.json(); }
  catch (cause) {
    assertCurrent(flight);
    const error = inconclusiveErrorReason(cause) || cause?.code === 'ERR_OUTBOUND_BLOCKED' || cause?.isFatal
      ? requestFailure(cause)
      : Object.assign(new Error('Leaf mint returned invalid metadata'), { code: 'ERR_LEAF_MINT_BODY', cause });
    recordFailure(matchId, slug, error, NEG_BASE_MS, base, error.leafTransient ? TRANSIENT_RETRY_MS : undefined);
    throw error;
  }
  assertCurrent(flight);
  if (!body || !Array.isArray(body.streams)) {
    const error = Object.assign(new Error('Leaf mint returned invalid metadata'), { code: 'ERR_LEAF_MINT_BODY' });
    recordFailure(matchId, slug, error, NEG_BASE_MS, base);
    throw error;
  }
  const streams = body.streams;
  if (isRateLimit(streams)) {
    const error = Object.assign(new Error('Leaf mint hit upstream rate limit'), {
      code: 'ERR_LEAF_MINT_RATE_LIMIT', rateLimit: true, upstreamStatus: 429
    });
    recordFailure(matchId, slug, error, NEG_BASE_429_MS, base, rateLimitDelay(res, streams));
    recordAccountRateLimit(base, error.retryAfterMs);
    throw error;
  }
  const candidates = streams
    .map((s) => s && s.url)
    .map(url => mediaCandidate(url, slug)).filter(Boolean);

  // State identifies a particular channel. Never silently substitute the first
  // channel when that slug disappeared from the official response.
  const picked = candidates[0];
  if (!picked) {
    const err = Object.assign(new Error('Leaf mint returned no signed media URL'), { code: 'ERR_LEAF_MINT_NO_MEDIA' });
    err.noMedia = true;
    recordFailure(matchId, slug, err, NEG_BASE_NOMEDIA_MS, base);
    throw err;
  }

  fails.delete(key);
  mintCache.set(key, picked);
  evictOldest(mintCache);
  return picked.url;
}

/** Exposed for diagnostics (/health, scripts). */
function stats() {
  const now = Date.now();
  let cooling = 0;
  for (const f of fails.values()) if (f.until > now) cooling++;
  return { configured: isConfigured(), cached: mintCache.size, coolingDown: cooling, ttlMs: MINT_TTL_MS };
}

module.exports = {
  mintUrl, seed, invalidate, noteFailure, isCoolingDown, cooldownRemaining, peekCachedUrl,
  isConfigured, stats, apiBase, normalizeConfigBlob, extractOrigin, isRateLimit, MINT_TTL_MS, UUID_REGEX
};
