'use strict';

// Exercise actual CronService methods without schedulers, files or provider I/O.
const CronService = require('../src/services/CronService');

function cronWith({ cache, leaf, providers, changed = true, touchedIds = ['fixture'] } = {}) {
  const clearCacheForMatch = jest.fn();
  const leafProvider = leaf || { sourceName: 'leaf', clearCacheForMatch };
  const aggregator = {
    providers: providers || [leafProvider],
    buildLiveOverlay: jest.fn(async () => ({ ok: true, fetched: 1, matched: 1, map: new Map() })),
  };
  const overlay = { setOverlay: jest.fn(() => ({
    changed, revision: 1, touchedIds, addedIds: touchedIds, removedIds: [],
  })) };
  return { cron: new CronService({ matchAggregator: aggregator, streamResolveCache: cache, liveOverlayService: overlay }),
    aggregator, overlay, leaf: leafProvider };
}

let oldInstance;
beforeEach(() => {
  oldInstance = process.env.NODE_APP_INSTANCE;
  process.env.NODE_APP_INSTANCE = '0';
  jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 6, 12));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('Unexpected network request'); });
});
afterEach(() => {
  expect(global.fetch).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  if (oldInstance === undefined) delete process.env.NODE_APP_INSTANCE;
  else process.env.NODE_APP_INSTANCE = oldInstance;
});

test.each([undefined, null, {}, { entries: new Map() }])('clears the exact private fixture even without matching outer cache state: %p', cache => {
  const { cron, leaf } = cronWith({ cache });

  expect(cron._invalidateOverlayMatch('canonical-fixture')).toBe(0);
  expect(leaf.clearCacheForMatch).toHaveBeenCalledTimes(1);
  expect(leaf.clearCacheForMatch).toHaveBeenCalledWith('canonical-fixture');
});

test('private invalidation and outer eviction stay limited to Leaf and the exact fixture', () => {
  const entries = new Map([
    ['leaf:fixture:upstream-one', { matchId: 'fixture' }],
    ['leaf:fixture:upstream-two', { matchId: 'fixture' }],
    ['leaf:fixture-other:upstream-one', { matchId: 'fixture-other' }],
    ['leafish:fixture:upstream-one', { matchId: 'fixture' }],
    ['ppvst:fixture:upstream-one', { matchId: 'fixture' }],
  ]);
  const keep = new Map(entries);
  const pendingLeaf = { matchId: 'fixture', publicationEntry: {} };
  const pendingOther = { matchId: 'fixture', publicationEntry: {} };
  const cache = { entries, pendingOperations: new Map([
    ['leaf:fixture:pending', pendingLeaf], ['ppvst:fixture:pending', pendingOther],
  ]), statsCounters: { evictions: 7 }, noteFailure: jest.fn() };
  const leaf = { sourceName: 'leaf', clearCacheForMatch: jest.fn() };
  const other = { sourceName: 'ppvst', clearCacheForMatch: jest.fn() };
  const lookalike = { name: 'Leaf', sourceName: 'leafish', clearCacheForMatch: jest.fn() };
  const { cron } = cronWith({ cache, providers: [lookalike, other, leaf] });

  expect(cron._invalidateOverlayMatch('fixture')).toBe(2);
  expect(leaf.clearCacheForMatch).toHaveBeenCalledWith('fixture');
  expect(other.clearCacheForMatch).not.toHaveBeenCalled();
  expect(lookalike.clearCacheForMatch).not.toHaveBeenCalled();
  for (const key of ['leaf:fixture:upstream-one', 'leaf:fixture:upstream-two']) {
    expect(entries.has(key)).toBe(false);
    expect(keep.get(key).invalidated).toBe(true);
  }
  for (const key of ['leaf:fixture-other:upstream-one', 'leafish:fixture:upstream-one', 'ppvst:fixture:upstream-one']) {
    expect(entries.get(key)).toBe(keep.get(key));
  }
  expect(pendingLeaf.publicationEntry.invalidated).toBe(true);
  expect(pendingOther.publicationEntry.invalidated).toBeUndefined();
  expect(cache.statsCounters.evictions).toBe(9);
  expect(cache.noteFailure).not.toHaveBeenCalled();
});

test('a private invalidator failure does not prevent outer Leaf eviction', () => {
  const cache = { entries: new Map([['leaf:fixture:feed', { matchId: 'fixture' }]]) };
  const leaf = { sourceName: 'leaf', clearCacheForMatch: jest.fn(() => { throw new Error('private cache unavailable'); }) };
  const { cron } = cronWith({ cache, leaf });

  expect(cron._invalidateOverlayMatch('fixture')).toBe(1);
  expect(cache.entries.size).toBe(0);
});

test('a changed overlay clears each touched private fixture without an outer cache', async () => {
  const { cron, leaf } = cronWith({ touchedIds: ['removed', 'added'] });

  expect(await cron.refreshLiveOverlay()).toMatchObject({ changed: true });
  expect(leaf.clearCacheForMatch.mock.calls).toEqual([['removed'], ['added']]);
});

test('an unchanged overlay does not invalidate private entries', async () => {
  const { cron, leaf } = cronWith({ changed: false });

  expect(await cron.refreshLiveOverlay()).toMatchObject({ changed: false });
  expect(leaf.clearCacheForMatch).not.toHaveBeenCalled();
});

test('failed ticks preserve private entries until the existing clear threshold', async () => {
  const { cron, leaf, aggregator, overlay } = cronWith();
  cron._overlayFailStreakMax = 3;
  aggregator.buildLiveOverlay.mockResolvedValue({ ok: false, reason: 'empty-unverified' });

  expect(await cron.refreshLiveOverlay()).toMatchObject({ kept: true });
  expect(await cron.refreshLiveOverlay()).toMatchObject({ kept: true });
  expect(overlay.setOverlay).not.toHaveBeenCalled();
  expect(leaf.clearCacheForMatch).not.toHaveBeenCalled();
  await cron.refreshLiveOverlay();
  expect(overlay.setOverlay).toHaveBeenCalledWith(new Map());
  expect(leaf.clearCacheForMatch).toHaveBeenCalledWith('fixture');
});
