'use strict';

/**
 * HlsRewriteService.js
 *
 * Single source of truth for HLS segment/variant URI rewriting.
 *
 * Both /api/manifest (playlist proxy) and the speed probe in streams.js must
 * build the exact URL a player would use for a given playlist entry. Before
 * this module existed the CF worker pool and the rewrite rules were duplicated
 * inline in routes/manifest.js and streams.js, which drifted apart once.
 *
 * Rewrite rules (mirrors what routes/manifest.js did inline):
 *  - .m3u8  → /api/manifest?url=...&referer=...&origin=...(+rckSuffix)
 *  - .image → random Cloudflare Worker (strips the 42-byte fake WebP/RIFF
 *             header Streamed.pk / TikTok CDN prepends), fallback /api/hlschunk
 *  - disguised pure MPEG-TS (.png/.webp/.js, no .ts) → append '#.ts' hint
 *  - anything else → absolute URL as-is
 */

const CF_IMAGE_WORKER_POOL = [
  'https://nuvio-proxy.odedararaj456.workers.dev',
  'https://nuvio-proxy2.rajodedara360.workers.dev',
  'https://nuvio-proxy3.raj-odedara.workers.dev',
  'https://spring-brook-5c1e.rajodedara456.workers.dev',
  'https://falling-unit-ffa6.rajcfproxy1.workers.dev',
];

function getCfImageWorker() {
  if (!CF_IMAGE_WORKER_POOL.length) return null;
  return CF_IMAGE_WORKER_POOL[Math.floor(Math.random() * CF_IMAGE_WORKER_POOL.length)];
}

/**
 * Resolve a playlist URI against the manifest URL, inheriting the manifest's
 * query params (upstream CDNs key tokens in the query string).
 */
function resolveSegmentUrl(segmentUri, manifestUrl) {
  try {
    const chunkUrl = new URL(segmentUri, manifestUrl);
    const manifestObj = new URL(manifestUrl);

    manifestObj.searchParams.forEach((val, key) => {
      if (!chunkUrl.searchParams.has(key)) {
        chunkUrl.searchParams.set(key, val);
      }
    });

    return chunkUrl.toString();
  } catch (_) {
    return segmentUri;
  }
}

/**
 * Rewrite one playlist entry into the URL the player should fetch.
 */
function rewriteHlsUri(segmentUri, manifestUrl, opts = {}) {
  const { referer = '', origin = '', rckSuffix = '', absoluteAddonBaseUrl = '' } = opts;
  const absoluteUrl = resolveSegmentUrl(segmentUri, manifestUrl);

  if (absoluteUrl.includes('.m3u8')) {
    let manifestPath = `/api/manifest?url=${encodeURIComponent(absoluteUrl)}`;
    if (referer) manifestPath += `&referer=${encodeURIComponent(referer)}`;
    if (origin) manifestPath += `&origin=${encodeURIComponent(origin)}`;
    manifestPath += rckSuffix || '';
    return absoluteAddonBaseUrl ? new URL(manifestPath, absoluteAddonBaseUrl).toString() : manifestPath;
  }

  if (absoluteUrl.includes('.image')) {
    const cfWorker = getCfImageWorker();
    if (cfWorker) {
      let workerChunkUrl = `${cfWorker}/?url=${encodeURIComponent(absoluteUrl)}`;
      if (referer) workerChunkUrl += `&referer=${encodeURIComponent(referer)}`;
      if (origin) workerChunkUrl += `&origin=${encodeURIComponent(origin)}`;
      return workerChunkUrl;
    }

    let chunkPath = `/api/hlschunk?url=${encodeURIComponent(absoluteUrl)}`;
    if (referer) chunkPath += `&referer=${encodeURIComponent(referer)}`;
    if (origin) chunkPath += `&origin=${encodeURIComponent(origin)}`;
    return absoluteAddonBaseUrl ? new URL(chunkPath, absoluteAddonBaseUrl).toString() : chunkPath;
  }

  // Plain MPEG-TS segments (e.g. the Streamed.pk 540p variant served by
  // lb*.strmd.st) are intermittently refused on a direct fetch — observed ~1/3
  // success, with the rest failing at the connection level. The same worker
  // pool relays them reliably (verified 5/5 workers, valid 0x47 sync byte), so
  // plain .ts goes through the workers too. /api/hlschunk stays as the
  // server-side fallback when no worker is configured.
  if (/\.ts(\?|$)/.test(absoluteUrl) && absoluteUrl.includes('strmd.st')) {
    const cfWorker = getCfImageWorker();
    if (cfWorker) {
      let workerChunkUrl = `${cfWorker}/?url=${encodeURIComponent(absoluteUrl)}`;
      if (referer) workerChunkUrl += `&referer=${encodeURIComponent(referer)}`;
      if (origin) workerChunkUrl += `&origin=${encodeURIComponent(origin)}`;
      return workerChunkUrl;
    }

    let chunkPath = `/api/hlschunk?url=${encodeURIComponent(absoluteUrl)}`;
    if (referer) chunkPath += `&referer=${encodeURIComponent(referer)}`;
    if (origin) chunkPath += `&origin=${encodeURIComponent(origin)}`;
    return absoluteAddonBaseUrl ? new URL(chunkPath, absoluteAddonBaseUrl).toString() : chunkPath;
  }

  const isPureDisguisedTs = absoluteUrl.includes('.png') || absoluteUrl.includes('.webp') || absoluteUrl.includes('.js');
  if (isPureDisguisedTs && !absoluteUrl.includes('.ts')) {
    return absoluteUrl + '#.ts';
  }

  return absoluteUrl;
}

module.exports = {
  CF_IMAGE_WORKER_POOL,
  getCfImageWorker,
  resolveSegmentUrl,
  rewriteHlsUri,
};
