'use strict';

/**
 * services/LeafMint.js - mint a papacito playback URL at the moment it is needed.
 *
 * Upstream (`sports.highfly.to/<install-config>/stream/sport/<matchId>.json`) answers
 * with stream objects whose `url` is `https://papacito.cfd/m3u/<slug>/live.m3u8?ft=<JWT>`.
 * That JWT is bound to the IP that asked for it, so the ONLY safe pattern is:
 *
 *     mint  ->  fetch the playlist  ->  discard
 *
 * inside one request, on one connection pool. Anything that stores the minted URL for
 * later (a resolve cache, a player-held tile) resurrects the stale-credential problem:
 * papacito answers `200` with a well-formed playlist whose segments point at
 * `w1.papacito.cfd/leaf/stream_notice/...` - a honey-pot reel, not media.
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

const impitClient = require('../impitClient');

const DEFAULT_ORIGIN = 'https://sports.highfly.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const MINT_TTL_MS = Math.min(10 * 60 * 1000, Math.max(5 * 1000, num(process.env.LEAF_MINT_TTL_MS, 60 * 1000)));
const MINT_TIMEOUT_MS = Math.max(2000, num(process.env.LEAF_MINT_TIMEOUT_MS, 8000));

// Backoff: base delay per failure class, doubling per consecutive failure, capped.
const NEG_BASE_MS = num(process.env.LEAF_MINT_BACKOFF_MS, 15 * 1000); // transport errors / 5xx
const NEG_BASE_429_MS = 30 * 1000;   // explicit throttling
const NEG_BASE_NOMEDIA_MS = 60 * 1000; // no signed URL
const NEG_BASE_HONEYPOT_MS = 10 * 1000; // playlist came back stream_notice after re-mint
const NEG_MAX_MS = 5 * 60 * 1000;

const CACHE_MAX = 500;

function toBase64Url(json) {
  return Buffer.from(JSON.stringify(json))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Robust normalizer for LEAF_INSTALL_CONFIG / LEAF_FREE_USER_ID.
 * Handles:
 *  - Full URLs: https://sports.highfly.to/bbecb026-6920-4b62-b006-ddd3eeb31e8d.6bd757136d146439/manifest.json
 *  - Raw JSON string: {"freeUserId":"..."}
 *  - Pre-encoded base64url JSON blob: eyJmcmVlVXNlcklkIjoi...
 *  - Bare token string: bbecb026-6920-4b62-b006-ddd3eeb31e8d.6bd757136d146439
 *
 * @param {string} rawInput
 * @returns {string} base64url or segment config string
 */
function normalizeConfigBlob(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let input = rawInput.trim();

  // If user pasted a full URL
  const urlMatch = input.match(/sports\.highfly\.to\/([^\/\s]+)/i);
  if (urlMatch) {
    input = urlMatch[1];
  }
  input = input.replace(/\/manifest\.json$/i, '').replace(/^\/+|\/+$/g, '');

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

  // Bare string (e.g. uuid.hash)
  if (input.includes('.') || input.length > 20) {
    return toBase64Url({ freeUserId: input });
  }

  return input;
}

/**
 * Mirror LeafProvider.buildApiUrl(): LEAF_API_URL is a whole-base kill switch,
 * otherwise origin + per-install config blob.
 */
