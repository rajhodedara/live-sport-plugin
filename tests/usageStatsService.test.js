'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const UsageStatsService = require('../src/services/UsageStatsService');

function makeTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-usage-stats-'));
  return { dir, dbPath: path.join(dir, 'usage_stats.sqlite') };
}

describe('UsageStatsService', () => {
  let tempDir;
  let dbPath;
  let service;

  beforeEach(() => {
    ({ dir: tempDir, dbPath } = makeTempDbPath());
    service = new UsageStatsService({
      dbPath,
      salt: 'unit-test-salt',
      flushIntervalMs: 0,
      retentionDays: 35,
    });
  });

  afterEach(() => {
    if (service) service.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('classifyEndpoint matches addon routes and ignores non-addon routes', () => {
    expect(service.classifyEndpoint('/manifest.json')).toBe('manifest');
    expect(service.classifyEndpoint('/abc123/manifest.json')).toBe('manifest');
    expect(service.classifyEndpoint('/catalog/tv/nuvio_sports_live.json')).toBe('catalog');
    expect(service.classifyEndpoint('/cfg/catalog/tv/nuvio_sports_live/skip=0.json')).toBe('catalog');
    expect(service.classifyEndpoint('/stream/tv/match_1.json')).toBe('stream');
    expect(service.classifyEndpoint('/cfg/stream/tv/match_1.json')).toBe('stream');

    expect(service.classifyEndpoint('/')).toBeNull();
    expect(service.classifyEndpoint('/health')).toBeNull();
    expect(service.classifyEndpoint('/status')).toBeNull();
    expect(service.classifyEndpoint('/api/stats')).toBeNull();
    expect(service.classifyEndpoint('/posters/replays/luffy_football.jpg')).toBeNull();
  });

  test('extractClientIp prefers cf-connecting-ip and first x-forwarded-for entry', () => {
    expect(service.extractClientIp({
      headers: {
        'cf-connecting-ip': '203.0.113.10, 10.0.0.1',
        'x-forwarded-for': '198.51.100.2',
      },
      socket: { remoteAddress: '127.0.0.1' },
    })).toBe('203.0.113.10');

    expect(service.extractClientIp({
      headers: {
        'x-forwarded-for': '198.51.100.2, 10.0.0.5',
      },
      socket: { remoteAddress: '127.0.0.1' },
    })).toBe('198.51.100.2');

    expect(service.extractClientIp({
      headers: {},
      ip: '::ffff:192.0.2.44',
      socket: { remoteAddress: '::ffff:192.0.2.44' },
    })).toBe('192.0.2.44');

    expect(service.extractClientIp({ headers: {}, socket: {} })).toBeNull();
  });

  test('hashes IPs (never stores raw IP), ignores non-GET, and deduplicates DAU/WAU/MAU', () => {
    const today = new Date('2026-11-25T12:00:00Z');
    const rawIpA = '203.0.113.77';
    const rawIpB = '198.51.100.88';

    // Non-GET should be ignored
    expect(service.recordRequest({
      method: 'HEAD',
      path: '/manifest.json',
      headers: { 'cf-connecting-ip': rawIpA },
    }, today)).toBe(false);

    // Same user hits manifest twice + stream once today
    expect(service.recordRequest({
      method: 'GET',
      path: '/manifest.json',
      headers: { 'cf-connecting-ip': rawIpA },
    }, today)).toBe(true);
    expect(service.recordRequest({
      method: 'GET',
      path: '/manifest.json',
      headers: { 'cf-connecting-ip': rawIpA },
    }, today)).toBe(true);
    expect(service.recordRequest({
      method: 'GET',
      path: '/stream/tv/m1.json',
      headers: { 'cf-connecting-ip': rawIpA },
    }, today)).toBe(true);

    // Second user hits catalog today
    expect(service.recordRequest({
      method: 'GET',
      path: '/catalog/tv/nuvio_sports_live.json',
      headers: { 'cf-connecting-ip': rawIpB },
    }, today)).toBe(true);

    // Same user A also visited 3 days ago -> should still deduplicate in WAU/MAU
    const threeDaysAgo = new Date('2026-11-22T12:00:00Z');
    expect(service.recordRequest({
      method: 'GET',
      path: '/manifest.json',
      headers: { 'cf-connecting-ip': rawIpA },
    }, threeDaysAgo)).toBe(true);

    service.flush(today);

    // Verify raw IP is never persisted
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare('SELECT visitor_hash FROM daily_visitors').all();
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.visitor_hash).not.toContain('203.0.113');
      expect(row.visitor_hash).not.toContain('198.51.100');
      expect(row.visitor_hash).toMatch(/^[a-f0-9]{24}$/);
    }

    const summary = service.getSummary(today);
    expect(summary.dau).toBe(2);
    expect(summary.wau).toBe(2);
    expect(summary.mau).toBe(2);
    expect(summary.byEndpoint.manifest.dau).toBe(1);
    expect(summary.byEndpoint.manifest.hitsToday).toBe(2);
    expect(summary.byEndpoint.stream.dau).toBe(1);
    expect(summary.byEndpoint.catalog.dau).toBe(1);
  });

  test('prunes records older than retentionDays', () => {
    const today = new Date('2026-11-25T12:00:00Z');
    const oldDay = new Date('2026-10-01T12:00:00Z'); // 55 days old

    service.recordRequest({
      method: 'GET',
      path: '/manifest.json',
      headers: { 'cf-connecting-ip': '203.0.113.5' },
    }, oldDay);

    service.flush(today, { forcePrune: true });

    const summary = service.getSummary(today);
    expect(summary.mau).toBe(0);

    const db = new DatabaseSync(dbPath);
    const count = db.prepare('SELECT COUNT(*) AS c FROM daily_visitors').get().c;
    db.close();
    expect(count).toBe(0);
  });
});
