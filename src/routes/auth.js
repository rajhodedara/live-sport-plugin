'use strict';

const express = require('express');
const crypto = require('../auth/AuthCrypto');
const { AuthError } = require('../auth/AuthService');

const SESSION_COOKIE = 'nuvio_session';
const STATE_COOKIE = 'nuvio_oauth';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

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

/**
 * @param {{service: import('../auth/AuthService').AuthService, config: object, baseUrlFor: (req) => string}} deps
 */
function createAuthRouter({ service, config, baseUrlFor }) {
  const router = express.Router();
  const json = express.json({ limit: '16kb' });

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
    let host;
    try { host = new URL(origin).host; } catch (_) { host = ''; }
    const own = new URL(baseUrlFor(req)).host;
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
    res.json({ enabled: config.enabled, providers: config.enabled ? service.providers.list() : [] });
  });

  router.use((req, res, next) => (config.enabled ? next() : res.status(503).json({ error: 'accounts_disabled' })));

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

  router.get('/settings', requireUser, (req, res) => {
    res.json({
      leafInstallSet: Boolean(service.getLeafInstallInput(req.authUser.id)),
    });
  });

  router.put('/settings', requireUser, json, (req, res) => {
    try {
      service.updateSettings(req.authUser.id, req.body || {});
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof AuthError) return res.status(err.status).json({ error: err.code, message: err.message });
      throw err;
    }
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
