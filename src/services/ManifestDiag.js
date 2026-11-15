'use strict';

/**
 * Small, side-effect-free helpers that make /api/manifest log lines
 * attributable: which source (from the `rck` recovery key) and which upstream
 * host a failure belongs to. Values are bounded and character-restricted so a
 * crafted query string cannot inject log lines.
 */
function hostOf(url) {
  try {
    const host = new URL(String(url)).host;
    return /^[A-Za-z0-9.\-:\[\]]{1,80}$/.test(host) ? host : 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function sourceOfRck(rck) {
  const source = String(rck || '').split(':')[0].toLowerCase();
  return /^[a-z0-9_-]{1,24}$/.test(source) ? source : 'none';
}

function describeManifestError(targetUrl, rck) {
  return `source=${sourceOfRck(rck)} host=${hostOf(targetUrl)}`;
}

module.exports = { hostOf, sourceOfRck, describeManifestError };
