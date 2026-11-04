'use strict';

// A cross-origin redirect must not forward arbitrary provider headers. These
// names cover content negotiation and bounded range requests; other headers,
// including Referer, Origin and all custom headers, require a fresh request to
// the destination. Values on allowlisted headers must not contain credentials.
const CROSS_ORIGIN_ALLOWED = new Set([
  'accept', 'accept-language', 'accept-encoding', 'user-agent', 'range',
  'content-type', 'content-encoding'
]);

function filterHeaders(headers, keep) {
  if (!headers) return headers;
  if (Array.isArray(headers) && headers.every(value => typeof value === 'string')) {
    const result = [];
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (keep(headers[i])) result.push(headers[i], headers[i + 1]);
    }
    return result;
  }
  if (typeof headers[Symbol.iterator] === 'function') {
    return Array.from(headers).filter(([name]) => keep(name)).flat();
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => keep(name)));
}

function filterRedirectHeaders(headers) {
  return filterHeaders(headers, name => CROSS_ORIGIN_ALLOWED.has(String(name).toLowerCase()));
}

function removeBodyHeaders(headers) {
  const bodyNames = new Set(['content-length', 'content-type', 'content-encoding']);
  return filterHeaders(headers, name => !bodyNames.has(String(name).toLowerCase()));
}

function shouldDropRedirectBody(status, method) {
  const upper = String(method).toUpperCase();
  return (status === 303 && upper !== 'HEAD') || ((status === 301 || status === 302) && upper === 'POST');
}

module.exports = { filterRedirectHeaders, removeBodyHeaders, shouldDropRedirectBody };
