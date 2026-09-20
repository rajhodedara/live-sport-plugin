/**
 * routes/manifest.js - /api/manifest HLS playlist proxy
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const express = require('express');
const router = express.Router();
const {
  MANIFEST_TTL_MS, playlistHasContent,
  manifestCacheGet, manifestCacheSet, manifestCacheSetNegative,
  notifyResolveCacheOfDeadStream, fetchUpstreamManifest,
  manifestInFlight
} = require('../manifestProxy');
const {
  readRck, getRemintCacheKey, remintCache, mergeRemintedUrl, isExpiryStatus, attemptRemint
} = require('../remint');

// ─── Cloudflare Worker Pool (.image only) ─────────────────────────────────────
// Used EXCLUSIVELY for Streamed.pk / TikTok CDN .image segments.
// Each worker strips the 42-byte fake WebP/RIFF header in-flight at the edge.
// All other traffic goes direct or through /api/hlschunk as before.
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

router.get('/api/manifest', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://embed.st/';
  const origin = req.query.origin || 'https://embed.st';

  if (!targetUrl) return res.status(400).send('Missing url');

  // Playlist-only proxy (same as WatchFooty / Streamed.pk .ts): this host fetches
  // the m3u8 with the CDN Referer, then the player pulls every media byte from the CDN.
  const cacheKey = `${targetUrl}|${referer}|${origin}`;
  // Recovery key for this stream, if the URL was emitted by our own resolver.
  const rck = readRck(req);
  const rckSuffix = rck ? '&rck=' + encodeURIComponent(rck) : '';
  const entry = manifestCacheGet(cacheKey);
  if (entry && entry.negative) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Manifest-Cache', 'NEGATIVE');
    return res.status(entry.status).send(entry.body);
  }
  if (entry) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Manifest-Cache', 'HIT');
    return res.send(entry.body);
  }

  try {
    let fetchPromise = manifestInFlight.get(cacheKey);
    if (!fetchPromise) {
      fetchPromise = (async () => {
        let effectiveUrl = targetUrl;
        let reminted = false;

        if (rck) {
          const subKey = getRemintCacheKey(rck, effectiveUrl);
          const cached = (subKey ? remintCache.get(subKey) : null) || remintCache.get(rck);
          if (cached && Date.now() < cached.expiresAt) {
            effectiveUrl = mergeRemintedUrl(effectiveUrl, cached.freshUrl, rck);
            reminted = true;
          }
        }

        let out;
        try {
          out = await fetchUpstreamManifest(effectiveUrl, referer, origin);
        } catch (firstErr) {
          const fresh = (isExpiryStatus(firstErr) && rck) ? await attemptRemint(rck, effectiveUrl || targetUrl) : null;
          if (!fresh || fresh === effectiveUrl) throw firstErr;
          
          console.log('[ManifestProxy] Upstream token expired — re-minted, retrying transparently');
          const subKey = getRemintCacheKey(rck, effectiveUrl || targetUrl);
          if (subKey) remintCache.set(subKey, { freshUrl: fresh, expiresAt: Date.now() + 15 * 60 * 1000 });
          remintCache.set(rck, { freshUrl: fresh, expiresAt: Date.now() + 15 * 60 * 1000 });
          
          // Preserve the variant the player asked for (see mergeRemintedUrl).
          effectiveUrl = mergeRemintedUrl(targetUrl, fresh, rck);
          reminted = true;
          out = await fetchUpstreamManifest(effectiveUrl, referer, origin);
        }
        if (!out.includes('#EXT')) {
          console.error('[ManifestProxy] Upstream returned non-m3u8 body for', effectiveUrl);
          throw new Error('Upstream returned non-m3u8 body');
        }

        // Reject header-only playlists (tags but no segment/variant URI). Feeding
        // one to a player just stalls it; reporting it lets the client fail over.
        if (!playlistHasContent(out)) {
          console.warn('[ManifestProxy] Upstream playlist has no media entries (empty live window) for', effectiveUrl);
          throw new Error('Upstream playlist has no media entries');
        }

        let dynamicTtl = MANIFEST_TTL_MS;
        try {
          const m3u8Parser = require('m3u8-parser');
          const parser = new m3u8Parser.Parser();
          parser.push(out);
          parser.end();
          if (parser.manifest.targetDuration) {
            dynamicTtl = (parser.manifest.targetDuration * 1000) / 2;
          }
        } catch (e) {
          // Fallback to default TTL on parse error
        }

        const isLive = !out.includes('#EXT-X-ENDLIST');
        const isMaster = out.includes('#EXT-X-STREAM-INF');

        // Master playlists can be cached longer, but live media playlists must refresh dynamically (2-3s)
        if (isMaster) {
          dynamicTtl = 60000;
        } else if (isLive) {
          dynamicTtl = Math.min(dynamicTtl, 3000);
        }
        let injectedStart = out.includes('#EXT-X-START');

        const lines = out.split('\n');
        const rewritten = lines.map(line => {
          const l = line.trim();

          let resultLine = line;

          if (!l) return resultLine;
          
          if (l.startsWith('#')) {
              // Handle EXT-X-MAP:URI="relative.mp4"
              if (l.startsWith('#EXT-X-MAP:')) {
                  const uriMatch = l.match(/URI="([^"]+)"/);
                  if (uriMatch) {
                      try {
                          const absUri = new URL(uriMatch[1], effectiveUrl).toString();
                          resultLine = l.replace(uriMatch[1], absUri);
                      } catch(e) {}
                  }
              }
              return resultLine;
          }

          let absoluteUrl = l;
          try {
            const chunkUrl = new URL(l, effectiveUrl);
            const manifestUrl = new URL(effectiveUrl);

            manifestUrl.searchParams.forEach((val, key) => {
              if (!chunkUrl.searchParams.has(key)) {
                chunkUrl.searchParams.set(key, val);
              }
            });
            absoluteUrl = chunkUrl.toString();
          } catch (err) {
            absoluteUrl = l;
          }

          if (absoluteUrl.includes('.m3u8')) {
            return `/api/manifest?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}${rckSuffix}`;
          }

          // .image = Streamed.pk / TikTok CDN — has a real 42-byte fake WebP/RIFF header
          // that must be stripped before the player sees MPEG-TS. Route to CF worker (edge strip).
          // Fallback to /api/hlschunk if no CF worker configured.
          const needsUnwrapping = absoluteUrl.includes('.image');
          if (needsUnwrapping) {
            const cfWorker = getCfImageWorker();
            if (cfWorker) {
              let workerChunkUrl = `${cfWorker}/?url=${encodeURIComponent(absoluteUrl)}`;
              if (referer) workerChunkUrl += `&referer=${encodeURIComponent(referer)}`;
              if (origin) workerChunkUrl += `&origin=${encodeURIComponent(origin)}`;
              return workerChunkUrl;
            }
            // fallback: strip on server
            let chunkUrl = `/api/hlschunk?url=${encodeURIComponent(absoluteUrl)}`;
            if (referer) chunkUrl += `&referer=${encodeURIComponent(referer)}`;
            return chunkUrl;
          }

          // WatchFooty / Alibaba / R2 / Tencent: pure MPEG-TS with disguised extension (.png, .webp, .js)
          // No header wrapper — starts with 0x47 byte 0. Just append #.ts hint for naive parsers.
          const isPureDisguisedTs = absoluteUrl.includes('.png') || absoluteUrl.includes('.webp') || absoluteUrl.includes('.js');
          if (isPureDisguisedTs && !absoluteUrl.includes('.ts')) {
            return absoluteUrl + '#.ts';
          }

          return absoluteUrl;
        });

        const rewrittenResult = rewritten.join('\n');
        manifestCacheSet(cacheKey, rewrittenResult, dynamicTtl);
        return rewrittenResult;
      })().finally(() => {
        manifestInFlight.delete(cacheKey);
      });
      manifestInFlight.set(cacheKey, fetchPromise);
    }

    const finalBody = await fetchPromise;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Manifest-Cache', 'MISS');
    res.send(finalBody);
  } catch (err) {
    // Preserve the old 404 semantics so players can fail over to another stream.
    // Failures are negatively cached (15 s) so player polls stop hammering the dead upstream.
    // In parallel, drop the originating resolve-cache entry so the next click mints fresh.
    notifyResolveCacheOfDeadStream(req.originalUrl || req.url);
    // Auth/expiry statuses from the CDN mean the embedded upstream token is gone,
    // not that this proxy is broken. Providers were observed to answer expired
    // tokens with 403 (see streams.js verifyStreams). Reporting those as 404 lets
    // the player fail over cleanly instead of hard-erroring on a misleading 502.
    const upstreamStatus = err && err.statusCode;
    const isExpired = upstreamStatus === 401 || upstreamStatus === 403 ||
                      upstreamStatus === 404 || upstreamStatus === 410;
    // A transient upland 5xx that survived the retry above is NOT a broken proxy —
    // the upstream is just briefly unavailable. Reporting 404 lets the player fail
    // over to another stream instead of stalling on a 502.
    const isTransientUpstream = upstreamStatus >= 500 && upstreamStatus <= 599;
    if (err.message === 'Upstream returned non-m3u8 body' ||
        err.message === 'Upstream playlist has no media entries' ||
        isExpired || isTransientUpstream) {
      if (isExpired) {
        console.warn(`[ManifestProxy] Upstream refused with ${upstreamStatus} (expired token?) for ${targetUrl}`);
      } else if (isTransientUpstream) {
        console.warn(`[ManifestProxy] Upstream ${upstreamStatus} persisted after retry; reporting 404 so the player fails over`);
      }
      // Negative-cache briefly so the player's rapid polls don't hammer a dead
      // upstream, but short enough that a recovered upstream is picked up quickly.
      manifestCacheSetNegative(cacheKey, 404, 'Stream not found or expired');
      return res.status(404).send('Stream not found or expired');
    }
    console.error('[ManifestProxy] Error:', err.message);
    manifestCacheSetNegative(cacheKey, 502, 'Manifest proxy error: ' + err.message);
    return res.status(502).send('Manifest proxy error: ' + err.message);
  }
});


module.exports = router;
