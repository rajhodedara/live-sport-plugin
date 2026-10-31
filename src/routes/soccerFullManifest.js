'use strict';

/**
 * routes/soccerFullManifest.js - SoccerFull-only HLS playlist endpoint
 *
 * `GET /api/soccerfull/manifest?url=<absolute playlist url>`
 *
 * Why this exists instead of reusing `/api/manifest`:
 *
 *  - `https://soccerfull.net/hls/<sid>.m3u8` is served **without**
 *    `Access-Control-Allow-Origin`, so a browser player cannot read it. This
 *    route fetches the playlist server-side and answers with `ACAO: *`.
 *  - Its segments hide MPEG-TS behind a 120-byte fake PNG header, while the
 *    shared rewriter hardcodes the 42-byte WebP/RIFF prefix that PPV.st needs.
 *    Rewriting happens in SoccerFullHlsRewrite, which measures the offset.
 *
 * Bandwidth model: only the playlist text passes through this addon. Every media
 * segment is left as a direct CDN URI (`#EXT-X-BYTERANGE` does the de-cloaking),
 * so this stays within the "no heavy server bandwidth" rule and no stream is
 * converted into a browser/web stream.
 */

const express = require('express');
const router = express.Router();
const { safeFetch } = require('../services/ProviderOutbound');
const { getRequestBaseUrl } = require('../config');
const { rewriteSoccerFullPlaylist, prewarmPlaylist } = require('../services/SoccerFullHlsRewrite');

const ALLOWED_HOSTS = new Set(['soccerfull.net', 'www.soccerfull.net']);
const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
  'Referer': 'https://soccerfull.net/'
};
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;
const REWRITE_TTL_MS = 60 * 1000;

// Rewritten playlists are keyed by upstream URL + base URL (child playlists embed
// the base). VOD playlists are immutable for the life of their signed CDN URLs,
// so a minute of caching removes the repeat fetch during player retries.
const rewriteCache = new Map();

function cachedRewrite(key) {
  const hit = rewriteCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    rewriteCache.delete(key);
    return null;
  }
  return hit.body;
}

function storeRewrite(key, body) {
  if (rewriteCache.size >= 500) rewriteCache.clear();
  rewriteCache.set(key, { body, expiresAt: Date.now() + REWRITE_TTL_MS });
}

/** Only SoccerFull playlists; never a generic SSRF surface. */
function isAllowedTarget(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
}

function buildProxyUrl(baseUrl, upstreamUrl) {
  const path = `/api/soccerfull/manifest?url=${encodeURIComponent(upstreamUrl)}`;
  return baseUrl ? new URL(path, baseUrl).toString() : path;
}

router.get('/api/soccerfull/manifest', async (req, res) => {
  const targetUrl = String(req.query.url || '');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!targetUrl) return res.status(400).send('Missing url');
  if (!isAllowedTarget(targetUrl)) return res.status(403).send('Blocked target');

  const baseUrl = getRequestBaseUrl(req);
  const cacheKey = JSON.stringify([targetUrl, baseUrl]);
  const cached = cachedRewrite(cacheKey);
  if (cached) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('X-SoccerFull-Cache', 'HIT');
    return res.send(cached);
  }

  try {
    const upstream = await safeFetch(targetUrl, {
      method: 'GET',
      headers: UPSTREAM_HEADERS,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      attempts: 1,
      maxBodyBytes: MAX_PLAYLIST_BYTES
    });

    if (!upstream || upstream.status !== 200) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).send(`Upstream ${upstream ? upstream.status : 'unreachable'}`);
    }

    if (upstream.bodyTruncated) throw new Error('Upstream playlist exceeds its body limit');

    const body = await upstream.text();
    const isMaster = body.includes('#EXT-X-STREAM-INF');

    // Master playlists only need their child playlists routed back here.
    if (!isMaster) await prewarmPlaylist(body, targetUrl);

    const rewritten = rewriteSoccerFullPlaylist(body, targetUrl, {
      toProxyUrl: absoluteUrl => buildProxyUrl(baseUrl, absoluteUrl)
    });

    storeRewrite(cacheKey, rewritten);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', `public, max-age=${Math.floor(REWRITE_TTL_MS / 1000)}`);
    res.setHeader('X-SoccerFull-Cache', 'MISS');
    return res.send(rewritten);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    if (err && err.code === 'ERR_OUTBOUND_CAPACITY') {
      return res.status(503).send('Outbound capacity temporarily exhausted');
    }
    if (err && err.code === 'ERR_OUTBOUND_BLOCKED') {
      return res.status(403).send('Blocked outbound URL');
    }
    console.error('[soccerFullManifest] rewrite failed:', err && err.message ? err.message : err);
    return res.status(502).send('Upstream playlist unavailable');
  }
});

module.exports = router;
