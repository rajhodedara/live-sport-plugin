'use strict';

const crypto = require('crypto');
const { AuthError } = require('./AuthService');

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

class PlaybackGrantService {
  constructor({ repository, authService, config }) {
    this.repository = repository;
    this.authService = authService;
    this.config = config;
    this.signingKey = crypto.createHmac('sha256', config.tokenPepper)
      .update('nuvio-playback-grant-v1')
      .digest();
  }

  _signature(payload) {
    return crypto.createHmac('sha256', this.signingKey).update(payload).digest('base64url');
  }

  mint(device) {
    if (device && device.browserSessionId) return this.mintBrowser(device);
    const now = Date.now();
    const sessionTtlMs = this.config.playbackSessionTtlMs || 12 * 60 * 60 * 1000;
    const sessionExpiresAt = Math.min(
      device.playbackSessionExpiresAt || now + sessionTtlMs,
      now + sessionTtlMs
    );
    const payload = encode({
      v: 1,
      d: device.deviceId,
      u: device.userId,
      s: 'playback',
      iat: now,
      exp: Math.min(now + this.config.playbackTtlMs, sessionExpiresAt),
      max: sessionExpiresAt,
    });
    return `${payload}.${this._signature(payload)}`;
  }

  mintBrowser(session) {
    const now = Date.now();
    const sessionTtlMs = this.config.playbackSessionTtlMs || 12 * 60 * 60 * 1000;
    const browserSessionExpiresAt = session.browserSessionExpiresAt || session.expiresAt;
    const sessionExpiresAt = Math.min(
      session.playbackSessionExpiresAt || now + sessionTtlMs,
      now + sessionTtlMs,
      browserSessionExpiresAt
    );
    const payload = encode({
      v: 1,
      b: session.browserSessionId,
      u: session.userId || session.user.id,
      s: 'playback',
      iat: now,
      exp: Math.min(now + this.config.playbackTtlMs, sessionExpiresAt),
      max: sessionExpiresAt,
    });
    return `${payload}.${this._signature(payload)}`;
  }

  validate(token) {
    if (!token || typeof token !== 'string') {
      throw new AuthError('missing_playback_grant', 'Playback authentication is required.', 401);
    }
    const parts = token.split('.');
    if (parts.length !== 2) throw new AuthError('invalid_playback_grant', 'Invalid playback authentication.', 401);
    const [payloadPart, signature] = parts;
    const expected = this._signature(payloadPart);
    const actualBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
      throw new AuthError('invalid_playback_grant', 'Invalid playback authentication.', 401);
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    } catch (_) {
      throw new AuthError('invalid_playback_grant', 'Invalid playback authentication.', 401);
    }
    if (
      payload.v !== 1 ||
      payload.s !== 'playback' ||
      (!payload.d && !payload.b) ||
      !payload.exp ||
      !payload.max ||
      payload.exp > payload.max ||
      payload.exp <= Date.now() ||
      payload.max <= Date.now()
    ) {
      throw new AuthError(
        payload && payload.exp && payload.exp <= Date.now() ? 'playback_grant_expired' : 'invalid_playback_grant',
        payload && payload.exp && payload.exp <= Date.now() ? 'Playback authentication has expired.' : 'Invalid playback authentication.',
        401
      );
    }
    let context;
    if (payload.b) {
      const session = this.repository.findSessionById(payload.b);
      context = this.authService.validateSessionRecord(session);
      context.browserSessionExpiresAt = session.session_expires_at;
    } else {
      const device = this.repository.findDeviceById(payload.d);
      context = this.authService.validateDeviceRecord(device);
    }
    if (context.userId !== payload.u) throw new AuthError('invalid_playback_grant', 'Invalid playback authentication.', 401);
    return { ...context, expiresAt: payload.exp, playbackSessionExpiresAt: payload.max };
  }
}

module.exports = PlaybackGrantService;
