'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  openDatabase,
  ensureSchema,
  replaceCatalog,
  writeCatalogFile,
  readMeta,
  reindexEventPairs
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

  test('indexes non-sports 24/7 channels (kind: other) into channel_keys', () => {
    const db = openDatabase(dbPath);
    ensureSchema(db);
    const nonSportsMetas = [
      { id: 'trex:cn', name: 'IT| CARTOON NETWORK 4K', type: 'tv' },
      { id: 'trex:cnn', name: 'UK| CNN FHD', type: 'tv' }
    ];
    replaceCatalog(db, nonSportsMetas, { generatedAt: '2026-11-24', source: 'test' });

    const keys = db.prepare('SELECT norm_key, channel_id FROM channel_keys ORDER BY norm_key').all();
    expect(keys).toEqual([
      { norm_key: 'cartoon network', channel_id: 'trex:cn' },
      { norm_key: 'cnn', channel_id: 'trex:cnn' }
    ]);
    db.close();
  });

  test('reindexEventPairs rebuilds malformed event_pairs while preserving channels, channel_keys, channel_health, and meta', () => {
    const db = openDatabase(dbPath);
    try {
      ensureSchema(db);
      const seedMetas = [
        { id: '1949763', name: 'US (ESPN+ 149) | Utah Mammoth vs. Minnesota Wild Nov 25 7:30PM ET (2026-11-25 19:30:00)', type: 'tv' },
        { id: '836296', name: 'NFL  | 01 - WED 8pm Packers at Rams', type: 'tv' },
        { id: 'trex:willow', name: 'CA| WILLOW CRICKET HD', type: 'tv' },
        { id: 'trex:nba-bulls', name: 'NBA TEAM| CHICAGO BULLS', type: 'tv' }
      ];
      replaceCatalog(db, seedMetas, { generatedAt: '2026-11-25T10:00:00.000Z', source: 'live' });

      // Inject legacy malformed keys and a channel_health record to simulate pre-fix on-disk catalog.
      db.exec('DELETE FROM event_pairs');
      db.prepare('INSERT INTO event_pairs (pair_key, channel_id, score) VALUES (?, ?, ?)')
        .run('minnesota wild nov 25 7 30pm et|utah mammoth', '1949763', 12000);
      db.prepare('INSERT INTO event_pairs (pair_key, channel_id, score) VALUES (?, ?, ?)')
        .run('rams|wed 8pm packers', '836296', 11000);
      db.prepare('INSERT INTO channel_health (channel_id, status, checked_at, frozen) VALUES (?, ?, ?, ?)')
        .run('trex:willow', 'ok', '2026-11-25T12:00:00.000Z', 0);

      const channelsBefore = db.prepare('SELECT * FROM channels ORDER BY id').all();
      const channelKeysBefore = db.prepare('SELECT * FROM channel_keys ORDER BY norm_key, channel_id').all();
      const healthBefore = db.prepare('SELECT * FROM channel_health ORDER BY channel_id').all();
      const metaBefore = readMeta(db);

      const result = reindexEventPairs(db);
      expect(result).toEqual({ rowsScanned: 4, eventPairs: 2 });

      const keysAfter = db.prepare('SELECT pair_key FROM event_pairs ORDER BY pair_key').all().map((r) => r.pair_key);
      expect(keysAfter).toContain('minnesota wild|utah mammoth');
      expect(keysAfter).toContain('packers|rams');
      expect(keysAfter).not.toContain('minnesota wild nov 25 7 30pm et|utah mammoth');
      expect(keysAfter).not.toContain('rams|wed 8pm packers');

      expect(db.prepare('SELECT * FROM channels ORDER BY id').all()).toEqual(channelsBefore);
      expect(db.prepare('SELECT * FROM channel_keys ORDER BY norm_key, channel_id').all()).toEqual(channelKeysBefore);
      expect(db.prepare('SELECT * FROM channel_health ORDER BY channel_id').all()).toEqual(healthBefore);
      expect(readMeta(db)).toEqual(metaBefore);
    } finally {
      db.close();
    }
  });

  test('reindexEventPairs rolls back and preserves old event_pairs on insert failure', () => {
    const db = openDatabase(dbPath);
    try {
      ensureSchema(db);
      replaceCatalog(db, [
        { id: '1949763', name: 'US (ESPN+ 149) | Utah Mammoth vs. Minnesota Wild Nov 25 7:30PM ET (2026-11-25 19:30:00)', type: 'tv' },
        { id: 'fail-row', name: 'Live | Celtics vs. Wizards', type: 'tv' }
      ], { generatedAt: '2026-11-25T10:00:00.000Z', source: 'live' });

      db.exec('DELETE FROM event_pairs');
      db.prepare('INSERT INTO event_pairs (pair_key, channel_id, score) VALUES (?, ?, ?)')
        .run('old-malformed|utah mammoth', '1949763', 999);
      db.exec(`
        CREATE TEMP TRIGGER fail_event_insert
        BEFORE INSERT ON event_pairs
        WHEN NEW.channel_id = 'fail-row'
        BEGIN
          SELECT RAISE(ABORT, 'simulated insert failure');
        END;
      `);

      expect(() => reindexEventPairs(db)).toThrow(/simulated insert failure/);

      const surviving = db.prepare('SELECT pair_key, channel_id, score FROM event_pairs').all();
      expect(surviving).toEqual([{ pair_key: 'old-malformed|utah mammoth', channel_id: '1949763', score: 999 }]);
    } finally {
      db.close();
    }
  });
});
