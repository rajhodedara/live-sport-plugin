'use strict';

// An internal client for NativeGuardedSlot's authenticated loopback proxy. The
// slot still owns URL/DNS admission, the pinned SOCKS connection and its lease.
// Curl never receives the external SOCKS endpoint or permission to redirect.
const { spawn } = require('node:child_process');
const HEADER_LIMIT = 64 * 1024;
const STDERR_LIMIT = 8 * 1024;
const BODY_LIMIT = 8 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const failure = (code, message) => Object.assign(new Error(message), { code, isFatal: true });

function guardedProxy(value) {
  let proxy;
  try { proxy = new URL(value); } catch (_) { /* checked below */ }
  if (!proxy || proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' ||
      !proxy.port || proxy.username !== 'guard' || !proxy.password ||
      proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw failure('ERR_GUARDED_CURL_PROXY', 'Curl requires the owned guarded loopback proxy');
  }
  return proxy.href;
}

function parseHeaders(bytes) {
  const lines = bytes.toString('latin1').split('\r\n');
  const match = /^HTTP\/\d+(?:\.\d+)? ([1-5]\d\d)(?: |$)/.exec(lines.shift());
  if (!match) throw failure('ERR_GUARDED_CURL_HEADERS', 'Invalid curl response headers');
  const status = Number(match[1]), headers = new Headers();
  if (status === 101) throw failure('ERR_GUARDED_CURL_HEADERS', 'Unsupported response upgrade');
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1 || /^[ \t]/.test(line)) throw failure('ERR_GUARDED_CURL_HEADERS', 'Invalid curl response headers');
    try { headers.append(line.slice(0, colon), line.slice(colon + 1).trim()); }
    catch (_) { throw failure('ERR_GUARDED_CURL_HEADERS', 'Invalid curl response headers'); }
  }
  return { status, headers };
}

function createGuardedCurlModule({ spawnProcess = spawn } = {}) {
  return { Impit: class GuardedCurlClient {
    constructor(options) { this.proxyUrl = guardedProxy(options?.proxyUrl); }

    async fetch(rawUrl, options = {}) {
      const url = new URL(rawUrl), method = String(options.method || 'GET').toUpperCase();
      const maxBodyBytes = options.maxBodyBytes;
      const timeoutMs = options.timeout;
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          !['GET', 'HEAD'].includes(method) || options.body != null || options.redirect !== 'manual') {
        throw failure('ERR_GUARDED_CURL_OPTIONS', 'Unsupported guarded curl request');
      }
      if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > BODY_LIMIT ||
          !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
        throw new RangeError('Invalid guarded curl bounds');
      }
      const signal = options.signal;
      signal?.throwIfAborted();
      const headers = new Headers(options.headers);
      const seconds = String(timeoutMs / 1000);
      const args = ['--disable', '--globoff', '--silent', '--show-error', '--include', '--suppress-connect-headers',
        '--proxy', this.proxyUrl, '--noproxy', '', '--proto', '=http,https',
        '--max-time', seconds, '--connect-timeout', seconds];
      if (method === 'HEAD') args.push('--head');
      for (const [name, value] of headers) args.push('--header', `${name}: ${value}`);
      args.push('--url', url.href);

      return await new Promise((resolve, reject) => {
        let child, deadlineTimer, killTimer, settled = false, stopped = false, pendingFailure;
        let pending = Buffer.alloc(0), headerBytes = 0, stderrBytes = 0, response;
        const chunks = [];
        let bodyBytes = 0;
        const cleanup = () => {
          clearTimeout(deadlineTimer); clearTimeout(killTimer);
          signal?.removeEventListener('abort', abort);
        };
        const finish = (fn, value) => {
          if (settled) return;
          settled = true; cleanup(); fn(value);
        };
        const stop = reason => {
          if (reason && !pendingFailure) pendingFailure = reason;
          if (stopped || !child) return;
          stopped = true;
          // A successful kill() only sends a signal. Do not release the slot
          // until close confirms the child and all its stdio have exited.
          try { child.kill('SIGTERM'); } catch (_) { /* still await close */ }
          if (!settled) killTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) { /* still await close */ }
          }, 250);
        };
        const abort = () => stop(signal.reason);
        const body = bytes => {
          if (!bytes.length) return;
          // Keep one extra byte so NativeGuardedFetch's existing bounded
          // reader can distinguish a full body from an explicit prefix sample.
          const keep = Math.min(bytes.length, maxBodyBytes + 1 - bodyBytes);
          if (keep > 0) { chunks.push(Buffer.from(bytes.subarray(0, keep))); bodyBytes += keep; }
          if (bodyBytes > maxBodyBytes) stop();
        };
        const output = bytes => {
          if (stopped || pendingFailure) return;
          if (response) { body(bytes); return; }
          pending = Buffer.concat([pending, bytes]);
          while (!response) {
            const end = pending.indexOf('\r\n\r\n');
            if (end === -1) {
              if (headerBytes + pending.length > HEADER_LIMIT) stop(failure('ERR_GUARDED_CURL_HEADER_LIMIT', 'Curl response headers exceed their limit'));
              return;
            }
            headerBytes += end + 4;
            if (headerBytes > HEADER_LIMIT) { stop(failure('ERR_GUARDED_CURL_HEADER_LIMIT', 'Curl response headers exceed their limit')); return; }
            let parsed;
            try { parsed = parseHeaders(pending.subarray(0, end)); }
            catch (error) { stop(error); return; }
            pending = pending.subarray(end + 4);
            if (parsed.status < 200) continue;
            response = parsed;
            if (method === 'HEAD' || [204, 205, 304].includes(parsed.status) ||
                (REDIRECTS.has(parsed.status) && parsed.headers.has('location'))) {
              pending = Buffer.alloc(0); stop(); return;
            }
            body(pending); pending = Buffer.alloc(0);
          }
        };
        try { child = spawnProcess('curl', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
        catch (_) { finish(reject, failure('ERR_GUARDED_CURL_UNAVAILABLE', 'Cannot start guarded curl')); return; }
        child.stdout.on('data', output);
        child.stderr.on('data', bytes => {
          stderrBytes += bytes.length;
          // Never include stderr: it may contain signed URLs or proxy secrets.
          if (stderrBytes > STDERR_LIMIT) stop(failure('ERR_GUARDED_CURL_STDERR_LIMIT', 'Curl diagnostics exceed their limit'));
        });
        child.once('error', () => { pendingFailure ||= failure('ERR_GUARDED_CURL_UNAVAILABLE', 'Cannot start guarded curl'); });
        child.once('close', code => {
          if (signal?.aborted) pendingFailure = signal.reason;
          if (pendingFailure) { finish(reject, pendingFailure); return; }
          if (!response || (!stopped && code !== 0)) {
            finish(reject, failure('ERR_GUARDED_CURL_FETCH', 'Guarded curl request failed')); return;
          }
          const bytes = Buffer.concat(chunks, bodyBytes);
          finish(resolve, { status: response.status, headers: response.headers,
            body: new ReadableStream({ start(controller) { if (bytes.length) controller.enqueue(bytes); controller.close(); } }) });
        });
        deadlineTimer = setTimeout(() => stop(new DOMException('Guarded curl deadline', 'TimeoutError')), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  } };
}

module.exports = { createGuardedCurlModule };
