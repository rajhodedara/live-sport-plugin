'use strict';

const crypto = require('./AuthCrypto');

const MAX_DEVICES = 20;
const SETTINGS_KEYS = ['teams', 'timezone', 'languages', 'liveLanguages', 'languageFilter', 'replayFilter', 'webStreams', 'sports', 'liveSources', 'replaySources', 'liveLeagues'];
const DEVICE_CACHE_MS = 30000;
const DISCORD_ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;
const DISCORD_ACCESS_TOKEN_RE = /^nt_[A-Za-z0-9_-]{32}$/;

function cleanStringList(list, maxLen, fieldName) {
  if (!Array.isArray(list) || list.length > maxLen) {
    throw new AuthError('invalid_settings', 400, `Invalid value for ${fieldName}`);
  }
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.length > 120) {
      throw new AuthError('invalid_settings', 400, `Invalid value for ${fieldName}`);
    }
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function cleanLiveLeagues(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new AuthError('invalid_settings', 400, 'Invalid value for liveLeagues');
  }
  const out = {
    ids: val.ids === undefined ? [] : cleanStringList(val.ids, 300, 'liveLeagues.ids'),
    custom: val.custom === undefined ? [] : cleanStringList(val.custom, 24, 'liveLeagues.custom'),
    other: val.other === undefined ? true : Boolean(val.other),
  };
  return out;
}

function cleanAddonConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new AuthError('invalid_settings', 400);
  const clean = {};
  for (const k of SETTINGS_KEYS) {
    if (cfg[k] === undefined) continue;
    const v = cfg[k];
    if (k === 'liveLeagues') {
      clean.liveLeagues = cleanLiveLeagues(v);
      continue;
    }
    if (typeof v !== 'string' && !Array.isArray(v)) throw new AuthError('invalid_settings', 400, `Invalid value for ${k}`);
    const str = Array.isArray(v) ? v.map(String).join(',') : v;
    if (str.length > 4000) throw new AuthError('invalid_settings', 400, `${k} is too long`);
    clean[k] = str;
  }
  return clean;
}

class AuthError extends Error {
  constructor(code, status, message) { super(message || code); this.code = code; this.status = status; }
}

class AuthService {
  constructor({ store, config, providers, now = () => Date.now() }) {
    this.store = store;
    this.config = config;
    this.providers = providers;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this._deviceCache = new Map();
  }

  /** Finds or creates the account behind a provider identity. Identities never auto-merge by email. */
  signInWithIdentity({ provider, subject, email, name }) {
    let user = this.store.findUserByIdentity(provider, subject);
    if (!user) user = this.store.createUserWithIdentity({ provider, subject, email: crypto.normalizeEmail(email), name });
    if (user.disabled_at) throw new AuthError('account_disabled', 403);
    return user;
  }

  createSession(userId) {
    const now = this.now();
    const token = crypto.createOpaqueToken('ns');
    this.store.createSession({
      tokenHash: crypto.hashOpaqueToken(token, this.config.pepper), userId, expiresAt: now + this.config.sessionTtlMs, now,
    });
    return token;
  }

  getSessionUser(token) {
    if (!token || typeof token !== 'string') return null;
    const s = this.store.findSession(crypto.hashOpaqueToken(token, this.config.pepper), this.now());
    return s ? this.store.getUser(s.user_id) : null;
  }

  /**
   * Issues a permanent, reusable private Discord access token keyed by interaction ID.
   * Returns `{ token, expiresAt: null }`, or `null` when the interaction ID was already issued.
   */
  issueDiscordAccessToken({ interactionId, subject, name, signedAtMs } = {}) {
    const iid = typeof interactionId === 'string' ? interactionId.trim() : '';
    const sub = typeof subject === 'string' ? subject.trim() : '';
    if (!iid || !sub) throw new AuthError('invalid_interaction', 400);
    const now = this.now();
    const effectiveSignedAt = Number.isFinite(signedAtMs) ? signedAtMs : now;
    const retainUntil = Math.max(effectiveSignedAt, now) + DISCORD_ACCESS_TOKEN_TTL_MS;
    const token = crypto.createOpaqueToken('nt', 24);
    const tokenHash = crypto.hashOpaqueToken(token, this.config.pepper);
    const cleanName = String(name || '').trim().slice(0, 80);

    let inserted;
    try {
      inserted = this.store.issueDiscordAccessToken({
        interactionId: iid,
        tokenHash,
        subject: sub,
        name: cleanName,
        expiresAt: 0,
        retainUntil,
        now,
      });
    } catch (err) {
      if (err && err.errcode === 5) throw new AuthError('storage_busy', 503, 'Temporary storage contention');
      throw err;
    }
    return inserted ? { token, expiresAt: null } : null;
  }

