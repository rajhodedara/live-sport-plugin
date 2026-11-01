/**
 * DashPayload — signs and verifies the opaque `d` parameter used by
 * /api/dash/* to describe a stream ({mpdUrl, key, kid, headers}).
 *
 * Token format:
 *
 *   d = base64url(json) "." base64url(HMAC-SHA256(secret, base64url(json)))
 *
 * Why sign at all: the payload names an upstream URL the *server* will fetch.
 * Unsigned, that is an open SSRF primitive (fetch any host, read the result
 * through the playlist). Signed, the only URLs the server will ever touch are
 * the ones its own providers produced.
 *
 * Two tiers of expiry, deliberately:
 *   - catalogue tokens (emitted by providers) carry no `e`: a Stremio catalogue
 *     entry may sit on a shelf for hours before it is clicked;
 *   - playlist/segment tokens are re-signed by the router with a TTL, so a
 *     leaked segment URL stops working instead of running forever.
 */

'use strict';

const crypto = require('crypto');

const MAX_TOKEN_LENGTH = 8192;
const HEADER_ALLOWLIST = new Set(['user-agent', 'referer', 'origin', 'accept', 'accept-language']);
const KEY_RE = /^[0-9a-fA-F]{32}$/;
const KID_RE = /^[0-9a-fA-F]{32}$/;

let ephemeralSeed = null;
let warned = false;

function getSecret(explicit) {
  if (explicit) return Buffer.isBuffer(explicit) ? explicit : Buffer.from(String(explicit), 'utf8');
  const fromEnv = process.env.DASH_SIGN_SECRET;
  if (fromEnv && fromEnv.length >= 16) return Buffer.from(fromEnv, 'utf8');
  if (!ephemeralSeed) {
    ephemeralSeed = crypto.randomBytes(32);
    if (!warned) {
      warned = true;
      console.warn(
        '[DashPayload] DASH_SIGN_SECRET is not set — using a per-process random secret. ' +
        'Signed DASH links will break across restarts and across pm2 cluster workers.'
      );
    }
  }
  return ephemeralSeed;
}

function sign(b64, secret) {
  return crypto.createHmac('sha256', secret).update(b64).digest('base64url');
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function sanitizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || !value) continue;
    const lower = name.toLowerCase();
    if (!HEADER_ALLOWLIST.has(lower)) continue;
    if (value.length > 512 || /[\r\n]/.test(value)) continue;
    out[lower === 'user-agent' ? 'User-Agent' : name] = value;
  }
  return out;
}

/** Normalises whatever the providers emitted into the canonical payload shape. */
function normalizePayload(input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.mpdUrl !== 'string' || !/^https?:\/\//i.test(input.mpdUrl)) return null;
  if (input.mpdUrl.length > 2048) return null;
  if (typeof input.key !== 'string' || !KEY_RE.test(input.key)) return null;

  const kid = typeof input.kid === 'string' ? input.kid.toLowerCase().replace(/-/g, '') : '';
  const payload = {
    mpdUrl: input.mpdUrl,
    key: input.key.toLowerCase(),
    kid: KID_RE.test(kid) ? kid : '',
    headers: sanitizeHeaders(input.headers)
  };
  if (Number.isFinite(input.e)) payload.e = Math.floor(input.e);
  return payload;
}

/**
 * @param {object} payload  {mpdUrl, key, kid, headers}
 * @param {object} [opts]   {ttlSec, secret, now}
 * @returns {string} signed token
 */
function signPayload(payload, opts = {}) {
  const normalized = normalizePayload(payload);
  if (!normalized) throw new Error('DashPayload: refusing to sign an invalid payload');
  const nowSec = Math.floor((opts.now || Date.now()) / 1000);
  if (Number.isFinite(opts.ttlSec) && opts.ttlSec !== 0) normalized.e = nowSec + Math.floor(opts.ttlSec);
  else if (Number.isFinite(opts.expiresAt)) normalized.e = Math.floor(opts.expiresAt);

  const b64 = encodePayload(normalized);
  return `${b64}.${sign(b64, getSecret(opts.signWith || opts.secret))}`;
}

/**
 * @returns {{ok:true, payload:object} | {ok:false, code:string, status:number}}
 */
function verifyPayload(token, opts = {}) {
  if (typeof token !== 'string' || !token) {
    return { ok: false, code: 'MISSING', status: 400 };
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, code: 'TOKEN_TOO_LARGE', status: 403 };
  }

  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, code: 'MALFORMED', status: 403 };
  }
  const b64 = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(b64, getSecret(opts.signWith || opts.secret));

  // timingSafeEqual throws on length mismatch — check first, or a bad token
  // turns a 403 into a 500.
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, code: 'BAD_SIGNATURE', status: 403 };
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, code: 'MALFORMED_PAYLOAD', status: 403 };
  }

  const payload = normalizePayload(decoded);
  if (!payload) return { ok: false, code: 'INVALID_PAYLOAD', status: 403 };
  if (Number.isFinite(payload.e)) {
    const nowSec = Math.floor((opts.now || Date.now()) / 1000);
    if (nowSec > payload.e) return { ok: false, code: 'EXPIRED', status: 403 };
  }

  return { ok: true, payload };
}

module.exports = {
  signPayload,
  verifyPayload,
  encodePayload,
  normalizePayload,
  sanitizeHeaders,
  MAX_TOKEN_LENGTH
};
