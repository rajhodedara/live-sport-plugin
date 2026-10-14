'use strict';

const express = require('express');
const { getAuthContext } = require('../auth');
const { AuthError } = require('../auth/AuthService');
const { handleCatalog } = require('../catalog');
const { handleStream } = require('../streams');

const router = express.Router();
router.use(express.json({ limit: '16kb', strict: true }));

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 30;

function rateLimit(req, res, next) {
  const now = Date.now();
  // Express resolves req.ip through the configured trusted proxy, avoiding a
  // single shared limiter bucket for every client behind the hosting proxy.
  const key = `${req.ip || req.socket && req.socket.remoteAddress || 'unknown'}:${req.path}`;
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }
  current.count++;
  if (current.count > MAX_REQUESTS) {
    res.setHeader('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
  }
  next();
}

function parseCookies(req) {
  const out = {};
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    try { out[key] = decodeURIComponent(pair.slice(index + 1).trim()); } catch (_) {}
  }
  return out;
}

function assertSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const parsed = new URL(origin);
    const host = req.get('host');
    if (parsed.host !== host) {
      return res.status(403).json({ error: 'origin_forbidden', message: 'Cross-origin account requests are not allowed.' });
    }
  } catch (_) {
    return res.status(403).json({ error: 'origin_forbidden', message: 'Cross-origin account requests are not allowed.' });
  }
  next();
}

function cookieOptions(config, expiresAt) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    expires: new Date(expiresAt),
  };
}

function sessionFromRequest(req) {
  const { config, authService } = getAuthContext();
  const token = parseCookies(req)[config.cookieName];
  return { token, session: authService.getSession(token) };
}

function requireSession(req, res, next) {
  const found = sessionFromRequest(req);
  if (!found.session) {
    return res.status(401).json({ error: 'authentication_required', message: 'Sign in to continue.' });
  }
  req.browserSession = found.session;
  req.browserSessionToken = found.token;
  next();
}

function sendError(res, error) {
  if (error instanceof AuthError || (error && error.status && error.code)) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  console.error('[Auth] Unexpected error:', error && error.stack ? error.stack : error);
  return res.status(500).json({ error: 'internal_error', message: 'Authentication service error.' });
}

router.use((_, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});

router.get('/status', (_, res) => {
  const { config } = getAuthContext();
  res.json({ required: config.required, registration: 'public' });
});

router.post('/device/validate', rateLimit, assertSameOrigin, (req, res) => {
  try {
    const { authService } = getAuthContext();
    authService.validateDeviceToken(req.body && req.body.token);
    res.json({ valid: true });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/register', rateLimit, assertSameOrigin, async (req, res) => {
  try {
    const { config, authService } = getAuthContext();
    const user = await authService.register(req.body && req.body.email, req.body && req.body.password);
    const login = await authService.login(user.email, req.body.password);
    res.cookie(config.cookieName, login.token, cookieOptions(config, login.expiresAt));
    res.status(201).json({ user: login.user });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/login', rateLimit, assertSameOrigin, async (req, res) => {
  try {
    const { config, authService } = getAuthContext();
    const login = await authService.login(req.body && req.body.email, req.body && req.body.password);
    res.cookie(config.cookieName, login.token, cookieOptions(config, login.expiresAt));
    res.json({ user: login.user });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/logout', assertSameOrigin, (req, res) => {
  const { config, authService } = getAuthContext();
  const { token } = sessionFromRequest(req);
  authService.logout(token);
  res.clearCookie(config.cookieName, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/' });
  res.status(204).end();
});

router.get('/me', (req, res) => {
  const { session } = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'authentication_required', message: 'Sign in to continue.' });
  res.json({ user: session.user });
});

router.get('/web/catalog/:id', requireSession, async (req, res) => {
  try {
    const result = await handleCatalog('tv', req.params.id, {}, {});
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/web/stream/:id', requireSession, async (req, res) => {
  try {
    const { playbackGrantService } = getAuthContext();
    const grant = playbackGrantService.mintBrowser({
      browserSessionId: req.browserSession.sessionId,
      userId: req.browserSession.user.id,
      expiresAt: req.browserSession.expiresAt,
    });
    const result = await handleStream('tv', req.params.id, { __playbackGrant: grant });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/devices', requireSession, (req, res) => {
  const { authService } = getAuthContext();
  res.json({ devices: authService.listDevices(req.browserSession.user.id) });
});

router.post('/devices', assertSameOrigin, requireSession, (req, res) => {
  try {
    const { authService } = getAuthContext();
    const result = authService.createDevice(req.browserSession.user.id, req.body && req.body.name);
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/devices/:id', assertSameOrigin, requireSession, (req, res) => {
  const { authService } = getAuthContext();
  const revoked = authService.revokeDevice(req.browserSession.user.id, req.params.id);
  if (!revoked) return res.status(404).json({ error: 'device_not_found', message: 'Device not found or already revoked.' });
  res.status(204).end();
});

router.delete('/devices/:id/permanent', assertSameOrigin, requireSession, (req, res) => {
  const { authService } = getAuthContext();
  const deleted = authService.deleteDevice(req.browserSession.user.id, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'device_not_found', message: 'Device not found.' });
  res.status(204).end();
});

module.exports = router;
module.exports._internal = { parseCookies, assertSameOrigin, rateLimit, attempts };
