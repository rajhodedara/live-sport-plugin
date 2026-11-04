'use strict';
const { summarizeQueue: summarizeRaw, summarizeHttpPhases } = require('../src/services/TimingStatistics');
const sessionId = 'b'.repeat(32);
const summarizeQueue = rows => summarizeRaw(rows.map(row => ({ sessionId, ...row })));
const workId = 'a'.repeat(32);
const id = n => n.toString(16).padStart(16, '0');

test('queue p95 uses admitted observations and reports canceled waits separately', () => {
  const rows = [
    { pid: 1, type: 'source_mint_start', workId, source: 'damitv' },
    { pid: 1, type: 'http_terminal', id: id(1), workId, enqueued: true, admitted: true, queueMs: 4 },
    { pid: 1, type: 'http_terminal', id: id(2), workId, enqueued: true, admitted: false, outcome: 'timeout', queueMs: 5000 },
    { pid: 1, type: 'http_terminal', id: id(3), workId, enqueued: true, admitted: true, queueMs: null }
  ];
  expect(summarizeQueue(rows)).toEqual({ groups: [{ source: 'damitv', total: 3, observed: 1, censored: 1, capacityRejected: 0,
    missing: 1, p95ObservedMs: 4 }], startsObserved: 0, startsWithoutTerminalObserved: 0,
    terminalsWithoutStartObserved: 3, observedPools: 0, terminalsWithoutPool: 3,
    duplicateStarts: 0, duplicateTerminals: 0, ambiguousTerminals: 0, conflictingWorkSources: 0, invalidRows: 0,
    attribution: { noWorkId: 0, invalidWorkId: 0, missingMintStart: 0, conflictingSource: 0, attributed: 3 },
    noWorkOwners: { catalog: 0, manifest: 0, wasm: 0, other: 0, unknown: 0 } });
});

test('unknown attribution distinguishes absent work IDs from missing mint events without guessing cause', () => {
  const base = { pid: 1, type: 'http_terminal', enqueued: true, admitted: true, queueMs: 1 };
  const rows = [{ ...base, id: id(1) }, { ...base, id: id(2), workId: 'bad' },
    { ...base, id: id(3), workId }, { ...base, id: id(4), workId: 'c'.repeat(32) },
    { pid: 1, type: 'source_mint_start', workId: 'c'.repeat(32), source: 'damitv' }];
  expect(summarizeQueue(rows).attribution).toEqual({ noWorkId: 1, invalidWorkId: 1, missingMintStart: 1,
    conflictingSource: 0, attributed: 1 });
});

test('no-work traffic is broken down only by explicitly allowlisted owner labels', () => {
  const base = { pid: 1, type: 'http_terminal', enqueued: true, admitted: true, queueMs: 1 };
  const report = summarizeQueue([{ ...base, id: id(1), owner: 'catalog' },
    { ...base, id: id(2), owner: 'manifest' }, { ...base, id: id(3), owner: 'secret' }, { ...base, id: id(4) }]);
  expect(report.noWorkOwners).toEqual({ catalog: 1, manifest: 1, wasm: 0, other: 0, unknown: 2 });
  expect(JSON.stringify(report)).not.toContain('secret');
});

test('reports unmatched starts and terminals without assuming why they are missing', () => {
  const rows = [
    { pid: 1, type: 'http_start', id: id(1) }, { pid: 1, type: 'http_start', id: id(1) },
    { pid: 1, type: 'http_start', id: id(2) },
    { pid: 1, type: 'http_terminal', id: id(1), enqueued: true, admitted: true, queueMs: 1 },
    { pid: 1, type: 'http_terminal', id: id(3), enqueued: true, admitted: true, queueMs: 3 }
  ];
  expect(summarizeQueue(rows)).toMatchObject({ startsObserved: 2, startsWithoutTerminalObserved: 1,
    terminalsWithoutStartObserved: 1, duplicateStarts: 1 });
});

test('duplicate terminals are excluded and collisions across processes remain distinct', () => {
  const row = { pid: 1, type: 'http_terminal', id: id(1), enqueued: true, admitted: true, queueMs: 5 };
  const result = summarizeQueue([row, row, { ...row, pid: 2, queueMs: 9 }, { ...row, id: 'private' }]);
  expect(result.groups).toEqual([{ source: 'unknown', total: 1, observed: 1, censored: 0, capacityRejected: 0, missing: 0, p95ObservedMs: 9 }]);
  expect(result).toMatchObject({ duplicateTerminals: 1, ambiguousTerminals: 1, invalidRows: 1 });
});

test('a recycled PID in another session does not merge requests', () => {
  const row = { pid: 1, sessionId, type: 'http_terminal', id: id(1), enqueued: true, admitted: true, queueMs: 5 };
  const result = summarizeRaw([row, { ...row, sessionId: 'c'.repeat(32), queueMs: 9 }]);
  expect(result.groups[0]).toMatchObject({ total: 2, observed: 2, p95ObservedMs: 9 });
  expect(result).toMatchObject({ duplicateTerminals: 0, invalidRows: 0 });
});

test('pool counts distinguish separate workers and identify missing pool IDs', () => {
  const base = { sessionId, type: 'http_terminal', enqueued: true, admitted: true, queueMs: 1 };
  const rows = [{ ...base, pid: 1, id: id(1), poolId: 'aabbccdd' },
    { ...base, pid: 2, id: id(2), poolId: 'aabbccdd' }, { ...base, pid: 1, id: id(3) }];
  expect(summarizeRaw(rows)).toMatchObject({ observedPools: 2, terminalsWithoutPool: 1 });
});

