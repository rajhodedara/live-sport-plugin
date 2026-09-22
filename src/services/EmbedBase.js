/**
 * EmbedBase.js
 *
 * Resolves the base URL to use for references the CLIENT must fetch -- i.e. the
 * crest and badge URLs embedded inside generated SVG.
 *
 * Generated SVG is NOT processed by the JSON response rewriter, so any host it
 * embeds is delivered verbatim to the player. Building those references from the
 * process-level BASE_URL shipped the server's internal LAN address
 * (http://192.168.x.x:7000) inside every composed match card, so the client
 * could load the card but never the crests -- every embedded logo rendered
 * blank. This is the defect that made team logos appear empty in production.
 *
 * The client reached us on a host it can demonstrably resolve, so that request
 * host is the correct base. A loopback / unspecified host is refused (returning
 * null) so the caller can omit the badge and let the card fall back to its crest
 * plate or monogram instead of embedding an image the client can never fetch.
 *
 * @param {object} req Express request
 * @returns {string|null} origin (scheme + host + port) without trailing slash,
 *   or null when no client-reachable base can be derived.
 */
'use strict';

const { getRequestBaseUrl } = require('../config');

function isUnreachableHost(host) {
  if (!host) return true;
  let h = String(host).toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h) return true;

  // Loopback / unspecified.
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (/^127\./.test(h)) return true;

  // Reserved / non-public suffixes.
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localdomain') ||
      h.endsWith('.home.arpa') || h.endsWith('.onion')) return true;

  // RFC1918 / link-local / CGNAT: the server can reach these, but a remote
  // player that received the card cannot resolve them either. getRequestBaseUrl
  // also returns the process BASE_URL (a LAN IP on a proxied deployment) when a
  // request arrives on localhost, so these must be refused for the same reason.
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  const m172 = h.match(/^172\.(\d{1,3})\./);
  if (m172) { const n = Number(m172[1]); if (n >= 16 && n <= 31) return true; }
  const m100 = h.match(/^100\.(\d{1,3})\./);
  if (m100) { const n = Number(m100[1]); if (n >= 64 && n <= 127) return true; }

  return false;
}

function resolveEmbedBase(req) {
  let origin = '';
  try {
    origin = new URL(getRequestBaseUrl(req)).origin;
  } catch (_) {
    return null;
  }
  if (!origin || origin === 'null') return null;
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch (_) {
    return null;
  }
  if (isUnreachableHost(host)) return null;
  return origin;
}

module.exports = { resolveEmbedBase, isUnreachableHost };
