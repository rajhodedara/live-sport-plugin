'use strict';
const { createTimingRelations } = require('../src/services/TimingRelations');

test('two stream requests can link to the same work without duplicating the work id', () => {
  const rows = [], relations = createTimingRelations({ emit: row => rows.push(row) });
  const first = relations.stream(), second = relations.stream(), work = relations.work();
  expect(relations.link(first, work)).toBe(true);
  expect(relations.link(second, work)).toBe(true);
  expect(relations.link(first, work)).toBe(false);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ streamId: first.id, workId: work.id });
  expect(rows[1]).toMatchObject({ streamId: second.id, workId: work.id });
  expect(first.id).not.toBe(second.id);
  expect(work.id).toMatch(/^[a-f0-9]{32}$/);
});

test('rejects fabricated handles and counts bounded or failed emissions', () => {
  const rows = [], relations = createTimingRelations({ maxEvents: 1, emit: row => rows.push(row) });
  const first = relations.stream(), second = relations.stream(), work = relations.work();
  expect(relations.link({ id: 'secret' }, work)).toBe(false);
  relations.link(first, work); relations.link(second, work);
  expect(relations.stats).toEqual({ emitted: 1, dropped: 1 });
  expect(JSON.stringify(rows)).not.toContain('secret');
  const failed = createTimingRelations({ emit: () => { throw new Error('sink'); } });
  expect(() => failed.link(failed.stream(), failed.work())).not.toThrow();
  expect(failed.stats).toEqual({ emitted: 0, dropped: 1 });
});

test('the event cap also holds if a sink reenters synchronously', () => {
  let relations, second, work;
  const rows = [];
  relations = createTimingRelations({ maxEvents: 1, emit: row => {
    rows.push(row);
    relations.link(second, work);
  } });
  const first = relations.stream(); second = relations.stream(); work = relations.work();
  relations.link(first, work);
  expect(rows).toHaveLength(1);
  expect(relations.stats).toEqual({ emitted: 1, dropped: 1 });
});

test('window end records monotonic duration and unsettled work only once', () => {
  let clock = 100;
  const rows = [], relations = createTimingRelations({ now: () => clock, emit: row => rows.push(row) });
  const stream = relations.stream();
  clock = 250;
  expect(relations.endWindow(stream, 4, 2)).toBe(true);
  expect(relations.endWindow(stream, 4, 0)).toBe(false);
  expect(rows).toEqual([{ type: 'stream_resolution_window_end', streamId: stream.id,
    observedAtMs: 250, durationMs: 150, sourceCount: 4, unsettledCount: 2, reason: 'unknown' }]);
});

test('cache operation can settle after stream window without implying cancellation', () => {
  let clock = 100;
  const rows = [], relations = createTimingRelations({ now: () => clock, emit: row => rows.push(row) });
  const stream = relations.stream(), work = relations.work();
  relations.link(stream, work);
  clock = 200; relations.endWindow(stream, 1, 1);
  clock = 350; expect(relations.endWork(work)).toBe(true);
  expect(relations.endWork(work)).toBe(false);
  expect(rows[2]).toMatchObject({ type: 'cache_operation_end', workId: work.id, observedAtMs: 350, durationMs: 250 });
  expect(rows[2].observedAtMs).toBeGreaterThan(rows[1].observedAtMs);
});

test('only allowlisted source names can appear in source timing events', () => {
  const rows = [], relations = createTimingRelations({ emit: row => rows.push(row) });
  const known = relations.work('damitv');
  const unknown = relations.work('private-secret-url');
  relations.startMint(known); relations.endMint(known, 'returned');
  relations.startMint(unknown); relations.endMint(unknown, 'threw');
  expect(rows.map(row => row.source)).toEqual(['damitv', 'damitv', 'other', 'other']);
  expect(JSON.stringify(rows)).not.toContain('private-secret-url');
});

test('stream timing summary reports losses without exposing request data', () => {
  const summaries = [];
  const relations = createTimingRelations({ maxEvents: 0, emitSummary: row => summaries.push(row) });
  relations.link(relations.stream(), relations.work());
  relations.report();
  expect(summaries).toEqual([{ type: 'stream_timing_summary', emitted: 0, dropped: 1 }]);
});
