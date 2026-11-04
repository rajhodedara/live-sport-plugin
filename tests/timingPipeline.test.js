'use strict';
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const { createTimingRelations } = require('../src/services/TimingRelations');
const { createNativeTiming } = require('../src/services/NativeTiming');
const { createIsolatedNativePoolCandidate } = require('../src/services/IsolatedNativePoolCandidate');
const { summarizeStream } = require('../scripts/summarize-native-timing');

test('synthetic stream-to-report pipeline preserves an admitted and a timed-out source', async () => {
  const previous = process.env.RESOLVE_CACHE_SHARED;
  process.env.RESOLVE_CACHE_SHARED = 'false';
  const rows = [], summaries = [];
  const sessionId = 'b'.repeat(32);
  const relations = createTimingRelations({ emit: row => rows.push({ kind: 'stream_timing', pid: process.pid, sessionId, ...row }) });
  const timing = createNativeTiming({ enabled: true, emitStarts: true,
    emit: row => rows.push({ kind: 'native_timing', pid: process.pid, sessionId, ...row }),
    emitSummary: row => summaries.push(row) });
  const children = [];
  const pool = createIsolatedNativePoolCandidate({ maxSlots: 1, admissionWaitMs: 1000, timing, spawn: () => {
    const child = new EventEmitter();
    child.send = (_message, callback) => callback();
    child.kill = () => {};
    children.push(child);
    return child;
  } });
  const cache = new StreamResolveCache({ timingRelations: relations });
  const stream = relations.stream();
  const a = cache.getOrCreate('damitv:private:a', async () => {
    await pool.fetch('https://example.test/private', { timeoutMs: 1000 });
    return [{ url: 'https://example.test/live' }];
  }, stream);
  const b = cache.getOrCreate('daddylive:private:b', async () => {
    await pool.fetch('https://example.test/private', { timeoutMs: 25 });
    return [];
  }, stream);
  try {
    expect(await b).toEqual([]);
    expect(children).toHaveLength(1);
    relations.endWindow(stream, 2, 1);
    children[0].emit('message', { type: 'diagnostic', phase: 'request_received' });
    children[0].emit('message', { type: 'diagnostic', phase: 'fetch_start', hop: 0, childElapsedMs: 10 });
    children[0].emit('message', { type: 'diagnostic', phase: 'response_received', hop: 0, childElapsedMs: 50 });
    children[0].emit('message', { type: 'diagnostic', phase: 'body_read_end', hop: 0, childElapsedMs: 70 });
    children[0].emit('message', { type: 'result', status: 200, url: 'https://example.test/', headers: [], bytes: Buffer.from('ok') });
    expect(await a).toHaveLength(1);
    children[0].emit('exit', 0);
    await pool.close();
    const lines = rows.map(row => JSON.stringify(row));
    lines.push(`[NativeTimingSummary] ${JSON.stringify({ ...summaries[0], pid: process.pid, sessionId })}`);
    const report = await summarizeStream(Readable.from([lines.join('\n')]));
    expect(report.queue.groups).toEqual([
      expect.objectContaining({ source: 'daddylive', total: 1, observed: 0, censored: 1, p95ObservedMs: null }),
      expect.objectContaining({ source: 'damitv', total: 1, observed: 1, censored: 0 })
    ]);
    expect(report.queue).toMatchObject({ startsObserved: 2, startsWithoutTerminalObserved: 0, terminalsWithoutStartObserved: 0 });
    expect(report.queue).toMatchObject({ observedPools: 1, terminalsWithoutPool: 0 });
    const damitvPhases = report.phases.groups.find(group => group.source === 'damitv');
    expect(damitvPhases.metrics.firstHopResponseMs).toEqual({ observed: 1, unavailable: 0, p95ObservedMs: 40 });
    expect(damitvPhases.metrics.firstHopBodyMs).toEqual({ observed: 1, unavailable: 0, p95ObservedMs: 20 });
    const daddyPhases = report.phases.groups.find(group => group.source === 'daddylive');
    expect(daddyPhases.metrics.firstHopResponseMs).toEqual({ observed: 0, unavailable: 1, p95ObservedMs: null });
    expect(report.losses.nativeDropped).toBe(0);
    expect(report.completeness).toBe('unknown');
    expect(JSON.stringify(rows)).not.toMatch(/example|private/);
  } finally {
    if (children[0] && pool.occupied) children[0].emit('exit', 0);
    await pool.close();
    if (previous === undefined) delete process.env.RESOLVE_CACHE_SHARED; else process.env.RESOLVE_CACHE_SHARED = previous;
  }
}, 10000);
