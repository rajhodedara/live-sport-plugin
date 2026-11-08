'use strict';

/**
 * services/LeafState.js - signed, stateless state token for the Leaf playlist route.
 *
 * Why this exists
 * ---------------
 * Leaf's upstream playback URL embeds `?ft=<JWT>` where the JWT carries the slug, an
 * 8 h expiry, the *IP of whoever minted it* and the install `uid`. Handing that URL to
 * a player means handing out a short-lived upstream credential that is only valid from
 * one address, so it dies the moment our egress changes, the token ages out, or a
 * second worker fetches it. It also leaks the credential into player logs.
 *
 * Instead of the upstream URL we hand out OUR token: `{m: matchId, s: slug, t}` plus an
 * HMAC. The playlist route verifies it and mints a fresh upstream URL at the moment of
 * the request, so the initial upstream credential is not stored in a player tile.
 *
 * Secret resolution: LEAF_STATE_SECRET -> APP_SECRET. Workers must share the chosen
 * private key. A missing key disables signed-state emission and resolution.
 */

const crypto = require('crypto');

function secret() {
  const key = process.env.LEAF_STATE_SECRET || process.env.APP_SECRET;
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw Object.assign(new Error('Leaf state signing is not configured'), {
      code: 'ERR_LEAF_STATE_UNCONFIGURED', statusCode: 503
    });
  }
  return key;
}

function usingFallbackSecret() {
  return !(process.env.LEAF_STATE_SECRET || process.env.APP_SECRET);
}

function mac(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 24);
}

/**
 * @param {{m: string, s?: string}} payload matchId + papacito slug
 * @returns {string} `<base64url(json)>.<hmac>`
 */
function sign(payload) {
  if (!validFields(payload)) {
    throw Object.assign(new Error('Invalid Leaf state payload'), { code: 'ERR_LEAF_STATE', statusCode: 400 });
  }
  const claims = { m: payload.m, s: payload.s || '', t: Date.now() };
  if (payload.u) claims.u = payload.u; // account whose own install must mint this stream
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${mac(body)}`;
}

/**
 * @param {string} token
 * @returns {{m: string, s?: string, t: number}|null} payload, or null when the token
 *          is malformed, tampered with, or older than MAX_AGE_MS
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 4096;

function validFields(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    typeof payload.m === 'string' && payload.m.trim().length > 0 && Buffer.byteLength(payload.m, 'utf8') <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(payload.m) &&
    (payload.s === undefined || (typeof payload.s === 'string' &&
      payload.s.length <= 256 && /^[a-z0-9-]*$/i.test(payload.s))) &&
    (payload.u === undefined || (typeof payload.u === 'string' && /^[0-9a-f-]{36}$/i.test(payload.u)));
}

function verify(token) {
  // Fail closed with an explicit configuration error even for otherwise valid
  // tokens signed by another worker; never fall back to a public default key.
  secret();
  if (!token || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{24}$/.test(given)) return null;
  const expected = mac(body);
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!validFields(payload) || !Number.isSafeInteger(payload.t) || payload.t <= 0) return null;
  const age = Date.now() - payload.t;
  if (age < 0 || age > MAX_AGE_MS) return null;
  return payload;
}

module.exports = { sign, verify, usingFallbackSecret, MAX_AGE_MS };
