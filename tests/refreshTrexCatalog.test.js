'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { fetchCatalogRows, run } = require('../scripts/refresh_trex_catalog');
const { openDatabase, readMeta } = require('../src/services/TrexCatalogDb');

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
});
