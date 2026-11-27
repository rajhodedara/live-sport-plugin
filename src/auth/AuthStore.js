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
   CREATE TABLE browser_sessions (
     id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
   );
   CREATE INDEX browser_sessions_expires ON browser_sessions(expires_at);
   CREATE TABLE device_tokens (
     id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL DEFAULT '', expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER, created_at INTEGER NOT NULL,
     addon_config_json TEXT NOT NULL DEFAULT '{}', token_encrypted TEXT
   );
   CREATE INDEX device_tokens_user ON device_tokens(user_id);`,
  `CREATE TABLE discord_access_tokens (
     id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
     subject TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL,
     retain_until INTEGER NOT NULL, redeemed_at INTEGER, created_at INTEGER NOT NULL
   );
   CREATE INDEX discord_access_tokens_retain ON discord_access_tokens(retain_until);`,
];

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const ISSUANCE_BUSY_TIMEOUT_MS = 500;

/** SQLite persistence on the built-in node:sqlite (no native dependency). */
class AuthStore {
  constructor(dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS;
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
    this._migrate();
  }

  _withWriteTransaction(fn, { busyTimeoutMs } = {}) {
    const overrideTimeout = busyTimeoutMs !== undefined;
    if (overrideTimeout) this.db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
    let inTx = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTx = true;
      const result = fn();
      this.db.exec('COMMIT');
      inTx = false;
      return result;
    } catch (err) {
      if (inTx) {
        try { this.db.exec('ROLLBACK'); } catch (_) { /* ignore rollback after aborted tx */ }
      }
      throw err;
    } finally {
      if (overrideTimeout) {
        try { this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`); } catch (_) { /* ignore if closed */ }
      }
    }
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

  _insertUserWithIdentity({ provider, subject, email, name, now = Date.now() }) {
    const userId = crypto.randomUUID();
    this.db.prepare('INSERT INTO users (id, display_name, email, created_at) VALUES (?, ?, ?, ?)').run(userId, name || '', email || '', now);
    this.db.prepare('INSERT INTO identities (id, user_id, provider, provider_subject, email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), userId, provider, subject, email || '', now);
    return this.getUser(userId);
  }

  createUserWithIdentity({ provider, subject, email, name }) {
    return this._withWriteTransaction(() => this._insertUserWithIdentity({ provider, subject, email, name }));
  }

  listIdentities(userId) {
    return this.db.prepare('SELECT provider, email, created_at FROM identities WHERE user_id = ? ORDER BY created_at').all(userId);
  }

  _insertSession({ tokenHash, userId, expiresAt, now = Date.now() }) {
    this.db.prepare('DELETE FROM browser_sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('INSERT INTO browser_sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), tokenHash, userId, expiresAt, now);
  }

  createSession({ tokenHash, userId, expiresAt, now = Date.now() }) {
    this._withWriteTransaction(() => this._insertSession({ tokenHash, userId, expiresAt, now }));
  }

  findSession(tokenHash, now = Date.now()) {
    return this.db.prepare(
      `SELECT s.id, s.user_id, s.expires_at FROM browser_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL`
    ).get(tokenHash, now) || null;
  }

  issueDiscordAccessToken({ interactionId, tokenHash, subject, name, expiresAt = 0, retainUntil, now = Date.now(), busyTimeoutMs = ISSUANCE_BUSY_TIMEOUT_MS }) {
    return this._withWriteTransaction(() => {
      const res = this.db.prepare(
        `INSERT OR IGNORE INTO discord_access_tokens
           (id, interaction_id, token_hash, subject, display_name, expires_at, retain_until, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), interactionId, tokenHash, subject, name || '', expiresAt || 0, retainUntil, now);
      return res.changes > 0;
    }, { busyTimeoutMs });
  }

  redeemDiscordAccessToken({ tokenHash, sessionTokenHash, sessionExpiresAt, now = Date.now() }) {
    return this._withWriteTransaction(() => {
      const claimed = this.db.prepare(
        `UPDATE discord_access_tokens
         SET redeemed_at = ?
         WHERE token_hash = ? AND (expires_at = 0 OR expires_at > ?)
         RETURNING subject, display_name`
      ).get(now, tokenHash, now);
      if (!claimed) return { status: 'invalid' };
      let user = this.findUserByIdentity('discord', claimed.subject);
      if (!user) {
        user = this._insertUserWithIdentity({
          provider: 'discord',
          subject: claimed.subject,
          email: '',
          name: claimed.display_name || '',
          now,
        });
      }
      if (user.disabled_at) {
        const err = new Error('account_disabled');
        err.code = 'account_disabled';
        throw err;
      }
      this._insertSession({
        tokenHash: sessionTokenHash,
        userId: user.id,
        expiresAt: sessionExpiresAt,
        now,
      });
      return { status: 'ok', user };
    });
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
