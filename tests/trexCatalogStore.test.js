'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeCatalogFile, openDatabase } = require('../src/services/TrexCatalogDb');
const { TrexCatalogStore } = require('../src/services/TrexCatalogStore');

const METAS = [
  { id: 'trex:nba-bulls', name: 'NBA TEAM| CHICAGO BULLS', type: 'tv' },
  { id: 'trex:sky-uk', name: 'UK| SKY SPORTS CRICKET FHD', type: 'tv' },
  { id: 'trex:sky-ie', name: 'IE| SKY SPORTS CRICKET HD', type: 'tv' },
  { id: 'trex:willow', name: 'CA| WILLOW CRICKET HD', type: 'tv' }
];

describe('TrexCatalogStore', () => {
  let dir;
  let dbPath;
  let stores;

  function openStore(opts) {
    const store = new TrexCatalogStore(opts);
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    stores = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-store-'));
    dbPath = path.join(dir, 'trex_catalog.sqlite');
    writeCatalogFile(dbPath, METAS, { generatedAt: '2026-11-24T00:00:00.000Z', source: 'test' });
  });

  afterEach(() => {
    for (const store of stores) store.close();
    stores = [];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('resolves a fixture team to its team channel', () => {
    const store = openStore({ dbPath });
    expect(store.isReady()).toBe(true);

    const hits = store.findTeam('Chicago Bulls');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'trex:nba-bulls', group: 'NBA TEAM', league: 'nba' });
    expect(store.findTeam('Bulls')).toEqual([]);
  });

  test('resolves broadcaster labels and prefers the requested country', () => {
    const store = openStore({ dbPath });

    expect(store.findChannel('Sky Sports Cricket HD')[0].group).toBe('UK');
    expect(store.findChannel('Sky Sports Cricket HD', { countryCode: 'IE' })[0].group).toBe('IE');
    expect(store.findChannel('Willow Cricket')[0]).toMatchObject({ id: 'trex:willow', name: 'CA| WILLOW CRICKET HD' });
    expect(store.findChannel('No Such Channel')).toEqual([]);
  });

  test('reports not ready for a missing or corrupt database without throwing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const missing = openStore({ dbPath: path.join(dir, 'nope.sqlite') });
      expect(missing.isReady()).toBe(false);
      expect(missing.findTeam('Chicago Bulls')).toEqual([]);

      const corruptPath = path.join(dir, 'corrupt.sqlite');
      fs.writeFileSync(corruptPath, 'not sqlite');
      const corrupt = openStore({ dbPath: corruptPath });
      expect(corrupt.isReady()).toBe(false);
      expect(corrupt.findChannel('Sky Sports Cricket')).toEqual([]);

      const unset = openStore({ dbPath: '' });
      expect(unset.isReady()).toBe(false);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[TrexCatalogStore] not ready:'));
    } finally {
      warn.mockRestore();
    }
  });

  test('reports catalog stats', () => {
    const store = openStore({ dbPath });
    expect(store.stats()).toMatchObject({ rows: 4, teams: 1, channels: 3, generatedAt: '2026-11-24T00:00:00.000Z' });
  });

  test('a reader keeps the previous catalog while a refresh transaction is open', () => {
    const store = openStore({ dbPath });
    expect(store.isReady()).toBe(true);
    expect(store.findTeam('Chicago Bulls')[0].id).toBe('trex:nba-bulls');

    const writer = openDatabase(dbPath);
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('INSERT INTO channels (id, name, grp, kind, league, tier) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('trex:nba-bulls-4k', 'NBA TEAM| CHICAGO BULLS 4K', 'NBA TEAM', 'team', 'nba');
    writer.prepare('INSERT INTO channel_keys (norm_key, channel_id, score) VALUES (?, ?, ?)')
      .run('chicago bulls', 'trex:nba-bulls-4k', 9999);

    expect(store.findTeam('Chicago Bulls')[0].id).toBe('trex:nba-bulls');

    writer.exec('COMMIT');
    writer.close();

    expect(store.findTeam('Chicago Bulls')[0].id).toBe('trex:nba-bulls-4k');
  });
});
