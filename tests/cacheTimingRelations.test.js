'use strict';
const StreamResolveCache = require('../src/services/StreamResolveCache');
const { createTimingRelations } = require('../src/services/TimingRelations');
const { createNativeTiming } = require('../src/services/NativeTiming');
const { withTimingWork, currentTimingWork } = require('../src/services/TimingContext');

let oldShared;
beforeEach(() => { oldShared = process.env.RESOLVE_CACHE_SHARED; process.env.RESOLVE_CACHE_SHARED = 'false'; });
afterEach(() => {
  if (oldShared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
  else process.env.RESOLVE_CACHE_SHARED = oldShared;
});

test('concurrent callers link to one local cache operation; a later cache hit creates no work link', async () => {
  const rows = [], relations = createTimingRelations({ emit: row => rows.push(row) });
  const cache = new StreamResolveCache({ timingRelations: relations });
  const first = relations.stream(), second = relations.stream(), third = relations.stream();
  let finish;
  const mint = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const key = 'provider:private-match:private-source';
  const a = cache.getOrCreate(key, mint, first);
  const b = cache.getOrCreate(key, mint, second);
  await Promise.resolve(); await Promise.resolve();
  expect(mint).toHaveBeenCalledTimes(1);
  expect(rows).toHaveLength(3);
  expect(rows[0].workId).toBe(rows[1].workId);
  expect(rows.filter(row => row.type === 'stream_work_link').map(row => row.streamId)).toEqual([first.id, second.id]);
  expect(rows[2]).toMatchObject({ type: 'source_mint_start', workId: rows[0].workId });
  finish([{ url: 'https://private.test/secret' }]);
  expect(await a).toEqual(await b);
  expect(rows[3]).toMatchObject({ type: 'source_mint_end', workId: rows[0].workId, outcome: 'returned' });
  expect(rows[4]).toMatchObject({ type: 'cache_operation_end', workId: rows[0].workId });
  expect((await cache.getOrCreate(key, mint, third))).toHaveLength(1);
  expect(rows).toHaveLength(5);
  expect(JSON.stringify(rows)).not.toMatch(/private|secret/);
});

test('observer failures leave normal cache results and errors unchanged', async () => {
  const cache = new StreamResolveCache({ timingRelations: { work() { throw new Error('observer'); }, link() { throw new Error('observer'); } } });
  const result = await cache.getOrCreate('p:m:s', async () => [{ url: 'https://example.test/' }], {});
  expect(result).toEqual([{ url: 'https://example.test/' }]);
});

test('a reentrant diagnostic sink cannot start a second mint for the same key', async () => {
  let cache, nested, invoked = false;
  const mint = jest.fn(async () => [{ url: 'https://example.test/' }]);
  const relations = createTimingRelations({ emit: () => {
    if (invoked) return;
    invoked = true;
    nested = cache.getOrCreate('p:m:s', mint, second);
  } });
  const first = relations.stream(), second = relations.stream();
  cache = new StreamResolveCache({ timingRelations: relations });
  const outer = cache.getOrCreate('p:m:s', mint, first);
  expect(await outer).toEqual(await nested);
  expect(mint).toHaveBeenCalledTimes(1);
});

test('shared local mint correlates both stream links with its HTTP timing and does not leak context', async () => {
  const links = [], httpRows = [];
  const relations = createTimingRelations({ emit: row => links.push(row) });
  const timing = createNativeTiming({ enabled: true, emit: row => httpRows.push(row) });
  const cache = new StreamResolveCache({ timingRelations: relations });
  const first = relations.stream(), second = relations.stream();
  let finish;
  const mint = jest.fn(async () => {
    await new Promise(resolve => { finish = resolve; });
    timing.start().finish();
    return [{ url: 'https://example.test/' }];
  });
  const a = cache.getOrCreate('p:m:s', mint, first);
  const b = cache.getOrCreate('p:m:s', mint, second);
  await Promise.resolve(); await Promise.resolve();
  finish();
  expect(await a).toEqual(await b);
  expect(mint).toHaveBeenCalledTimes(1);
  expect(links).toHaveLength(5);
  expect(httpRows[0].workId).toBe(links[0].workId);
  expect(httpRows[0].workId).toBe(links[1].workId);
  timing.start().finish();
  expect(httpRows[1].workId).toBeNull();
});

test('provider rejection is recorded without changing the cache error contract', async () => {
  const rows = [], relations = createTimingRelations({ emit: row => rows.push(row) });
  const cache = new StreamResolveCache({ timingRelations: relations });
  const result = await cache.getOrCreate('p:m:s', async () => { throw new Error('private'); }, relations.stream());
  expect(result).toEqual([]);
  expect(rows.find(row => row.type === 'source_mint_end')).toMatchObject({ outcome: 'threw' });
  expect(JSON.stringify(rows)).not.toContain('private');
});

test('cache derives only an allowlisted source label for timing', async () => {
  const rows = [], relations = createTimingRelations({ emit: row => rows.push(row) });
  const cache = new StreamResolveCache({ timingRelations: relations });
  await cache.getOrCreate('damitv:private-match:private-source', async () => [], relations.stream());
  expect(rows.find(row => row.type === 'source_mint_end')).toMatchObject({ source: 'damitv' });
  expect(JSON.stringify(rows)).not.toContain('private');
});

test('adopting a shared-cache result records no local source mint', async () => {
  process.env.RESOLVE_CACHE_SHARED = 'true';
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: 'ok',
    streams: [{ url: 'https://example.test/' }], expiresAt: Date.now() + 60000 }) }));
  try {
    const rows = [], relations = createTimingRelations({ emit: row => rows.push(row) });
    const cache = new StreamResolveCache({ timingRelations: relations });
    const mint = jest.fn(async () => []);
    expect(await cache.getOrCreate('p:m:s', mint, relations.stream())).toHaveLength(1);
    expect(mint).not.toHaveBeenCalled();
    expect(rows.map(row => row.type)).toEqual(['stream_work_link', 'cache_operation_end']);
  } finally { global.fetch = originalFetch; }
});

test('untraced nested work cannot inherit another operation attribution', async () => {
  const relations = createTimingRelations(), work = relations.work();
  await withTimingWork(work, async () => {
    expect(currentTimingWork()).toBe(work.id);
    await withTimingWork(null, async () => {
      await Promise.resolve();
      expect(currentTimingWork()).toBeNull();
    });
    expect(currentTimingWork()).toBe(work.id);
  });
  expect(currentTimingWork()).toBeNull();
});

test('cache with diagnostics disabled clears any unrelated inherited timing context', async () => {
  const relations = createTimingRelations(), outerWork = relations.work();
  const cache = new StreamResolveCache();
  await withTimingWork(outerWork, async () => {
    const result = await cache.getOrCreate('p:m:s', async () => {
      expect(currentTimingWork()).toBeNull();
      return [{ url: 'https://example.test/' }];
    });
    expect(result).toHaveLength(1);
    expect(currentTimingWork()).toBe(outerWork.id);
  });
});
