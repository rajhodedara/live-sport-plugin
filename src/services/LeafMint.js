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
 * When `force: true` is requested (or `invalidate` is called), the cooldown is cleared
 * to allow immediate recovery without waiting up to 5 minutes.
 */

const providerOutbound = require('./ProviderOutbound');
const { validateLeafManifestUrl } = require('./GuardedEgressPolicy');

const DEFAULT_ORIGIN = 'https://sports.highfly.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const MINT_TTL_MS = Math.min(8 * 60 * 60 * 1000, Math.max(5 * 1000, num(process.env.LEAF_MINT_TTL_MS, 4 * 60 * 60 * 1000)));
const MINT_TIMEOUT_MS = Math.min(30000, Math.max(2000, num(process.env.LEAF_MINT_TIMEOUT_MS, 8000)));
const MAX_MINT_BYTES = 256 * 1024;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Backoff: base delay per failure class, doubling per consecutive failure, capped.
const NEG_BASE_MS = num(process.env.LEAF_MINT_BACKOFF_MS, 15 * 1000); // transport errors / 5xx
const NEG_BASE_429_MS = 30 * 1000;   // explicit throttling
const NEG_BASE_NOMEDIA_MS = 60 * 1000; // no signed URL
const NEG_BASE_HONEYPOT_MS = 10 * 1000; // playlist denied or returned invalid media
const NEG_MAX_MS = 5 * 60 * 1000;

const CACHE_MAX = 500;

function toBase64Url(json) {
  return Buffer.from(JSON.stringify(json))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function extractOrigin(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  let trimmed = rawInput.trim();
  if (!/^https?:\/\//i.test(trimmed) && /(?:[a-z0-9-]+\.)*highfly\.(?:to|dev)/i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      return u.origin;
    } catch (_) {}
  }
  if (UUID_REGEX.test(trimmed)) {
    return 'https://premium.highfly.to';
  }
  return null;
}

/**
 * Robust normalizer for LEAF_INSTALL_CONFIG / LEAF_FREE_USER_ID.
 * Handles:
 *  - Full URLs: https://sports.highfly.to/bbecb026-6920-4b62-b006-ddd3eeb31e8d.6bd757136d146439/manifest.json
 *  - Highfly Premium URLs: https://premium.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/manifest.json
 *  - Raw JSON string: {"freeUserId":"..."}
 *  - Pre-encoded base64url JSON blob: eyJmcmVlVXNlcklkIjoi...
 *  - Bare token string: bbecb026-6920-4b62-b006-ddd3eeb31e8d.6bd757136d146439
 *  - Bare UUID token: a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d
 *
 * @param {string} rawInput
 * @returns {string} base64url or segment config string
 */
function normalizeConfigBlob(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let input = rawInput.trim();

  // If user pasted a full URL (sports.highfly.to, premium.highfly.to, *.highfly.to, *.highfly.dev, etc.)
  const urlMatch = input.match(/(?:[a-z0-9-]+\.)*highfly\.(?:to|dev)\/([^\/\s]+)/i);
  if (urlMatch) {
    input = urlMatch[1];
  } else if (/^https?:\/\//i.test(input)) {
    try {
      const u = new URL(input);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        input = parts[parts.length - 1].toLowerCase() === 'manifest.json' && parts.length > 1
          ? parts[parts.length - 2]
          : parts[0];
      }
    } catch (_) {}
  }
  input = input.replace(/(?:^|\/)manifest\.json$/i, '').replace(/^\/+|\/+$/g, '');
  if (!input) return '';

  // Check if input is already base64url-encoded JSON with freeUserId
  try {
    const decoded = Buffer.from(input, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed && (parsed.freeUserId || parsed.userId)) {
      return input;
    }
  } catch (_) {}

  // Check if input is a JSON string
  try {
    const parsed = JSON.parse(input);
    if (parsed && (parsed.freeUserId || parsed.userId)) {
      return toBase64Url(parsed);
    }
  } catch (_) {}

  // Bare UUID token (Highfly Premium subscription token)
  if (UUID_REGEX.test(input)) {
    return input;
  }

  // Bare string (e.g. uuid.hash)
  if (input.includes('.') || input.length > 20) {
    return toBase64Url({ freeUserId: input });
  }

  return input;
}

/**
 * Check if upstream returned rate limit stub.
 */
function isRateLimit(streamsList) {
  return (streamsList || []).some((st) => st && (
    /rate limit/i.test(st.name || '') ||
    /rate limit/i.test(st.title || '') ||
    /too many stream requests/i.test(st.title || '')
  ));
}

/**
 * Mirror LeafProvider.buildApiUrl(): LEAF_API_URL is a whole-base kill switch,
 * otherwise origin + per-install config blob.
 */
