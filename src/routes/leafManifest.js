'use strict';

/**
 * routes/leafManifest.js - High-performance HLS manifest proxy & coalescer for Leaf (Highfly / Papacito)
 *
 * GET /api/leaf/manifest.m3u8?url=<signed_papacito_url>
 * GET /api/leaf/manifest.m3u8?d=<base64_encoded_state>
 * GET /api/leaf/m3u8/:state/index.m3u8
 *
 * Architecture & Zero Bandwidth Bleed Policy:
 *  - Papacito requires authenticated segment hashes (?a=<hash> or ?t=<hash>) on Cloudflare CDN edge.
 *    Without this auth hash, Cloudflare returns an invalid link / expired video slate.
 *  - This endpoint fetches the upstream ~800-byte text playlist on demand, preserving all authenticated
 *    segment URLs (?a=...).
 *  - High-traffic request coalescing (single-flight) and in-memory caching ensures that even
 *    with 10,000 concurrent viewers, only ONE lightweight 800-byte manifest fetch hits upstream every few seconds.
 *  - All media segments (.ts) resolve directly to Cloudflare edge CDN (e.g. https://w1.papacito.cfd),
 *    guaranteeing ZERO video bytes ever pass through the Nuvio server (100% Zero Bandwidth Bleed compliance).
 */

const express = require('express');
const router = express.Router();
const providerOutbound = require('../services/ProviderOutbound');
const { validateLeafManifestUrl: validateTargetUrl } = require('../services/GuardedEgressPolicy');
const leafState = require('../services/LeafState');
const leafMint = require('../services/LeafMint');

// Live edge vs request budget: papacito's playlists run #EXT-X-TARGETDURATION:11
// (~10s segments, ~8 deep window), so a 6s shared cache never serves a segment that
// has already fallen out of the window, while collapsing N viewers into one upstream
// fetch. 2.5s was needlessly expensive upstream.
const MANIFEST_CACHE_TTL_MS = Math.max(2500, Number(process.env.LEAF_PLAYLIST_TTL_MS) || 6000);
const FALLBACK_TTL_MS = 60 * 1000; // 60s stale fallback in case upstream has transient timeout
const MAX_MANIFEST_BYTES = 256 * 1024;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

const manifestCache = new Map(); // targetUrl -> { body, expiresAt, staleUntil }
const inFlightFetches = new Map(); // targetUrl -> Promise<string>

// Retain legacy session cache for backward compatibility / fallback
const sessionCache = new Map();

function isTransientFetchFailure(error) {
  return error?.leafTransient === true || error?.name === 'TimeoutError' ||
    TRANSIENT_NETWORK_CODES.has(error?.code);
}

/**
 * Sanitize and ensure all segment lines in upstream m3u8 body have absolute CDN URLs.
 */
function sanitizeManifestBody(body, targetUrl) {
  if (!body || !body.includes('#EXT')) {
    throw new Error('Upstream returned non-m3u8 body');
  }

  if (/_antipiracy|antipiracy|stream_notice/i.test(body)) {
    throw Object.assign(new Error('Upstream returned denied media'), { code: 'ERR_LEAF_UPSTREAM_DENIED' });
  }

  let defaultCdnBase = 'https://w1.papacito.cfd';
  if (targetUrl) {
    try {
      const u = new URL(targetUrl);
      if (!u.hostname.includes('papacito.cfd')) {
        defaultCdnBase = u.origin;
      }
    } catch (_) {}
  }

  const lines = body.split('\n');

  // Derive cdnBase from actual media segments (lines not starting with #), avoid matching comments/metadata
  let cdnBase = defaultCdnBase;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
      try {
        cdnBase = new URL(trimmed).origin;
        break;
      } catch (_) {}
    }
  }

  const sanitizedLines = [];
  let isNextLineVariant = false;

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Directives and comments
    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#EXT-X-STREAM-INF:') || trimmed.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
        isNextLineVariant = true;
      }
      sanitizedLines.push(trimmed);
      continue;
    }

    // Master playlist child variant playlist line
    if (isNextLineVariant || /\.m3u8(?:[?#]|$)/i.test(trimmed)) {
      isNextLineVariant = false;
      let absoluteVariant = trimmed;
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        try {
          absoluteVariant = new URL(trimmed, targetUrl).href;
        } catch (_) {
          absoluteVariant = trimmed.startsWith('/') ? `${cdnBase}${trimmed}` : `${cdnBase}/${trimmed}`;
        }
      }
      sanitizedLines.push(`/api/leaf/manifest.m3u8?url=${encodeURIComponent(absoluteVariant)}`);
      continue;
    }

    // Media segment URL: ensure absolute URL while preserving all query parameters (?a=..., ?t=...)
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      sanitizedLines.push(trimmed);
    } else if (trimmed.startsWith('/')) {
      sanitizedLines.push(`${cdnBase}${trimmed}`);
    } else {
      sanitizedLines.push(`${cdnBase}/${trimmed}`);
    }
  }

  return sanitizedLines.join('\n') + '\n';
}

