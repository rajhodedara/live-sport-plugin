'use strict';

const UID_KEY = '__uid';

function decodeSegment(seg) {
  try {
    let parsed;
    if (seg.startsWith('%7B') || seg.startsWith('{')) {
      parsed = JSON.parse(decodeURIComponent(seg));
    } else if (/^[A-Za-z0-9_-]{8,}$/.test(seg)) {
      parsed = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    } else {
      return null;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * Account-aware config rewrite. For a URL whose first segment is an addon config:
 *  - always strips any client-supplied `__uid` (internal-only claim),
 *  - when it carries a device token (`a`), resolves the account, merges the saved
 *    addon settings over the URL config, tags the config with `__uid`, and rewrites
 *    the segment so everything downstream (manifest, SDK router) sees a plain config.
 * Invalid/revoked tokens get 401. The token itself never reaches downstream handlers.
 *
 * @param {{service: import('./AuthService').AuthService|null}} deps
 */
function createDeviceConfigMiddleware({ service }) {
  return function deviceConfigMiddleware(req, res, next) {
    const m = /^\/([^/?]+)(\/.*)?$/.exec(req.url.split('?')[0]);
    if (!m || m[1] === 'api') return next();
    const parsed = decodeSegment(m[1]);
    if (!parsed) return next();

    const hadUid = Object.prototype.hasOwnProperty.call(parsed, UID_KEY);
    delete parsed[UID_KEY];
    const token = parsed.a;
    let merged = parsed;

    if (typeof token === 'string' && token.startsWith('nd_') && service) {
      const auth = service.authenticateDeviceToken(token);
      if (!auth) return res.status(401).json({ error: 'invalid_device_token' });
      delete parsed.a;
      merged = { ...parsed, ...auth.config, [UID_KEY]: auth.userId };
      req.nuvioUserId = auth.userId;
    } else if (!hadUid) {
      return next();
    }

    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = `/${encodeURIComponent(JSON.stringify(merged))}${m[2] || ''}${query}`;
    return next();
  };
}

module.exports = { createDeviceConfigMiddleware, UID_KEY };
