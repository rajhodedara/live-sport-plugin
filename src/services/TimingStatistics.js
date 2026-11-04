'use strict';
const { normalizeTimingSource } = require('./TimingRelations');

// Queue waits that never reached admission are not completed waits. Capacity
// rejection is reported separately from timeout/cancellation while waiting.
// Input is the already sanitized experimental JSON events, grouped by process.
function summarizeQueue(rows) {
  const sources = new Map(), terminals = new Map(), starts = new Set(), pools = new Set();
  let duplicateTerminals = 0, duplicateStarts = 0, invalidRows = 0, conflictingWorkSources = 0;
  const validPid = pid => Number.isSafeInteger(pid) && pid > 0;
  const validSession = session => typeof session === 'string' && /^[a-f0-9]{32}$/.test(session);
  const processKey = row => `${row.pid}:${row.sessionId}`;
  const validId = id => typeof id === 'string' && /^[a-f0-9]{16,32}$/.test(id);
  for (const row of rows) {
    if (!row || !validPid(row.pid) || !validSession(row.sessionId)) continue;
    if (row.type === 'source_mint_start' && validId(row.workId) && typeof row.source === 'string' && /^[a-z0-9_]{1,32}$/.test(row.source)) {
      const key = `${processKey(row)}:${row.workId}`, source = normalizeTimingSource(row.source);
      if (sources.has(key) && sources.get(key) !== source && sources.get(key) !== null) {
        sources.set(key, null); conflictingWorkSources++;
      } else if (!sources.has(key)) sources.set(key, source);
    }
  }
  for (const row of rows) {
    if (!row || !['http_terminal', 'http_start'].includes(row.type)) continue;
    if (!validPid(row.pid) || !validSession(row.sessionId) || !validId(row.id)) { invalidRows++; continue; }
    const key = `${processKey(row)}:${row.id}`;
    if (row.type === 'http_start') {
      if (starts.has(key)) duplicateStarts++;
      else starts.add(key);
      continue;
    }
    if (terminals.has(key)) { duplicateTerminals++; terminals.set(key, null); }
    else terminals.set(key, row);
  }
  const groups = new Map();
  let ambiguousTerminals = 0, terminalsWithoutPool = 0;
  const attribution = { noWorkId: 0, invalidWorkId: 0, missingMintStart: 0, conflictingSource: 0, attributed: 0 };
  const noWorkOwners = { catalog: 0, manifest: 0, wasm: 0, other: 0, unknown: 0 };
  for (const row of terminals.values()) {
    if (!row) { ambiguousTerminals++; continue; }
    if (typeof row.poolId === 'string' && /^[a-f0-9]{8}$/.test(row.poolId)) pools.add(`${processKey(row)}:${row.poolId}`);
    else terminalsWithoutPool++;
    const workKey = `${processKey(row)}:${row.workId}`;
    const source = validId(row.workId) && sources.has(workKey) ? sources.get(workKey) ?? 'ambiguous' : 'unknown';
    // No work ID can be legitimate non-mint traffic, or an absent context;
    // neither that case nor a missing event establishes a root cause.
    if (row.workId == null) {
      attribution.noWorkId++;
      const owner = ['catalog', 'manifest', 'wasm', 'other'].includes(row.owner) ? row.owner : 'unknown';
      noWorkOwners[owner]++;
    }
    else if (!validId(row.workId)) attribution.invalidWorkId++;
    else if (!sources.has(workKey)) attribution.missingMintStart++;
    else if (sources.get(workKey) === null) attribution.conflictingSource++;
    else attribution.attributed++;
    let group = groups.get(source);
    if (!group) { group = { source, total: 0, observedMs: [], censored: 0, capacityRejected: 0, missing: 0 }; groups.set(source, group); }
    group.total++;
    if (row.enqueued !== true || !Number.isFinite(row.queueMs) || row.queueMs < 0 || typeof row.admitted !== 'boolean') group.missing++;
    else if (!row.admitted && row.outcome === 'capacity') group.capacityRejected++;
    else if (!row.admitted && ['timeout', 'canceled'].includes(row.outcome)) group.censored++;
    else if (!row.admitted) group.missing++;
    else group.observedMs.push(row.queueMs);
  }
  return {
    groups: [...groups.values()].map(group => {
      group.observedMs.sort((a, b) => a - b);
      const count = group.observedMs.length;
      return { source: group.source, total: group.total, observed: count, censored: group.censored, capacityRejected: group.capacityRejected,
        missing: group.missing, p95ObservedMs: count ? group.observedMs[Math.ceil(count * 0.95) - 1] : null };
    }).sort((a, b) => a.source.localeCompare(b.source)),
    startsObserved: starts.size,
    startsWithoutTerminalObserved: [...starts].filter(key => !terminals.has(key)).length,
    terminalsWithoutStartObserved: [...terminals.keys()].filter(key => !starts.has(key)).length,
    observedPools: pools.size, terminalsWithoutPool,
    duplicateStarts, duplicateTerminals, ambiguousTerminals, conflictingWorkSources, invalidRows, attribution, noWorkOwners
  };
}

