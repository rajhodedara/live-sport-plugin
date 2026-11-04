'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { summarizeQueue, summarizeHttpPhases } = require('../src/services/TimingStatistics');

const MAX_TIMING_RECORDS = 250000;
const MAX_LINE_BYTES = 8192;
const MARKERS = {
  '[NativeTimingSummary]': 'native',
  '[StreamTimingSummary]': 'stream',
  '[TimingOutputSummary]': 'output'
};

function decodeLine(line) {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return null;
  const trimmed = line.trim();
  for (const [marker, kind] of Object.entries(MARKERS)) {
    if (!trimmed.startsWith(marker)) continue;
    try { return { kind: 'summary', summaryKind: kind, value: JSON.parse(trimmed.slice(marker.length)) }; }
    catch (_) { return null; }
  }
  try {
    const value = JSON.parse(trimmed);
    if (!value || !['native_timing', 'stream_timing'].includes(value.kind)) return null;
    if (!['http_start', 'http_terminal', 'source_mint_start', 'stream_resolution_window_end', 'child_spawn_observed',
      'child_request_received', 'child_http_phase'].includes(value.type)) return { kind: 'other_timing' };
    const shortString = item => typeof item === 'string' && item.length <= 64 ? item : null;
    return { kind: 'event', value: { type: value.type, pid: Number.isSafeInteger(value.pid) ? value.pid : null, sessionId: shortString(value.sessionId),
      id: shortString(value.id), workId: shortString(value.workId), poolId: shortString(value.poolId), source: shortString(value.source),
      owner: ['manifest', 'wasm', 'catalog', 'other'].includes(value.owner) ? value.owner : null,
      streamId: shortString(value.streamId), durationMs: value.durationMs, sourceCount: value.sourceCount, unsettledCount: value.unsettledCount,
      reason: ['all_settled', 'early_return', 'priority_completed', 'hard_wait_expired', 'budget_exhausted'].includes(value.reason) ? value.reason : 'unknown',
      outcome: ['success', 'timeout', 'canceled', 'capacity', 'error'].includes(value.outcome) ? value.outcome : null,
      phase: ['fetch_start', 'response_received', 'body_read_end'].includes(value.phase) ? value.phase : null,
      hop: Number.isSafeInteger(value.hop) && value.hop >= 0 && value.hop <= 5 ? value.hop : null,
      childElapsedMs: Number.isSafeInteger(value.childElapsedMs) && value.childElapsedMs >= 0 ? value.childElapsedMs : null,
      sinceSpawnAttemptMs: Number.isSafeInteger(value.sinceSpawnAttemptMs) && value.sinceSpawnAttemptMs >= 0 ? value.sinceSpawnAttemptMs : null,
      sinceSpawnMs: Number.isSafeInteger(value.sinceSpawnMs) && value.sinceSpawnMs >= 0 ? value.sinceSpawnMs : null,
      spawnCallMs: Number.isSafeInteger(value.spawnCallMs) && value.spawnCallMs >= 0 ? value.spawnCallMs : null,
      duplicateChildEvents: Number.isSafeInteger(value.duplicateChildEvents) && value.duplicateChildEvents >= 0 ? value.duplicateChildEvents : null,
      invalidChildEvents: Number.isSafeInteger(value.invalidChildEvents) && value.invalidChildEvents >= 0 ? value.invalidChildEvents : null,
      enqueued: typeof value.enqueued === 'boolean' ? value.enqueued : null,
      admitted: typeof value.admitted === 'boolean' ? value.admitted : null,
      queueMs: typeof value.queueMs === 'number' && Number.isFinite(value.queueMs) ? value.queueMs : null } };
  } catch (_) { return null; }
}

