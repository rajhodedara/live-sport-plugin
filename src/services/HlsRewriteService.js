'use strict';

/**
 * HlsRewriteService.js
 *
 * Single source of truth for HLS segment/variant URI rewriting and playlist transformation.
 *
 * Architecture:
 *  - .m3u8  → /api/manifest?url=...&referer=...&origin=...(+rckSuffix)
 *  - TikTok / ByteDance cloaked segments (.image / ~tplv-obj / tiktokcdn):
 *    Zero-Bandwidth Byte-Range exploit:
 *    1. Injects `#EXT-X-BYTERANGE:<length>@42` (needs EXT-X-VERSION >= 4).
 *    2. Addresses the segment according to TIKTOK_SEGMENT_MODE
 *       (see segmentAddressMode):
 *       direct (default) -> the upstream CDN URI itself. The player range-requests
 *                           the CDN, and the CDN slices off the 42 fake WebP
 *                           bytes at its own edge. VPS bandwidth: 0 KB/s.
 *       redirect         -> /api/hls/resource/<token>/media.ts?psig=<hmac>, a 307
 *                           hop to the CDN. ExoPlayer will not follow the
 *                           cross-protocol (http addon -> https CDN) redirect,
 *                           so this survives only as a rollback switch.
 *       proxy            -> CF worker / /api/hlschunk (costs server bandwidth).
 *  - disguised pure MPEG-TS (.png/.webp/.js, no .ts) → append '#.ts' hint
 *  - anything else → absolute URL as-is
 */

const { createWorkerPool } = require('./WorkerBudget');
const byteRangeSigner = require('./ByteRangeSigner');
const segmentLengthService = require('./SegmentLengthService');

// Legacy fallback worker pool (for explicit opt-out or testing)
const workerPool = createWorkerPool();

/**
 * Detect whether a segment URL is a TikTok / ByteDance cloaked segment (WebP with MPEG-TS).
 *
 * @param {string} url
 * @returns {boolean}
 */
function isTikTokCloakedSegment(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('.image') ||
    lower.includes('tplv-obj') ||
    lower.includes('tiktokcdn') ||
    lower.includes('byteoversea') ||
    lower.includes('ibytedtos') ||
    lower.includes('byteimg') ||
    lower.includes('bytegoofy') ||
    lower.includes('cowedd4855ws') ||
    lower.includes('bytedance')
  );
}

/**
 * Resolve a playlist URI against the manifest URL, inheriting the manifest's
 * query params (upstream CDNs key tokens in the query string).
 */
function resolveSegmentUrl(segmentUri, manifestUrl) {
  try {
    const raw = String(segmentUri).trim();
    const chunkUrl = new URL(raw, manifestUrl);
    const manifestObj = new URL(manifestUrl);
    const isAbsoluteReference = /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//');

    // Relative paths on the same host can inherit a parent manifest token.
    // Never copy credentials from one CDN origin to another.
    if (!isAbsoluteReference && chunkUrl.origin === manifestObj.origin) {
      manifestObj.searchParams.forEach((val, key) => {
        if (!chunkUrl.searchParams.has(key)) {
          chunkUrl.searchParams.set(key, val);
        }
      });
    }

    return chunkUrl.toString();
  } catch (_) {
    return segmentUri;
  }
}

/**
 * How a cloaked (ByteDance / TikTok) segment is addressed to the player.
 *
 *  direct   - emit the upstream CDN URI verbatim; the player range-requests it
 *             itself. #EXT-X-BYTERANGE:len@42 is already in the playlist, so the
 *             player skips the fake WebP header with no hop through us. DEFAULT.
 *             The CDN answers 206 with Access-Control-Allow-Origin: * and needs
 *             none of our headers, so removing the hop loses nothing.
 *  redirect - emit /api/hls/resource/<token>/media.ts and bounce the Range
 *             request to the CDN with a 307. NOT ExoPlayer-safe: Media3
 *             DefaultHttpDataSource does not follow cross-protocol redirects
 *             (http addon -> https CDN), so the player is handed the 307 and
 *             fails. Kept as a rollback switch only.
 *  proxy    - stream the bytes through a CF worker / /api/hlschunk (bandwidth).
 *
 * USE_TIKTOK_BYTERANGE_307=off keeps its historical meaning: proxy.
 *
 * @returns {'direct'|'redirect'|'proxy'}
 */
