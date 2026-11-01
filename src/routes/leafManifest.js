'use strict';

/**
 * routes/leafManifest.js - Synthetic sliding-window HLS generator for Leaf (Highfly / Papacito)
 *
 * GET /api/leaf/manifest.m3u8?url=<signed_papacito_url>
 * GET /api/leaf/manifest.m3u8?d=<base64_encoded_state>
 *
 * Why this exists:
 *  - Papacito's tokenized origin manifest (https://papacito.cfd/m3u/<slug>/live.m3u8?ft=...)
 *    actively detects repeated polling from VPS/datacenter IPs and triggers an anti-piracy
 *    trap playlist (_antipiracy/v2/seg_000.ts).
 *  - However, the underlying media segments (*.ts) are hosted on Cloudflare edge CDN
 *    (e.g. https://w1.papacito.cfd) and are completely public with Access-Control-Allow-Origin: *.
 *  - By fetching the upstream manifest EXACTLY ONCE to establish session anchors (cdnBase,
 *    slug, session ID, sequence offset, target duration), this endpoint generates the HLS
 *    sliding window dynamically in memory using wall-clock arithmetic (< 1ms CPU response).
 *  - Media segments resolve directly to Cloudflare edge CDN, ensuring ZERO video bytes pass
 *    through the Nuvio server (100% compliance with Zero Server Bandwidth Bleed Policy).
 */

const express = require('express');
const router = express.Router();
const impitClient = require('../impitClient');

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (spans a full sporting event)
const sessionCache = new Map(); // targetUrl -> { slug, session, edge, at, cdnBase, targetDuration, discontinuitySeq, expiresAt }
const inFlightFetches = new Map(); // targetUrl -> Promise<sessionData>

/**
 * Parse upstream manifest body into anchor session parameters.
 */
function parseUpstreamManifest(body, targetUrl) {
  if (!body || !body.includes('#EXT')) {
    throw new Error('Upstream returned non-m3u8 body');
  }

  if (/_antipiracy|antipiracy|stream_notice/i.test(body)) {
    throw new Error('Upstream returned anti-piracy trap');
  }

  // Parse target duration (default 6)
  const durMatch = body.match(/#EXT-X-TARGETDURATION:(\d+)/);
  const targetDuration = durMatch ? parseInt(durMatch[1], 10) : 6;

  // Parse discontinuity sequence (default 0)
  const discMatch = body.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/);
  const discontinuitySeq = discMatch ? parseInt(discMatch[1], 10) : 0;

  // Find media segment URLs (e.g. https://w1.papacito.cfd/leaf/632410/1793459956/seg_2975.ts)
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
    expiresAt: Date.now() + SESSION_TTL_MS
  };
}

/**
 * Fetch upstream session anchors with single-flight request coalescing.
 */
async function getOrFetchSession(targetUrl) {
  const cached = sessionCache.get(targetUrl);
  if (cached && Date.now() < cached.expiresAt) {
    return cached;
  }

  let fetchPromise = inFlightFetches.get(targetUrl);
  if (!fetchPromise) {
    fetchPromise = (async () => {
      try {
        const res = await impitClient.safeFetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
            'Referer': 'https://sports.highfly.to/',
            'Origin': 'https://sports.highfly.to',
            'Accept': '*/*'
          },
          timeoutMs: 8000
        });

        if (!res || !res.ok) {
          throw new Error(`HTTP ${res ? res.status : 'No response'}`);
        }

        const body = await res.text();
        const sessionData = parseUpstreamManifest(body, targetUrl);

        // Keep cache bounded
        if (sessionCache.size >= 1000) {
          const oldestKey = sessionCache.keys().next().value;
          sessionCache.delete(oldestKey);
        }

        sessionCache.set(targetUrl, sessionData);
        return sessionData;
      } finally {
        inFlightFetches.delete(targetUrl);
      }
    })();

    inFlightFetches.set(targetUrl, fetchPromise);
  }

  return fetchPromise;
}

/**
 * Generate RFC 8216 HLS sliding-window playlist text.
 */
function generateSlidingPlaylist(sessionData) {
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - sessionData.at) / 1000);
  const dur = sessionData.targetDuration || 6;
  const seqOffset = Math.floor(elapsedSec / dur);

  // Live edge advances continuously with wall clock; mediaSeq slides naturally
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
  const targetUrl = req.query.url;
  const stateEncoded = req.query.d;

  try {
    let sessionData = null;

    if (stateEncoded) {
      try {
        const decodedStr = Buffer.from(stateEncoded, 'base64url').toString('utf8');
        sessionData = JSON.parse(decodedStr);
      } catch (err) {
        return res.status(400).send('Invalid state payload');
      }
    } else if (targetUrl) {
      sessionData = await getOrFetchSession(targetUrl);
    } else {
      return res.status(400).send('Missing url or d parameter');
    }

    if (!sessionData) {
      return res.status(502).send('Failed to obtain Leaf session');
    }

    const playlist = generateSlidingPlaylist(sessionData);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).send(playlist);
  } catch (err) {
    console.error(`[LeafManifest] Failed to generate sliding playlist: ${err.message}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).send(`Upstream Leaf Error: ${err.message}`);
  }
});

module.exports = router;
module.exports.parseUpstreamManifest = parseUpstreamManifest;
module.exports.generateSlidingPlaylist = generateSlidingPlaylist;
module.exports.sessionCache = sessionCache;
