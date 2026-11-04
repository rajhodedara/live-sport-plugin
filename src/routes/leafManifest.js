'use strict';

/**
 * routes/leafManifest.js - High-performance HLS manifest proxy & coalescer for Leaf (Highfly / Papacito)
 *
 * GET /api/leaf/manifest.m3u8?url=<signed_papacito_url>
 * GET /api/leaf/manifest.m3u8?d=<base64_encoded_state>
 *
 * Architecture & Zero Bandwidth Bleed Policy:
 *  - Papacito requires authenticated segment hashes (?a=<hash> or ?t=<hash>) on Cloudflare CDN edge.
 *    Without this auth hash, Cloudflare returns an invalid link / expired video slate.
 *  - This endpoint fetches the upstream ~800-byte text playlist on demand, preserving all authenticated
 *    segment URLs (?a=...).
 *  - High-traffic request coalescing (single-flight) and 2.5-second in-memory caching ensures that even
 *    with 10,000 concurrent viewers, only ONE lightweight 800-byte manifest fetch hits upstream every 2.5s.
 *  - All media segments (.ts) resolve directly to Cloudflare edge CDN (e.g. https://w1.papacito.cfd),
 *    guaranteeing ZERO video bytes ever pass through the Nuvio server (100% Zero Bandwidth Bleed compliance).
 */

const express = require('express');
const router = express.Router();
const impitClient = require('../impitClient');

const MANIFEST_CACHE_TTL_MS = 2500; // 2.5 seconds (HLS segments are 6s; guarantees fresh live edge)
const FALLBACK_TTL_MS = 60 * 1000; // 60s stale fallback in case upstream has transient timeout

const manifestCache = new Map(); // targetUrl -> { body, expiresAt, staleUntil }
const inFlightFetches = new Map(); // targetUrl -> Promise<string>

// Retain legacy session cache for backward compatibility / fallback
const sessionCache = new Map();

/**
 * Sanitize and ensure all segment lines in upstream m3u8 body have absolute CDN URLs.
 */
function sanitizeManifestBody(body, targetUrl) {
  if (!body || !body.includes('#EXT')) {
    throw new Error('Upstream returned non-m3u8 body');
  }

  if (/_antipiracy|antipiracy|stream_notice/i.test(body)) {
    throw new Error('Upstream returned anti-piracy trap');
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
  const now = Date.now();
  const cached = manifestCache.get(targetUrl);

  if (cached && now < cached.expiresAt) {
    return cached.body;
  }

  let fetchPromise = inFlightFetches.get(targetUrl);
  if (!fetchPromise) {
    fetchPromise = (async () => {
      try {
        const res = await impitClient.safeFetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
            'Referer': 'https://sports.highfly.to/',
            'Origin': 'https://sports.highfly.to',
            'Accept': '*/*'
          },
          timeoutMs: 6000
        });

        if (!res || !res.ok) {
          throw new Error(`HTTP ${res ? res.status : 'No response'}`);
        }

        const rawBody = await res.text();
        const sanitizedBody = sanitizeManifestBody(rawBody, targetUrl);

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
        // Fall back to stale cached manifest if available within fallback window
        if (cached && Date.now() < cached.staleUntil) {
          // Extend cache expiration by 2s backoff to avoid immediate retry stampede
          cached.expiresAt = Date.now() + 2000;
          return cached.body;
        }
        throw err;
      } finally {
        inFlightFetches.delete(targetUrl);
      }
    })();

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
    console.error(`[LeafManifest] Failed to resolve Leaf playlist: ${err.message}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).send(`Upstream Leaf Error: ${err.message}`);
  }
});

module.exports = router;
module.exports.sanitizeManifestBody = sanitizeManifestBody;
module.exports.getOrFetchLiveManifest = getOrFetchLiveManifest;
module.exports.parseUpstreamManifest = parseUpstreamManifest;
module.exports.generateSlidingPlaylist = generateSlidingPlaylist;
module.exports.manifestCache = manifestCache;
module.exports.sessionCache = sessionCache;
