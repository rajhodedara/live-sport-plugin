'use strict';

// Opt-in maintenance/CI check only. This does not download or install rules and
// is never called by the addon, its request handlers, or the offline preflight.
const { reference } = require('../tests/fixtures/timezone-runtime.json');
const VERSION_URL = 'https://data.iana.org/time-zones/tzdb/version';
const VERSION_PATTERN = /^\d{4}[a-z]+$/;
const MAX_VERSION_BYTES = 64;

function compareVersions(left, right) {
  const split = value => {
    if (!VERSION_PATTERN.test(value)) throw new Error('INVALID_VERSION');
    const suffix = [...value.slice(4)].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 96, 0);
    return [Number(value.slice(0, 4)), suffix];
  };
  const a = split(left), b = split(right);
  return Math.sign(a[0] - b[0] || a[1] - b[1]);
}

async function readBoundedText(response) {
  if (!response.body || !response.body[Symbol.asyncIterator]) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_VERSION_BYTES) throw new Error('INVALID_VERSION_RESPONSE');
    return text;
  }
  let text = '';
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_VERSION_BYTES) throw new Error('INVALID_VERSION_RESPONSE');
    text += Buffer.from(chunk).toString('utf8');
  }
  return text;
}

async function checkDataRelease({ fetchImpl, timeoutMs = 15000 } = {}) {
  let dispatcher;
  let timer;
  const controller = new AbortController();
  try {
    if (!fetchImpl) {
      // The repository already depends on undici. Its explicit proxy agent
      // supports inherited HTTP(S)_PROXY/NO_PROXY on supported Node22 as well.
      const undici = require('undici');
      fetchImpl = undici.fetch;
      dispatcher = new undici.EnvHttpProxyAgent();
    }
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchImpl(VERSION_URL, {
      signal: controller.signal, redirect: 'error',
      ...(dispatcher ? { dispatcher } : {})
    });
    if (!response.ok) throw new Error('IANA_HTTP_ERROR');
    const latest = (await readBoundedText(response)).trim();
    if (!VERSION_PATTERN.test(latest)) throw new Error('INVALID_VERSION_RESPONSE');
    const comparison = compareVersions(latest, reference.version);
    return {
      source: VERSION_URL, reference: reference.version, latest,
      status: comparison === 0 ? 'PASS' : 'FAIL',
      ...(comparison !== 0 ? {
        reason: comparison > 0 ? 'NEW_IANA_RELEASE' : 'REFERENCE_AHEAD_OF_OFFICIAL_RELEASE',
        action: 'Review the official IANA release, regenerate independent fixtures, and verify a supported Node/ICU candidate before rollout. No rules were installed.'
      } : {})
    };
  } catch (error) {
    return {
      source: VERSION_URL, reference: reference.version, status: 'FAIL',
      reason: controller.signal.aborted ? 'IANA_CHECK_TIMEOUT' :
        ['IANA_HTTP_ERROR', 'INVALID_VERSION_RESPONSE'].includes(error?.message) ? error.message : 'IANA_CHECK_UNAVAILABLE',
      action: 'Retry the maintenance check with network access to the official IANA endpoint. No rules were installed.'
    };
  } finally {
    clearTimeout(timer);
    // Error responses need not have had their bodies consumed. Abort before
    // closing the owned proxy dispatcher so an unread or oversized response
    // cannot keep this opt-in maintenance command alive indefinitely.
    controller.abort();
    if (dispatcher) {
      try { await dispatcher.destroy(); } catch (_) { /* keep the sanitized report */ }
    }
  }
}

if (require.main === module) {
  checkDataRelease().then(report => {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  }).catch(() => {
    console.log(JSON.stringify({ status: 'FAIL', reason: 'IANA_CHECK_UNAVAILABLE' }));
    process.exitCode = 1;
  });
}

module.exports = { checkDataRelease, compareVersions, VERSION_URL };
