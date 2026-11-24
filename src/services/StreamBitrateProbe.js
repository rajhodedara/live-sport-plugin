'use strict';

// Kafka (Trex) serves single-variant HLS playlists: no #EXT-X-STREAM-INF, so
// there is no RESOLUTION or BANDWIDTH to read. The only honest source of a
// quality label is the segment the player itself would fetch: its byte size
// over its EXTINF duration is the real bitrate.
//
// The CDN ignores Range and answers 200 with the whole segment, so the body is
// cancelled as soon as the headers arrive. A 10 s segment can be 10 MB; reading
// it just to learn its length would be worse than saying nothing.

const MIN_SEGMENT_BYTES = 64 * 1024;
const MAX_BITRATE_BPS = 80 * 1000 * 1000;

// Below 5.5 Mbps the same ladder streams.js already uses when a provider only
// says "HD" and a measurement arrives.
function resolutionFromBitrate(bitsPerSecond) {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;
  if (bitsPerSecond >= 5500000) return '1080p60';
  if (bitsPerSecond >= 3800000) return '1080p';
  if (bitsPerSecond >= 2000000) return '720p';
  return 'SD';
}

function formatBitrate(bitsPerSecond) {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '';
  return bitsPerSecond >= 1000000
    ? `${(bitsPerSecond / 1000000).toFixed(1)} Mbps`
    : `${Math.round(bitsPerSecond / 1000)} kbps`;
}

// The upstream packs its own tier into the stream title: "US| NBA TV HD · HD",
// "TR| NBA TV 4K · UHD". Only the unambiguous tiers are trusted; "HD" says
// nothing about 720p vs 1080p, so it is left to the measurement.
function resolutionFromTag(text) {
  const match = /(?:·|\||\s)\s*(UHD|4K|FHD|FULL\s*HD|1080[pi]?|720p|SD)\s*$/i.exec(String(text || '').trim());
  if (!match) return null;
  const tag = match[1].toUpperCase().replace(/\s+/g, '');
  if (tag === 'UHD' || tag === '4K') return '2160p';
  if (tag === 'FHD' || tag === 'FULLHD' || tag === '1080P' || tag === '1080I') return '1080p';
  if (tag === '720P') return '720p';
  if (tag === 'SD') return 'SD';
  return null;
}

function firstSegment(playlistText, playlistUrl) {
  if (typeof playlistText !== 'string' || !playlistText) return null;
  const durationMatch = /#EXTINF:\s*([\d.]+)/.exec(playlistText);
  if (!durationMatch) return null;
  const duration = Number(durationMatch[1]);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const uri = playlistText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
  if (!uri) return null;
  try {
    return { url: new URL(uri, playlistUrl).toString(), duration };
  } catch (_) {
    return null;
  }
}

/**
 * Measures a media playlist's bitrate from its first segment and returns
 * `{ bitrate, resolution }`. Both fields are '' / null when the measurement
 * is not possible; callers then keep whatever the upstream declared.
 */
async function probeBitrate({ playlistText, playlistUrl, fetchImpl = fetch, timeoutMs = 2500 } = {}) {
  const segment = firstSegment(playlistText, playlistUrl);
  if (!segment) return { bitrate: '', resolution: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    const response = await fetchImpl(segment.url, { signal: controller.signal });
    if (!response || !response.ok) return { bitrate: '', resolution: null };
    const headers = response.headers;
    const range = headers && typeof headers.get === 'function' ? headers.get('content-range') : '';
    const length = headers && typeof headers.get === 'function' ? Number(headers.get('content-length')) : 0;
    // Cancel before the body loads: the length is all this needs.
    if (response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel().catch(() => {});
    }
    const bytes = range ? Number(String(range).split('/').pop()) : length;
    if (!Number.isFinite(bytes) || bytes < MIN_SEGMENT_BYTES) return { bitrate: '', resolution: null };

    const bitsPerSecond = (bytes * 8) / segment.duration;
    if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0 || bitsPerSecond > MAX_BITRATE_BPS) {
      return { bitrate: '', resolution: null };
    }
    return {
      bitrate: formatBitrate(bitsPerSecond),
      resolution: resolutionFromBitrate(bitsPerSecond)
    };
  } catch (_) {
    return { bitrate: '', resolution: null };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

module.exports = { probeBitrate, resolutionFromBitrate, resolutionFromTag, formatBitrate, firstSegment, MIN_SEGMENT_BYTES };
