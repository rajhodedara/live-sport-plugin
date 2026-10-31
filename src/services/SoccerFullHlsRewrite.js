'use strict';

/**
 * Playlist rewriter for SoccerFull's self-hosted HLS servers.
 *
 * SoccerFull serves full-match replays from `/hls/<sid>.m3u8` on its own origin.
 * Two properties make the stock `/api/manifest` rewriter unusable for them:
 *
 *  1. The upstream playslist is served **without** `Access-Control-Allow-Origin`,
 *     so a browser player cannot read it. Serving it from this addon fixes CORS
 *     while still costing no video bandwidth — only the playlist (a few hundred
 *     KB) passes through us; every media byte comes from the CDN.
 *  2. Each segment is a complete object with MPEG-TS hidden behind a fake PNG
 *     header whose size differs from the WebP/RIFF prefix the shared rewriter
 *     assumes (42). The offset has to be measured, see SoccerFullSegmentLength.
 *
 * Segments are therefore emitted as **direct CDN URIs** carrying
 * `#EXT-X-BYTERANGE:<len>@<offset>`. That is the same zero-bandwidth addressing
 * the PPV.st fix uses; nothing here proxies media.
 */

const { resolveSegmentUrl, isTikTokCloakedSegment } = require('./HlsRewriteService');
const segmentLengthService = require('./SoccerFullSegmentLength');

/**
 * Rewrite a SoccerFull playlist into what the player should fetch.
 *
 * @param {string} body       Upstream playlist text
 * @param {string} manifestUrl Absolute URL the playlist was fetched from
 * @param {Object} [opts={}]
 * @param {(absoluteUrl: string) => string} [opts.toProxyUrl]
 *        Wraps child playlists so they come back through this addon too.
 * @returns {string}
 */
function rewriteSoccerFullPlaylist(body, manifestUrl, opts = {}) {
  const toProxyUrl = typeof opts.toProxyUrl === 'function' ? opts.toProxyUrl : (u => u);
  const lines = String(body).split('\n');
  const out = [];

  let duration = null;
  let hasPrecedingByteRange = false;
  let injectedByteRange = false;
  let versionLineIndex = -1;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      out.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#EXTINF:')) {
        const parsed = parseFloat(trimmed.slice('#EXTINF:'.length));
        duration = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      } else if (trimmed.startsWith('#EXT-X-BYTERANGE:')) {
        hasPrecedingByteRange = true;
      } else if (trimmed.startsWith('#EXT-X-VERSION:')) {
        versionLineIndex = out.length;
      }
      out.push(line);
      continue;
    }

    const absoluteUrl = resolveSegmentUrl(trimmed, manifestUrl);

    // Child playlist (master -> media). Route it through this addon as well, so
    // the media playlist gets the same CORS + byterange treatment.
    if (absoluteUrl.includes('.m3u8')) {
      out.push(toProxyUrl(absoluteUrl));
      duration = null;
      hasPrecedingByteRange = false;
      continue;
    }

    if (isTikTokCloakedSegment(absoluteUrl) && !hasPrecedingByteRange) {
      const prefixBytes = segmentLengthService.getPrefixBytes(absoluteUrl);
      const segmentLength = segmentLengthService.getSegmentLength(absoluteUrl, { duration });
      // An over-declared range returns what exists; an under-declared one
      // truncates the chunk tail (see PPVST_CHUNK_TAIL_TRUNCATION_2026-10-29).
      out.push(`#EXT-X-BYTERANGE:${segmentLength}@${prefixBytes}`);
      out.push(absoluteUrl);
      injectedByteRange = true;
      duration = null;
      hasPrecedingByteRange = false;
      continue;
    }

    out.push(absoluteUrl);
    duration = null;
    hasPrecedingByteRange = false;
  }

  // #EXT-X-BYTERANGE requires protocol version 4.
  if (injectedByteRange) {
    if (versionLineIndex < 0) {
      const headerIndex = out.findIndex(line => line.trim() === '#EXTM3U');
      out.splice(headerIndex + 1, 0, '#EXT-X-VERSION:4');
    } else {
      const existing = parseInt(String(out[versionLineIndex]).split(':')[1], 10);
      if (!Number.isFinite(existing) || existing < 4) {
        out[versionLineIndex] = '#EXT-X-VERSION:4';
      }
    }
  }

  return out.join('\n');
}

/**
 * Warm the prefix/length caches for a media playlist before the synchronous
 * rewrite reads them. Bounded so a huge VOD playlist cannot hold the response:
 * one prefix probe per host plus the first few segment length probes.
 *
 * @param {string} body
 * @param {string} manifestUrl
 * @returns {Promise<void>}
 */
async function prewarmPlaylist(body, manifestUrl) {
  const urls = [];
  for (const line of String(body).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const absoluteUrl = resolveSegmentUrl(trimmed, manifestUrl);
    if (!absoluteUrl.includes('.m3u8') && isTikTokCloakedSegment(absoluteUrl)) urls.push(absoluteUrl);
    if (urls.length >= 4) break;
  }
  if (urls.length === 0) return;

  // Prefix is what makes the byterange correct; lengths only shape the range.
  await Promise.race([
    segmentLengthService.probePrefixBytes(urls[0]),
    new Promise(resolve => setTimeout(resolve, 1500))
  ]);

  await Promise.race([
    Promise.allSettled(urls.slice(0, 2).map(u => segmentLengthService.probeLength(u))),
    new Promise(resolve => setTimeout(resolve, 1500))
  ]);
}

module.exports = { rewriteSoccerFullPlaylist, prewarmPlaylist };
