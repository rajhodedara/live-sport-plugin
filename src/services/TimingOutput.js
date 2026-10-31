'use strict';
const { randomBytes } = require('node:crypto');

// Bounded by the writable's own high-water mark: once write() signals
// backpressure, reject new events until drain. A false write return still means
// that particular chunk was accepted by Node, not that it was delivered.
function createTimingOutput(writable) {
  const sessionId = randomBytes(16).toString('hex');
  let blocked = false, closed = false, writing = false, accepted = 0, rejected = 0, failed = 0;
  writable.on('error', () => { closed = true; });
  return {
    get identity() { return { pid: process.pid, sessionId }; },
    write(kind, row) {
      if (closed || blocked || writing || writable.destroyed || writable.writableEnded) { rejected++; return false; }
      let line;
      try { line = JSON.stringify({ ...row, kind, pid: process.pid, sessionId }) + '\n'; }
      catch (_) { rejected++; return false; }
      writing = true;
      try {
        const ready = writable.write(line, error => { if (error) failed++; });
        accepted++;
        if (!ready) {
          blocked = true;
          writable.once('drain', () => { blocked = false; });
        }
        return true;
      } catch (_) { rejected++; return false; } finally { writing = false; }
    },
    get stats() { return { accepted, rejected, failed }; }
  };
}

const outputKey = Symbol.for('nuvio.guardedTiming.output.v1');
function sharedTimingOutput() {
  if (!globalThis[outputKey]) {
    const shared = createTimingOutput(process.stdout);
    globalThis[outputKey] = shared;
    const report = () => { try { console.info('[TimingOutputSummary]', JSON.stringify({ ...shared.stats, ...shared.identity })); } catch (_) {} };
    const stopSnapshots = require('./TimingSnapshotTimer').startTimingSnapshotTimer(report);
    process.once('exit', () => {
      // Best effort: a forced termination or a broken stdout can lose this.
      stopSnapshots(); report();
    });
  }
  return globalThis[outputKey];
}

module.exports = { createTimingOutput, sharedTimingOutput };
