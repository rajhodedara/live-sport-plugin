'use strict';

const crypto = require('crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

/**
 * Google OpenID Connect (authorization code + PKCE). `fetchImpl` is injectable for tests.
 */
function createGoogleProvider(env = process.env, fetchImpl = globalThis.fetch) {
  const clientId = env.AUTH_GOOGLE_CLIENT_ID || '';
  const clientSecret = env.AUTH_GOOGLE_CLIENT_SECRET || '';
  let jwksCache = { at: 0, keys: null };

  async function getKeys(force) {
    if (!force && jwksCache.keys && Date.now() - jwksCache.at < 3600000) return jwksCache.keys;
    const res = await fetchImpl(JWKS_URL);
    if (!res.ok) throw new Error('google_jwks_unavailable');
    const body = await res.json();
    jwksCache = { at: Date.now(), keys: Array.isArray(body.keys) ? body.keys : [] };
    return jwksCache.keys;
  }

  async function verifyIdToken(idToken, { nonce }) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('invalid_id_token');
    const header = decodeSegment(parts[0]);
    const claims = decodeSegment(parts[1]);
    if (header.alg !== 'RS256') throw new Error('invalid_id_token_alg');
    let keys = await getKeys(false);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) { keys = await getKeys(true); jwk = keys.find((k) => k.kid === header.kid); }
    if (!jwk) throw new Error('invalid_id_token_key');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('invalid_id_token_signature');
    if (!ISSUERS.has(claims.iss)) throw new Error('invalid_id_token_issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) throw new Error('invalid_id_token_audience');
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 < Date.now() - 60000) throw new Error('expired_id_token');
    if (!nonce || claims.nonce !== nonce) throw new Error('invalid_id_token_nonce');
    if (!claims.sub) throw new Error('invalid_id_token_subject');
    return claims;
  }

  return {
    id: 'google',
    label: 'Google',
    isConfigured: () => Boolean(clientId && clientSecret),
    buildAuthUrl({ state, nonce, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: 'openid email profile', state, nonce,
        code_challenge: codeChallenge, code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `${AUTH_URL}?${q}`;
    },
    async exchange({ code, codeVerifier, redirectUri, nonce }) {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
          grant_type: 'authorization_code', code_verifier: codeVerifier,
        }).toString(),
      });
      if (!res.ok) throw new Error('google_token_exchange_failed');
      const body = await res.json();
      const claims = await verifyIdToken(body.id_token, { nonce });
      if (!claims.email || claims.email_verified !== true) throw new Error('email_not_verified');
      return { subject: String(claims.sub), email: claims.email, name: claims.name || claims.email };
    },
  };
}

module.exports = { createGoogleProvider };
