'use strict';

// Decides whether a verification sample proves nothing about being a playlist.
//
// A body cut at the sample cap can legitimately lack '#EXT': direct media
// (MPEG-TS, FLV, progressive video) is always larger than the cap and never
// contains it, so a truncated sample alone must not condemn a stream. A
// truncated HTML document is different: that is a soft-404 or login page that
// answered 200, not media, and must not pass as a playable stream.
const HTML_START = /^\s*<(?:!doctype\s+html|html|head|body)\b/i;

function lacksPlaylistEvidence({ isMpd = false, isMp4 = false, bodySample = '', bodyTruncated = false } = {}) {
  if (isMpd || isMp4) return false;
  const sample = typeof bodySample === 'string' ? bodySample : String(bodySample ?? '');
  if (sample.includes('#EXT')) return false;
  if (!bodyTruncated) return true;
  return HTML_START.test(sample);
}

module.exports = { lacksPlaylistEvidence };
