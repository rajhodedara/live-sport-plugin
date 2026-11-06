'use strict';

// Private PPV.st WASM subprocess protocol. These statuses carry only typed
// inconclusive transport outcomes; ordinary extraction failures stay exit 1.
const LOCAL_CAPACITY_EXIT_CODE = 75;
const LOCAL_TIMEOUT_EXIT_CODE = 76;
const LOCAL_CANCELLED_EXIT_CODE = 77;
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'
]);

function wasmFailureExitCode(error) {
  if (!error || typeof error !== 'object') return 1;
  try {
    const chain = [], seen = new Set();
    for (let current = error; current && typeof current === 'object'; current = current.cause) {
      // A truncated chain has not established that a deeper guard/fatal error
      // is absent. Cycles and unreadable error properties fail closed as well.
      if (seen.has(current) || chain.length >= 8) return 1;
      seen.add(current);
      chain.push(current);
    }
    const capacity = item => item.code === 'ERR_OUTBOUND_CAPACITY' ||
      /^ERR_NATIVE_(POOL|SLOT)_(BUSY|CAPACITY)$/.test(item.code || '');
    if (chain.some(item => item.code === 'ERR_OUTBOUND_BLOCKED' ||
      (item.isFatal === true && !capacity(item)))) return 1;
    if (chain.some(item => item.name === 'AbortError' || item.code === 'ABORT_ERR')) return LOCAL_CANCELLED_EXIT_CODE;
    if (chain.some(capacity)) return LOCAL_CAPACITY_EXIT_CODE;
    if (chain.some(item => item.name === 'TimeoutError' || TIMEOUT_CODES.has(item.code))) return LOCAL_TIMEOUT_EXIT_CODE;
  } catch (_) { /* Unknown errors are not a transport retry signal. */ }
  return 1;
}

function isLocalCapacityFailure(error) {
  return wasmFailureExitCode(error) === LOCAL_CAPACITY_EXIT_CODE;
}

module.exports = {
  LOCAL_CAPACITY_EXIT_CODE, LOCAL_TIMEOUT_EXIT_CODE, LOCAL_CANCELLED_EXIT_CODE,
  wasmFailureExitCode, isLocalCapacityFailure
};