test('a group with no admitted request has no p95', () => {
  expect(summarizeQueue([{ pid: 1, type: 'http_terminal', id: id(2), enqueued: true, admitted: false, outcome: 'timeout', queueMs: 100 }]).groups[0])
    .toMatchObject({ total: 1, observed: 0, censored: 1, p95ObservedMs: null });
});

test('capacity rejections are separate from timeout and cancellation', () => {
  const base = { pid: 1, type: 'http_terminal', enqueued: true, admitted: false, queueMs: 0 };
  const group = summarizeQueue([{ ...base, id: id(1), outcome: 'capacity' },
    { ...base, id: id(2), outcome: 'timeout' }, { ...base, id: id(3), outcome: 'error' }]).groups[0];
  expect(group).toMatchObject({ total: 3, observed: 0, capacityRejected: 1, censored: 1, missing: 1, p95ObservedMs: null });
});

test('untrusted source labels in input cannot become report fields', () => {
  const result = summarizeQueue([{ pid: 1, type: 'source_mint_start', workId, source: 'secretcredential' },
    { pid: 1, type: 'http_terminal', id: id(4), workId, enqueued: true, admitted: true, queueMs: 1 }]);
  expect(result.groups[0].source).toBe('other');
  expect(JSON.stringify(result)).not.toContain('secretcredential');
});

test('conflicting source labels do not assign a request to either source', () => {
  const rows = [{ pid: 1, type: 'source_mint_start', workId, source: 'damitv' },
    { pid: 1, type: 'source_mint_start', workId, source: 'daddylive' },
    { pid: 1, type: 'source_mint_start', workId, source: 'damitv' },
    { pid: 1, type: 'http_terminal', id: id(4), workId, enqueued: true, admitted: true, queueMs: 1 }];
  const report = summarizeQueue(rows);
  expect(report.groups).toEqual([expect.objectContaining({ source: 'ambiguous', total: 1 })]);
  expect(report.conflictingWorkSources).toBe(1);
});

test('phase metrics use child-local boundaries and report unavailable samples', () => {
  const base = { pid: 1, sessionId }, first = id(1), second = id(2);
  const rows = [
    { ...base, type: 'source_mint_start', workId, source: 'damitv' },
    { ...base, type: 'http_terminal', id: first, workId, spawnCallMs: 4 },
    { ...base, type: 'http_terminal', id: second, workId, spawnCallMs: null },
    { ...base, type: 'child_spawn_observed', id: first, sinceSpawnAttemptMs: 7 },
    { ...base, type: 'child_request_received', id: first, sinceSpawnMs: 8 },
    { ...base, type: 'child_http_phase', id: first, hop: 0, phase: 'fetch_start', childElapsedMs: 100 },
    { ...base, type: 'child_http_phase', id: first, hop: 0, phase: 'response_received', childElapsedMs: 150 },
    { ...base, type: 'child_http_phase', id: first, hop: 0, phase: 'body_read_end', childElapsedMs: 180 }
  ];
  const group = summarizeHttpPhases(rows).groups[0];
  expect(group).toMatchObject({ source: 'damitv', total: 2, metrics: {
    spawnCallMs: { observed: 1, unavailable: 1, p95ObservedMs: 4 },
    spawnObservedMs: { observed: 1, unavailable: 1, p95ObservedMs: 7 },
    childReceiptMs: { observed: 1, unavailable: 1, p95ObservedMs: 8 },
    firstHopResponseMs: { observed: 1, unavailable: 1, p95ObservedMs: 50 },
    firstHopBodyMs: { observed: 1, unavailable: 1, p95ObservedMs: 30 }
  } });
  rows.push({ ...base, type: 'child_http_phase', id: first, hop: 0, phase: 'response_received', childElapsedMs: 151 });
  const ambiguous = summarizeHttpPhases(rows).groups[0];
  expect(ambiguous.metrics.firstHopResponseMs).toMatchObject({ observed: 0, unavailable: 2, p95ObservedMs: null });
  expect(ambiguous.metrics.firstHopBodyMs).toMatchObject({ observed: 0, unavailable: 2, p95ObservedMs: null });
});

test('a duplicate flagged by the child trace excludes child intervals but not parent spawn', () => {
  const base = { pid: 1, sessionId }, requestId = id(1);
  const rows = [{ ...base, type: 'http_terminal', id: requestId, spawnCallMs: 2, duplicateChildEvents: 1 },
    { ...base, type: 'child_request_received', id: requestId, sinceSpawnMs: 5 },
    { ...base, type: 'child_http_phase', id: requestId, hop: 0, phase: 'fetch_start', childElapsedMs: 10 },
    { ...base, type: 'child_http_phase', id: requestId, hop: 0, phase: 'response_received', childElapsedMs: 20 }];
  const metrics = summarizeHttpPhases(rows).groups[0].metrics;
  expect(metrics.spawnCallMs).toMatchObject({ observed: 1, p95ObservedMs: 2 });
  expect(metrics.childReceiptMs).toMatchObject({ observed: 0, unavailable: 1 });
  expect(metrics.firstHopResponseMs).toMatchObject({ observed: 0, unavailable: 1 });
});
