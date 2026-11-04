'use strict';
const cheerio = require('cheerio');

// Only inspect a bounded number of iframe tags; this does not fetch any page.
// Prefer a candidate already understood by the provider, while retaining the
// first valid iframe as the existing fallback for unknown player formats.
function findBridgeIframe(html, baseUrl, isKnownPlayer, maxCandidates = 8) {
  if (typeof html !== 'string') return null;
  const $ = cheerio.load(html);
  let fallback = null;
  let known = null;
  $('iframe[src]').slice(0, maxCandidates).each((_index, element) => {
    let parsed;
    try { parsed = new URL($(element).attr('src'), baseUrl); } catch (_) { return; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
    if (!fallback) fallback = parsed.href;
    if (isKnownPlayer(parsed)) { known = parsed.href; return false; }
  });
  return known || fallback;
}

function matchesHost(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

function isByseHost(host) {
  return /(?:^|\.)byse[a-z0-9]*\.[a-z]+$/i.test(host);
}

function playerHostname(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  try {
    const url = new URL(rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.hostname;
  } catch (_) {
    return '';
  }
}

module.exports = { findBridgeIframe, matchesHost, isByseHost, playerHostname };
