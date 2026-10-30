'use strict';
const { EventEmitter } = require('node:events');
const { createNativeTiming } = require('../src/services/NativeTiming');

test('terminal owner labels are allowlisted and do not expose caller input', () => {
  const rows = [], timing = createNativeTiming({ enabled: true, emit: row => rows.push(row) });
  timing.start('abcd1234', 'catalog').finish();
  timing.start('abcd1234', 'private-secret').finish();
  expect(rows.map(row => row.owner)).toEqual(['catalog', 'other']);
  expect(JSON.stringify(rows)).not.toContain('private-secret');
});
const { createIsolatedNativePoolCandidate } = require('../src/services/IsolatedNativePoolCandidate');

test('a deadline emits one terminal row and a later child-exit row', async () => {
  const rows = [], timing = createNativeTiming({ enabled: true, emit: row => rows.push(row) });
  const child = new EventEmitter(); child.send = (_message, callback) => callback(); child.kill = jest.fn();
  const pool = createIsolatedNativePoolCandidate({ maxSlots: 1, timing, spawn: () => child });
  const pending = pool.fetch('https://cdn.example.org/private?token=secret', { timeoutMs: 30 });
  await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ type: 'http_terminal', outcome: 'timeout', admitted: true, spawnReturned: true });
  child.emit('exit', 1);
  expect(rows[1]).toMatchObject({ type: 'child_exit', id: rows[0].id });
  child.emit('close', 1); expect(rows).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toMatch(/secret|example|private/);
  await pool.close();
});

test('a queue cancellation emits an unadmitted terminal row', async () => {
  const rows = [], timing = createNativeTiming({ enabled: true, emit: row => rows.push(row) });
  const child = new EventEmitter(); child.send = (_message, callback) => callback(); child.kill = jest.fn();
  const pool = createIsolatedNativePoolCandidate({ maxSlots: 1, timing, spawn: () => child });
  const first = pool.fetch('https://cdn.example.org/').catch(error => error);
  const controller = new AbortController();
  const queued = pool.fetch('https://cdn.example.org/', { signal: controller.signal });
  controller.abort(new DOMException('Canceled', 'AbortError'));
  await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  expect(rows[0]).toMatchObject({ type: 'http_terminal', outcome: 'canceled', admitted: false, spawnReturned: false });
  const closing = pool.close(); child.emit('exit', 1); await first; await closing;
});

