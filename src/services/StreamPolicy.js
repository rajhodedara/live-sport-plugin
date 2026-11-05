'use strict';

/**
 * StreamPolicy — the addon's bandwidth policy for DASH.
 *
 * ClearKey DASH cannot be decrypted by the target players (hls.js has no
 * sample-level AES path, Media3 only decrypts whole segments), so the only way
 * to play it is to relay it: `/api/dash` fetches every segment, decrypts it in
 * process and re-serves it. That moves the full media bitrate through the addon
 * — measured at ≈3.74 GB per viewer-hour for a 1080p ClearKey feed (see
 * docs/CLEARKEY_ZERO_EGRESS_DECISION_2026-11-01.md).
 *
 * Policy: relayed DASH is not offered at all. Providers must not mint
 * `/api/dash` URLs, and the stream assembler drops any that still arrive
 * (cached entries, older call sites, future providers).
 *
 * Manifest-only proxies are not media relays. Their actual target still decides
 * whether a source is DASH and therefore excluded from the offered stream list.
 * Proxied HLS must stay available even though it uses the same endpoint family.
 */

// Match parsed pathnames, never arbitrary query/fragment text. Optional leading
// paths retain reverse-proxy installations such as /addon/api/manifest.
const DASH_RELAY_PATH = /(?:^|\/)api\/dash(?:\/|$)/i;
const MPD_TARGET = /\.mpd$/i;
const MANIFEST_PROXY_PATH = /(?:^|\/)api\/manifest(?:\.m3u8|\.mpd)?$/i;
const MAX_PROXY_DEPTH = 8;
const CLOAKED_HOST = /(?:^|\.)(?:cowedd\d*[a-z0-9]*|wedd\d+[a-z0-9]*|tiktokcdn|tiktokx-origin)\.[a-z]+$/i;
const PNG_SEGMENT_PATH = /\.png$/i;

function inspectStreamTarget(stream) {
  const result = { relay: false, dash: false, cloaked: false };
  if (!stream || typeof stream !== 'object') return result;
  let target = String(stream.url || stream.streamUrl || stream._rawMpdUrl || '');
  let base = 'https://stream-policy.invalid/';
  const seen = new Set();

  for (let depth = 0; target && depth < MAX_PROXY_DEPTH; depth++) {
    let parsed;
    try { parsed = new URL(target, base); } catch (_) { break; }
    if (!['http:', 'https:'].includes(parsed.protocol) || seen.has(parsed.href)) break;
    seen.add(parsed.href);
    if (DASH_RELAY_PATH.test(parsed.pathname)) result.relay = true;
    if (MPD_TARGET.test(parsed.pathname)) result.dash = true;
    if (CLOAKED_HOST.test(parsed.hostname) || PNG_SEGMENT_PATH.test(parsed.pathname)) result.cloaked = true;
    if (!MANIFEST_PROXY_PATH.test(parsed.pathname)) break;
    // URLSearchParams performs exactly the normal outer query decoding; CDN
    // signatures are never decoded again or reconstructed by this classifier.
    target = parsed.searchParams.get('url');
    base = parsed.href;
  }
  return result;
}

/** True when the playable bytes would transit this addon (the media relay). */
function isRelayedDashStream(stream) {
  return inspectStreamTarget(stream).relay;
}

/** True when the stream is DASH in any form — unplayable natively, never offered. */
function isDashStream(stream) {
  if (!stream || typeof stream !== 'object') return false;
  if (inspectStreamTarget(stream).dash) return true;
  if (stream.clearkey) return true;
  if (String(stream.format || '').toLowerCase() === 'dash') return true;
  if (String(stream.type || '').toLowerCase().includes('dash')) return true;
  return false;
}

/** The single gate used by the stream assembler. */
function isPngCloakedStream(stream) {
  return inspectStreamTarget(stream).cloaked;
}

function isBlockedStream(stream) {
  return isBlockedDashStream(stream) || isPngCloakedStream(stream);
}

function isBlockedDashStream(stream) {
  return isRelayedDashStream(stream) || isDashStream(stream);
}

module.exports = {
  isRelayedDashStream,
  isDashStream,
  isBlockedDashStream,
  isPngCloakedStream,
  isBlockedStream,
  CLOAKED_HOST,
  PNG_SEGMENT_PATH,
  DASH_RELAY_PATH,
  MPD_TARGET
};
