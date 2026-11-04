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
 * the request, so the upstream credential never leaves the server and is never reused.
 *
 * Secret resolution: LEAF_STATE_SECRET -> APP_SECRET -> a fixed dev fallback. The
 * fallback is deliberate (local dev must work), but production should set one of the
 * first two - a shared default would let anyone mint valid Leaf tiles.
 */

const crypto = require('crypto');

const DEV_FALLBACK = 'leaf-state-dev-secret';

function secret() {
  return process.env.LEAF_STATE_SECRET || process.env.APP_SECRET || DEV_FALLBACK;
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
  const body = Buffer.from(JSON.stringify({ ...payload, t: Date.now() })).toString('base64url');
  return `${body}.${mac(body)}`;
}

/**
 * @param {string} token
 * @returns {{m: string, s?: string, t?: number}|null} payload, or null when the token
 *          is malformed, tampered with, or older than MAX_AGE_MS
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const expected = mac(body);
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.m !== 'string' || !payload.m) return null;
  if (payload.t && Date.now() - payload.t > MAX_AGE_MS) return null;
  return payload;
}

module.exports = { sign, verify, usingFallbackSecret, MAX_AGE_MS };
