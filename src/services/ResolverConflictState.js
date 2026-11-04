'use strict';

// Process/isolate-local observation only. It is not resolver identity and is
// not shared across PM2 workers. Once a bind conflict is confirmed, this
// worker stays blocked until restart.
const key = Symbol.for('nuvio.resolverPortConflict.v1');
if (!globalThis[key]) globalThis[key] = { conflict: false, controller: new AbortController() };

function markConflict() {
  globalThis[key].conflict = true;
  if (!globalThis[key].controller.signal.aborted) {
    globalThis[key].controller.abort(new DOMException('Resolver port conflict', 'AbortError'));
  }
}
function hasConflict() { return globalThis[key].conflict === true; }
function signal() { return globalThis[key].controller.signal; }

module.exports = { markConflict, hasConflict, signal };
