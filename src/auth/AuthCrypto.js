'use strict';

const crypto = require('crypto');

function createOpaqueToken(prefix, byteLength = 32) {
  return `${prefix || 'nuvio'}_${crypto.randomBytes(byteLength).toString('base64url')}`;
}

function hashOpaqueToken(token, pepper) {
  return crypto.createHmac('sha256', String(pepper)).update(String(token)).digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Signs a small JSON payload as `<base64url(json)>.<hmac>`. Used for the stateless OAuth state cookie. */
function signPayload(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyPayload(token, secret, maxAgeMs) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
  if (!safeEqual(mac, token.slice(dot + 1))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (maxAgeMs && (!Number.isFinite(payload.t) || Date.now() - payload.t > maxAgeMs || payload.t > Date.now() + 60000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function encryptionKey(secret) {
  return crypto.createHash('sha256').update(`nuvio-settings:${secret}`).digest();
}

/** AES-256-GCM. Output `v1.<iv>.<tag>.<ciphertext>` (base64url). */
function encryptString(plain, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

function decryptString(blob, secret) {
  try {
    const [v, iv, tag, enc] = String(blob).split('.');
    if (v !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

module.exports = {
  createOpaqueToken, hashOpaqueToken, normalizeEmail, safeEqual,
  signPayload, verifyPayload, pkcePair, encryptString, decryptString,
};
