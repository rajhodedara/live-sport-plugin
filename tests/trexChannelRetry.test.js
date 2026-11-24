'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeCatalogFile } = require('../src/services/TrexCatalogDb');
const { TrexCatalogStore } = require('../src/services/TrexCatalogStore');

const METAS = [
  { id: 'trex:nba-tv-us', name: 'US| NBA TV HD', type: 'tv' },
  { id: 'trex:sport5-il', name: 'ISR| SPORT 5 HD', type: 'tv' },
  { id: 'trex:sky-cricket', name: 'UK| SKY SPORTS CRICKET FHD', type: 'tv' },
  { id: 'trex:willow', name: 'CA| WILLOW CRICKET HD', type: 'tv' }
];

describe('TrexCatalogStore broadcaster retry', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trex-retry-'));
    const dbPath = path.join(dir, 'catalog.sqlite');
    writeCatalogFile(dbPath, METAS, { generatedAt: 'retry', source: 'test' });
    store = new TrexCatalogStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('finds the channel behind a label with a trailing market word', () => {
    expect(store.findChannel('NBA TV USA').map((hit) => hit.id)).toEqual(['trex:nba-tv-us']);
    expect(store.findChannel('Sport 5 Israel').map((hit) => hit.id)).toEqual(['trex:sport5-il']);
  });

  test('exact labels still win without the retry', () => {
    expect(store.findChannel('NBA TV').map((hit) => hit.id)).toEqual(['trex:nba-tv-us']);
    expect(store.findChannel('Sky Sports Cricket').map((hit) => hit.id)).toEqual(['trex:sky-cricket']);
  });

  test('does not trim a trailing word that is not a market', () => {
    expect(store.findChannel('Sky Sports Cricket Extra')).toEqual([]);
    expect(store.findChannel('NBA TV Plus')).toEqual([]);
  });

  test('still reports nothing for an unknown label', () => {
    expect(store.findChannel('NBA League Pass')).toEqual([]);
  });
});