// All metrics are observed boundaries, not wire-level connect or TTFB. The
// first-hop intervals below use the child's own monotonic clock exclusively.
function summarizeHttpPhases(rows) {
  const sources = new Map(), terminals = new Map(), phases = new Map();
  const validId = id => typeof id === 'string' && /^[a-f0-9]{16,32}$/.test(id);
  const validProcess = row => Number.isSafeInteger(row.pid) && row.pid > 0 &&
    typeof row.sessionId === 'string' && /^[a-f0-9]{32}$/.test(row.sessionId);
  const processKey = row => `${row.pid}:${row.sessionId}`;
  const putOnce = (map, key, value) => { if (map.has(key)) map.set(key, null); else map.set(key, value); };
  const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  for (const row of rows) {
    if (!row || !validProcess(row)) continue;
    if (row.type === 'source_mint_start' && validId(row.workId) && typeof row.source === 'string') {
      const key = `${processKey(row)}:${row.workId}`, source = normalizeTimingSource(row.source);
      if (sources.has(key) && sources.get(key) !== source) sources.set(key, null);
      else if (!sources.has(key)) sources.set(key, source);
    }
    if (!validId(row.id)) continue;
    const key = `${processKey(row)}:${row.id}`;
    if (row.type === 'http_terminal') putOnce(terminals, key, row);
    if (row.type === 'child_spawn_observed') putOnce(phases, `${key}:spawn`, nonnegative(row.sinceSpawnAttemptMs));
    if (row.type === 'child_request_received') putOnce(phases, `${key}:receipt`, nonnegative(row.sinceSpawnMs));
    if (row.type === 'child_http_phase' && row.hop === 0 && ['fetch_start', 'response_received', 'body_read_end'].includes(row.phase)) {
      putOnce(phases, `${key}:${row.phase}`, nonnegative(row.childElapsedMs));
    }
  }
  const groups = new Map(), names = ['spawnCallMs', 'spawnObservedMs', 'childReceiptMs', 'firstHopResponseMs', 'firstHopBodyMs'];
  let ambiguousTerminals = 0;
  for (const [key, row] of terminals) {
    if (!row) { ambiguousTerminals++; continue; }
    const sourceKey = `${processKey(row)}:${row.workId}`;
    const source = validId(row.workId) && sources.has(sourceKey) ? sources.get(sourceKey) ?? 'ambiguous' : 'unknown';
    let group = groups.get(source);
    if (!group) {
      group = { source, total: 0, values: Object.fromEntries(names.map(name => [name, []])) };
      groups.set(source, group);
    }
    group.total++;
    // A duplicated or malformed child event makes child-side attribution
    // uncertain. Preserve parent-side spawn measurements but exclude child
    // receipt and phase intervals for that request.
    const childReliable = !(row.duplicateChildEvents > 0 || row.invalidChildEvents > 0);
    const start = childReliable ? phases.get(`${key}:fetch_start`) : null;
    const response = childReliable ? phases.get(`${key}:response_received`) : null;
    const body = childReliable ? phases.get(`${key}:body_read_end`) : null;
    const delta = (a, b) => typeof a === 'number' && typeof b === 'number' && b >= a ? b - a : null;
    const measurements = { spawnCallMs: nonnegative(row.spawnCallMs), spawnObservedMs: phases.get(`${key}:spawn`),
      childReceiptMs: childReliable ? phases.get(`${key}:receipt`) : null,
      firstHopResponseMs: delta(start, response), firstHopBodyMs: delta(response, body) };
    for (const name of names) if (typeof measurements[name] === 'number') group.values[name].push(measurements[name]);
  }
  return {
    groups: [...groups.values()].map(group => ({ source: group.source, total: group.total,
      metrics: Object.fromEntries(names.map(name => {
        const values = group.values[name].sort((a, b) => a - b), observed = values.length;
        return [name, { observed, unavailable: group.total - observed,
          p95ObservedMs: observed ? values[Math.ceil(observed * 0.95) - 1] : null }];
      })) })).sort((a, b) => a.source.localeCompare(b.source)),
    ambiguousTerminals
  };
}

module.exports = { summarizeQueue, summarizeHttpPhases };
