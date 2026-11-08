'use strict';

const crypto = require('./AuthCrypto');
const { resolveLeafInstallConfig, PUBLIC_LEAF_ORIGINS } = require('../services/LeafInstallConfig');

// Account-supplied installs are user input: only Highfly origins, and only plain id/link characters.
const SAFE_INPUT = /^[A-Za-z0-9_.:/#%@=-]+$/;
function resolveUserInstall(input) {
  if (typeof input !== 'string' || !SAFE_INPUT.test(input)) return null;
  const install = resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: input });
  return install.configured && PUBLIC_LEAF_ORIGINS.includes(install.origin) ? install : null;
}

const MAX_DEVICES = 20;
const SETTINGS_KEYS = ['teams', 'timezone', 'languages', 'replayFilter', 'webStreams', 'sports', 'liveSources', 'replaySources'];
const DEVICE_CACHE_MS = 30000;

function cleanAddonConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new AuthError('invalid_settings', 400);
  const clean = {};
  for (const k of SETTINGS_KEYS) {
    if (cfg[k] === undefined) continue;
    const v = cfg[k];
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
  constructor({ store, config, providers }) {
    this.store = store;
    this.config = config;
    this.providers = providers;
    this._deviceCache = new Map();
    this._installCache = new Map();
  }

  /** Finds or creates the account behind a provider identity. Identities never auto-merge by email. */
  signInWithIdentity({ provider, subject, email, name }) {
    let user = this.store.findUserByIdentity(provider, subject);
    if (!user) user = this.store.createUserWithIdentity({ provider, subject, email: crypto.normalizeEmail(email), name });
    if (user.disabled_at) throw new AuthError('account_disabled', 403);
    return user;
  }

  createSession(userId) {
    const token = crypto.createOpaqueToken('ns');
    this.store.createSession({
      tokenHash: crypto.hashOpaqueToken(token, this.config.pepper), userId, expiresAt: Date.now() + this.config.sessionTtlMs,
    });
    return token;
  }

  getSessionUser(token) {
    if (!token || typeof token !== 'string') return null;
    const s = this.store.findSession(crypto.hashOpaqueToken(token, this.config.pepper));
    return s ? this.store.getUser(s.user_id) : null;
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

  /** Resolves a device token to { userId, deviceId } (30s positive cache per worker), or null. */
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

  /** The account's own Leaf/Highfly install value as entered, or '' when unset. */
  getLeafInstallInput(userId) {
    const row = this.store.getSettings(userId);
    if (!row || !row.leaf_install_encrypted) return '';
    return crypto.decryptString(row.leaf_install_encrypted, this.config.encryptionKey) || '';
  }

  /** Per-account Leaf install object ({configured, apiBase, origin, mode}) or null to fall back to the shared install. */
  getLeafInstall(userId) {
    const hit = this._installCache.get(userId);
    if (hit && hit.until > Date.now()) return hit.value;
    let value = null;
    const input = this.getLeafInstallInput(userId);
    if (input) {
      try {
        value = resolveUserInstall(input);
      } catch (_) { value = null; }
    }
    this._installCache.set(userId, { value, until: Date.now() + 30000 });
    if (this._installCache.size > 1000) this._installCache.clear();
    return value;
  }

  updateSettings(userId, body) {
    const patch = {};
    if (body && body.leafInstall !== undefined) {
      const raw = typeof body.leafInstall === 'string' ? body.leafInstall.trim() : null;
      if (raw === null || raw.length > 2000) throw new AuthError('invalid_leaf_install', 400);
      if (raw === '') {
        patch.leafInstallEncrypted = null;
      } else {
        let install;
        try { install = resolveUserInstall(raw); } catch (_) { install = null; }
        if (!install) throw new AuthError('invalid_leaf_install', 400, 'Not a valid Highfly install link or ID');
        patch.leafInstallEncrypted = crypto.encryptString(raw, this.config.encryptionKey);
      }
    }
    this.store.saveSettings(userId, patch);
    this._installCache.delete(userId);
  }
}

module.exports = { AuthService, AuthError, SETTINGS_KEYS };
