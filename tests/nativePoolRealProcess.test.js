'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { createIsolatedNativePoolCandidate } = require('../src/services/IsolatedNativePoolCandidate');
const { createNativeTiming } = require('../src/services/NativeTiming');

test('a real IPC child releases its slot after exit and another request can run', async () => {
  const children = [];
  const pool = createIsolatedNativePoolCandidate({ maxSlots: 1, admissionWaitMs: 2000, spawn: () => {
    const child = fork(path.join(__dirname, 'fixtures/native-pool-child.cjs'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced'
    });
    children.push(child);
    return child;
  } });
  try {
    const first = await pool.fetch('https://example.test/', { timeoutMs: 5000 });
    expect(await first.text()).toBe('fixture');
    const second = await pool.fetch('https://example.test/', { timeoutMs: 5000 });
    expect(await second.text()).toBe('fixture');
    expect(children).toHaveLength(2);
  } finally {
    await pool.close();
  }
  expect(pool.occupied).toBe(0);
  expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
}, 15000);

test('real IPC preserves correlation across receipt, result and child exit', async () => {
  const rows = [], summaries = [];
  const timing = createNativeTiming({ enabled: true, emit: row => rows.push(row), emitSummary: row => summaries.push(row) });
  const pool = createIsolatedNativePoolCandidate({ maxSlots: 1, timing, spawn: () =>
    fork(path.join(__dirname, 'fixtures/native-pool-child.cjs'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced'
    }) });
  try {
    const response = await pool.fetch('https://example.test/private', { timeoutMs: 5000 });
    expect(await response.text()).toBe('fixture');
  } finally { await pool.close(); }
  expect(rows.map(row => row.type)).toEqual(['child_spawn_observed', 'child_request_received',
    'child_http_phase', 'child_http_phase', 'child_http_phase', 'http_terminal', 'child_exit']);
  expect(new Set(rows.map(row => row.id)).size).toBe(1);
  expect(rows[5].outcome).toBe('success');
  expect(rows.slice(2, 5).map(row => row.childElapsedMs)).toEqual([3, 7, 12]);
  expect(summaries[0]).toMatchObject({ emitted: 7, dropped: 0 });
  expect(JSON.stringify(rows)).not.toMatch(/example|private/);
}, 15000);
