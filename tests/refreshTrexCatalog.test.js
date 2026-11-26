'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { fetchCatalogRows, run } = require('../scripts/refresh_trex_catalog');
const { openDatabase, readMeta, writeCatalogFile } = require('../src/services/TrexCatalogDb');

const BASE = 'https://upstream.invalid/u/secret';

function page(count, prefix) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      metas: Array.from({ length: count }, (_, index) => ({
        id: `trex:${prefix}-${index}`,
        name: `NBA TEAM| TEAM ${prefix} ${index}`,
        type: 'tv'
      }))
    })
  };
}

describe('refresh_trex_catalog', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-refresh-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('pages with skip in batches and stops at the first short page', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes('skip=0.json')) return page(100, 'a');
      if (String(url).includes('skip=100.json')) return page(100, 'b');
      if (String(url).includes('skip=200.json')) return page(40, 'c');
      throw new Error(`unexpected ${url}`);
    };

    const result = await fetchCatalogRows({ baseUrl: BASE, fetchImpl, concurrency: 1 });
    expect(result.pages).toBe(3);
    expect(result.metas).toHaveLength(240);
    expect(result.truncated).toBe(false);
    expect(calls.some((url) => url.includes('skip=300.json'))).toBe(false);
    expect(calls.every((url) => url.includes('/catalog/tv/flix-live-tv-v2-trex/skip='))).toBe(true);
  });

  test('reports truncation when maxPages is reached before a short page', async () => {
    const fetchImpl = async () => page(100, 'x');
    const result = await fetchCatalogRows({ baseUrl: BASE, fetchImpl, concurrency: 2, maxPages: 3 });
    expect(result.truncated).toBe(true);
    expect(result.pages).toBe(3);
  });

  test('rejects with the HTTP status and never the catalog URL', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('skip=100.json')) return { ok: false, status: 502, json: async () => ({}) };
      return page(100, 'a');
    };

    await expect(fetchCatalogRows({ baseUrl: BASE, fetchImpl, concurrency: 1 })).rejects.toThrow(/HTTP 502/);
    await expect(fetchCatalogRows({ baseUrl: BASE, fetchImpl, concurrency: 1 })).rejects.not.toThrow(/upstream\.invalid/);
  });

  test('builds the database from a CSV and leaves it untouched when a live run fails', async () => {
    const csv = path.join(dir, 'channels.csv');
    fs.writeFileSync(
      csv,
      'id,name,prefix,type,description\n"trex:1","NBA TEAM| CHICAGO BULLS","","tv","x"\n"trex:2","CA| WILLOW CRICKET HD","CA","tv","x"\n"trex:3","NO EVENT STREAMING NOW -| Box Office","","tv","x"\n'
    );
    const dbPath = path.join(dir, 'catalog.sqlite');

    expect(await run(['--db', dbPath, '--from-csv', csv, '--quiet'])).toBe(0);
    let db = openDatabase(dbPath, { readOnly: true });
    expect(readMeta(db).source).toBe('csv');
    expect(readMeta(db).row_count).toBe('3');
    const before = readMeta(db).generated_at;
    db.close();

    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    expect(await run(['--db', dbPath, '--base-url', BASE, '--quiet'], { fetchImpl })).toBe(1);

    db = openDatabase(dbPath, { readOnly: true });
    expect(readMeta(db).generated_at).toBe(before);
    expect(readMeta(db).row_count).toBe('3');
    db.close();
  });

  test('--reindex-events rebuilds event_pairs on disk without upstream fetches and preserves non-event data', async () => {
    const dbPath = path.join(dir, 'existing.sqlite');
    writeCatalogFile(dbPath, [
      { id: '1949763', name: 'US (ESPN+ 149) | Utah Mammoth vs. Minnesota Wild Nov 25 7:30PM ET (2026-11-25 19:30:00)', type: 'tv' },
      { id: 'trex:willow', name: 'CA| WILLOW CRICKET HD', type: 'tv' }
    ], { generatedAt: '2026-11-25T10:00:00.000Z', source: 'live' });

    const setupDb = openDatabase(dbPath);
    setupDb.exec('DELETE FROM event_pairs');
    setupDb.prepare('INSERT INTO event_pairs (pair_key, channel_id, score) VALUES (?, ?, ?)')
      .run('minnesota wild nov 25 7 30pm et|utah mammoth', '1949763', 50);
    setupDb.prepare('INSERT INTO channel_health (channel_id, status, checked_at, frozen) VALUES (?, ?, ?, ?)')
      .run('trex:willow', 'ok', '2026-11-25T11:00:00.000Z', 0);
    setupDb.close();

    const fetchImpl = jest.fn(() => { throw new Error('unexpected upstream fetch'); });
    expect(await run(['--reindex-events', '--db', dbPath, '--quiet'], { fetchImpl })).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    const checkDb = openDatabase(dbPath, { readOnly: true });
    expect(checkDb.prepare('SELECT pair_key FROM event_pairs').all().map(r => r.pair_key)).toEqual(['minnesota wild|utah mammoth']);
    expect(checkDb.prepare('SELECT status FROM channel_health WHERE channel_id = ?').get('trex:willow')).toEqual({ status: 'ok' });
    expect(readMeta(checkDb).generated_at).toBe('2026-11-25T10:00:00.000Z');
    checkDb.close();
  });

  test('--reindex-events rejects a missing database file via run() and CLI without creating it', async () => {
    const missingPath = path.join(dir, 'missing.sqlite');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await run(['--reindex-events', '--db', missingPath, '--quiet'])).toBe(1);
      expect(fs.existsSync(missingPath)).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }

    let exitCode = 0;
    try {
      execFileSync(process.execPath, [
        path.join(__dirname, '..', 'scripts', 'refresh_trex_catalog.js'),
        '--reindex-events',
        '--db',
        missingPath,
        '--quiet'
      ], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      exitCode = err.status;
    }
    expect(exitCode).toBe(1);
    expect(fs.existsSync(missingPath)).toBe(false);
  });
});
