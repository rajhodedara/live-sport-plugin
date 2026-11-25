'use strict';

/**
 * SQLite storage for the Trex generic catalog.
 *
 * One file holds every catalog channel (about 54k rows), the keys a fixture
 * team or a broadcaster label can be found under, and a reserved table for
 * per-channel health. The nightly refresh job writes it in one transaction;
 * the workers open it read-only (see `TrexCatalogStore`).
 *
 * Writer-side only: this module never fetches anything and never logs URLs.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  classifyChannelKind,
  channelKey,
  channelAliasKey,
  teamChannelKeys,
  entryScore
} = require('./TrexCatalogKeys');

const { parsePair, pairKey, eventScore } = require('./TrexFixtureMatch');
const SCHEMA_VERSION = '2';

/** Leading `GROUP|` token of a catalog name, or '' when the name has none. */
function groupOf(name) {
  const bar = String(name || '').indexOf('|');
  if (bar <= 0) return '';
  const head = String(name).slice(0, bar).trim();
  return head.length <= 28 ? head : '';
}

/**
 * Opens the catalog database. The writer sets WAL and a busy timeout so
 * workers keep reading the previous catalog while a refresh transaction is
 * open. A missing parent directory fails with a clear message instead of
 * SQLite's bare CANTOPEN.
 */
function openDatabase(dbPath, { readOnly = false } = {}) {
  if (!readOnly) {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      throw new Error(`Trex catalog directory does not exist: ${dir}`);
    }
  }
  const db = new DatabaseSync(dbPath, { readOnly });
  if (!readOnly) {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
  }
  db.exec('PRAGMA busy_timeout=5000');
  return db;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      grp TEXT,
      kind TEXT NOT NULL,
      league TEXT,
      tier TEXT
    );
    CREATE TABLE IF NOT EXISTS channel_keys (
      norm_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      PRIMARY KEY (norm_key, channel_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_keys_norm ON channel_keys(norm_key);
    CREATE TABLE IF NOT EXISTS event_pairs (
      pair_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      PRIMARY KEY (pair_key, channel_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS channel_health (
      channel_id TEXT PRIMARY KEY,
      status TEXT,
      checked_at TEXT,
      frozen INTEGER
    );
  `);
}

/**
 * Replaces the whole catalog in one transaction.
 *
 * metas: [{ id, name, type }]
 * Returns { rows, teamChannels, linearChannels, eventChannels, keys }.
 *
 * Keys exist for team and linear rows only. Event and placeholder rows are
 * stored (the catalog is kept whole for future use) but cannot be matched by
 * name. Alias keys (a channel name without its trailing qualifier) only fill
 * gaps: an exact key always wins.
 */
function replaceCatalog(db, metas, { generatedAt, source } = {}) {
  if (!Array.isArray(metas)) throw new Error('Trex catalog metas must be an array');

  const counts = { rows: 0, teamChannels: 0, linearChannels: 0, eventChannels: 0, keys: 0 };
  const aliases = [];
  const insertChannel = db.prepare(
    'INSERT OR REPLACE INTO channels (id, name, grp, kind, league, tier) VALUES (?, ?, ?, ?, ?, NULL)'
  );
  const insertKey = db.prepare(
    'INSERT OR IGNORE INTO channel_keys (norm_key, channel_id, score) VALUES (?, ?, ?)'
  );
  const keyExists = db.prepare('SELECT 1 AS present FROM channel_keys WHERE norm_key = ? LIMIT 1');
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const insertEvent = db.prepare('INSERT INTO event_pairs (pair_key, channel_id, score) VALUES (?, ?, ?)');

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM channel_keys');
    db.exec('DELETE FROM event_pairs');
    db.exec('DELETE FROM channels');

    const seen = new Set();
    for (const meta of metas) {
      if (!meta || !meta.id || !meta.name) throw new Error('invalid catalog meta');
      const id = String(meta.id).trim();
      const name = String(meta.name).trim();
      if (!id || !name) throw new Error('invalid catalog meta');
      if (seen.has(id)) continue;
      seen.add(id);

      const kind = classifyChannelKind(name);
      const group = groupOf(name);
      const score = entryScore(name, group);
      let league = null;
      const keys = [];

      if (kind === 'team') {
        const team = teamChannelKeys(name);
        if (team) {
          league = team.league;
          keys.push(...team.keys);
        }
        counts.teamChannels += 1;
      } else if (kind === 'linear' || kind === 'other') {
        const exact = channelKey(name);
        if (exact) keys.push(exact);
        const alias = channelAliasKey(name);
        if (alias) aliases.push({ key: alias, id, score });
        if (kind === 'linear') counts.linearChannels += 1;
      } else if (kind === 'event') {
        counts.eventChannels += 1;
      }

      insertChannel.run(id, name, group, kind, league);
      const pair = parsePair(name);
      if (pair) insertEvent.run(pairKey(pair.a, pair.b), id, eventScore(name, group));
      for (const key of new Set(keys)) {
        insertKey.run(key, id, score);
        counts.keys += 1;
      }
      counts.rows += 1;
    }

    for (const alias of aliases) {
      if (keyExists.get(alias.key)) continue;
      insertKey.run(alias.key, alias.id, alias.score);
      counts.keys += 1;
    }

    setMeta.run('schema_version', SCHEMA_VERSION);
    setMeta.run('generated_at', String(generatedAt || new Date().toISOString()));
    setMeta.run('source', String(source || 'unknown'));
    setMeta.run('row_count', String(counts.rows));
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      /* the transaction may already be gone */
    }
    throw err;
  }
  return counts;
}

/** Opens (creating when needed), writes the whole catalog, closes. */
function writeCatalogFile(dbPath, metas, opts = {}) {
  const db = openDatabase(dbPath);
  try {
    ensureSchema(db);
    return replaceCatalog(db, metas, opts);
  } finally {
    try {
      db.close();
    } catch (_) {
      /* ignore a close error after a failed write */
    }
  }
}

function readMeta(db) {
  const rows = db.prepare('SELECT key, value FROM meta').all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

module.exports = {
  SCHEMA_VERSION,
  openDatabase,
  ensureSchema,
  replaceCatalog,
  writeCatalogFile,
  readMeta,
  groupOf
};
