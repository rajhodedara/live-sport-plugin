'use strict';

// Diagnostic snapshots are best effort. The timer never keeps a worker alive
// and diagnostic failures must not alter the transport or shutdown path.
function startTimingSnapshotTimer(report, intervalMs = 30000) {
  const timer = setInterval(() => { try { report(); } catch (_) {} }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startTimingSnapshotTimer };