function segmentAddressMode() {
  if (process.env.USE_TIKTOK_BYTERANGE_307 === 'off') return 'proxy';
  const mode = String(process.env.TIKTOK_SEGMENT_MODE || '').trim().toLowerCase();
  if (mode === 'direct' || mode === 'redirect' || mode === 'proxy') return mode;
  return 'direct';
}

/**
 * Build the signed 307 redirect URL for a cloaked TikTok segment, or keep the
 * direct CDN URL when production signing is disabled.
 */
function buildByteRangeRedirectUrl(absoluteUrl, opts = {}) {
  // Missing production configuration disables only this legacy hop. Both URI
  // and full-playlist rewriting use the existing direct-CDN mode instead.
  // Never turn signing failure into a server-side video proxy fallback.
  if (byteRangeSigner.enabled === false) return absoluteUrl;
  const { referer = '', origin = '', absoluteAddonBaseUrl = '' } = opts;
  const { token, psig } = byteRangeSigner.encodeSegmentToken({
    url: absoluteUrl,
    referer,
    origin,
    prefixBytes: 42
  });

  const relativePath = `/api/hls/resource/${token}/media.ts?psig=${encodeURIComponent(psig)}`;
  return absoluteAddonBaseUrl ? new URL(relativePath, absoluteAddonBaseUrl).toString() : relativePath;
}

/**
 * Rewrite one playlist entry into the URL the player should fetch.
 */
function buildManifestProxyUrl(upstreamUrl, opts = {}) {
  const { referer = '', origin = '', userAgent = '', rckSuffix = '', absoluteAddonBaseUrl = '' } = opts;
  let manifestPath = `/api/manifest?url=${encodeURIComponent(upstreamUrl)}`;
  if (referer) manifestPath += `&referer=${encodeURIComponent(referer)}`;
  if (origin) manifestPath += `&origin=${encodeURIComponent(origin)}`;
  if (userAgent) manifestPath += `&hlsua=${encodeURIComponent(userAgent)}`;
  manifestPath += rckSuffix || '';
  return absoluteAddonBaseUrl ? new URL(manifestPath, absoluteAddonBaseUrl).toString() : manifestPath;
}

function rewriteHlsUri(segmentUri, manifestUrl, opts = {}) {
  const { referer = '', origin = '', absoluteAddonBaseUrl = '' } = opts;
  const absoluteUrl = resolveSegmentUrl(segmentUri, manifestUrl);

  if (absoluteUrl.includes('.m3u8')) {
    return buildManifestProxyUrl(absoluteUrl, opts);
  }

  if (isTikTokCloakedSegment(absoluteUrl)) {
    const mode = segmentAddressMode();

    // Explicit opt-out: legacy CF worker budget pool
    if (mode === 'proxy') {
      const pick = workerPool.pick(absoluteUrl);
      if (pick) {
        let workerChunkUrl = `${pick.url}/seg.ts?url=${encodeURIComponent(absoluteUrl)}`;
        if (referer) workerChunkUrl += `&referer=${encodeURIComponent(referer)}`;
        if (origin) workerChunkUrl += `&origin=${encodeURIComponent(origin)}`;
        return workerChunkUrl;
      }

      if (!workerPool.config.hlschunkFallback) {
        return absoluteUrl;
      }

      let chunkPath = `/api/hlschunk?url=${encodeURIComponent(absoluteUrl)}`;
      if (referer) chunkPath += `&referer=${encodeURIComponent(referer)}`;
      if (origin) chunkPath += `&origin=${encodeURIComponent(origin)}`;
      return absoluteAddonBaseUrl ? new URL(chunkPath, absoluteAddonBaseUrl).toString() : chunkPath;
    }

    if (mode === 'redirect') {
      // Legacy zero-bandwidth 307 hop (not ExoPlayer-safe; see segmentAddressMode)
      return buildByteRangeRedirectUrl(absoluteUrl, opts);
    }

    // Default: hand the CDN URI to the player; #EXT-X-BYTERANGE does the skipping.
    return absoluteUrl;
  }

  // Plain MPEG-TS segments stream directly from the upstream CDN (0 VPS bandwidth bleeding).
  const isPureDisguisedTs = absoluteUrl.includes('.png') || absoluteUrl.includes('.webp') || absoluteUrl.includes('.js');
  if (isPureDisguisedTs && !absoluteUrl.includes('.ts')) {
    return absoluteUrl + '#.ts';
  }

  return absoluteUrl;
}

