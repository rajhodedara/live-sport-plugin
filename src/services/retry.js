/**
 * retry.js — shared retry policy for the stream pipeline.
 *
 * Why this exists: a single transient failure used to cost a working stream for
 * the whole negative-cache window. Verification pings a CDN edge exactly once;
 * one ECONNRESET, one 503 from an edge that is mid-rotation, and the stream is
 * dropped and negative-cached, so the user sees no source at all for minutes.
 *
 * The policy here is deliberately narrow:
 *
 *   - Retry only what is plausibly transient (connection resets, timeouts,
 *     429, 5xx). A 403/404 is a real answer from a working server — retrying it
 *     only burns the caller's time budget.
 *   - Never overrun the caller's deadline. Stream resolution races a soft
 *     deadline (STREAM_SOFT_DEADLINE_MS), so a retry that would land after the
 *     deadline is worthless: it cannot make it into the response, and it holds
 *     a socket open while the user is already waiting.
 *   - Full jitter on the backoff. Every source for a match is verified at the
 *     same instant, so a fixed backoff would re-collide the whole batch on the
 *     same edge.
 */

'use strict';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2000;
const ATTEMPT_TIMEOUT = Symbol('verification attempt timeout');

/** A deadline owned by one verification attempt, not a caller cancellation. */
function createAttemptTimeoutError() {
  const error = Object.assign(new Error('Verification attempt timed out'), {
    name: 'TimeoutError', code: 'ETIMEDOUT'
  });
  Object.defineProperty(error, ATTEMPT_TIMEOUT, { value: true });
  return error;
}

// Node/undici network failures worth a second look. Anything else (bad URL,
// TypeError in our own code) is a bug, not a blip, and must surface fast.
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETRESET', 'EAI_AGAIN', 'EBUSY',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_RESPONSE_STATUS_CODE',
]);

const TRANSIENT_MESSAGE_RE = /timeout|timed out|socket hang up|network|reset by peer|aborted|temporarily|too many requests|EAI_AGAIN/i;

/** True when an HTTP status is worth retrying rather than believing. */
function isTransientStatus(status) {
  if (!status) return false;
  // 429 = rate limited, 5xx = the edge is unwell. 408 = server-side timeout.
  return status === 408 || status === 429 || status >= 500;
}

/** True when a thrown error looks like a blip rather than a verdict. */
function isTransientError(err) {
  if (!err || typeof err !== 'object') return false;
  try {
    const causes = [], seen = new Set();
    for (let current = err; current && typeof current === 'object'; current = current.cause) {
      if (seen.has(current) || causes.length >= 8) return false;
      seen.add(current);
      causes.push(current);
    }
    // A local resource limit or guard refusal must not become another request
    // merely because a wrapper resembles a network timeout.
    if (causes.some(item => item.isFatal || item.code === 'ERR_OUTBOUND_BLOCKED' ||
        item.code === 'ERR_OUTBOUND_CAPACITY' || /^ERR_NATIVE_(POOL|SLOT)_/.test(item.code || ''))) return false;
    // A public deadlineExceeded flag is not authority to retry a cancellation.
    if (causes.some(item => item.name === 'AbortError')) return false;
    if (causes.some(item => item[ATTEMPT_TIMEOUT] === true || item.name === 'TimeoutError')) return true;
    if (causes.some(item => TRANSIENT_ERROR_CODES.has(item.code))) return true;
    return TRANSIENT_MESSAGE_RE.test(String(err.message || ''));
  } catch (_) { return false; }
}

/** Full-jitter exponential backoff, capped. */
function backoffDelay(attempt, baseDelayMs, maxDelayMs) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with bounded retries.
 *
 * `fn` receives { attempt } and may either throw or return a value. The caller
 * must bound each attempt by its remaining deadline; this helper bounds retry
 * admission and backoff, not arbitrary work performed inside `fn`.
 * Returning a value that `shouldRetryResult` accepts (e.g. a response carrying
 * a 503) also triggers a retry; the last result is returned once attempts run
 * out, so callers still get the real status to act on rather than an exception.
 *
 * @param {(ctx: {attempt: number}) => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.attempts=3]           total tries, including the first
 * @param {number} [opts.baseDelayMs=250]
 * @param {number} [opts.maxDelayMs=2000]
 * @param {number} [opts.deadlineAt]           absolute Date.now() cutoff
 * @param {(err: Error) => boolean} [opts.shouldRetryError]
 * @param {(result: any) => boolean} [opts.shouldRetryResult]
 * @param {(info: object) => void} [opts.onRetry]
 * @param {string} [opts.label]                for logs
 */
async function withRetry(fn, opts = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    deadlineAt,
    shouldRetryError = isTransientError,
    shouldRetryResult = () => false,
    onRetry,
    label = 'retry',
  } = opts;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn({ attempt });
      if (attempt < attempts && shouldRetryResult(result)) {
        const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
        // Out of time? Hand back what we have rather than sleeping into a
        // deadline the caller has already stopped waiting on.
        if (!hasTimeLeft(deadlineAt, delay)) return result;
        if (onRetry) onRetry({ label, attempt, delay, result });
        await sleep(delay);
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !shouldRetryError(err)) throw err;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      if (!hasTimeLeft(deadlineAt, delay)) throw err;
      if (onRetry) onRetry({ label, attempt, delay, error: err });
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Room for a `delay` sleep plus a token slice of work before `deadlineAt`. */
function hasTimeLeft(deadlineAt, delay) {
  if (!deadlineAt) return true;
  const MIN_WORK_MS = 150; // a retry that cannot even start is not a retry
  return Date.now() + delay + MIN_WORK_MS < deadlineAt;
}

module.exports = {
  withRetry,
  isTransientError,
  isTransientStatus,
  backoffDelay,
  TRANSIENT_ERROR_CODES,
  createAttemptTimeoutError,
};
