'use strict';

/**
 * Read-only lookup over the Trex catalog database.
 *
 * The store holds no catalog rows in memory: every lookup is one indexed
 * query, and the whole cost for a worker is the open file handle. When the
 * database is missing, unreadable, or corrupt, `isReady()` is false and every
 * lookup returns an empty list, so callers fall back to their previous
 * behavior instead of failing.
 */

const { openDatabase } = require('./TrexCatalogDb');
const { teamQueryKeys, channelKey } = require('./TrexCatalogKeys');
const { fixturePairKeys, matchesFixture } = require('./TrexFixtureMatch');

const RETRY_AFTER_MS = 60 * 1000;

/** Market words a broadcaster label often carries after its name (`NBA TV USA`, `Sport 5 Israel`). */
const MARKET_SUFFIXES = new Set([
  'usa', 'us', 'uk', 'gb', 'ie', 'ca', 'canada', 'israel', 'au', 'australia', 'nz',
  'de', 'germany', 'fr', 'france', 'es', 'spain', 'it', 'italy', 'tr', 'turkey',
  'pl', 'poland', 'br', 'brazil', 'mx', 'mexico', 'ar', 'argentina'
]);

function errorKind(error) {
  return String((error && (error.code || error.name)) || 'Error').replace(/[^a-z0-9_.-]/gi, '').slice(0, 80);
}

function countryMatches(group, context) {
  if (!context) return false;
  const text = String(group || '').toUpperCase();
  if (!text) return false;
  const code = String(context.countryCode || '').toUpperCase();
  if (code && (text === code || text.startsWith(`${code} `) || text.startsWith(code))) return true;
  const name = String(context.country || '').toUpperCase();
  return Boolean(name) && text === name;
}

class TrexCatalogStore {
  constructor({ dbPath = process.env.KAFKA_CATALOG_DB } = {}) {
    this.dbPath = dbPath || '';
    this.db = null;
    this._ready = false;
    this._nextRetryAt = 0;
  }

  /** Opens the database on first use and after a transient failure (once a minute). */
  isReady() {
    if (this._ready) return true;
    if (!this.dbPath) return false;
    if (Date.now() < this._nextRetryAt) return false;
    try {
      this.db = openDatabase(this.dbPath, { readOnly: true });
      // A corrupt file opens lazily and only fails on the first statement.
      this.db.prepare('SELECT 1 AS ok FROM channels LIMIT 1').get();
      this._ready = true;
      return true;
    } catch (error) {
      try {
        if (this.db) this.db.close();
      } catch (_) {
        /* ignore */
      }
      this.db = null;
      this._nextRetryAt = Date.now() + RETRY_AFTER_MS;
      console.warn(`[TrexCatalogStore] not ready: ${errorKind(error)}`);
      return false;
    }
  }

  _query(normKey, context, { kind = '' } = {}) {
    if (!normKey || !this.isReady()) return [];
    let rows;
    try {
      const kindSql = kind ? ' AND c.kind = ?' : '';
      const params = kind ? [normKey, kind] : [normKey];
      rows = this.db
        .prepare(
          `SELECT c.id AS id, c.name AS name, c.grp AS grp, c.league AS league, k.score AS score
             FROM channel_keys k
             JOIN channels c ON c.id = k.channel_id
            WHERE k.norm_key = ?${kindSql}
            ORDER BY k.score DESC`
        )
        .all(...params);
    } catch (error) {
      console.warn(`[TrexCatalogStore] query failed: ${errorKind(error)}`);
      return [];
    }
    const ranked = rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        group: row.grp || '',
        league: row.league || null,
        score: Number(row.score) || 0
      }))
      .sort((a, b) => Number(countryMatches(b.group, context)) - Number(countryMatches(a.group, context)) || b.score - a.score);
    return ranked.slice(0, 2);
  }

  /** Fixture team name -> team channel candidates (best first, at most two). */
  findTeam(teamName) {
    if (!this.isReady()) return [];
    for (const key of teamQueryKeys(teamName)) {
      const hits = this._query(key, {}, { kind: 'team' });
      if (hits.length) return hits;
    }
    return [];
  }

  /** Broadcaster label -> linear channel candidates, preferring the fixture's country. */
  findChannel(label, context = {}) {
    const key = channelKey(label);
    if (!key) return [];
    const hits = this._query(key, context || {});
    if (hits.length) return hits;
    // A label such as `NBA TV USA` names the same channel as `NBA TV`; drop one
    // trailing market word and retry. Anything else keeps the exact-match rule.
    const tokens = key.split(' ');
    if (tokens.length < 3 || !MARKET_SUFFIXES.has(tokens[tokens.length - 1])) return hits;
    return this._query(tokens.slice(0, -1).join(' '), context || {});
  }

  stats() {
    if (!this.isReady()) return { rows: 0, teams: 0, channels: 0, generatedAt: null };
    try {
      const count = (kind) =>
        kind
          ? this.db.prepare('SELECT COUNT(*) AS n FROM channels WHERE kind = ?').get(kind).n
          : this.db.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
      const generated = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('generated_at');
      return {
        rows: count(null),
        teams: count('team'),
        channels: count('linear'),
        generatedAt: generated ? generated.value : null
      };
    } catch (error) {
      console.warn(`[TrexCatalogStore] stats failed: ${errorKind(error)}`);
      return { rows: 0, teams: 0, channels: 0, generatedAt: null };
    }
  }

  /** Indexed opponent-pair lookup. The legacy catalog still supports its
   * regular broadcaster/team lookups until a v2 refresh commits. */
  findEvents(match) {
    const keys = [...fixturePairKeys(match)];
    if (!keys.length || !this.isReady()) return [];
    try {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_pairs'").get()) return [];
      const params = keys.map(() => '?').join(',');
      return this.db.prepare(`
        SELECT c.id, c.name, c.grp AS "group", e.score
          FROM event_pairs e JOIN channels c ON c.id = e.channel_id
         WHERE e.pair_key IN (${params})
         ORDER BY e.score DESC, e.channel_id
      `).all(...keys).filter(row => matchesFixture(row.name, match));
    } catch (error) {
      console.warn(`[TrexCatalogStore] event lookup failed: ${errorKind(error)}`);
      return [];
    }
  }

  close() {
    try {
      if (this.db) this.db.close();
    } catch (_) {
      /* ignore */
    }
    this.db = null;
    this._ready = false;
  }
}

module.exports = { TrexCatalogStore };