/**
 * Fetch live upstream manifest with single-flight request coalescing and micro-caching.
 */
async function getOrFetchLiveManifest(targetUrl) {
  validateTargetUrl(targetUrl);
  const now = Date.now();
  const cached = manifestCache.get(targetUrl);

  if (cached && now < cached.expiresAt) {
    return cached.body;
  }

  let fetchPromise = inFlightFetches.get(targetUrl);
  if (!fetchPromise) {
    // Install the in-flight entry before a synchronous dependency failure can
    // clear it, so a failed request cannot leave a permanently rejected entry.
    fetchPromise = Promise.resolve().then(async () => {
      try {
        const res = await providerOutbound.safeFetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
            'Referer': 'https://sports.highfly.to/',
            'Origin': 'https://sports.highfly.to',
            'Accept': '*/*'
          },
          timeoutMs: 6000,
          maxBodyBytes: MAX_MANIFEST_BYTES,
          diagnosticOwner: 'manifest'
        });

        if (!res || !res.ok) {
          throw Object.assign(new Error(`HTTP ${res ? res.status : 'No response'}`), {
            code: 'ERR_LEAF_UPSTREAM_STATUS',
            upstreamStatus: res ? res.status : 0,
            leafTransient: Boolean(res && TRANSIENT_HTTP_STATUSES.has(res.status))
          });
        }
        // Guarded outbound validates DNS/IP and every redirect before dialing.
        // Also reject a final redirect outside Leaf's intended host scope.
        if (res.url) {
          try { validateTargetUrl(res.url); }
          catch (_) {
            throw Object.assign(new Error('Invalid Leaf manifest redirect'), { code: 'ERR_LEAF_MANIFEST_REDIRECT' });
          }
        }
        if (res.bodyTruncated) {
          throw Object.assign(new Error('Leaf manifest exceeds its body limit'), { code: 'ERR_LEAF_BODY_LIMIT' });
        }

        const rawBody = await res.text();
        if (typeof rawBody !== 'string' || !/^\uFEFF?#EXTM3U(?:\r?\n|$)/.test(rawBody)) {
          throw Object.assign(new Error('Upstream returned non-m3u8 body'), { code: 'ERR_LEAF_MANIFEST_BODY' });
        }
        const sanitizedBody = sanitizeManifestBody(rawBody, res.url || targetUrl);

        // LRU-style map eviction if cache grows beyond 1000 items
        if (manifestCache.size >= 1000) {
          const oldestKey = manifestCache.keys().next().value;
          manifestCache.delete(oldestKey);
        }

        manifestCache.set(targetUrl, {
          body: sanitizedBody,
          expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS,
          staleUntil: Date.now() + FALLBACK_TTL_MS
        });

        return sanitizedBody;
      } catch (err) {
        // Only transient transport/server failures may reuse a short-lived
        // window. Authorization, guard and malformed-body failures stay errors.
        if (cached && isTransientFetchFailure(err) && Date.now() < cached.staleUntil) {
          // Extend cache expiration by 2s backoff to avoid immediate retry stampede
          cached.expiresAt = Date.now() + 2000;
          return cached.body;
        }
        manifestCache.delete(targetUrl);
        throw err;
      } finally {
        inFlightFetches.delete(targetUrl);
      }
    });

    inFlightFetches.set(targetUrl, fetchPromise);
  }

  return fetchPromise;
}

/**
 * Parse upstream manifest body into anchor session parameters (legacy/testing export).
 */
function parseUpstreamManifest(body, targetUrl) {
  if (!body || !body.includes('#EXT')) {
    throw new Error('Upstream returned non-m3u8 body');
  }

  if (/_antipiracy|antipiracy|stream_notice/i.test(body)) {
    throw new Error('Upstream returned anti-piracy trap');
  }

  const durMatch = body.match(/#EXT-X-TARGETDURATION:(\d+)/);
  const targetDuration = durMatch ? parseInt(durMatch[1], 10) : 6;

  const discMatch = body.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/);
  const discontinuitySeq = discMatch ? parseInt(discMatch[1], 10) : 0;

  const segRegex = /(https?:\/\/[^\s\/]+)\/leaf\/([^\s\/]+)\/([^\s\/]+)\/seg_(\d+)\.ts/g;
  const matches = [...body.matchAll(segRegex)];

  if (!matches || matches.length === 0) {
    throw new Error('No valid Papacito media segments found in upstream manifest');
  }

  const firstMatch = matches[0];
  const cdnBase = firstMatch[1];
  const slug = firstMatch[2];
  const session = firstMatch[3];
  const edge = parseInt(firstMatch[4], 10);

  return {
    cdnBase,
    slug,
    session,
    edge,
    targetDuration,
    discontinuitySeq,
    at: Date.now(),
    expiresAt: Date.now() + 4 * 60 * 60 * 1000
  };
}

