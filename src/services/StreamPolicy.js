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
 * Deliberately NOT in scope: `/api/manifest.mpd` and `/api/manifest?url=<mpd>`.
 * Those inject a BaseURL and strip protection, so the media segments are pulled
 * by the player straight from the CDN — only the manifest transits the addon.
 * They cost kilobytes, not gigabytes, and are handled by the 24/7 channel path.
 */

const DASH_RELAY_PATH = /\/api\/dash(\/|\?|$)/i;
const MPD_TARGET = /\.mpd(\?|#|$)/i;

/** True when the playable bytes would transit this addon (the media relay). */
function isRelayedDashStream(stream) {
  if (!stream || typeof stream !== 'object') return false;
  const url = String(stream.url || stream.streamUrl || stream._rawMpdUrl || '');
  if (!url) return false;
  return DASH_RELAY_PATH.test(url);
}

/** True when the stream is DASH in any form — unplayable natively, never offered. */
function isDashStream(stream) {
  if (!stream || typeof stream !== 'object') return false;
  const url = String(stream.url || stream.streamUrl || stream._rawMpdUrl || '');
  if (url && MPD_TARGET.test(url)) return true;
  if (stream.clearkey) return true;
  if (String(stream.format || '').toLowerCase() === 'dash') return true;
  if (String(stream.type || '').toLowerCase().includes('dash')) return true;
  return false;
}

/** The single gate used by the stream assembler. */
function isBlockedDashStream(stream) {
  return isRelayedDashStream(stream) || isDashStream(stream);
}

module.exports = {
  isRelayedDashStream,
  isDashStream,
  isBlockedDashStream,
  DASH_RELAY_PATH,
  MPD_TARGET
};
