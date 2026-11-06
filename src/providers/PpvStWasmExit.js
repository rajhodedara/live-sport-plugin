'use strict';

// Private PPV.st WASM subprocess protocol. Exit 75 is reserved for confirmed
// *local* transport admission failures. Every other child failure stays exit 1.
const LOCAL_CAPACITY_EXIT_CODE = 75;

function isLocalCapacityFailure(error) {
  let found = false;
  const seen = new Set();
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 8; current = current.cause, depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    const code = current.code || '';
    const capacity = code === 'ERR_OUTBOUND_CAPACITY' || /^ERR_NATIVE_(POOL|SLOT)_(BUSY|CAPACITY)$/.test(code);
    // Never turn a prohibited destination or another fatal transport error
    // into a retry by trusting an outer timeout/capacity wrapper.
    if (code === 'ERR_OUTBOUND_BLOCKED' || (current.isFatal === true && !capacity)) return false;
    if (capacity) found = true;
  }
  return found;
}

module.exports = { LOCAL_CAPACITY_EXIT_CODE, isLocalCapacityFailure };