async function summarizeStream(input, limit = MAX_TIMING_RECORDS) {
  const rows = [], snapshots = { native: 0, stream: 0, output: 0 };
  const snapshotObservations = { native: 0, stream: 0, output: 0 };
  const losses = { nativeDropped: 0, streamDropped: 0, outputRejected: 0, outputFailed: 0 };
  const snapshotGroups = new Map();
  let ignoredLines = 0, otherTimingEvents = 0, invalidSnapshots = 0, repeatedSnapshots = 0, truncated = false;
  const validNumber = value => Number.isSafeInteger(value) && value >= 0;
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    const decoded = decodeLine(line);
    if (!decoded) { ignoredLines++; continue; }
    if (decoded.kind === 'other_timing') { otherTimingEvents++; continue; }
    if (decoded.kind === 'event') {
      if (rows.length >= limit) { truncated = true; continue; }
      rows.push(decoded.value);
      continue;
    }
    const v = decoded.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) { ignoredLines++; continue; }
    if ((decoded.summaryKind === 'native' || decoded.summaryKind === 'stream') && !validNumber(v.dropped) ||
        decoded.summaryKind === 'output' && (!validNumber(v.rejected) || !validNumber(v.failed)) ||
        !Number.isSafeInteger(v.pid) || v.pid < 1 || typeof v.sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(v.sessionId) ||
        decoded.summaryKind === 'native' && (typeof v.poolId !== 'string' || !/^[a-f0-9]{8}$/.test(v.poolId))) {
      invalidSnapshots++;
      continue;
    }
    const key = `${decoded.summaryKind}:${v.pid}:${v.sessionId}:${decoded.summaryKind === 'native' ? v.poolId : ''}`;
    const previous = snapshotGroups.get(key);
    snapshotObservations[decoded.summaryKind]++;
    // A later snapshot from the same writer is expected. Without a snapshot
    // identity we cannot distinguish an actual duplicate from equal counters.
    if (previous) repeatedSnapshots++;
    snapshotGroups.set(key, { kind: decoded.summaryKind,
      dropped: Math.max(previous?.dropped || 0, v.dropped || 0),
      rejected: Math.max(previous?.rejected || 0, v.rejected || 0),
      failed: Math.max(previous?.failed || 0, v.failed || 0) });
  }
  for (const snapshot of snapshotGroups.values()) {
    snapshots[snapshot.kind]++;
    if (snapshot.kind === 'native') losses.nativeDropped += snapshot.dropped;
    if (snapshot.kind === 'stream') losses.streamDropped += snapshot.dropped;
    if (snapshot.kind === 'output') { losses.outputRejected += snapshot.rejected; losses.outputFailed += snapshot.failed; }
  }
  // No observed snapshot is unknown, not evidence of zero loss. Even a
  // present snapshot only covers its observed writer/pool and time interval.
  if (!snapshots.native) losses.nativeDropped = null;
  if (!snapshots.stream) losses.streamDropped = null;
  if (!snapshots.output) { losses.outputRejected = null; losses.outputFailed = null; }
  return { timingRecords: rows.length, truncated, ignoredLines, otherTimingEvents, invalidSnapshots, repeatedSnapshots, snapshots, snapshotObservations, losses,
    // Counts can overlap; do not add nativeDropped and outputRejected together.
    // Missing summaries, unfinished work, accepted writes and forced exit leave
    // completeness unknown even if all observed counts are zero.
    completeness: 'unknown', queue: summarizeQueue(rows), phases: summarizeHttpPhases(rows), streamWindows: summarizeStreamWindows(rows) };
}

// An end event alone cannot prove a stream deadline fired or that missing
// windows did not occur. Reject duplicates and malformed counts, and report
// only the ends actually observed, scoped by writer session to avoid PID reuse.
function summarizeStreamWindows(rows) {
  const windows = new Map();
  let invalid = 0, duplicate = 0;
  for (const row of rows) {
    if (row.type !== 'stream_resolution_window_end') continue;
    if (!Number.isSafeInteger(row.pid) || row.pid < 1 || !/^[a-f0-9]{32}$/.test(row.sessionId || '') ||
        !/^[a-f0-9]{32}$/.test(row.streamId || '') || !Number.isSafeInteger(row.durationMs) || row.durationMs < 0 ||
        !Number.isSafeInteger(row.sourceCount) || row.sourceCount < 0 || !Number.isSafeInteger(row.unsettledCount) ||
        row.unsettledCount < 0 || row.unsettledCount > row.sourceCount) { invalid++; continue; }
    const key = `${row.pid}:${row.sessionId}:${row.streamId}`;
    if (windows.has(key)) { windows.set(key, null); duplicate++; } else windows.set(key, row);
  }
  const valid = [...windows.values()].filter(Boolean);
  const durations = valid.map(row => row.durationMs).sort((a, b) => a - b);
  const reasons = { all_settled: 0, early_return: 0, priority_completed: 0, hard_wait_expired: 0, budget_exhausted: 0, unknown: 0 };
  for (const row of valid) reasons[row.reason]++;
  return { observed: valid.length, withUnsettledSources: valid.filter(row => row.unsettledCount > 0).length, reasons,
    unsettledSources: valid.reduce((sum, row) => sum + row.unsettledCount, 0),
    p95ObservedDurationMs: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
    invalid, duplicate, ambiguous: windows.size - valid.length };
}

if (require.main === module) {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length !== 3) {
    console.error('Usage: node scripts/summarize-native-timing.js <log-file>');
    process.exitCode = 2;
  } else {
    summarizeStream(fs.createReadStream(inputPath, { encoding: 'utf8' })).then(report => {
      console.log(JSON.stringify(report, null, 2));
    }).catch(() => { console.error('Unable to read timing log'); process.exitCode = 1; });
  }
}

module.exports = { decodeLine, summarizeStream };
