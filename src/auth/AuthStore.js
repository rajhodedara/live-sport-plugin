'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL, disabled_at INTEGER
   );
   CREATE TABLE identities (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     provider TEXT NOT NULL, provider_subject TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL, UNIQUE(provider, provider_subject)
   );
   CREATE INDEX identities_user ON identities(user_id);
   CREATE TABLE user_settings (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     addon_config_json TEXT NOT NULL DEFAULT '{}', leaf_install_encrypted TEXT, updated_at INTEGER NOT NULL
   );
   CREATE TABLE browser_sessions (
     id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
   );
   CREATE TABLE device_tokens (
     id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL DEFAULT '', expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER, created_at INTEGER NOT NULL
   );
   CREATE INDEX device_tokens_user ON device_tokens(user_id);`,
  // v2: each device carries its own addon settings, and its (encrypted) token so the link can be shown again.
  `ALTER TABLE device_tokens ADD COLUMN addon_config_json TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE device_tokens ADD COLUMN token_encrypted TEXT;`,
];

/** SQLite persistence on the built-in node:sqlite (no native dependency). */
class AuthStore {
  constructor(dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this._migrate();
  }

  _migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS auth_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const current = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM auth_schema_migrations').get().v;
    for (let i = current; i < MIGRATIONS.length; i += 1) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Another cluster worker may have applied it while we waited for the lock.
        const again = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM auth_schema_migrations').get().v;
        if (again <= i) {
          this.db.exec(MIGRATIONS[i]);
          this.db.prepare('INSERT INTO auth_schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, Date.now());
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  close() { this.db.close(); }

  findUserByIdentity(provider, subject) {
    return this.db.prepare(
      `SELECT u.* FROM users u JOIN identities i ON i.user_id = u.id WHERE i.provider = ? AND i.provider_subject = ?`
    ).get(provider, subject) || null;
  }

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  }

  createUserWithIdentity({ provider, subject, email, name }) {
    const now = Date.now();
    const userId = crypto.randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO users (id, display_name, email, created_at) VALUES (?, ?, ?, ?)').run(userId, name || '', email || '', now);
      this.db.prepare('INSERT INTO identities (id, user_id, provider, provider_subject, email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), userId, provider, subject, email || '', now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getUser(userId);
  }

  listIdentities(userId) {
    return this.db.prepare('SELECT provider, email, created_at FROM identities WHERE user_id = ? ORDER BY created_at').all(userId);
  }

  getSettings(userId) {
    return this.db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) || null;
  }

  saveSettings(userId, { addonConfigJson, leafInstallEncrypted }) {
    const existing = this.getSettings(userId);
    const addon = addonConfigJson !== undefined ? addonConfigJson : (existing ? existing.addon_config_json : '{}');
    const leaf = leafInstallEncrypted !== undefined ? leafInstallEncrypted : (existing ? existing.leaf_install_encrypted : null);
    this.db.prepare(
      `INSERT INTO user_settings (user_id, addon_config_json, leaf_install_encrypted, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET addon_config_json = excluded.addon_config_json,
         leaf_install_encrypted = excluded.leaf_install_encrypted, updated_at = excluded.updated_at`
    ).run(userId, addon, leaf, Date.now());
  }

  createSession({ tokenHash, userId, expiresAt }) {
    this.db.prepare('INSERT INTO browser_sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), tokenHash, userId, expiresAt, Date.now());
  }

  findSession(tokenHash) {
    return this.db.prepare(
      `SELECT s.id, s.user_id, s.expires_at FROM browser_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL`
    ).get(tokenHash, Date.now()) || null;
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM browser_sessions WHERE token_hash = ?').run(tokenHash);
  }

  createDevice({ tokenHash, userId, name, expiresAt, tokenEncrypted }) {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO device_tokens (id, token_hash, user_id, name, expires_at, token_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, tokenHash, userId, name, expiresAt || null, tokenEncrypted || null, Date.now());
    return id;
  }

  getDevice(userId, deviceId) {
    return this.db.prepare(
      'SELECT id, name, addon_config_json, token_encrypted, created_at, last_used_at FROM device_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
    ).get(deviceId, userId) || null;
  }

  updateDevice(userId, deviceId, { name, addonConfigJson }) {
    const cur = this.getDevice(userId, deviceId);
    if (!cur) return false;
    this.db.prepare('UPDATE device_tokens SET name = ?, addon_config_json = ? WHERE id = ? AND user_id = ?')
      .run(name !== undefined ? name : cur.name, addonConfigJson !== undefined ? addonConfigJson : cur.addon_config_json, deviceId, userId);
    return true;
  }

  listDevices(userId) {
    return this.db.prepare(
      'SELECT id, name, created_at, last_used_at, expires_at FROM device_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
    ).all(userId);
  }

  countDevices(userId) {
    return this.db.prepare('SELECT COUNT(*) AS c FROM device_tokens WHERE user_id = ? AND revoked_at IS NULL').get(userId).c;
  }

  revokeDevice(userId, deviceId) {
    return this.db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(Date.now(), deviceId, userId).changes > 0;
  }

  findDevice(tokenHash) {
    const now = Date.now();
    return this.db.prepare(
      `SELECT d.id, d.user_id, d.addon_config_json FROM device_tokens d JOIN users u ON u.id = d.user_id
       WHERE d.token_hash = ? AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at > ?) AND u.disabled_at IS NULL`
    ).get(tokenHash, now) || null;
  }

  touchDevice(id) {
    this.db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  }

  deleteUser(userId) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
}

module.exports = { AuthStore };