/**
 * HLS tags can carry URI= resources even when the resource is not an ordinary
 * segment line. Keep key/initialization resources direct; playlist resources
 * (including extensionless audio/video renditions) go through /api/manifest.
 * Leave non-HTTP DRM schemes alone.
 */
function rewriteHlsTagUris(line, manifestUrl, opts = {}) {
  const colon = line.indexOf(':');
  if (colon < 0) return line;
  const tag = line.slice(0, colon);
  if (!/^#EXT-X-(?:KEY|SESSION-KEY|MEDIA|I-FRAME-STREAM-INF|IMAGE-STREAM-INF|RENDITION-REPORT|PART|PRELOAD-HINT|MAP|SESSION-DATA)$/.test(tag)) return line;

  const text = line.slice(colon + 1);
  const replacements = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (text[i] === ',' || /\s/.test(text[i]))) i++;
    const keyStart = i;
    while (i < text.length && /[A-Za-z0-9-]/.test(text[i])) i++;
    const key = text.slice(keyStart, i);
    if (!key || text[i] !== '=') {
      while (i < text.length && text[i] !== ',') i++;
      continue;
    }
    i++;
    if (text[i] === '"') {
      const valueStart = i + 1;
      i++;
      while (i < text.length && text[i] !== '"') i++;
      const valueEnd = i;
      const value = text.slice(valueStart, valueEnd);
      if (i < text.length) i++;
      if (key === 'URI' && value) {
        try {
          const resolved = new URL(value, manifestUrl);
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            // Child playlists must go through our manifest proxy so they retain
            // provider headers, recovery identity (rck), and nested redirect handling.
            // URI meaning comes from the HLS tag, not just the filename.
            // KEY, SESSION-KEY, MAP, and SESSION-DATA resources stay direct even
            // if their endpoint happens to end in ".m3u8".
            const isPlaylistReference = tag === '#EXT-X-MEDIA'
              || tag === '#EXT-X-I-FRAME-STREAM-INF'
              || tag === '#EXT-X-RENDITION-REPORT'
              || tag === '#EXT-X-IMAGE-STREAM-INF';
            const isSegmentReference = tag === '#EXT-X-PART' || tag === '#EXT-X-PRELOAD-HINT';
            const rewrittenUri = isPlaylistReference
              ? buildManifestProxyUrl(resolveSegmentUrl(value, manifestUrl), opts)
              : isSegmentReference
                ? rewriteHlsUri(value, manifestUrl, opts)
                : resolved.toString();
            replacements.push({ start: valueStart, end: valueEnd, value: rewrittenUri });
          }
        } catch (_) {}
      }
    } else {
      while (i < text.length && text[i] !== ',') i++;
    }
  }
  if (!replacements.length) return line;
  let rewritten = text;
  for (const item of replacements.reverse()) {
    rewritten = rewritten.slice(0, item.start) + item.value + rewritten.slice(item.end);
  }
  return line.slice(0, colon + 1) + rewritten;
}

/**
 * Rewrite a full HLS playlist manifest text:
 * - Detects #EXTINF segment duration
 * - Injects `#EXT-X-BYTERANGE:<length>@42` above cloaked TikTok segments
 * - Rewrites segment URIs to 307 redirect endpoints
 * - Preserves all other tags (#EXT-X-MAP, #EXT-X-STREAM-INF, etc.)
 *
 * @param {string} manifestBody
 * @param {string} manifestUrl
 * @param {Object} [opts={}]
 * @returns {string}
 */
