'use strict';

// Compatibility shapes for metadata extractors. All I/O enters the shared
// guarded path; caller-provided dispatchers cannot supply an alternate dial.
const { Readable } = require('node:stream');

function safeFetch(url, options = {}) {
  return require('../impitClient').safeFetch(url, { ...options, guardExternal: true });
}

async function request(url, options = {}) {
  const timeoutMs = options.timeoutMs || Math.min(options.headersTimeout || 15000, options.bodyTimeout || 15000);
  const response = await safeFetch(url, { ...options, timeoutMs,
    transport: 'undici', attempts: 1, redirect: options.maxRedirections > 0 ? 'follow' : 'manual' });
  const bytes = Buffer.from(await response.arrayBuffer());
  const body = Readable.from([bytes]);
  let consumed = false;
  const take = () => {
    if (consumed) throw new TypeError('Response body already consumed');
    consumed = true; body.destroy(); return bytes;
  };
  body.text = async () => take().toString('utf8');
  body.json = async () => JSON.parse(take().toString('utf8'));
  body.arrayBuffer = async () => Uint8Array.from(take()).buffer;
  body.dump = async () => { if (!consumed) take(); };
  return { statusCode: response.status, headers: Object.fromEntries(new Headers(response.headers)),
    body, url: response.url || String(url), bodyTruncated: response.bodyTruncated };
}

async function fetch(url, options = {}) {
  const input = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
  if (url && typeof url === 'object' && url.url) {
    const requestOptions = { method: url.method, headers: url.headers, signal: url.signal, redirect: url.redirect, ...options };
    if (requestOptions.body === undefined && !['GET', 'HEAD'].includes(requestOptions.method) && typeof url.arrayBuffer === 'function') {
      requestOptions.body = Buffer.from(await url.clone().arrayBuffer());
    }
    options = requestOptions;
  }
  const response = await safeFetch(input, options);
  const bytes = [204, 205, 304].includes(response.status) ? null : await response.arrayBuffer();
  const wrapped = new Response(bytes, { status: response.status, headers: response.headers });
  Object.defineProperty(wrapped, 'url', { value: response.url || input });
  Object.defineProperty(wrapped, 'redirected', { value: wrapped.url !== input });
  Object.defineProperty(wrapped, 'bodyTruncated', { value: response.bodyTruncated });
  return wrapped;
}

async function streamingFetch(url, options = {}) {
  const response = await require('./GuardedOutbound').guardedRequest(String(url), options);
  const body = [204, 205, 304].includes(response.statusCode) || options.method === 'HEAD' ? null : Readable.toWeb(response.body);
  if (!body) response.body.destroy();
  const wrapped = new Response(body, { status: response.statusCode, headers: response.headers });
  Object.defineProperty(wrapped, 'url', { value: response.url || String(url) });
  return wrapped;
}

const fetchUndici = (url, options = {}) => fetch(url, { ...options, transport: 'undici' });
module.exports = { safeFetch, request, fetch, fetchUndici, streamingFetch };
