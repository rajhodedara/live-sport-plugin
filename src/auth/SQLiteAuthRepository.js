'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const AuthRepository = require('./AuthRepository');

class SQLiteAuthRepository extends AuthRepository {
  constructor({ filename }) {
    super();
    const resolved = path.resolve(filename);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this._migrate();
    this._prepare();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const current = this.db.prepare('SELECT MAX(version) AS version FROM auth_schema_migrations').get().version || 0;
    if (current < 1) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            failed_login_count INTEGER NOT NULL DEFAULT 0,
            locked_until INTEGER,
            disabled_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS browser_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_browser_sessions_user ON browser_sessions(user_id);
          CREATE INDEX IF NOT EXISTS idx_browser_sessions_expiry ON browser_sessions(expires_at);
          CREATE TABLE IF NOT EXISTS device_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_hash TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            expires_at INTEGER,
            revoked_at INTEGER,
            last_used_at INTEGER,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
          CREATE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_hash);
        `);
        this.db.prepare('INSERT OR IGNORE INTO auth_schema_migrations (version, applied_at) VALUES (?, ?)').run(1, Date.now());
      })();
    }
  }

  _prepare() {
    this.statements = {
      createUser: this.db.prepare(`
        INSERT INTO users (email, password_hash, password_salt, created_at, updated_at)
        VALUES (@email, @passwordHash, @passwordSalt, @now, @now)
      `),
      findUserByEmail: this.db.prepare('SELECT * FROM users WHERE email = ?'),
      findUserById: this.db.prepare('SELECT * FROM users WHERE id = ?'),
      loginFailure: this.db.prepare(`
        UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?
      `),
      resetLogin: this.db.prepare(`
        UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?
      `),
      createSession: this.db.prepare(`
        INSERT INTO browser_sessions (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `),
      findSession: this.db.prepare(`
        SELECT s.id AS session_id, s.expires_at AS session_expires_at,
               u.id, u.email, u.disabled_at, u.created_at
        FROM browser_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
      `),
      findSessionById: this.db.prepare(`
        SELECT s.id AS session_id, s.expires_at AS session_expires_at,
               u.id, u.email, u.disabled_at, u.created_at
        FROM browser_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?
      `),
      deleteSession: this.db.prepare('DELETE FROM browser_sessions WHERE token_hash = ?'),
      deleteExpiredSessions: this.db.prepare('DELETE FROM browser_sessions WHERE expires_at <= ?'),
      createDevice: this.db.prepare(`
        INSERT INTO device_tokens (token_hash, user_id, name, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      listDevices: this.db.prepare(`
        SELECT id, name, expires_at, revoked_at, last_used_at, created_at
        FROM device_tokens WHERE user_id = ? ORDER BY created_at DESC
      `),
      getDeviceById: this.db.prepare(`
        SELECT id, name, expires_at, revoked_at, last_used_at, created_at
        FROM device_tokens WHERE id = ?
      `),
      findDevice: this.db.prepare(`
        SELECT d.id AS device_id, d.name AS device_name, d.expires_at AS device_expires_at,
               d.revoked_at, d.last_used_at, d.created_at AS device_created_at,
               u.id AS user_id, u.email, u.disabled_at
        FROM device_tokens d JOIN users u ON u.id = d.user_id
        WHERE d.token_hash = ?
      `),
      findDeviceById: this.db.prepare(`
        SELECT d.id AS device_id, d.name AS device_name, d.expires_at AS device_expires_at,
               d.revoked_at, d.last_used_at, d.created_at AS device_created_at,
               u.id AS user_id, u.email, u.disabled_at
        FROM device_tokens d JOIN users u ON u.id = d.user_id
        WHERE d.id = ?
      `),
      touchDevice: this.db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ?'),
      revokeDevice: this.db.prepare(`
        UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL
      `),
      deleteDevice: this.db.prepare('DELETE FROM device_tokens WHERE id = ? AND user_id = ?'),
    };
  }

  createUser({ email, passwordHash, passwordSalt, now = Date.now() }) {
    const result = this.statements.createUser.run({ email, passwordHash, passwordSalt, now });
    return this.findUserById(result.lastInsertRowid);
  }

  findUserByEmail(email) { return this.statements.findUserByEmail.get(email) || null; }
  findUserById(id) { return this.statements.findUserById.get(id) || null; }

  recordLoginFailure(id, count, lockedUntil, now = Date.now()) {
    this.statements.loginFailure.run(count, lockedUntil || null, now, id);
  }

  resetLoginFailures(id, now = Date.now()) {
    this.statements.resetLogin.run(now, id);
  }

  createSession({ tokenHash, userId, expiresAt, now = Date.now() }) {
    this.statements.deleteExpiredSessions.run(now);
    this.statements.createSession.run(tokenHash, userId, expiresAt, now);
  }

  findSessionByTokenHash(tokenHash) { return this.statements.findSession.get(tokenHash) || null; }
  findSessionById(id) { return this.statements.findSessionById.get(id) || null; }
  deleteSessionByTokenHash(tokenHash) { return this.statements.deleteSession.run(tokenHash).changes > 0; }

  createDeviceToken({ tokenHash, userId, name, expiresAt, now = Date.now() }) {
    const result = this.statements.createDevice.run(tokenHash, userId, name, expiresAt || null, now);
    return this.statements.getDeviceById.get(result.lastInsertRowid);
  }

  listDeviceTokens(userId) { return this.statements.listDevices.all(userId); }
  findDeviceByTokenHash(tokenHash) { return this.statements.findDevice.get(tokenHash) || null; }
  findDeviceById(id) { return this.statements.findDeviceById.get(id) || null; }
  touchDeviceToken(id, now = Date.now()) { this.statements.touchDevice.run(now, id); }
  revokeDeviceToken(userId, id, now = Date.now()) {
    return this.statements.revokeDevice.run(now, id, userId).changes > 0;
  }
  deleteDeviceToken(userId, id) {
    return this.statements.deleteDevice.run(id, userId).changes > 0;
  }

  close() { if (this.db && this.db.open) this.db.close(); }
}

module.exports = SQLiteAuthRepository;
