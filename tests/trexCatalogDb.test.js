'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  openDatabase,
  ensureSchema,
  replaceCatalog,
  writeCatalogFile,
  readMeta
} = require('../src/services/TrexCatalogDb');

const METAS = [
  { id: 'trex:nba-bulls', name: 'NBA TEAM| CHICAGO BULLS', type: 'tv' },
  { id: 'trex:ahl-wolves', name: 'AHL-TEAM| CHICAGO WOLVES [CHI]', type: 'tv' },
  { id: 'trex:nfl-ny', name: 'NFL TEAMS| CBS BILLS GIANTS JETS NEW YORK NY', type: 'tv' },
  { id: 'trex:willow', name: 'CA| WILLOW CRICKET HD', type: 'tv' },
  { id: 'trex:event', name: 'NEXT | CHI - BULLS VS CLE - CAVALIERS | Mon 23 Nov 19:00 EST (US) | 8K EXCLUSIVE | US: NBA PASS PPV 6', type: 'tv' },
  { id: 'trex:placeholder', name: 'NO EVENT STREAMING NOW -| Box Office', type: 'tv' }
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trex-db-'));
}

describe('TrexCatalogDb', () => {
  let dir;
  let dbPath;

  beforeEach(() => {
    dir = tmpDir();
    dbPath = path.join(dir, 'trex_catalog.sqlite');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('replaceCatalog writes every row and counts the kinds and keys', () => {
    const db = openDatabase(dbPath);
    ensureSchema(db);
    const stats = replaceCatalog(db, METAS, { generatedAt: '2026-11-24T00:00:00.000Z', source: 'test' });

    expect(stats).toEqual({ rows: 6, teamChannels: 3, linearChannels: 1, eventChannels: 1, keys: 8 });

    const kinds = Object.fromEntries(
      db.prepare('SELECT kind, COUNT(*) AS n FROM channels GROUP BY kind').all().map((row) => [row.kind, row.n])
    );
    expect(kinds).toEqual({ team: 3, linear: 1, event: 1, placeholder: 1 });

    const keys = db.prepare('SELECT norm_key FROM channel_keys ORDER BY norm_key').all().map((row) => row.norm_key);
    expect(keys).toEqual([
      'bulls chicago',
      'chicago bulls',
      'chicago wolves',
      'new york bills',
      'new york giants',
      'new york jets',
      'willow cricket',
      'wolves chicago'
    ]);
    expect(readMeta(db).generated_at).toBe('2026-11-24T00:00:00.000Z');
    db.close();
  });

  test('a second replaceCatalog replaces the previous catalog completely', () => {
    const db = openDatabase(dbPath);
    ensureSchema(db);
    replaceCatalog(db, METAS, { generatedAt: 'first', source: 'test' });
    replaceCatalog(db, METAS.slice(0, 2), { generatedAt: 'second', source: 'test' });

    expect(db.prepare('SELECT COUNT(*) AS n FROM channels').get().n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM channel_keys').get().n).toBe(4);
    expect(readMeta(db).generated_at).toBe('second');
    db.close();
  });

  test('a failed write leaves the previous catalog in place', () => {
    const db = openDatabase(dbPath);
    ensureSchema(db);
    replaceCatalog(db, METAS, { generatedAt: 'before', source: 'test' });

    expect(() => replaceCatalog(db, [null, { id: 'x' }], { generatedAt: 'after', source: 'test' })).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM channels').get().n).toBe(6);
    expect(readMeta(db).generated_at).toBe('before');
    db.close();
  });

  test('writeCatalogFile creates the file and fails clearly when the directory is missing', () => {
    const stats = writeCatalogFile(dbPath, METAS, { generatedAt: 'file', source: 'csv' });
    expect(stats.rows).toBe(6);

    const missing = path.join(dir, 'no-such-dir', 'catalog.sqlite');
    expect(() => writeCatalogFile(missing, METAS, { generatedAt: 'x', source: 'csv' })).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });
});