function apiBase() {
  const override = process.env.LEAF_API_URL;
  if (override) return override.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');

  const rawConfig = process.env.LEAF_INSTALL_CONFIG || process.env.LEAF_FREE_USER_ID || '';
  const detectedOrigin = extractOrigin(rawConfig);
  const origin = (process.env.LEAF_API_ORIGIN || detectedOrigin || DEFAULT_ORIGIN).replace(/\/+$/, '');

  const config = normalizeConfigBlob(rawConfig);
  return config ? `${origin}/${config}` : origin;
}

/** @type {Map<string, {url: string, at: number}>} success cache */
const mintCache = new Map();
/** @type {Map<string, {until: number, count: number, reason: string}>} failure backoff */
const fails = new Map();
const inFlightMints = new Map();

// A changed install or API kill switch must never reuse the previous credential.
const keyOf = (matchId, slug, base = apiBase()) => JSON.stringify([base, matchId, slug || '']);

function evictOldest(map) {
  if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

function cooldownRemaining(matchId, slug) {
  const f = fails.get(keyOf(matchId, slug));
  if (!f) return 0;
  return Math.max(0, f.until - Date.now());
}

function isCoolingDown(matchId, slug) {
  return cooldownRemaining(matchId, slug) > 0;
}

function recordFailure(matchId, slug, reason, baseMs, base = apiBase()) {
  const key = keyOf(matchId, slug, base);
  const now = Date.now();
  const prev = fails.get(key);
  const count = prev && now < prev.until ? prev.count + 1 : 1;
  const delay = Math.min(baseMs * 2 ** (count - 1), NEG_MAX_MS);
  fails.set(key, { until: now + delay, count, reason });
  evictOldest(fails);
  // Neither install paths nor upstream exception messages belong in logs.
  console.warn(`[LeafMint] cooling down ${Math.round(delay / 1000)}s after ${count} consecutive failure(s); class: ${reason}`);
  return delay;
}

function noteFailure(matchId, slug, opts = {}) {
  const reason = typeof opts.reason === 'string' && /^ERR_[A-Z0-9_]{1,80}$/.test(opts.reason) ? opts.reason : 'ERR_LEAF_PLAYLIST';
  return recordFailure(matchId, slug, reason, Math.max(1000, num(opts.baseMs, NEG_BASE_HONEYPOT_MS)));
}

function seed(matchId, slug, url) {
  if (!matchId || !url) return;
  const key = keyOf(matchId, slug);
  mintCache.set(key, { url, at: Date.now() });
  fails.delete(key);
  evictOldest(mintCache);
}

function invalidate(matchId, slug) {
  if (matchId === undefined) {
    mintCache.clear();
    fails.clear();
    return;
  }
  const key = keyOf(matchId, slug);
  mintCache.delete(key);
  fails.delete(key);
}

function isConfigured() {
  return Boolean(process.env.LEAF_API_URL || process.env.LEAF_INSTALL_CONFIG || process.env.LEAF_FREE_USER_ID);
}

/**
 * @param {string} matchId upstream match id, e.g. `streamed:cricket-nz-ind-odi1`
 * @param {string} [slug] papacito slug, e.g. `441094`
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<string>} signed papacito playlist URL
 */
async function mintUrl(matchId, slug, opts = {}) {
  if (typeof matchId !== 'string' || !matchId.trim() || matchId.length > 1024 || /[\u0000-\u001f\u007f]/.test(matchId) ||
      (slug !== undefined && (typeof slug !== 'string' || slug.length > 256 || !/^[a-z0-9-]*$/i.test(slug)))) {
    throw Object.assign(new Error('Leaf mint input is invalid'), { code: 'ERR_LEAF_MINT_INPUT' });
  }
  if (!isConfigured()) throw Object.assign(new Error('Leaf mint is not configured'), { code: 'ERR_LEAF_MINT_UNCONFIGURED' });

  const base = apiBase();
  const key = keyOf(matchId, slug, base);

  // If force is NOT set, check cache first!
  if (!opts.force) {
    const hit = mintCache.get(key);
    if (hit && Date.now() - hit.at < MINT_TTL_MS) {
      return hit.url;
    }
    const remaining = cooldownRemaining(matchId, slug);
    if (remaining > 0) {
      const err = Object.assign(new Error('Leaf mint is cooling down'), { code: 'ERR_LEAF_MINT_COOLDOWN' });
      err.cooldown = true;
      err.retryAfterMs = remaining;
      throw err;
    }
  } else {
    // If forcing, clear prior failure state for this key
    fails.delete(key);
  }

  const flightKey = `${key}|${opts.force ? 'force' : 'normal'}`;
  if (inFlightMints.has(flightKey)) return inFlightMints.get(flightKey);
  // Set the promise before entering I/O, including synchronous dependency throws.
  const pending = Promise.resolve().then(async () => {
    try {
      return await fetchMint(matchId, slug, opts, key, base);
    } catch (err) {
      if ((err.rateLimit || err.upstreamStatus === 429) && mintCache.has(key)) {
        const hit = mintCache.get(key);
        if (hit && hit.url) {
          console.warn(`[LeafMint] Upstream rate limit hit for ${matchId}/${slug || ''}; preserving cached Papacito URL`);
          hit.at = Date.now();
          return hit.url;
        }
      }
      throw err;
    }
  }).finally(() => inFlightMints.delete(flightKey));
  inFlightMints.set(flightKey, pending);
  return pending;
}

async function fetchMint(matchId, slug, opts, key, base) {
  const qs = opts.force ? `?cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : '';
  const url = `${base}/stream/sport/${encodeURIComponent(matchId)}.json${qs}`;

  let res;
  try {
    res = await providerOutbound.safeFetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeoutMs: MINT_TIMEOUT_MS,
      maxBodyBytes: MAX_MINT_BYTES,
      diagnosticOwner: 'provider',
    });
  } catch (err) {
    const code = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(err.code) ? err.code : 'ERR_LEAF_MINT_TRANSPORT';
    recordFailure(matchId, slug, code, NEG_BASE_MS, base);
    throw Object.assign(new Error('Leaf mint request failed'), { code });
  }

  if (!res || !res.ok) {
    const status = res ? res.status : 0;
    const err = Object.assign(new Error('Leaf mint upstream request failed'), { code: 'ERR_LEAF_MINT_STATUS' });
    err.upstreamStatus = status;
    recordFailure(matchId, slug, `HTTP_${status}`, status === 429 ? NEG_BASE_429_MS : NEG_BASE_MS, base);
    throw err;
  }

  if (res.bodyTruncated) {
    recordFailure(matchId, slug, 'ERR_LEAF_MINT_BODY_LIMIT', NEG_BASE_MS, base);
    throw Object.assign(new Error('Leaf mint metadata exceeds its body limit'), { code: 'ERR_LEAF_MINT_BODY_LIMIT' });
  }
  let body;
  try { body = await res.json(); }
  catch (_) {
    recordFailure(matchId, slug, 'ERR_LEAF_MINT_BODY', NEG_BASE_MS, base);
    throw Object.assign(new Error('Leaf mint returned invalid metadata'), { code: 'ERR_LEAF_MINT_BODY' });
  }
  const streams = body && Array.isArray(body.streams) ? body.streams : [];

  if (isRateLimit(streams)) {
    const err = Object.assign(new Error('Leaf mint hit upstream rate limit'), {
      code: 'ERR_LEAF_MINT_RATE_LIMIT',
      rateLimit: true,
      upstreamStatus: 429
    });
    recordFailure(matchId, slug, 'ERR_LEAF_MINT_RATE_LIMIT', NEG_BASE_429_MS, base);
    throw err;
  }

  const candidates = streams
    .map((s) => s && s.url)
    .filter((u) => {
      try { validateLeafManifestUrl(u); return Boolean(new URL(u).search); }
      catch (_) { return false; }
    });

  // State identifies a particular channel. Never silently substitute the first
  // channel when that slug disappeared from the official response.
  const picked = slug
    ? candidates.find(u => new URL(u).pathname === `/m3u/${slug}/live.m3u8`)
    : candidates[0];
  if (!picked) {
    const err = Object.assign(new Error('Leaf mint returned no signed media URL'), { code: 'ERR_LEAF_MINT_NO_MEDIA' });
    err.noMedia = true;
    recordFailure(matchId, slug, 'ERR_LEAF_MINT_NO_MEDIA', NEG_BASE_NOMEDIA_MS, base);
    throw err;
  }

  fails.delete(key);
  mintCache.set(key, { url: picked, at: Date.now() });
  evictOldest(mintCache);
  return picked;
}

/** Exposed for diagnostics (/health, scripts). */
function stats() {
  const now = Date.now();
  let cooling = 0;
  for (const f of fails.values()) if (f.until > now) cooling++;
  return { configured: isConfigured(), cached: mintCache.size, coolingDown: cooling, ttlMs: MINT_TTL_MS };
}

module.exports = {
  mintUrl, seed, invalidate, noteFailure, isCoolingDown, cooldownRemaining,
  isConfigured, stats, apiBase, normalizeConfigBlob, MINT_TTL_MS,
  extractOrigin, isRateLimit, UUID_REGEX
};