test('a request aborted before admission is not reported as a queued wait', async () => {
  const rows = [], timing = createNativeTiming({ enabled: true, emit: row => rows.push(row), emitSummary: () => {} });
  const pool = createIsolatedNativePoolCandidate({ timing, spawn: () => { throw new Error('must not spawn'); } });
  const controller = new AbortController();
  controller.abort(new DOMException('Canceled', 'AbortError'));
  await expect(pool.fetch('https://example.test/', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(rows[0]).toMatchObject({ enqueued: false, admitted: false, queueMs: null });
  await pool.close();
});

test('an HTTP deadline spent entirely in the queue emits a terminal row without a child', async () => {
  const rows = [], timing = createNativeTiming({ enabled: true, emit: row => rows.push(row) });
  const child = new EventEmitter(); child.send = (_message, callback) => callback(); child.kill = jest.fn();
  const spawn = jest.fn(() => child);
  const pool = createIsolatedNativePoolCandidate({ maxSlots: 1, admissionWaitMs: 500, timing, spawn });
  const first = pool.fetch('https://example.test/', { timeoutMs: 1000 }).catch(error => error);
  try {
    await expect(pool.fetch('https://example.test/', { timeoutMs: 30 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'http_terminal', outcome: 'timeout', admitted: false, spawnReturned: false });
  } finally {
    const closing = pool.close(); child.emit('exit', 1); await first; await closing;
  }
});

test('a late child exit has the same opaque HTTP id after a deadline', () => {
  let clock = 100;
  const rows = [], timing = createNativeTiming({ enabled: true, now: () => clock, emit: row => rows.push(row) });
  const trace = timing.start();
  trace.enqueued();
  clock = 104; trace.admitted();
  clock = 109; trace.spawned();
  clock = 130; trace.finish(new DOMException('Deadline', 'TimeoutError'));
  clock = 175; trace.exited();
  expect(rows[0]).toMatchObject({ type: 'http_terminal', outcome: 'timeout', totalMs: 30, queueMs: 4 });
  expect(rows[1]).toMatchObject({ type: 'child_exit', id: rows[0].id, childLifetimeMs: 66 });
});

test('spawn call and observed spawn are separate measurements', () => {
  let clock = 10;
  const rows = [], timing = createNativeTiming({ enabled: true, now: () => clock, emit: row => rows.push(row) });
  const trace = timing.start();
  trace.enqueued();
  clock = 12; trace.admitted();
  clock = 15; trace.spawnAttempt();
  clock = 19; trace.spawned();
  clock = 25; trace.spawnObserved();
  clock = 30; trace.finish();
  expect(rows[0]).toMatchObject({ type: 'child_spawn_observed', sinceSpawnAttemptMs: 10 });
  expect(rows[1]).toMatchObject({ type: 'http_terminal', id: rows[0].id, spawnCallMs: 4 });
});

test('failed spawn emits a terminal row without claiming a completed spawn call', async () => {
  const rows = [], timing = createNativeTiming({ enabled: true, emit: row => rows.push(row), emitSummary: () => {} });
  const pool = createIsolatedNativePoolCandidate({ timing, spawn: () => { throw new Error('unavailable'); } });
  await expect(pool.fetch('https://example.test/')).rejects.toMatchObject({ code: 'ERR_NATIVE_UNAVAILABLE' });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ type: 'http_terminal', outcome: 'error', spawnReturned: false, spawnCallMs: null });
  await pool.close();
});

test('diagnostic event count is bounded and sink failures do not affect requests', () => {
  const rows = [], timing = createNativeTiming({ enabled: true, maxEvents: 1, emit: row => rows.push(row) });
  timing.start().finish(); timing.start().finish();
  expect(rows).toHaveLength(1); expect(timing.stats).toEqual({ emitted: 1, dropped: 1 });
  expect(() => createNativeTiming({ enabled: true, emit: () => { throw Error('sink failed'); } }).start().finish()).not.toThrow();
});

test('reentrant diagnostic sink cannot bypass event cap', () => {
  let timing;
  const rows = [];
  timing = createNativeTiming({ enabled: true, maxEvents: 1, emit: row => {
    rows.push(row);
    timing.start().finish();
  } });
  timing.start().finish();
  expect(rows).toHaveLength(1);
  expect(timing.stats).toEqual({ emitted: 1, dropped: 1 });
});

test('a sink rejection counts as a dropped event', () => {
  const timing = createNativeTiming({ enabled: true, emit: () => false });
  timing.start().finish();
  expect(timing.stats).toEqual({ emitted: 0, dropped: 1 });
});

test('start and terminal use the same id when start events are enabled', () => {
  const rows = [], timing = createNativeTiming({ enabled: true, emitStarts: true, emit: row => rows.push(row) });
  timing.start().finish();
  expect(rows.map(row => row.type)).toEqual(['http_start', 'http_terminal']);
  expect(rows[0].id).toBe(rows[1].id);
});

test('pool close emits a snapshot including dropped rows', async () => {
  const rows = [], summaries = [];
  const timing = createNativeTiming({ enabled: true, maxEvents: 1, emit: row => rows.push(row), emitSummary: row => summaries.push(row) });
  const child = new EventEmitter(); child.send = (_message, callback) => callback(); child.kill = jest.fn();
  const pool = createIsolatedNativePoolCandidate({ maxSlots: 1, timing, spawn: () => child });
  const pending = pool.fetch('https://example.test/').catch(error => error);
  child.emit('exit', 1);
  await pending;
  // Exit and request terminal each attempted a row; one exceeded the cap.
  await pool.close();
  expect(rows).toHaveLength(1);
  expect(summaries).toEqual([expect.objectContaining({ type: 'native_timing_summary', emitted: 1, dropped: 1,
    poolId: expect.stringMatching(/^[a-f0-9]{8}$/) })]);
});

test('receipt diagnostic does not consume the subsequent result message', async () => {
  let clock = 100;
  const rows = [], timing = createNativeTiming({ enabled: true, now: () => clock, emit: row => rows.push(row), emitSummary: () => {} });
  const child = new EventEmitter(); child.send = jest.fn((_message, callback) => callback()); child.kill = jest.fn();
  const pool = createIsolatedNativePoolCandidate({ maxSlots: 1, timing, spawn: () => child });
  const pending = pool.fetch('https://example.test/');
  expect(child.send.mock.calls[0][0].diagnostic).toBe(true);
  clock = 125; child.emit('message', { type: 'diagnostic', phase: 'request_received' });
  child.emit('message', { type: 'diagnostic', phase: 'fetch_start', hop: 0, childElapsedMs: 9 });
  child.emit('message', { type: 'result', status: 200, url: 'https://example.test/', headers: [], bytes: Buffer.from('ok'),
    diagnosticSnapshot: { attempted: 2, pending: 1, failed: 0, backpressure: 1, secret: 'ignored' } });
  expect(await (await pending).text()).toBe('ok');
  expect(rows[0]).toMatchObject({ type: 'child_request_received', sinceSpawnMs: 25 });
  expect(rows[1]).toMatchObject({ type: 'child_http_phase', phase: 'fetch_start', hop: 0, childElapsedMs: 9, id: rows[0].id });
  expect(rows[2]).toMatchObject({ type: 'http_terminal', outcome: 'success', id: rows[0].id });
  expect(rows[2].childDiagnosticSnapshot).toEqual({ attempted: 2, pending: 1, failed: 0, backpressure: 1 });
  expect(JSON.stringify(rows)).not.toContain('ignored');
  child.emit('exit', 0); await pool.close();
});

test('duplicate and invalid child phase events are counted and not emitted as valid phases', () => {
  const rows = [], timing = createNativeTiming({ enabled: true, emit: row => rows.push(row) });
  const trace = timing.start();
  trace.spawned();
  trace.childPhase('fetch_start', 0, 4);
  trace.childPhase('fetch_start', 0, 5);
  trace.childPhase('response_received', 9, 8);
  trace.finish();
  expect(rows.filter(row => row.type === 'child_http_phase')).toHaveLength(1);
  expect(rows.find(row => row.type === 'http_terminal')).toMatchObject({ duplicateChildEvents: 1, invalidChildEvents: 1 });
});