  /**
   * Atomically redeems a Discord access token, creating the Discord identity if needed
   * and issuing a browser session token.
   */
  redeemDiscordAccessToken(rawToken) {
    if (typeof rawToken !== 'string') throw new AuthError('invalid_access_token', 401);
    const token = rawToken.trim();
    if (!DISCORD_ACCESS_TOKEN_RE.test(token)) throw new AuthError('invalid_access_token', 401);

    const now = this.now();
    const tokenHash = crypto.hashOpaqueToken(token, this.config.pepper);
    const sessionToken = crypto.createOpaqueToken('ns');
    const sessionTokenHash = crypto.hashOpaqueToken(sessionToken, this.config.pepper);
    const sessionExpiresAt = now + this.config.sessionTtlMs;

    let result;
    try {
      result = this.store.redeemDiscordAccessToken({
        tokenHash,
        sessionTokenHash,
        sessionExpiresAt,
        now,
      });
    } catch (err) {
      if (err && err.code === 'account_disabled') throw new AuthError('invalid_access_token', 401);
      throw err;
    }
    if (!result || result.status !== 'ok') throw new AuthError('invalid_access_token', 401);
    return { sessionToken };
  }

  destroySession(token) {
    if (token) this.store.deleteSession(crypto.hashOpaqueToken(token, this.config.pepper));
  }

  /** Creates a device (a named install target with its own settings) and its link token. */
  createDeviceToken(userId, name) {
    if (this.store.countDevices(userId) >= MAX_DEVICES) throw new AuthError('device_limit', 400, 'Too many devices; revoke one first');
    const token = crypto.createOpaqueToken('nd', 16);
    const ttl = this.config.deviceTokenTtlMs;
    const id = this.store.createDevice({
      tokenHash: crypto.hashOpaqueToken(token, this.config.pepper), userId,
      name: String(name || 'Device').trim().slice(0, 60) || 'Device', expiresAt: ttl ? Date.now() + ttl : null,
      tokenEncrypted: crypto.encryptString(token, this.config.encryptionKey),
    });
    return { id, token };
  }

  revokeDevice(userId, deviceId) {
    this._deviceCache.clear();
    return this.store.revokeDevice(userId, deviceId);
  }

  /** Resolves a device token to { userId, deviceId, config } (30s positive cache per worker), or null. */
  authenticateDeviceToken(token) {
    if (typeof token !== 'string' || !token.startsWith('nd_') || token.length > 200) return null;
    const hash = crypto.hashOpaqueToken(token, this.config.pepper);
    const hit = this._deviceCache.get(hash);
    if (hit && hit.until > Date.now()) return hit.value;
    this._deviceCache.delete(hash);
    const d = this.store.findDevice(hash);
    if (!d) return null;
    this.store.touchDevice(d.id);
    let config = {};
    try { config = JSON.parse(d.addon_config_json) || {}; } catch (_) { /* keep empty */ }
    const value = { userId: d.user_id, deviceId: d.id, config };
    this._deviceCache.set(hash, { value, until: Date.now() + DEVICE_CACHE_MS });
    if (this._deviceCache.size > 1000) this._deviceCache.clear();
    return value;
  }

  /** A device with its saved settings and (decrypted) link token, or null. */
  getDevice(userId, deviceId) {
    const row = this.store.getDevice(userId, deviceId);
    if (!row) return null;
    let config = {};
    try { config = JSON.parse(row.addon_config_json) || {}; } catch (_) { /* keep empty */ }
    const token = row.token_encrypted ? crypto.decryptString(row.token_encrypted, this.config.encryptionKey) : null;
    return { id: row.id, name: row.name, config, token };
  }

  updateDevice(userId, deviceId, body) {
    const patch = {};
    if (body && body.name !== undefined) {
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) throw new AuthError('invalid_name', 400, 'Give the device a name');
      patch.name = name;
    }
    if (body && body.config !== undefined) patch.addonConfigJson = JSON.stringify(cleanAddonConfig(body.config));
    if (!this.store.updateDevice(userId, deviceId, patch)) throw new AuthError('not_found', 404);
    this._deviceCache.clear();
  }
}

module.exports = { AuthService, AuthError, SETTINGS_KEYS };
