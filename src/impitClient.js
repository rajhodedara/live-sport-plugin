/**
 * impitClient.js — Safe impit singleton with undici fallback
 *
 * impit is a native Rust/NAPI addon. On some architectures (ARM64 VPS,
 * Alpine/musl Linux, certain Windows Server builds) the native binary may fail
 * to load. This module wraps every call so a missing or broken impit
 * transparently falls back to undici — callers never need to worry about it.
 *
 * Usage:
 *   const { safeFetch } = require('./impitClient');
 *   const { ok, status, text } = await safeFetch(url, { headers, method });
 */

'use strict';

const { request: undiciRequest, Agent } = require('undici');

// -- Singleton -----------------------------------------------------------------
// undefined  = not yet probed
// null       = probed and unavailable (native binary missing / bad arch)
// Impit obj  = ready to use
let _impitInstance;

function getImpit() {
  if (_impitInstance !== undefined) return _impitInstance;
  try {
    const { Impit } = require('impit');
    _impitInstance = new Impit({ browser: 'chrome142' });
    console.log('[impitClient] impit native client loaded successfully.');
  } catch (e) {
    _impitInstance = null;
    console.warn(`[impitClient] impit unavailable (${e.message}). All requests will use undici fallback - streams will still work.`);
  }
  return _impitInstance;
}

// -- Shared undici keep-alive agent -------------------------------------------
const _undiciAgent = new Agent({
  connect: { timeout: 20000, rejectUnauthorized: false },
  keepAliveTimeout: 15000,
  keepAliveMaxTimeout: 30000,
});

// -- Core helper --------------------------------------------------------------
/**
 * safeFetch - fetches a URL using impit when available, falls back to undici.
 *
 * @param {string} url
 * @param {object} opts   - { method, headers, body, signal, timeoutMs, attempts }
 *   attempts: how many times to try the impit path before falling back to
 *   undici (default 3). Callers that run their own retry policy should pass 1,
 *   so the two layers do not multiply: three impit tries at a 5s timeout plus
 *   backoff is ~17s inside a call the caller believes is bounded by timeoutMs.
 * @returns {{ ok, status, text: () => string, json: () => object }}
 */
async function safeFetch(url, opts = {}) {
  const { method = 'GET', headers = {}, body, signal, timeoutMs = 15000, attempts = 3 } = opts;
  const impit = getImpit();
  const maxAttempts = Math.max(1, attempts);

  // -- Path A: impit ---------------------------------------------------------
  if (impit) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // The caller gave up (deadline hit upstream); stop burning its budget.
      if (signal && signal.aborted) throw Object.assign(new Error('aborted before impit attempt'), { name: 'AbortError' });
      let timer = null;
      try {
        const res = await Promise.race([
          impit.fetch(url, { method, headers, body }),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`impit timeout ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
        const textData = await res.text();
        if (res.status === 400 && url.includes('ok.ru')) {
           throw new Error('ok.ru blocked impit');
        }
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          text: async () => textData,
          json: async () => JSON.parse(textData),
        };
      } catch (impitErr) {
        lastErr = impitErr;
        if (attempt < maxAttempts) {
           await new Promise(r => setTimeout(r, 800 * attempt));
        }
      } finally {
        // Always clear the timeout so a fast response does not leave a pending
        // timer holding the event loop (timer churn under load).
        if (timer) clearTimeout(timer);
      }
    }
    console.warn(`[impitClient] impit fetch failed after ${maxAttempts} attempt(s) (${lastErr.message}), falling back to undici for: ${url}`);
  }

  // -- Path B: undici --------------------------------------------------------
  const res = await undiciRequest(url, {
    method,
    headers,
    body,
    signal,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    dispatcher: _undiciAgent,
  });
  const textData = await res.body.text();
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    text: async () => textData,
    json: async () => JSON.parse(textData),
  };
}

/**
 * isImpitAvailable - quick runtime check, useful for startup logs.
 */
function isImpitAvailable() {
  return getImpit() !== null;
}

module.exports = { safeFetch, isImpitAvailable, getImpit };