function rewriteHlsPlaylist(manifestBody, manifestUrl, opts = {}) {
  const { referer = '', origin = '', bitrate } = opts;
  const lines = String(manifestBody).split('\n');
  const rewritten = [];
  let currentDuration = null;
  let hasPrecedingByteRange = false;

  const requiresByteRange = segmentAddressMode() !== 'proxy' && lines.some(l => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return false;
    return isTikTokCloakedSegment(resolveSegmentUrl(t, manifestUrl));
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      rewritten.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      const rewrittenTag = rewriteHlsTagUris(line, manifestUrl, opts);
      if (rewrittenTag !== line) {
        rewritten.push(rewrittenTag);
        continue;
      }
      if (trimmed.startsWith('#EXT-X-VERSION:')) {
        if (requiresByteRange) {
          const v = parseInt(trimmed.slice('#EXT-X-VERSION:'.length).trim(), 10);
          if (isNaN(v) || v < 4) {
            rewritten.push('#EXT-X-VERSION:4');
            continue;
          }
        }
      } else if (trimmed === '#EXTM3U') {
        rewritten.push(line);
        if (requiresByteRange && !manifestBody.includes('#EXT-X-VERSION:')) {
          rewritten.push('#EXT-X-VERSION:4');
        }
        continue;
      } else if (trimmed.startsWith('#EXTINF:')) {
        const durMatch = trimmed.match(/^#EXTINF:([0-9.]+)/i);
        if (durMatch) {
          currentDuration = parseFloat(durMatch[1]);
        }
        hasPrecedingByteRange = false;
      } else if (trimmed.startsWith('#EXT-X-BYTERANGE:')) {
        hasPrecedingByteRange = true;
      } else if (trimmed.startsWith('#EXT-X-MAP:')) {
        const uriMatch = trimmed.match(/URI="([^"]+)"/);
        if (uriMatch) {
          try {
            const absUri = new URL(uriMatch[1], manifestUrl).toString();
            rewritten.push(trimmed.replace(uriMatch[1], absUri));
            continue;
          } catch (_) {}
        }
      }
      rewritten.push(line);
      continue;
    }

    // URI line
    const absoluteUrl = resolveSegmentUrl(trimmed, manifestUrl);

    if (absoluteUrl.includes('.m3u8')) {
      rewritten.push(rewriteHlsUri(trimmed, manifestUrl, opts));
      currentDuration = null;
      hasPrecedingByteRange = false;
      continue;
    }

    if (isTikTokCloakedSegment(absoluteUrl)) {
      const mode = segmentAddressMode();
      if (mode === 'proxy') {
        rewritten.push(rewriteHlsUri(trimmed, manifestUrl, opts));
      } else {
        if (!hasPrecedingByteRange) {
          const segmentLength = segmentLengthService.getSegmentLength(absoluteUrl, {
            duration: currentDuration,
            bitrate,
            referer,
            origin
          });
          rewritten.push(`#EXT-X-BYTERANGE:${segmentLength}@42`);
        }
        rewritten.push(mode === 'redirect' ? buildByteRangeRedirectUrl(absoluteUrl, opts) : absoluteUrl);
      }
      currentDuration = null;
      hasPrecedingByteRange = false;
      continue;
    }

    // Standard / direct segment
    rewritten.push(rewriteHlsUri(trimmed, manifestUrl, opts));
    currentDuration = null;
    hasPrecedingByteRange = false;
  }

  return rewritten.join('\n');
}

/**
 * Scan a manifest body for cloaked TikTok segments and pre-probe all un-cached
 * segments in parallel before the manifest is rewritten.
 *
 * Ensures #EXT-X-BYTERANGE declarations match the exact byte size served by the
 * upstream CDN, preventing player decoder EOF stalls and repeated frames.
 *
 * @param {string} manifestBody
 * @param {string} manifestUrl
 * @param {Object} [opts={}]
 * @returns {Promise<void>}
 */
async function preprobeManifestSegments(manifestBody, manifestUrl, opts = {}) {
  const { referer = '', origin = '' } = opts;
  const lines = String(manifestBody).split('\n');
  const urlsToProbe = new Set();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const absUrl = resolveSegmentUrl(trimmed, manifestUrl);
    if (isTikTokCloakedSegment(absUrl)) {
      if (!segmentLengthService.hasValidLength(absUrl)) {
        urlsToProbe.add(absUrl);
      }
    }
  }

  if (urlsToProbe.size === 0) return;

  // Prioritize the live edge (last 4 segments): players begin playback from the
  // freshest edge, not the historical buffer. Bounding candidates to the latest
  // segments ensures the concurrent probe slots are spent on the immediate chunks
  // the player will request.
  const liveEdgeUrls = [...urlsToProbe].slice(-4);

  const probePromises = liveEdgeUrls.map(url =>
    segmentLengthService.probeContentLength(url, { referer, origin })
  );

  await Promise.race([
    Promise.allSettled(probePromises),
    new Promise(resolve => setTimeout(resolve, 1500))
  ]);
}

module.exports = {
  resolveSegmentUrl,
  segmentAddressMode,
  rewriteHlsUri,
  rewriteHlsPlaylist,
  preprobeManifestSegments,
  isTikTokCloakedSegment,
  buildByteRangeRedirectUrl,
  workerPool,
};
