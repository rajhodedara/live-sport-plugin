'use strict';

const { providerRequestHeaders, isDamitvTarget } = require('./ProviderRequestHeaders');
const DEFAULT_LIMIT = 1024 * 1024;
let singleton, nativePool;

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

function createSharedOutboundFetch({ nativeFetch, fallbackFetch, delay = abortableDelay } = {}) {
  return async function fetchShared(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15000;
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_LIMIT;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new RangeError('Invalid guarded request deadline');
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 8 * 1024 * 1024) throw new RangeError('Invalid guarded response limit');
    const attempts = options.attempts ?? 3;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new RangeError('Invalid guarded attempt count');
    const proxyUrl = options.proxyUrl || (isDamitvTarget(url) && (process.env.WARP_PROXY_URL || process.env.DAMITV_PROXY_URL)) || null;
    const supplied = providerRequestHeaders(url, options.headers);
    const pairs = Array.isArray(supplied) && supplied.length && !Array.isArray(supplied[0])
      ? Array.from({ length: Math.ceil(supplied.length / 2) }, (_, i) => [supplied[i * 2], supplied[i * 2 + 1]])
      : supplied;
    const headers = pairs && Object.prototype.toString.call(pairs) === '[object Object]'
      ? pairs : Object.fromEntries(new Headers(pairs || {}));
    const profile = options.profile || (proxyUrl || isDamitvTarget(url) ? 'vanilla' : 'chrome');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(new DOMException('Shared outbound deadline', 'TimeoutError')), timeoutMs);
    const requestOptions = () => ({ ...options, headers, profile, proxyUrl, signal, maxBodyBytes,
      timeoutMs: Math.max(1, Math.min(30000, Math.ceil(deadline - performance.now()))) });
    const requireCompleteMetadata = response => {
      // Prefix sampling is explicit (e.g. size probes). A default metadata cap
      // must not silently turn a large playlist/HTML document into valid text.
      if (response.bodyTruncated && options.maxBodyBytes === undefined) {
        throw Object.assign(new Error('Guarded metadata exceeds its body limit'), { code: 'ERR_OUTBOUND_BODY_LIMIT', isFatal: true });
      }
      return response;
    };
    const fallback = async () => requireCompleteMetadata(await fallbackFetch(url, requestOptions()));
    const nonRetryable = failure => failure?.isFatal || failure?.code === 'ERR_OUTBOUND_BLOCKED' ||
      /^ERR_NATIVE_(POOL|SLOT)_/.test(failure?.code || '') ||
      failure instanceof TypeError || failure instanceof RangeError;
    try {
      let lastError;
      if (options.transport === 'undici') {
        signal.throwIfAborted();
        return await fallback();
      }
      for (let attempt = 1; attempt <= attempts; attempt++) {
        signal.throwIfAborted();
        try {
          const response = requireCompleteMetadata(await nativeFetch(url, requestOptions()));
          if (response.status === 403) {
            if (proxyUrl) return response;
            try { return await fallback(); }
            catch (failure) {
              if (signal.aborted) throw signal.reason;
              // A guard rejection is not a failed alternate fingerprint.
              if (nonRetryable(failure)) throw failure;
              return response;
            }
          }
          if (response.status === 400 && String(url).includes('ok.ru')) throw new Error('ok.ru blocked native transport');
          return response;
        } catch (failure) {
          if (signal.aborted) throw signal.reason;
          if (/^ERR_NATIVE_(POOL|SLOT)_(BUSY|CAPACITY)$/.test(failure.code || '')) {
            console.warn('[GuardedOutbound] Native capacity', JSON.stringify(failure.capacityDiagnostic || { reason: failure.code }));
            throw Object.assign(failure, { transportCode: failure.code, code: 'ERR_OUTBOUND_CAPACITY', isFatal: true, statusCode: 503 });
          }
          if (nonRetryable(failure)) throw failure;
          lastError = failure;
          if (failure.code === 'ERR_NATIVE_UNAVAILABLE' || /InvalidCertificate|UnknownIssuer|certificate has expired|certificate/i.test(String(failure))) break;
          if (attempt < attempts) await delay(800 * attempt, signal);
        }
      }
      if (proxyUrl) throw lastError;
      signal.throwIfAborted();
      return await fallback();
    } finally { clearTimeout(timer); }
  };
}

async function fetchSharedOutbound(url, options) {
  if (!singleton) {
    singleton = createSharedOutboundFetch({
      nativeFetch: (target, configuration) => {
        if (!nativePool) {
          nativePool = process.env.GUARDED_NATIVE_ISOLATION === 'true'
            ? require('./IsolatedNativePoolCandidate').createIsolatedNativePoolCandidate()
            : require('./NativeGuardedFetch').createNativeGuardedFetch();
        }
        return nativePool.fetch(target, configuration);
      },
      fallbackFetch: (target, configuration) => require('./GuardedOutbound').guardedFetch(target, configuration)
    });
  }
  return singleton(url, options);
}

async function closeSharedOutbound() {
  const pool = nativePool;
  singleton = undefined;
  if (pool) {
    await pool.close();
    if (nativePool === pool) nativePool = undefined;
  }
}

module.exports = { createSharedOutboundFetch, fetchSharedOutbound, closeSharedOutbound };
