'use strict';

const { randomBytes } = require('node:crypto');
const SOURCES = new Set(['leaf', 'daddylive', 'vavoo', 'sktech', 'ppvst', 'damitv', 'ak47live',
  'golf', 'delta', 'echo', 'replayzone', 'livetv', 'soccerfull', 'basketballvideo', 'nflvideo',
  'fullraces', 'hockeyreplays', 'mlblive', 'watchfooty', 'cdnlive', 'streamsports99',
  'timstreams', 'streamsports', 'admin', 'streamedpk', 'embedindia', 'embedst']);
const normalizeTimingSource = source => SOURCES.has(source) ? source : 'other';

// Experimental opt-in. IDs never derive from matches, keys or URLs.
function createTimingRelations({ emit = () => {}, emitSummary = () => {}, maxEvents = 1000, id = () => randomBytes(16).toString('hex'), now = () => performance.now() } = {}) {
  let emitted = 0, dropped = 0, pending = 0;
  const streamIds = new WeakSet(), workIds = new WeakSet();
  const links = new WeakMap(), starts = new WeakMap(), workStarts = new WeakMap(), mintStarts = new WeakMap(), workSources = new WeakMap();
  function publish(row) {
    if (emitted + pending >= maxEvents) { dropped++; return; }
    pending++;
    try { if (emit(row) === false) dropped++; else emitted++; } catch (_) { dropped++; } finally { pending--; }
  }
  function make(registry) {
    const handle = Object.freeze({ id: id() });
    registry.add(handle);
    return handle;
  }
  return {
    stream() { const handle = make(streamIds); starts.set(handle, now()); return handle; },
    work(source) {
      const handle = make(workIds);
      workStarts.set(handle, now());
      workSources.set(handle, normalizeTimingSource(source));
      return handle;
    },
    link(stream, work) {
      if (!streamIds.has(stream) || !workIds.has(work)) return false;
      let seen = links.get(stream);
      if (!seen) { seen = new WeakSet(); links.set(stream, seen); }
      if (seen.has(work)) return false;
      seen.add(work);
      publish({ type: 'stream_work_link', streamId: stream.id, workId: work.id });
      return true;
    },
    endWindow(stream, sourceCount, unsettledCount, reason = 'unknown') {
      if (!streamIds.has(stream) || !starts.has(stream) || !Number.isSafeInteger(sourceCount) || sourceCount < 0 ||
          !Number.isSafeInteger(unsettledCount) || unsettledCount < 0 || unsettledCount > sourceCount ||
          !['unknown', 'all_settled', 'early_return', 'priority_completed', 'hard_wait_expired', 'budget_exhausted'].includes(reason)) return false;
      const started = starts.get(stream);
      starts.delete(stream);
      const ended = now();
      publish({ type: 'stream_resolution_window_end', streamId: stream.id,
        observedAtMs: Math.round(ended), durationMs: Math.max(0, Math.round(ended - started)), sourceCount, unsettledCount, reason });
      return true;
    },
    endWork(work) {
      if (!workIds.has(work) || !workStarts.has(work)) return false;
      const started = workStarts.get(work), ended = now();
      workStarts.delete(work);
      publish({ type: 'cache_operation_end', workId: work.id,
        observedAtMs: Math.round(ended), durationMs: Math.max(0, Math.round(ended - started)) });
      return true;
    },
    startMint(work) {
      if (!workIds.has(work) || !workStarts.has(work) || mintStarts.has(work)) return false;
      const started = now();
      mintStarts.set(work, started);
      publish({ type: 'source_mint_start', workId: work.id, source: workSources.get(work), observedAtMs: Math.round(started) });
      return true;
    },
    endMint(work, outcome) {
      if (!workIds.has(work) || !mintStarts.has(work) || !['returned', 'threw'].includes(outcome)) return false;
      const started = mintStarts.get(work), ended = now();
      mintStarts.delete(work);
      publish({ type: 'source_mint_end', workId: work.id, source: workSources.get(work), observedAtMs: Math.round(ended),
        durationMs: Math.max(0, Math.round(ended - started)), outcome });
      return true;
    },
    report() {
      try { emitSummary({ type: 'stream_timing_summary', emitted, dropped }); } catch (_) { /* diagnostic only */ }
    },
    get stats() { return { emitted, dropped }; }
  };
}

module.exports = { createTimingRelations, normalizeTimingSource };
