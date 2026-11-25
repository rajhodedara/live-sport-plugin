'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ENDPOINTS = ['manifest', 'catalog', 'stream'];
const DEFAULT_FLUSH_INTERVAL_MS = 10000;
const DEFAULT_RETENTION_DAYS = 35;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_PENDING_VISITORS = 50000;

function resolveDefaultDbPath() {
  if (process.env.JEST_WORKER_ID) {
    return path.join(os.tmpdir(), `nuvio-usage-stats-${process.pid}.sqlite`);
  }
  if (process.env.USAGE_STATS_DB && process.env.USAGE_STATS_DB.trim()) {
    return path.resolve(process.env.USAGE_STATS_DB.trim());
  }
  return path.join(process.cwd(), 'data', 'usage_stats.sqlite');
}

function formatUtcDay(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return d.toISOString().slice(0, 10);
}

function shiftUtcDay(date, deltaDays) {
  const base = date instanceof Date ? date : new Date(date || Date.now());
  const shifted = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

function firstIpFromHeader(value) {
  if (value === undefined || value === null) return null;
  const raw = Array.isArray(value) ? value[0] : String(value);
  const first = raw.split(',')[0].trim();
  if (!first) return null;
  return first.startsWith('::ffff:') ? first.slice(7) : first;
}

class UsageStatsService {
  /**
   * Privacy-preserving DAU / WAU / MAU tracker backed by a shared WAL SQLite file.
   */
  constructor(options = {}) {
    this.dbPath = options.dbPath || resolveDefaultDbPath();
    this.retentionDays = Number.isInteger(options.retentionDays) && options.retentionDays > 0
      ? options.retentionDays
      : DEFAULT_RETENTION_DAYS;
    this.flushIntervalMs = Number.isInteger(options.flushIntervalMs) && options.flushIntervalMs >= 0
      ? options.flushIntervalMs
      : DEFAULT_FLUSH_INTERVAL_MS;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.salt = this._resolveSalt(options.salt);

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS daily_visitors (
        day TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        visitor_hash TEXT NOT NULL,
        PRIMARY KEY (day, endpoint, visitor_hash)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS daily_hits (
        day TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, endpoint)
      ) WITHOUT ROWID;
    `);

    this._insertVisitorStmt = this.db.prepare(
      'INSERT OR IGNORE INTO daily_visitors (day, endpoint, visitor_hash) VALUES (?, ?, ?)'
    );
    this._upsertHitStmt = this.db.prepare(
      'INSERT INTO daily_hits (day, endpoint, hits) VALUES (?, ?, ?) ON CONFLICT(day, endpoint) DO UPDATE SET hits = hits + excluded.hits'
    );

    this._pendingVisitors = new Set();
    this._pendingHits = new Map();
    this._lastPrunedAt = 0;
    this._closed = false;

    if (this.flushIntervalMs > 0) {
      this._flushTimer = setInterval(() => {
        try {
          this.flush();
        } catch (_) {}
      }, this.flushIntervalMs);
      if (this._flushTimer.unref) this._flushTimer.unref();
    }
  }

  _resolveSalt(explicitSalt) {
    if (explicitSalt && String(explicitSalt).trim()) return String(explicitSalt).trim();
    if (process.env.STATS_SALT && process.env.STATS_SALT.trim()) {
      return process.env.STATS_SALT.trim();
    }
    const saltFile = `${this.dbPath}.salt`;
    try {
      const existing = fs.readFileSync(saltFile, 'utf8').trim();
      if (existing) return existing;
    } catch (_) {}
    const generated = crypto.randomBytes(24).toString('hex');
    try {
      fs.writeFileSync(saltFile, generated, { mode: 0o600, flag: 'wx' });
      return generated;
    } catch (_) {
      try {
        const raced = fs.readFileSync(saltFile, 'utf8').trim();
        if (raced) return raced;
      } catch (_) {}
      return generated;
    }
  }

  /**
   * Classify a request path into 'manifest', 'catalog', 'stream', or null.
   */
  classifyEndpoint(reqPath) {
    if (!reqPath || typeof reqPath !== 'string') return null;
    const cleanPath = reqPath.split('?')[0];
    if (cleanPath === '/manifest.json' || /^\/[^/]+\/manifest\.json$/.test(cleanPath)) {
      return 'manifest';
    }
    if (cleanPath.startsWith('/catalog/') || /^\/[^/]+\/catalog\//.test(cleanPath)) {
      return 'catalog';
    }
    if (cleanPath.startsWith('/stream/') || /^\/[^/]+\/stream\//.test(cleanPath)) {
      return 'stream';
    }
    return null;
  }

  /**
   * Extract normalized client IP from Cloudflare / proxy headers or socket.
   */
  extractClientIp(req) {
    if (!req) return null;
    const headers = req.headers || {};
    return (
      firstIpFromHeader(headers['cf-connecting-ip']) ||
      firstIpFromHeader(headers['x-forwarded-for']) ||
      firstIpFromHeader(headers['x-real-ip']) ||
      firstIpFromHeader(req.ip) ||
      firstIpFromHeader(req.socket && req.socket.remoteAddress) ||
      null
    );
  }

  _hashIp(ip) {
    return crypto
      .createHash('sha256')
      .update(`${this.salt}:${ip}`)
      .digest('hex')
      .slice(0, 24);
  }

  /**
   * Record a request in memory (O(1), non-blocking). Returns true if counted.
   */
  recordRequest(req, nowDate = new Date()) {
    if (this._closed || !req) return false;
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET') return false;

    const endpoint = this.classifyEndpoint(req.path || req.url);
    if (!endpoint) return false;

    const ip = this.extractClientIp(req);
    if (!ip) return false;

    const day = formatUtcDay(nowDate);
    const visitorHash = this._hashIp(ip);

    if (this._pendingVisitors.size < MAX_PENDING_VISITORS) {
      this._pendingVisitors.add(`${day}\0${endpoint}\0${visitorHash}`);
    }
    const hitKey = `${day}\0${endpoint}`;
    this._pendingHits.set(hitKey, (this._pendingHits.get(hitKey) || 0) + 1);
    return true;
  }

  /**
   * Flush buffered visitors and hit counts to SQLite.
   */
  flush(nowDate = new Date(), options = {}) {
    if (this._closed) return 0;
    const visitors = Array.from(this._pendingVisitors);
    const hits = Array.from(this._pendingHits.entries());
    this._pendingVisitors.clear();
    this._pendingHits.clear();

    const shouldPrune = Boolean(options.forcePrune) ||
      (Date.now() - this._lastPrunedAt >= PRUNE_INTERVAL_MS);

    if (visitors.length === 0 && hits.length === 0 && !shouldPrune) {
      return 0;
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (let i = 0; i < visitors.length; i++) {
        const [day, endpoint, hash] = visitors[i].split('\0');
        this._insertVisitorStmt.run(day, endpoint, hash);
      }
      for (let i = 0; i < hits.length; i++) {
        const [key, count] = hits[i];
        const [day, endpoint] = key.split('\0');
        this._upsertHitStmt.run(day, endpoint, count);
      }
      if (shouldPrune) {
        const cutoffDay = shiftUtcDay(nowDate, -this.retentionDays);
        this.db.prepare('DELETE FROM daily_visitors WHERE day < ?').run(cutoffDay);
        this.db.prepare('DELETE FROM daily_hits WHERE day < ?').run(cutoffDay);
        this._lastPrunedAt = Date.now();
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw err;
    }

    return visitors.length;
  }

  /**
   * Return deduplicated DAU / WAU / MAU and per-endpoint breakdowns.
   */
  getSummary(nowDate = new Date(), daysLimit = 14) {
    this.flush(nowDate);

    const today = formatUtcDay(nowDate);
    const d7 = shiftUtcDay(nowDate, -6);
    const d30 = shiftUtcDay(nowDate, -29);

    const countWindow = (sinceDay) => this.db.prepare(
      'SELECT COUNT(DISTINCT visitor_hash) AS c FROM daily_visitors WHERE day >= ? AND day <= ?'
    ).get(sinceDay, today).c;

    const dau = countWindow(today);
    const wau = countWindow(d7);
    const mau = countWindow(d30);
    const stickiness = mau > 0 ? Number((dau / mau).toFixed(3)) : 0;

    const byEndpoint = {};
    const epVisitorStmt = this.db.prepare(
      'SELECT COUNT(DISTINCT visitor_hash) AS c FROM daily_visitors WHERE endpoint = ? AND day >= ? AND day <= ?'
    );
    const epHitsStmt = this.db.prepare(
      'SELECT COALESCE(SUM(hits), 0) AS h FROM daily_hits WHERE endpoint = ? AND day >= ? AND day <= ?'
    );

    for (const ep of ENDPOINTS) {
      byEndpoint[ep] = {
        dau: epVisitorStmt.get(ep, today, today).c,
        wau: epVisitorStmt.get(ep, d7, today).c,
        mau: epVisitorStmt.get(ep, d30, today).c,
        hitsToday: epHitsStmt.get(ep, today, today).h,
        hits7d: epHitsStmt.get(ep, d7, today).h,
        hits30d: epHitsStmt.get(ep, d30, today).h,
      };
    }

    const safeDays = Math.max(1, Math.min(35, Number(daysLimit) || 14));
    const sinceDaily = shiftUtcDay(nowDate, -(safeDays - 1));
    const dailyRows = this.db.prepare(`
      SELECT
        v.day AS day,
        COUNT(DISTINCT v.visitor_hash) AS uniques,
        COALESCE(h.total_hits, 0) AS hits
      FROM daily_visitors v
      LEFT JOIN (
        SELECT day, SUM(hits) AS total_hits
        FROM daily_hits
        WHERE day >= ? AND day <= ?
        GROUP BY day
      ) h ON h.day = v.day
      WHERE v.day >= ? AND v.day <= ?
      GROUP BY v.day
      ORDER BY v.day DESC
    `).all(sinceDaily, today, sinceDaily, today);

    return {
      dau,
      wau,
      mau,
      stickiness,
      byEndpoint,
      daily: dailyRows,
      updatedAt: new Date(nowDate).toISOString(),
    };
  }

  close() {
    if (this._closed) return;
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    try {
      this.flush();
    } catch (_) {}
    this._closed = true;
    try {
      this.db.close();
    } catch (_) {}
  }
}

module.exports = UsageStatsService;
