'use strict';

const {
  hashPassword,
  verifyPassword,
  createOpaqueToken,
  hashOpaqueToken,
  normalizeEmail,
} = require('./AuthCrypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

class AuthError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

class AuthService {
  constructor({ repository, config }) {
    this.repository = repository;
    this.config = config;
  }

  _publicUser(user) {
    return { id: user.id, email: user.email, createdAt: user.created_at };
  }

  _publicDevice(device) {
    return {
      id: device.id,
      name: device.name,
      createdAt: device.created_at,
      lastUsedAt: device.last_used_at,
      expiresAt: device.expires_at,
      revokedAt: device.revoked_at,
    };
  }

  async register(emailInput, password) {
    const email = normalizeEmail(emailInput);
    if (!EMAIL_RE.test(email) || email.length > 254) {
      throw new AuthError('invalid_email', 'Enter a valid email address.');
    }
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
      throw new AuthError('invalid_password', 'Password must be between 10 and 128 characters.');
    }
    const { salt, hash } = await hashPassword(password);
    try {
      const user = this.repository.createUser({ email, passwordHash: hash, passwordSalt: salt });
      return this._publicUser(user);
    } catch (error) {
      if (error && (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(error.message))) {
        throw new AuthError('email_exists', 'An account with that email already exists.', 409);
      }
      throw error;
    }
  }

  async login(emailInput, password) {
    const email = normalizeEmail(emailInput);
    const user = this.repository.findUserByEmail(email);
    const generic = new AuthError('invalid_credentials', 'Invalid email or password.', 401);
    if (!user) {
      // Reduce the timing distinction between an unknown email and a bad password.
      await verifyPassword(password || '', 'invalid-salt', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      throw generic;
    }
    const now = Date.now();
    if (user.disabled_at) throw new AuthError('account_disabled', 'This account is disabled.', 403);
    if (user.locked_until && user.locked_until > now) {
      throw new AuthError('account_locked', 'Too many failed attempts. Try again later.', 429);
    }
    const valid = await verifyPassword(password || '', user.password_salt, user.password_hash);
    if (!valid) {
      const failures = Number(user.failed_login_count || 0) + 1;
      this.repository.recordLoginFailure(
        user.id,
        failures >= MAX_FAILURES ? 0 : failures,
        failures >= MAX_FAILURES ? now + LOCKOUT_MS : null,
        now
      );
      throw generic;
    }
    this.repository.resetLoginFailures(user.id, now);
    return this._createSession(user, now);
  }

  _createSession(user, now = Date.now()) {
    const token = createOpaqueToken('nuvio_session');
    const expiresAt = now + this.config.sessionTtlMs;
    this.repository.createSession({
      tokenHash: hashOpaqueToken(token, this.config.tokenPepper),
      userId: user.id,
      expiresAt,
      now,
    });
    return { token, expiresAt, user: this._publicUser(user) };
  }

  getSession(token) {
    if (!token) return null;
    const hash = hashOpaqueToken(token, this.config.tokenPepper);
    const session = this.repository.findSessionByTokenHash(hash);
    if (!session) return null;
    if (session.session_expires_at <= Date.now() || session.disabled_at) {
      this.repository.deleteSessionByTokenHash(hash);
      return null;
    }
    return {
      sessionId: session.session_id,
      tokenHash: hash,
      expiresAt: session.session_expires_at,
      user: this._publicUser(session),
    };
  }

  validateSessionRecord(session) {
    if (!session) throw new AuthError('invalid_browser_session', 'Your browser session is invalid.', 401);
    if (session.disabled_at) throw new AuthError('account_disabled', 'This account is disabled.', 403);
    if (session.session_expires_at <= Date.now()) {
      throw new AuthError('browser_session_expired', 'Your browser session has expired.', 401);
    }
    return {
      browserSessionId: session.session_id,
      userId: session.id,
      email: session.email,
      expiresAt: session.session_expires_at,
    };
  }

  logout(token) {
    if (!token) return false;
    return this.repository.deleteSessionByTokenHash(hashOpaqueToken(token, this.config.tokenPepper));
  }

  createDevice(userId, nameInput) {
    const name = String(nameInput || 'Nuvio device').trim().slice(0, 80) || 'Nuvio device';
    // 128 bits is sufficient for an online bearer credential and keeps the
    // tokenized config compact enough for Nuvio Collections, where the
    // manifest URL is repeated for every catalog source.
    const token = createOpaqueToken('nd', 16);
    const now = Date.now();
    const expiresAt = this.config.deviceTokenTtlMs ? now + this.config.deviceTokenTtlMs : null;
    const device = this.repository.createDeviceToken({
      tokenHash: hashOpaqueToken(token, this.config.tokenPepper),
      userId,
      name,
      expiresAt,
      now,
    });
    return { token, device: this._publicDevice(device) };
  }

  listDevices(userId) {
    return this.repository.listDeviceTokens(userId).map((device) => this._publicDevice(device));
  }

  revokeDevice(userId, deviceId) {
    return this.repository.revokeDeviceToken(userId, Number(deviceId));
  }

  deleteDevice(userId, deviceId) {
    return this.repository.deleteDeviceToken(userId, Number(deviceId));
  }

  validateDeviceToken(token, { touch = true } = {}) {
    if (!token) throw new AuthError('missing_device_token', 'Authentication is required.', 401);
    const device = this.repository.findDeviceByTokenHash(hashOpaqueToken(token, this.config.tokenPepper));
    return this.validateDeviceRecord(device, { touch });
  }

  validateDeviceRecord(device, { touch = false } = {}) {
    if (!device) throw new AuthError('invalid_device_token', 'This device access token is invalid.', 401);
    if (device.disabled_at) throw new AuthError('account_disabled', 'This account is disabled.', 403);
    if (device.revoked_at) throw new AuthError('device_revoked', 'This device access has been revoked.', 403);
    if (device.device_expires_at && device.device_expires_at <= Date.now()) {
      throw new AuthError('device_expired', 'This device access token has expired.', 401);
    }
    if (touch) this.repository.touchDeviceToken(device.device_id);
    return {
      deviceId: device.device_id,
      deviceName: device.device_name,
      userId: device.user_id,
      email: device.email,
    };
  }
}

module.exports = AuthService;
module.exports.AuthError = AuthError;
