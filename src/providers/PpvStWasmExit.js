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

/**
 * Orphan guard for the WASM child. The parent spawns it with a 15 s execFile
 * timeout, but if the parent dies first (restart, crash, OOM kill) nobody sends
 * that signal and a stuck child lives for days. The child therefore ends itself
 * when it outlives `maxLifetimeMs` (exit 76, timeout) or when its parent is
 * gone (exit 77, cancelled). Timers are unref'd so they never keep a finished
 * child alive. Needs a free event loop: it does not help a child blocked in a
 * synchronous loop.
 */
function startChildWatchdog({
  maxLifetimeMs = 25000,
  pollMs = 2000,
  getParentPid = () => process.ppid,
  exit = (code) => process.exit(code)
} = {}) {
  const initialParent = getParentPid();
  const lifetime = setTimeout(() => exit(LOCAL_TIMEOUT_EXIT_CODE), maxLifetimeMs);
  const poll = setInterval(() => {
    if (getParentPid() !== initialParent) exit(LOCAL_CANCELLED_EXIT_CODE);
  }, pollMs);
  lifetime.unref();
  poll.unref();
  return () => { clearTimeout(lifetime); clearInterval(poll); };
}

module.exports = {
  LOCAL_CAPACITY_EXIT_CODE, LOCAL_TIMEOUT_EXIT_CODE, LOCAL_CANCELLED_EXIT_CODE,
  wasmFailureExitCode, isLocalCapacityFailure, startChildWatchdog
};
