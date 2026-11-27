'use strict';

const express = require('express');
const crypto = require('../auth/AuthCrypto');
const { AuthError } = require('../auth/AuthService');
const { createDiscordInteractionHandler } = require('../auth/discordInteractions');
const { isPrivateOrLoopback } = require('../services/localRequest');

const SESSION_COOKIE = 'nuvio_session';
const STATE_COOKIE = 'nuvio_oauth';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_REDEEM_RATE_LIMIT = { max: 10, windowMs: 60 * 1000 };
const MAX_RATE_LIMIT_ENTRIES = 5000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* skip */ }
  }
  return out;
}

function safeReturnPath(value) {
  const v = typeof value === 'string' ? value : '';
  return /^\/[A-Za-z0-9\-._~/%?=&#]*$/.test(v) && !v.startsWith('//') && !v.startsWith('/api/') ? v : '/account';
}

function normalizeRedirectPath(returnTo, canonicalOrigin) {
  const candidate = safeReturnPath(returnTo);
  if (!canonicalOrigin) return '/account';
  try {
    const resolved = new URL(candidate, canonicalOrigin);
    if (resolved.origin !== canonicalOrigin) return '/account';
    const pathname = resolved.pathname || '/';
    const lower = pathname.toLowerCase();
    if (lower === '/api' || lower.startsWith('/api/')) return '/account';
    return `${pathname}${resolved.search}${resolved.hash}`;
  } catch (_) {
    return '/account';
  }
}

function normalizeClientIp(raw) {
  const ip = String(raw || '').trim();
  if (!ip || ip.length > 64) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function extractTrustedClientIp(req) {
  const remote = normalizeClientIp(req && req.socket && req.socket.remoteAddress);
  if (!isPrivateOrLoopback(remote)) return remote || 'unknown';
  const headers = (req && req.headers) || {};
  const cf = normalizeClientIp(String(headers['cf-connecting-ip'] || '').split(',')[0]);
  if (cf) return cf;
  const realIp = normalizeClientIp(String(headers['x-real-ip'] || '').split(',')[0]);
  if (realIp) return realIp;
  const xffParts = String(headers['x-forwarded-for'] || '').split(',').map(normalizeClientIp).filter(Boolean);
  if (xffParts.length) return xffParts[xffParts.length - 1];
  return remote || 'unknown';
}

function isExactCanonicalOrigin(originHeader, canonicalOrigin) {
  if (!canonicalOrigin || typeof originHeader !== 'string') return false;
  try {
    const parsed = new URL(originHeader);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    if (parsed.pathname && parsed.pathname !== '/') return false;
    return parsed.origin === canonicalOrigin;
  } catch (_) {
    return false;
  }
}

/**
 * @param {{service: import('../auth/AuthService').AuthService, config: object, baseUrlFor: (req) => string, now?: () => number, redeemRateLimit?: {max: number, windowMs: number}}} deps
 */
function createAuthRouter({ service, config, baseUrlFor, now = () => Date.now(), redeemRateLimit = DEFAULT_REDEEM_RATE_LIMIT }) {
  const router = express.Router();
  const json = express.json({ limit: '16kb' });
  const redeemJson = express.json({ limit: '4kb' });
  const discordRaw = express.raw({ type: 'application/json', limit: '16kb' });
  const redeemLimits = new Map();
  const maxRedeemAttempts = Math.max(1, Number(redeemRateLimit.max) || DEFAULT_REDEEM_RATE_LIMIT.max);
  const redeemWindowMs = Math.max(1000, Number(redeemRateLimit.windowMs) || DEFAULT_REDEEM_RATE_LIMIT.windowMs);

  function checkRedeemRateLimit(clientKey) {
    const currentMs = now();
    let entry = redeemLimits.get(clientKey);
    if (!entry || currentMs >= entry.resetAt) {
      if (redeemLimits.size >= MAX_RATE_LIMIT_ENTRIES && !redeemLimits.has(clientKey)) {
        redeemLimits.delete(redeemLimits.keys().next().value);
      }
      entry = { count: 1, resetAt: currentMs + redeemWindowMs };
      redeemLimits.set(clientKey, entry);
      return { allowed: true, retryAfterSec: 0 };
    }
    entry.count += 1;
    if (entry.count > maxRedeemAttempts) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - currentMs) / 1000));
      return { allowed: false, retryAfterSec };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  function isSecure(req) {
    if (config.cookieSecure === 'true') return true;
    if (config.cookieSecure === 'false') return false;
    return baseUrlFor(req).startsWith('https://');
  }

  function setCookie(res, req, name, value, maxAgeMs) {
    res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/', maxAge: maxAgeMs });
  }

  function clearCookie(res, req, name) {
    res.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/' });
  }

  function currentUser(req) {
    return service.getSessionUser(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  }

  // Cookie-authenticated mutations must come from our own origin.
  function sameOrigin(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    if (!origin) return next(); // non-browser clients cannot ride a cookie
    let host = '';
    let own = '';
    try { host = new URL(origin).host; } catch (_) { host = ''; }
    try { own = new URL(baseUrlFor(req)).host; } catch (_) { own = ''; }
    const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (host && (host === own || host === reqHost)) return next();
    return res.status(403).json({ error: 'cross_origin' });
  }

  function requireUser(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    req.authUser = user;
    return next();
  }

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/providers', (req, res) => {
    const accessTokenEnabled = Boolean(config.enabled && config.discord && config.discord.enabled);
    res.json({
      enabled: config.enabled,
      providers: config.enabled ? service.providers.list() : [],
      accessTokenEnabled,
    });
  });

  router.use((req, res, next) => (config.enabled ? next() : res.status(503).json({ error: 'accounts_disabled' })));

  // Signed Discord webhooks carry no browser Origin header and verify Ed25519 over raw bytes.
  router.post(
    '/discord/interactions',
    discordRaw,
    createDiscordInteractionHandler({ service, config, now })
  );

  router.post('/access-token/redeem', (req, res, next) => {
    if (!config.discord || !config.discord.enabled) {
      return res.status(404).json({ error: 'discord_disabled' });
    }
    if (!isExactCanonicalOrigin(req.headers.origin, config.discord.canonicalOrigin)) {
      return res.status(403).json({ error: 'cross_origin' });
    }
    const rate = checkRedeemRateLimit(extractTrustedClientIp(req));
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Too many sign-in attempts. Please wait a minute and try again.',
      });
    }
    return next();
  }, redeemJson, (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(401).json({ error: 'invalid_access_token' });
    }
    try {
      const { sessionToken } = service.redeemDiscordAccessToken(req.body.token);
      setCookie(res, req, SESSION_COOKIE, sessionToken, config.sessionTtlMs);
      const redirectTo = normalizeRedirectPath(req.body.returnTo, config.discord.canonicalOrigin);
      return res.json({ ok: true, redirectTo });
    } catch (err) {
      if (err instanceof AuthError && err.code === 'invalid_access_token') {
        return res.status(401).json({ error: 'invalid_access_token' });
      }
      return authFail(res, err);
    }
  });

  router.get('/me', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.json({ authenticated: false });
    return res.json({
      authenticated: true,
      user: { id: user.id, name: user.display_name, email: user.email },
      identities: service.store.listIdentities(user.id),
    });
  });

  router.get('/:provider/start', (req, res) => {
    const provider = service.providers.get(req.params.provider);
    if (!provider) return res.status(404).json({ error: 'unknown_provider' });
    const state = crypto.createOpaqueToken('st', 16);
    const nonce = crypto.createOpaqueToken('no', 16);
    const { verifier, challenge } = crypto.pkcePair();
    const redirectUri = `${baseUrlFor(req)}/api/auth/${provider.id}/callback`;
    setCookie(res, req, STATE_COOKIE, crypto.signPayload({
      p: provider.id, s: state, n: nonce, v: verifier, r: safeReturnPath(req.query.return), t: Date.now(),
    }, config.pepper), STATE_MAX_AGE_MS);
    return res.redirect(302, provider.buildAuthUrl({ state, nonce, codeChallenge: challenge, redirectUri }));
  });

  router.get('/:provider/callback', async (req, res) => {
    const provider = service.providers.get(req.params.provider);
    const saved = crypto.verifyPayload(parseCookies(req.headers.cookie)[STATE_COOKIE], config.pepper, STATE_MAX_AGE_MS);
    clearCookie(res, req, STATE_COOKIE);
    const fail = (code) => res.redirect(302, `/account?error=${encodeURIComponent(code)}`);
    if (!provider) return fail('unknown_provider');
    if (req.query.error) return fail('sign_in_cancelled');
    if (!saved || saved.p !== provider.id || typeof req.query.state !== 'string'
        || !crypto.safeEqual(saved.s, req.query.state) || typeof req.query.code !== 'string') {
      return fail('invalid_state');
    }
    try {
      const identity = await provider.exchange({
        code: req.query.code, codeVerifier: saved.v, nonce: saved.n,
        redirectUri: `${baseUrlFor(req)}/api/auth/${provider.id}/callback`,
      });
      const user = service.signInWithIdentity({ provider: provider.id, ...identity });
      setCookie(res, req, SESSION_COOKIE, service.createSession(user.id), config.sessionTtlMs);
      return res.redirect(302, safeReturnPath(saved.r));
    } catch (err) {
      console.warn(`[auth] ${provider.id} sign-in failed: ${err && err.code ? err.code : ''} ${err && err.message ? err.message : ''}`.trim());
      return fail(err instanceof AuthError ? err.code : 'sign_in_failed');
    }
  });

  router.use(sameOrigin);

  router.post('/logout', (req, res) => {
    service.destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    clearCookie(res, req, SESSION_COOKIE);
    res.json({ ok: true });
  });

  router.get('/devices', requireUser, (req, res) => {
    res.json({ devices: service.store.listDevices(req.authUser.id) });
  });

  function authFail(res, err) {
    if (err instanceof AuthError) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }

  // Adds a device (just a name); its settings and install link come later, from Configure.
  router.post('/devices', requireUser, json, (req, res) => {
    try {
      const { id } = service.createDeviceToken(req.authUser.id, req.body && req.body.name);
      res.status(201).json({ id });
    } catch (err) { authFail(res, err); }
  });

  router.get('/devices/:id', requireUser, (req, res) => {
    const d = service.getDevice(req.authUser.id, req.params.id);
    if (!d) return res.status(404).json({ error: 'not_found' });
    const cfg = d.token ? Buffer.from(JSON.stringify({ a: d.token })).toString('base64url') : null;
    return res.json({ id: d.id, name: d.name, config: d.config, manifestUrl: cfg ? `${baseUrlFor(req)}/${cfg}/manifest.json` : null });
  });

  router.put('/devices/:id', requireUser, json, (req, res) => {
    try {
      service.updateDevice(req.authUser.id, req.params.id, req.body || {});
      res.json({ ok: true });
    } catch (err) { authFail(res, err); }
  });

  router.delete('/devices/:id', requireUser, (req, res) => {
    res.json({ ok: service.revokeDevice(req.authUser.id, req.params.id) });
  });

  return router;
}

module.exports = { createAuthRouter, parseCookies, safeReturnPath };