/**
 * Generate RFC 8216 HLS sliding-window playlist text (fallback/testing export).
 */
function generateSlidingPlaylist(sessionData) {
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - sessionData.at) / 1000);
  const dur = sessionData.targetDuration || 6;
  const seqOffset = Math.floor(elapsedSec / dur);

  const liveEdge = sessionData.edge + seqOffset;
  const windowSize = 8;
  const mediaSeq = Math.max(sessionData.edge, liveEdge - windowSize);

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${dur}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${sessionData.discontinuitySeq || 0}`,
    '#EXT-X-ALLOW-CACHE:NO'
  ];

  for (let i = 0; i < windowSize; i++) {
    const s = mediaSeq + i;
    lines.push(`#EXTINF:${dur.toFixed(3)},`);
    lines.push(`${sessionData.cdnBase}/leaf/${sessionData.slug}/${sessionData.session}/seg_${s}.ts`);
  }

  return lines.join('\n') + '\n';
}

router.get(['/api/leaf/manifest.m3u8', '/api/leaf/live.m3u8'], async (req, res) => {
  let targetUrl = req.query.url;
  const stateEncoded = req.query.d;

  // Reconstruct unencoded targetUrl if Express query parser split on unencoded ampersands (&)
  if (targetUrl && req.url) {
    const urlIdx = req.url.indexOf('url=');
    if (urlIdx !== -1) {
      const rawTarget = req.url.slice(urlIdx + 4);
      if (rawTarget.includes('&') && (rawTarget.startsWith('http://') || rawTarget.startsWith('https://'))) {
        targetUrl = rawTarget;
      }
    }
  }

  try {
    let playlist = null;

    if (targetUrl) {
      playlist = await getOrFetchLiveManifest(targetUrl);
    } else if (stateEncoded) {
      try {
        const decodedStr = Buffer.from(stateEncoded, 'base64url').toString('utf8');
        const sessionData = JSON.parse(decodedStr);
        playlist = generateSlidingPlaylist(sessionData);
      } catch (err) {
        return res.status(400).send('Invalid state payload');
      }
    } else {
      return res.status(400).send('Missing url or d parameter');
    }

    if (!playlist) {
      return res.status(502).send('Failed to obtain Leaf playlist');
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).send(playlist);
  } catch (err) {
    // Fetch errors can contain signed URLs; log only the failure class.
    console.error('[LeafManifest] Failed to resolve Leaf playlist:', err.code || 'ERR_LEAF_UPSTREAM');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(err.code === 'ERR_LEAF_MANIFEST_URL' ? 400 : 502).send('Failed to resolve Leaf playlist');
  }
});

/**
 * Mint-at-fetch path: `/api/leaf/m3u8/<signed-state>/index.m3u8`.
 *
 * The state carries only `{m: matchId, s: slug}`. Nothing upstream-facing is stored, so
 * upstream credentials are held only in a bounded server-side cache. A denied answer (`stream_notice`)
 * is rejected and backed off. The route never generates a replacement identity or
 * retries an upstream denial with a cache buster.
 */
async function resolveViaState(stateToken) {
  const payload = leafState.verify(stateToken);
  if (!payload) {
    throw Object.assign(new Error('Invalid or expired leaf state'), {
      code: 'ERR_LEAF_STATE', statusCode: 400
    });
  }

  const minted = await leafMint.mintUrl(payload.m, payload.s);
  try {
    return { playlist: await getOrFetchLiveManifest(minted), payload };
  } catch (err) {
    // An upstream denial or invalid body is not permission to bypass it by
    // re-minting with a cache buster. Discard that credential and back off.
    if (!isTransientFetchFailure(err)) {
      leafMint.invalidate(payload.m, payload.s);
      leafMint.noteFailure(payload.m, payload.s, {
        reason: err?.code || 'ERR_LEAF_PLAYLIST'
      });
    }
    throw err;
  }
}

router.get(['/api/leaf/m3u8/:state/index.m3u8', '/api/leaf/m3u8/:state'], async (req, res) => {
  try {
    const { playlist } = await resolveViaState(req.params.state);
    if (!playlist) throw new Error('empty playlist');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).send(playlist);
  } catch (err) {
    const status = err.statusCode || 502;
    if (status >= 500) console.warn('[LeafManifest] state route failed:', err.code || 'ERR_LEAF_UPSTREAM');
    if (err.retryAfterMs) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(status).send(status === 400 ? 'Invalid leaf state' : 'Failed to resolve Leaf playlist');
  }
});

module.exports = router;
module.exports.sanitizeManifestBody = sanitizeManifestBody;
module.exports.getOrFetchLiveManifest = getOrFetchLiveManifest;
module.exports.parseUpstreamManifest = parseUpstreamManifest;
module.exports.generateSlidingPlaylist = generateSlidingPlaylist;
module.exports.manifestCache = manifestCache;
module.exports.sessionCache = sessionCache;
