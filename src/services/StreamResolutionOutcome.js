'use strict';

// Local control outcomes, never resolver wire payloads. A missing result caused
// by our timeout/capacity is not evidence that the provider has no stream.
const REASONS = new Set(['timeout', 'capacity', 'cancelled', 'unavailable']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'
]);
const CAPACITY_CODE = /^ERR_NATIVE_(POOL|SLOT)_(BUSY|CAPACITY)$/;

function createDeferredResolution(reason, retryAfterMs = 2000) {
  const delay = Number.isSafeInteger(retryAfterMs) ? retryAfterMs : 2000;
  return Object.freeze({
    status: 'deferred',
    reason: REASONS.has(reason) ? reason : 'unavailable',
    retryAfterMs: Math.max(1000, Math.min(3000, delay)),
    streams: Object.freeze([])
  });
}

function isDeferredResolution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // Inspect data properties only. A malformed provider value cannot make this
  // control-plane check run a getter or smuggle a positive/expired URL.
  try {
    const own = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(own).length !== 4 || ['status', 'reason', 'retryAfterMs', 'streams']
      .some(key => !own[key] || !Object.hasOwn(own[key], 'value'))) return false;
    return own.status.value === 'deferred' && REASONS.has(own.reason.value) &&
      Number.isSafeInteger(own.retryAfterMs.value) && own.retryAfterMs.value >= 1000 && own.retryAfterMs.value <= 3000 &&
      Array.isArray(own.streams.value) && own.streams.value.length === 0;
  } catch (_) { return false; }
}

function isInconclusiveResolutionError(error) {
  if (!error || typeof error !== 'object') return false;
  try {
    const chain = [], seen = new Set();
    for (let current = error; current && typeof current === 'object'; current = current.cause) {
      if (seen.has(current) || chain.length >= 8) return false;
      seen.add(current);
      chain.push(current);
    }
    const capacity = item => item.code === 'ERR_OUTBOUND_CAPACITY' || CAPACITY_CODE.test(item.code || '');
    // A guard refusal remains hard even when a timeout/capacity wrapper hides
    // it in cause. Capacity's own isFatal only prevents immediate transport
    // fallback/retry; it still describes local contention, not upstream health.
    if (chain.some(item => item.code === 'ERR_OUTBOUND_BLOCKED' || (item.isFatal === true && !capacity(item)))) return false;
    return chain.some(item => capacity(item) || item.name === 'AbortError' || item.name === 'TimeoutError' || TIMEOUT_CODES.has(item.code));
  } catch (_) { return false; }
}

module.exports = { createDeferredResolution, isDeferredResolution, isInconclusiveResolutionError };
