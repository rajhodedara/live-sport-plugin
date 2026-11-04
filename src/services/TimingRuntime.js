'use strict';
const { createTimingRelations } = require('./TimingRelations');
const { sharedTimingOutput } = require('./TimingOutput');

// Deliberately separate experimental opt-in; not yet suitable for load tests.
const key = Symbol.for('nuvio.guardedTiming.relations.v1');
let relations = null;
if (process.env.STREAM_TIMING_EXPERIMENT === 'true') {
  if (!globalThis[key]) {
    const created = createTimingRelations({ maxEvents: 100000, emit: row => sharedTimingOutput().write('stream_timing', row),
      emitSummary: row => console.info('[StreamTimingSummary]', JSON.stringify({ ...row, ...sharedTimingOutput().identity })) });
    globalThis[key] = created;
    const stopSnapshots = require('./TimingSnapshotTimer').startTimingSnapshotTimer(() => created.report());
    process.once('exit', () => { stopSnapshots(); created.report(); });
  }
  relations = globalThis[key];
}

module.exports = { relations };
