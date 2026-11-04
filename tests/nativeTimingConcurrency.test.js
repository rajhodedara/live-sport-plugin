'use strict';
const { EventEmitter } = require('node:events');
const { createNativeTiming } = require('../src/services/NativeTiming');
const { createIsolatedNativePoolCandidate } = require('../src/services/IsolatedNativePoolCandidate');

test.each([4, 6])('synthetic concurrency with %i slots emits one HTTP terminal and one exit per request', async maxSlots => {
  const rows = [];
  const timing = createNativeTiming({ enabled: true, emitStarts: true, emit: row => rows.push(row), emitSummary: () => {} });
  let active = 0, peak = 0;
  const pool = createIsolatedNativePoolCandidate({ maxSlots, admissionWaitMs: 3000, maxWaiters: 128, timing, spawn: () => {
    const child = new EventEmitter();
    active++; peak = Math.max(peak, active);
    child.send = (_request, callback) => {
      callback();
      setImmediate(() => {
        child.emit('spawn');
        child.emit('message', { type: 'result', status: 200, url: 'https://example.test/', headers: [], bytes: Buffer.from('ok') });
      });
    };
    let killed = false;
    child.kill = () => {
      if (!killed) { killed = true; setImmediate(() => { active--; child.emit('exit', 0); }); }
    };
    return child;
  } });
  try {
    const results = await Promise.all(Array.from({ length: 80 }, () => pool.fetch('https://example.test/private', { timeoutMs: 5000 })));
    expect(results).toHaveLength(80);
  } finally { await pool.close(); }
  const terminal = rows.filter(row => row.type === 'http_terminal');
  const starts = rows.filter(row => row.type === 'http_start');
  const exits = rows.filter(row => row.type === 'child_exit');
  expect(terminal).toHaveLength(80);
  expect(starts).toHaveLength(80);
  expect(exits).toHaveLength(80);
  expect(new Set(terminal.map(row => row.id)).size).toBe(80);
  expect(new Set(starts.map(row => row.id))).toEqual(new Set(terminal.map(row => row.id)));
  expect(new Set(exits.map(row => row.id))).toEqual(new Set(terminal.map(row => row.id)));
  expect(timing.stats.dropped).toBe(0);
  expect(peak).toBeLessThanOrEqual(maxSlots);
  expect(active).toBe(0);
  expect(JSON.stringify(rows)).not.toMatch(/example|private/);
}, 15000);
