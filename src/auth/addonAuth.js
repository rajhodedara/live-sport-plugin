'use strict';

const { getAuthContext } = require('./index');
const { AuthError } = require('./AuthService');

const CONFIG_ALIASES = {
  a: 'accessToken',
  z: 'timezone',
  tm: 'teams',
  sp: 'sports',
  so: 'sources',
  lg: 'languages',
  rf: 'replayFilter',
  ws: 'webStreams',
};

function expandAddonConfig(input) {
  const config = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  for (const [shortKey, fullKey] of Object.entries(CONFIG_ALIASES)) {
    if (config[fullKey] === undefined && config[shortKey] !== undefined) config[fullKey] = config[shortKey];
    delete config[shortKey];
  }
  return config;
}

function sanitizeAddonConfig(input) {
  const config = expandAddonConfig(input);
  delete config.accessToken;
  delete config.__playbackGrant;
  return config;
}

function authenticateAddonConfig(input, { mintPlayback = false } = {}) {
  const { config: authConfig, authService, playbackGrantService } = getAuthContext();
  const raw = expandAddonConfig(input);
  const token = typeof raw.accessToken === 'string' ? raw.accessToken : '';
  let device = null;

  if (token) device = authService.validateDeviceToken(token);
  else if (authConfig.required) throw new AuthError('authentication_required', 'Sign in and install an authenticated addon URL.', 401);

  const config = sanitizeAddonConfig(raw);
  if (mintPlayback && device) config.__playbackGrant = playbackGrantService.mint(device);
  return { config, device };
}

function sendAuthError(res, error) {
  const status = error && error.status ? error.status : 401;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({
    error: error && error.code ? error.code : 'authentication_required',
    message: error && error.message ? error.message : 'Authentication is required.',
  });
}

function requirePlaybackGrant(req, res, next) {
  const { config, playbackGrantService } = getAuthContext();
  if (!config.required && !req.query.pt) return next();
  try {
    const incomingGrant = req.query.pt;
    req.playbackAuth = playbackGrantService.validate(incomingGrant);
    // Roll the grant forward on every successful local playback request. Live
    // HLS sessions can run for hours; playlist rewrites will carry this renewed
    // grant into subsequent segment and variant requests.
    const renewWindow = Math.max(60_000, Math.floor(config.playbackTtlMs / 3));
    req.playbackGrant = req.playbackAuth.expiresAt - Date.now() <= renewWindow
      ? playbackGrantService.mint(req.playbackAuth)
      : incomingGrant;
    req.query.pt = req.playbackGrant;
    try {
      const parsed = new URL(req.url, 'http://nuvio.local');
      parsed.searchParams.set('pt', req.playbackGrant);
      req.url = parsed.pathname + parsed.search;
    } catch (_) {}
    next();
  } catch (error) {
    sendAuthError(res, error);
  }
}

function isProtectedPlaybackPath(pathname) {
  return pathname === '/watch' ||
    pathname === '/api/manifest' ||
    pathname === '/api/fastmp4' ||
    pathname === '/api/mp4proxy' ||
    pathname === '/api/hlschunk' ||
    pathname === '/api/proxy-embed' ||
    pathname.startsWith('/api/hls');
}

function isOwnedPlaybackUrl(value, addonBaseUrl = '') {
  if (!value || typeof value !== 'string') return false;
  try {
    const isAbsolute = /^https?:\/\//i.test(value);
    const parsed = new URL(value, 'http://nuvio.local');
    if (isAbsolute) {
      if (!addonBaseUrl) return false;
      const addonOrigin = new URL(addonBaseUrl).origin;
      if (parsed.origin !== addonOrigin) return false;
    }
    return isProtectedPlaybackPath(parsed.pathname);
  } catch (_) {
    return false;
  }
}

function appendPlaybackGrant(value, grant, addonBaseUrl = '') {
  if (!value || !grant || typeof value !== 'string') return value;
  try {
    if (!isOwnedPlaybackUrl(value, addonBaseUrl)) return value;
    const isAbsolute = /^https?:\/\//i.test(value);
    const parsed = new URL(value, 'http://nuvio.local');
    parsed.searchParams.set('pt', grant);
    if (isAbsolute) return parsed.toString();
    return parsed.pathname + parsed.search + parsed.hash;
  } catch (_) {
    return value;
  }
}

module.exports = {
  sanitizeAddonConfig,
  expandAddonConfig,
  authenticateAddonConfig,
  sendAuthError,
  requirePlaybackGrant,
  appendPlaybackGrant,
  isOwnedPlaybackUrl,
};
