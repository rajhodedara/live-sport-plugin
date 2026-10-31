'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
// The bundle and copied services can load separate module instances. Share
// one context per JS isolate so a source operation and its transport agree.
const contextKey = Symbol.for('nuvio.guardedTiming.context.v1');
const storage = globalThis[contextKey] || (globalThis[contextKey] = new AsyncLocalStorage());

// Only opaque generated IDs are eligible for diagnostics. This context is
// scoped to the mint itself, not to shared-cache lookups or polling.
function withTimingWork(work, fn) {
  if (!work || typeof work.id !== 'string' || !/^[a-f0-9]{32}$/.test(work.id)) {
    return storage.getStore() ? storage.run(null, fn) : fn();
  }
  return storage.run(work.id, fn);
}
function currentTimingWork() { return storage.getStore() || null; }

module.exports = { withTimingWork, currentTimingWork };
