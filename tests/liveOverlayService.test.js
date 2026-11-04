'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LiveOverlayService = require('../src/services/LiveOverlayService');
const MatchAggregator = require('../src/services/MatchAggregator');
const CronService = require('../src/services/CronService');

let seq = 0;
function tempFile(tag) {
  seq += 1;
  return path.join(os.tmpdir(), `nuvio-overlay-${tag}-${process.pid}-${seq}.json`);
}

const HOUR = 60 * 60 * 1000;

describe('LiveOverlayService', () => {
  let file;
  let overlay;

  beforeEach(() => {
    file = tempFile('svc');
    overlay = new LiveOverlayService({ file });
  });

  afterEach(() => {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  });

  test('setOverlay writes a snapshot, bumps the revision and merges its sources', () => {
    const applied = overlay.setOverlay(new Map([
      ['m1', [{ source: 'leaf', id: 'live-1', name: 'Real Madrid vs AEK' }]]
    ]));

    expect(applied.changed).toBe(true);
    expect(applied.revision).toBe(1);
    expect(applied.addedIds).toEqual(['m1']);
    expect(fs.existsSync(file)).toBe(true);

    const merged = overlay.mergeSources('m1', [{ source: 'ppvst', id: 'p1' }]);
    expect(merged).toEqual([
      { source: 'ppvst', id: 'p1' },
      { source: 'leaf', id: 'live-1', name: 'Real Madrid vs AEK' }
    ]);
  });

  test('an unchanged snapshot is a true no-op: no revision bump, no disk write', () => {
    const snapshot = new Map([['m1', [{ source: 'leaf', id: 'live-1' }]]]);
    overlay.setOverlay(snapshot);

    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    try {
      const second = overlay.setOverlay(new Map([['m1', [{ source: 'leaf', id: 'live-1' }]]]));
      expect(second.changed).toBe(false);
      expect(second.touchedIds).toEqual([]);
      expect(overlay.revision).toBe(1);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  test('the overlay is authoritative for the leaf source key', () => {
    overlay.setOverlay(new Map([['m1', [{ source: 'leaf', id: 'live-1' }]]]));

    // A full sync that ran while the fixture was live left a stale copy behind.
    const merged = overlay.mergeSources('m1', [
      { source: 'leaf', id: 'stale-0' },
      { source: 'ppvst', id: 'p1' }
    ]);

    expect(merged.filter((s) => s.source === 'leaf')).toEqual([{ source: 'leaf', id: 'live-1' }]);
    expect(merged.filter((s) => s.source === 'ppvst')).toHaveLength(1);
  });

  test('a fixture that leaves the snapshot has its stale catalog leaf source stripped', () => {
    overlay.setOverlay(new Map([['m1', [{ source: 'leaf', id: 'live-1' }]]]));
    overlay.setOverlay(new Map());

    const merged = overlay.mergeSources('m1', [
      { source: 'leaf', id: 'live-1' },
      { source: 'ppvst', id: 'p1' }
    ]);

    expect(merged.map((s) => s.source)).toEqual(['ppvst']);
  });

  test('a match the overlay never touched is returned untouched (same array)', () => {
    overlay.setOverlay(new Map([['m1', [{ source: 'leaf', id: 'live-1' }]]]));
    const base = [{ source: 'leaf', id: 'added-by-the-last-full-sync' }];

    expect(overlay.mergeSources('m2', base)).toBe(base);
  });

  test('removed ids remain tombstoned in the persisted snapshot', () => {
    overlay.setOverlay(new Map([['m1', [{ source: 'leaf', id: 'live-1' }]]]));
    overlay.setOverlay(new Map([['m2', [{ source: 'leaf', id: 'live-2' }]]]));

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.ownedIds).toEqual(expect.arrayContaining(['m1', 'm2']));
    expect(Object.keys(raw.overlay)).toEqual(['m2']);
  });

  test('a second worker adopts the snapshot and revision at boot', () => {
    overlay.setOverlay(new Map([['m1', [{ source: 'leaf', id: 'live-1' }]]]));
    const reader = new LiveOverlayService({ file });

    expect(reader.getRevision()).toBe(overlay.revision);
    expect(reader.hasOverlay('m1')).toBe(true);
    expect(reader.mergeSources('m1', []).map((s) => s.id)).toEqual(['live-1']);
  });

  test('a corrupt file degrades to "no overlay" instead of throwing', () => {
    fs.writeFileSync(file, '{not json');
    const recovered = new LiveOverlayService({ file });

    expect(recovered.getRevision()).toBe(0);
    expect(recovered.mergeSources('m1', [{ source: 'ppvst', id: 'p1' }]))
      .toEqual([{ source: 'ppvst', id: 'p1' }]);
  });

  test('refuses to carry any source that is not leaf', () => {
    const applied = overlay.setOverlay(new Map([
      ['m1', [{ source: 'ppvst', id: 'p1' }, { source: 'daddylive', id: 'dd1' }]]
    ]));

    expect(applied.changed).toBe(false);
    expect(overlay.size).toBe(0);
    expect(overlay.mergeSources('m1', [{ source: 'ppvst', id: 'p1' }]))
      .toEqual([{ source: 'ppvst', id: 'p1' }]);
  });
});

describe('MatchAggregator.buildLiveOverlay', () => {
  const now = Date.now();

  function providerReturning(matches, overrides = {}) {
    return {
      name: 'Leaf',
      sourceName: 'leaf',
      configured: true,
      lastCatalogOk: true,
      getMatches: jest.fn(async () => matches),
      ...overrides
    };
  }

  function aggregatorWith(catalog, provider) {
    return new MatchAggregator({
      cacheService: { getMatchesReadOnly: () => catalog },
      leafProvider: provider
    });
  }

  test('selects the provider by stable source key and maps a live fixture onto its card', async () => {
    const catalog = [
      {
        id: 'real-madrid-v-aek',
        aliasIds: ['streamed:football-real-madrid-aek-20750'],
        title: 'Real Madrid vs AEK Athens',
        date: String(now),
        category: 'football',
        status: 'live',
        sources: [{ source: 'ppvst', id: 'p1' }]
      }
    ];
    const provider = providerReturning([{
      id: 'leaf_real-madrid-aek',
      aliasIds: ['streamed:football-real-madrid-aek-20750'],
      title: 'Real Madrid vs AEK Athens',
      category: 'football',
      date: String(now),
      status: 'live',
      sources: [{ source: 'leaf', id: 'streamed:football-real-madrid-aek-20750', name: 'Real Madrid vs AEK Athens' }]
    }]);

    const result = await aggregatorWith(catalog, provider).buildLiveOverlay();

    expect(result.ok).toBe(true);
    expect(result.fetched).toBe(1);
    expect(result.matched).toBe(1);
    expect([...result.map.keys()]).toEqual(['real-madrid-v-aek']);
    expect(result.map.get('real-madrid-v-aek')).toEqual([
      { source: 'leaf', id: 'streamed:football-real-madrid-aek-20750', name: 'Real Madrid vs AEK Athens' }
    ]);
  });

  test('falls back to event identity when ids and aliases differ', async () => {
    const catalog = [
      { id: 'm2', title: 'Arsenal vs Chelsea', date: String(now + 2 * HOUR), category: 'football', status: 'scheduled', sources: [{ source: 'ppvst', id: 'p2' }] }
    ];
    const provider = providerReturning([{
      id: 'leaf_ars-che',
      title: 'Arsenal vs Chelsea',
      category: 'football',
      date: String(now + 2 * HOUR),
      status: 'live',
      sources: [{ source: 'leaf', id: 'ars-che' }]
    }]);

    const result = await aggregatorWith(catalog, provider).buildLiveOverlay();

    expect(result.matched).toBe(1);
    expect([...result.map.keys()]).toEqual(['m2']);
  });

  test('ignores catalog rows outside the kickoff window without normalising them', async () => {
    const catalog = [
      { id: 'old', title: 'Arsenal vs Chelsea', date: String(now - 5 * 24 * HOUR), category: 'football', status: 'finished', sources: [{ source: 'ppvst', id: 'p1' }] }
    ];
    const provider = providerReturning([{
      id: 'leaf_ars-che',
      title: 'Arsenal vs Chelsea',
      date: String(now),
      status: 'live',
      sources: [{ source: 'leaf', id: 'ars-che' }]
    }]);

    const result = await aggregatorWith(catalog, provider).buildLiveOverlay();

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no-candidates');
    expect(result.map.size).toBe(0);
  });

  test('a provider that never proved it answered reports ok:false', async () => {
    const provider = providerReturning([], { lastCatalogOk: false });
    const result = await aggregatorWith([], provider).buildLiveOverlay();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-unverified');
    expect(result.map.size).toBe(0);
  });

  test('an unconfigured provider is never treated as a source of truth', async () => {
    const provider = providerReturning([
      { id: 'leaf_x', title: 'A vs B', date: String(now), sources: [{ source: 'leaf', id: 'x' }] }
    ], { configured: false });

    const result = await aggregatorWith([], provider).buildLiveOverlay();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('provider-unconfigured');
    expect(provider.getMatches).not.toHaveBeenCalled();
  });

  test('a missing provider reports provider-missing instead of throwing', async () => {
    const aggregator = new MatchAggregator({ cacheService: { getMatchesReadOnly: () => [] } });
    const result = await aggregator.buildLiveOverlay();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('provider-missing');
  });

  test('the real LeafProvider is selectable by its stable source key', () => {
    const LeafProvider = require('../src/providers/LeafProvider');
    const provider = new LeafProvider();

    expect(provider.sourceName).toBe('leaf');
    const aggregator = new MatchAggregator({ leafProvider: provider, cacheService: { getMatchesReadOnly: () => [] } });
    expect(aggregator.providers.some((p) => p && p.sourceName === 'leaf')).toBe(true);
  });

  test('consults Leaf and nothing else, even with other providers registered', async () => {
    const catalog = [
      { id: 'm1', title: 'Real Madrid vs AEK Athens', date: String(now), category: 'football', status: 'live', sources: [{ source: 'ppvst', id: 'p1' }] }
    ];
    const leaf = providerReturning([{
      id: 'leaf_x', title: 'Real Madrid vs AEK Athens', date: String(now), status: 'live',
      sources: [{ source: 'leaf', id: 'live-1' }]
    }]);
    const other = {
      name: 'DaddyLive', sourceName: 'daddylive', configured: true, lastCatalogOk: true,
      getMatches: jest.fn(async () => [{ id: 'dd', title: 'Some other match', date: String(now), sources: [{ source: 'daddylive', id: 'dd1' }] }])
    };

    const aggregator = new MatchAggregator({
      cacheService: { getMatchesReadOnly: () => catalog },
      leafProvider: leaf,
      daddyLiveProvider: other
    });
    const result = await aggregator.buildLiveOverlay();

    expect(leaf.getMatches).toHaveBeenCalledTimes(1);
    expect(other.getMatches).not.toHaveBeenCalled();
    expect([...result.map.keys()]).toEqual(['m1']);
  });

  test('a Leaf fixture carrying non-leaf sources cannot smuggle them in', async () => {
    const catalog = [
      { id: 'm1', title: 'Real Madrid vs AEK Athens', date: String(now), category: 'football', status: 'live', sources: [{ source: 'ppvst', id: 'p1' }] }
    ];
    const provider = providerReturning([{
      id: 'leaf_x', title: 'Real Madrid vs AEK Athens', date: String(now), status: 'live',
      sources: [
        { source: 'leaf', id: 'live-1' },
        { source: 'daddylive', id: 'dd1' },
        { source: 'vavoo', id: 'vv1' }
      ]
    }]);

    const result = await aggregatorWith(catalog, provider).buildLiveOverlay();

    expect(result.map.get('m1').map((s) => s.source)).toEqual(['leaf']);
  });

});

describe('CronService.refreshLiveOverlay', () => {
  const originalInstance = process.env.NODE_APP_INSTANCE;
  let file;
  let overlay;
  let resolveCache;

  beforeEach(() => {
    file = tempFile('cron');
    overlay = new LiveOverlayService({ file });
    resolveCache = {
      entries: new Map([
        ['leaf:m1:live-1', { matchId: 'm1', streams: [] }],
        ['leaf:m2:other', { matchId: 'm2', streams: [] }]
      ]),
      statsCounters: { evictions: 0 }
    };
  });

  afterEach(() => {
    if (originalInstance === undefined) delete process.env.NODE_APP_INSTANCE;
    else process.env.NODE_APP_INSTANCE = originalInstance;
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  });

  function makeCron(buildLiveOverlay) {
    return new CronService({
      matchAggregator: { buildLiveOverlay },
      streamResolveCache: resolveCache,
      cacheService: {},
      liveOverlayService: overlay
    });
  }

  const liveSnapshot = () => ({ ok: true, reason: 'ok', fetched: 1, matched: 1, map: new Map([['m1', [{ source: 'leaf', id: 'live-1' }]]]) });

  test('does nothing on a secondary cluster worker', async () => {
    process.env.NODE_APP_INSTANCE = '1';
    const buildLiveOverlay = jest.fn();
    const result = await makeCron(buildLiveOverlay).refreshLiveOverlay();

    expect(result.skipped).toBe('secondary-worker');
    expect(buildLiveOverlay).not.toHaveBeenCalled();
    expect(overlay.revision).toBe(0);
  });

  test('applies the snapshot and evicts only the changed match', async () => {
    process.env.NODE_APP_INSTANCE = '0';
    const result = await makeCron(async () => liveSnapshot()).refreshLiveOverlay();

    expect(result.changed).toBe(true);
    expect(overlay.revision).toBe(1);
    expect(resolveCache.entries.has('leaf:m1:live-1')).toBe(false);
    expect(resolveCache.entries.has('leaf:m2:other')).toBe(true);
    expect(resolveCache.statsCounters.evictions).toBe(1);
  });

  test('an unchanged downstream answer does not bump the revision or evict anything', async () => {
    process.env.NODE_APP_INSTANCE = '0';
    const cron = makeCron(async () => liveSnapshot());
    await cron.refreshLiveOverlay();
    resolveCache.entries.set('leaf:m1:live-1', { matchId: 'm1', streams: [] });

    const second = await cron.refreshLiveOverlay();

    expect(second.changed).toBe(false);
    expect(overlay.revision).toBe(1);
    expect(resolveCache.entries.has('leaf:m1:live-1')).toBe(true);
  });

  test('a failed fetch keeps the previous snapshot', async () => {
    process.env.NODE_APP_INSTANCE = '0';
    await makeCron(async () => liveSnapshot()).refreshLiveOverlay();

    const failing = makeCron(async () => ({ ok: false, reason: 'fetch-failed', fetched: 0, matched: 0, map: new Map() }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await failing.refreshLiveOverlay();
      expect(result.kept).toBe(true);
      expect(overlay.revision).toBe(1);
      expect(overlay.hasOverlay('m1')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('a successful empty fetch clears the snapshot', async () => {
    process.env.NODE_APP_INSTANCE = '0';
    const cron = makeCron(async () => liveSnapshot());
    await cron.refreshLiveOverlay();

    const empty = makeCron(async () => ({ ok: true, reason: 'empty', fetched: 0, matched: 0, map: new Map() }));
    const result = await empty.refreshLiveOverlay();

    expect(result.changed).toBe(true);
    expect(overlay.size).toBe(0);
    expect(overlay.revision).toBe(2);
  });
});