function apiBase() {
  const override = process.env.LEAF_API_URL;
  if (override) return override.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  const origin = (process.env.LEAF_API_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');

  const rawConfig = process.env.LEAF_INSTALL_CONFIG || process.env.LEAF_FREE_USER_ID || '';
  const config = normalizeConfigBlob(rawConfig);
  return config ? `${origin}/${config}` : origin;
}

/** @type {Map<string, {url: string, at: number}>} success cache */
const mintCache = new Map();
/** @type {Map<string, {until: number, count: number, reason: string}>} failure backoff */
const fails = new Map();

const keyOf = (matchId, slug) => `${matchId}|${slug || ''}`;

function evictOldest(map) {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
}

function cooldownRemaining(matchId, slug) {
  const f = fails.get(keyOf(matchId, slug));
  if (!f) return 0;
  return Math.max(0, f.until - Date.now());
}

function isCoolingDown(matchId, slug) {
  return cooldownRemaining(matchId, slug) > 0;
}

function recordFailure(matchId, slug, reason, baseMs) {
  const key = keyOf(matchId, slug);
  const now = Date.now();
  const prev = fails.get(key);
  const count = prev && now < prev.until ? prev.count + 1 : 1;
  const delay = Math.min(baseMs * 2 ** (count - 1), NEG_MAX_MS);
  fails.set(key, { until: now + delay, count, reason });
  evictOldest(fails);
  console.warn(`[LeafMint] ${key} cooling down ${Math.round(delay / 1000)}s after ${count} consecutive failure(s); last: ${reason}`);
  return delay;
}

function noteFailure(matchId, slug, opts = {}) {
  return recordFailure(matchId, slug, opts.reason || 'honeypot', Math.max(1000, num(opts.baseMs, NEG_BASE_HONEYPOT_MS)));
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
  if (!matchId) throw new Error('leaf mint: matchId required');
  if (!isConfigured()) throw new Error('leaf mint: no LEAF_INSTALL_CONFIG / LEAF_FREE_USER_ID');

  const key = keyOf(matchId, slug);

  // If force is NOT set, honor active cooldown
  if (!opts.force) {
    const remaining = cooldownRemaining(matchId, slug);
    if (remaining > 0) {
      const f = fails.get(key);
      const err = new Error(`leaf mint: cooling down ${Math.ceil(remaining / 1000)}s after ${f ? f.count : '?'} failure(s) (last: ${f ? f.reason : 'unknown'})`);
      err.cooldown = true;
      err.retryAfterMs = remaining;
      throw err;
    }
    const hit = mintCache.get(key);
    if (hit && Date.now() - hit.at < MINT_TTL_MS) return hit.url;
  } else {
    // If forcing, clear prior failure state for this key
    fails.delete(key);
  }

  const qs = opts.force ? `?cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : '';
  const url = `${apiBase()}/stream/sport/${encodeURIComponent(matchId)}.json${qs}`;

  let res;
  try {
    res = await impitClient.safeFetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      timeoutMs: MINT_TIMEOUT_MS,
    });
  } catch (err) {
    recordFailure(matchId, slug, `transport: ${err.message}`, NEG_BASE_MS);
    throw err;
  }

  if (!res || !res.ok) {
    const status = res ? res.status : 0;
    const err = new Error(`leaf mint HTTP ${status || 'no response'}`);
    err.upstreamStatus = status;
    recordFailure(matchId, slug, `HTTP ${status}`, status === 429 ? NEG_BASE_429_MS : NEG_BASE_MS);
    throw err;
  }

  const body = await res.json().catch(() => null);
  const streams = body && Array.isArray(body.streams) ? body.streams : [];
  const candidates = streams
    .map((s) => s && s.url)
    .filter((u) => typeof u === 'string' && u.includes('papacito.cfd') && u.includes('?'));

  const picked = (slug && candidates.find((u) => u.includes(`/m3u/${slug}/`))) || candidates[0];
  if (!picked) {
    const err = new Error('leaf mint: upstream served no signed papacito URL (retired install or pre-match fixture)');
    err.noMedia = true;
    recordFailure(matchId, slug, 'no signed URL', NEG_BASE_NOMEDIA_MS);
    throw err;
  }

  fails.delete(key);
  evictOldest(mintCache);
  mintCache.set(key, { url: picked, at: Date.now() });
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
  mintUrl, invalidate, noteFailure, isCoolingDown, cooldownRemaining,
  isConfigured, stats, apiBase, normalizeConfigBlob, MINT_TTL_MS
};
