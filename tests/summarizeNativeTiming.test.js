'use strict';
const { Readable } = require('node:stream');
const { decodeLine, summarizeStream } = require('../scripts/summarize-native-timing');

test('reports observed stream windows without treating missing or duplicated events as complete', async () => {
  const base = { kind: 'stream_timing', type: 'stream_resolution_window_end', pid: 7,
    sessionId: 'a'.repeat(32), streamId: 'b'.repeat(32), durationMs: 15000, sourceCount: 5, unsettledCount: 2 };
  const other = { ...base, streamId: 'c'.repeat(32), durationMs: 100, unsettledCount: 0 };
  const invalid = { ...base, streamId: 'd'.repeat(32), unsettledCount: 6 };
  const report = await summarizeStream(Readable.from([[base, other, other, invalid].map(JSON.stringify).join('\n')]));
  expect(report.streamWindows).toEqual({ observed: 1, withUnsettledSources: 1, unsettledSources: 2,
    reasons: { all_settled: 0, early_return: 0, priority_completed: 0, hard_wait_expired: 0, budget_exhausted: 0, unknown: 1 },
    p95ObservedDurationMs: 15000, invalid: 1, duplicate: 1, ambiguous: 1 });
  expect(report.completeness).toBe('unknown');
});

test('reports loss snapshots without adding overlapping counters or claiming completeness', async () => {
  const id = 'a'.repeat(16);
  const sessionId = 'b'.repeat(32);
  const lines = [
    'ordinary server log with private data',
    JSON.stringify({ kind: 'native_timing', pid: 10, sessionId, type: 'http_start', id }),
    JSON.stringify({ kind: 'native_timing', pid: 10, sessionId, type: 'http_terminal', id, enqueued: true, admitted: false, outcome: 'timeout', queueMs: 100 }),
    `[NativeTimingSummary] ${JSON.stringify({ dropped: 2, pid: 10, sessionId, poolId: 'abcd1234' })}`,
    `[TimingOutputSummary] ${JSON.stringify({ rejected: 2, failed: 1, pid: 10, sessionId })}`,
    '[StreamTimingSummary] invalid json'
  ];
  const result = await summarizeStream(Readable.from([lines.join('\n')]));
  expect(result).toMatchObject({ timingRecords: 2, truncated: false, ignoredLines: 2,
    snapshots: { native: 1, stream: 0, output: 1 },
    losses: { nativeDropped: 2, streamDropped: null, outputRejected: 2, outputFailed: 1 }, completeness: 'unknown' });
  expect(result.queue.groups[0]).toMatchObject({ total: 1, observed: 0, censored: 1, p95ObservedMs: null });
  expect(JSON.stringify(result)).not.toMatch(/private/);
});

test('repeated cumulative snapshots are counted once per process session and pool', async () => {
  const sessionId = 'b'.repeat(32);
  const summary = { dropped: 3, pid: 10, sessionId, poolId: 'abcd1234' };
  const lines = [`[NativeTimingSummary] ${JSON.stringify(summary)}`,
    `[NativeTimingSummary] ${JSON.stringify(summary)}`,
    `[NativeTimingSummary] ${JSON.stringify({ ...summary, dropped: 5 })}`,
    `[NativeTimingSummary] ${JSON.stringify({ ...summary, poolId: 'defa5678', dropped: 2 })}`];
  const report = await summarizeStream(Readable.from([lines.join('\n')]));
  expect(report.snapshots.native).toBe(2);
  expect(report.repeatedSnapshots).toBe(2);
  expect(report.snapshotObservations).toEqual({ native: 4, stream: 0, output: 0 });
  expect(report).not.toHaveProperty('duplicateSnapshots');
  expect(report.losses.nativeDropped).toBe(7);
});

test('periodic snapshot lines are counted separately from their three writer series', async () => {
  const identity = { pid: 10, sessionId: 'b'.repeat(32) };
  const lines = [];
  for (let i = 0; i < 4; i++) lines.push(`[NativeTimingSummary] ${JSON.stringify({ ...identity, poolId: 'abcd1234', dropped: i })}`);
  for (let i = 0; i < 5; i++) lines.push(`[StreamTimingSummary] ${JSON.stringify({ ...identity, dropped: 0 })}`);
  for (let i = 0; i < 4; i++) lines.push(`[TimingOutputSummary] ${JSON.stringify({ ...identity, rejected: 0, failed: 0 })}`);
  const report = await summarizeStream(Readable.from([lines.join('\n')]));
  expect(report.snapshots).toEqual({ native: 1, stream: 1, output: 1 });
  expect(report.snapshotObservations).toEqual({ native: 4, stream: 5, output: 4 });
  expect(report.repeatedSnapshots).toBe(10);
  expect(report.losses.nativeDropped).toBe(3);
  expect(report.completeness).toBe('unknown');
});

test('caps retained timing records and flags truncation', async () => {
  const lines = [1, 2].map(i => JSON.stringify({ kind: 'native_timing', pid: 1, sessionId: 'b'.repeat(32), type: 'http_start', id: String(i).padStart(16, '0') }));
  const result = await summarizeStream(Readable.from([lines.join('\n')]), 1);
  expect(result).toMatchObject({ timingRecords: 1, truncated: true });
  expect(result.queue.startsWithoutTerminalObserved).toBe(1);
});

test('ignores JSON outside the timing schema', () => {
  expect(decodeLine('{"url":"secret"}')).toBeNull();
  expect(decodeLine('[NativeTimingSummary] invalid')).toBeNull();
});

test('invalid snapshots are not silently counted as zero loss', async () => {
  const input = ['[NativeTimingSummary] {"dropped":"unknown"}', '[TimingOutputSummary] {"rejected":0}'];
  const result = await summarizeStream(Readable.from([input.join('\n')]));
  expect(result.invalidSnapshots).toBe(2);
  expect(result.snapshots).toEqual({ native: 0, stream: 0, output: 0 });
  expect(result.losses).toEqual({ nativeDropped: null, streamDropped: null, outputRejected: null, outputFailed: null });
  expect(result.completeness).toBe('unknown');
});

test('extra event fields and oversized lines are not retained in the report', async () => {
  const event = { kind: 'native_timing', pid: 1, sessionId: 'b'.repeat(32), type: 'http_terminal',
    id: 'a'.repeat(16), enqueued: true, admitted: true, queueMs: 2, url: 'private-secret' };
  const input = [JSON.stringify(event), 'x'.repeat(9000)];
  const result = await summarizeStream(Readable.from([input.join('\n')]));
  expect(result.ignoredLines).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/private-secret/);
});

test('timing phases not included in the queue report are distinguished from ordinary log lines', async () => {
  const lines = ['ordinary log', JSON.stringify({ kind: 'native_timing', type: 'child_exit' })];
  const result = await summarizeStream(Readable.from([lines.join('\n')]));
  expect(result).toMatchObject({ ignoredLines: 1, otherTimingEvents: 1, timingRecords: 0 });
});
