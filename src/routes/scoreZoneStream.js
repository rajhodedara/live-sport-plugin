'use strict';

const express = require('express');
const crypto = require('crypto');
const { safeFetch } = require('../services/ProviderOutbound');
const { rewriteHlsPlaylist } = require('../services/HlsRewriteService');

const router = express.Router();

const SCOREZONE_API_BASE = 'https://testscore.pxxl.pro';
const SCOREZONE_HEADERS = {
  'Origin': 'https://scorezonetv.live',
  'Referer': 'https://scorezonetv.live/'
};

// Unified in-memory caches with FIFO bounding (Decision D4)
const MAX_TOKEN_CACHE_ENTRIES = 1000;
const MAX_PLAYLIST_CACHE_ENTRIES = 1000;
const MAX_RATE_LIMIT_ENTRIES = 5000;

const tokenCache = new Map(); // `${eventId}:${channelId}` -> { matchKey, playbackUrl, meta, createdAt }
const playlistCache = new Map(); // `${eventId}:${channelId}:${variant}` -> { body, expiresAt }
const playlistInFlight = new Map(); // cacheKey -> Promise<string>
const ipRateLimits = new Map(); // ip -> { count, resetAt }

const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function setTokenCache(tokenKey, val) {
  if (tokenCache.size >= MAX_TOKEN_CACHE_ENTRIES && !tokenCache.has(tokenKey)) {
    tokenCache.delete(tokenCache.keys().next().value);
  }
  tokenCache.set(tokenKey, val);
}

function setPlaylistCache(playlistCacheKey, val) {
  if (playlistCache.size >= MAX_PLAYLIST_CACHE_ENTRIES && !playlistCache.has(playlistCacheKey)) {
    playlistCache.delete(playlistCache.keys().next().value);
  }
  playlistCache.set(playlistCacheKey, val);
}

function checkRateLimit(ip) {
  const maxReq = Number(process.env.SCOREZONE_RATE_LIMIT || 240);
  const now = Date.now();
  let record = ipRateLimits.get(ip);
  if (!record || now >= record.resetAt) {
    if (ipRateLimits.size >= MAX_RATE_LIMIT_ENTRIES && !ipRateLimits.has(ip)) {
      ipRateLimits.delete(ipRateLimits.keys().next().value);
    }
    record = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    ipRateLimits.set(ip, record);
    return true;
  }
  record.count++;
  if (record.count > maxReq) {
    return false;
  }
  return true;
}

function extractMasterPlaylistVariants(masterBody, masterUrl) {
  const lines = String(masterBody).split('\n');
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (!nextLine) continue;
        if (!nextLine.startsWith('#')) {
          try {
            const absUrl = new URL(nextLine, masterUrl).toString();
            variants.push(absUrl);
          } catch (_) {}
          i = j;
          break;
        }
      }
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) {
        try {
          const absUrl = new URL(uriMatch[1], masterUrl).toString();
          variants.push(absUrl);
        } catch (_) {}
      }
    }
  }
  return variants;
}

async function getOrRemintPlaybackUrl(meta, channelId, forceFresh = false) {
  const tokenKey = `${meta.e}:${channelId}`;
  const now = Date.now();

  if (!forceFresh) {
    const entry = tokenCache.get(tokenKey);
    if (entry && entry.playbackUrl && (now - entry.createdAt < 12 * 60 * 1000)) {
      return entry.playbackUrl;
    }
  }

  let entry = tokenCache.get(tokenKey);
  let matchKey = entry ? entry.matchKey : null;

  if (forceFresh || !matchKey) {
    const qs = new URLSearchParams({
      home: meta.h || '',
      away: meta.a || '',
      sport: meta.s || 'football',
      eventId: String(meta.e || ''),
      ...(meta.t ? { start: String(meta.t) } : {}),
      ...(meta.c ? { competition: meta.c } : {})
    }).toString();

    const channelsRes = await safeFetch(`${SCOREZONE_API_BASE}/api/matches/channels?${qs}`, {
      headers: SCOREZONE_HEADERS,
      timeoutMs: 8000
    });

    if (!channelsRes || !channelsRes.ok) {
      return null;
    }

    const channelsData = typeof channelsRes.json === 'function'
      ? await channelsRes.json()
      : JSON.parse(await channelsRes.text());

    if (!channelsData || !channelsData.key) {
      return null;
    }

    matchKey = channelsData.key;
  }

  const playbackRes = await safeFetch(`${SCOREZONE_API_BASE}/api/matches/playback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...SCOREZONE_HEADERS
    },
    body: JSON.stringify({ matchKey, channelId }),
    timeoutMs: 8000
  });

  if (!playbackRes || !playbackRes.ok) {
    return null;
  }

  const playbackData = typeof playbackRes.json === 'function'
    ? await playbackRes.json()
    : JSON.parse(await playbackRes.text());

  if (!playbackData || !playbackData.url) {
    return null;
  }

  setTokenCache(tokenKey, {
    matchKey,
    playbackUrl: playbackData.url,
    meta,
    createdAt: Date.now()
  });

  return playbackData.url;
}

router.options('/api/scorezone/manifest/:sourceId/:channelId.m3u8', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Max-Age', '86400');
  return res.sendStatus(204);
});

router.get('/api/scorezone/manifest/:sourceId/:channelId.m3u8', async (req, res) => {
  const { sourceId, channelId } = req.params;
  const variantQuery = req.query.v;

  const secret = process.env.APP_SECRET || process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'scorezone-dev-default-secret');
  if (!secret) {
    return res.status(500).send('Server configuration error: missing secret');
  }

  if (variantQuery !== undefined) {
    if (!/^\d{1,2}$/.test(variantQuery)) {
      return res.status(400).send('Invalid variant parameter');
    }
  }

  if (!sourceId || typeof sourceId !== 'string') {
    return res.status(400).send('Invalid source identifier');
  }

  const lastDot = sourceId.lastIndexOf('.');
  if (lastDot === -1) {
    return res.status(403).send('Invalid signature format');
  }

  const b64 = sourceId.slice(0, lastDot);
  const sig = sourceId.slice(lastDot + 1);

  const expected = crypto.createHmac('sha256', secret).update(b64).digest('hex').slice(0, 16);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(403).send('Forbidden: invalid signature');
  }

  let meta;
  try {
    meta = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (_) {
    return res.status(400).send('Invalid source payload');
  }

  const variantSuffix = variantQuery !== undefined ? `:${variantQuery}` : '';
  const playlistCacheKey = `${meta.e}:${channelId}${variantSuffix}`;
  const now = Date.now();

  const cached = playlistCache.get(playlistCacheKey);
  if (cached && now < cached.expiresAt) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    return res.send(cached.body);
  }

  const clientIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1').split(',')[0].trim();
  if (!checkRateLimit(clientIp)) {
    return res.status(429).send('Too Many Requests');
  }

  if (playlistInFlight.has(playlistCacheKey)) {
    try {
      const body = await playlistInFlight.get(playlistCacheKey);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
      return res.send(body);
    } catch (err) {
      return res.status(502).send(err.message || 'Upstream error');
    }
  }

  const fetchPromise = (async () => {
    let playbackUrl = await getOrRemintPlaybackUrl(meta, channelId, false);
    if (!playbackUrl) {
      throw new Error('Failed to resolve playback URL');
    }

    let manifestRes = await safeFetch(playbackUrl, {
      headers: SCOREZONE_HEADERS,
      timeoutMs: 8000,
      maxBodyBytes: 2 * 1024 * 1024
    });

    if (manifestRes && (manifestRes.status === 401 || manifestRes.status === 403)) {
      playbackUrl = await getOrRemintPlaybackUrl(meta, channelId, true);
      if (!playbackUrl) {
        throw new Error('Failed to remint playback URL on 401/403');
      }
      manifestRes = await safeFetch(playbackUrl, {
        headers: SCOREZONE_HEADERS,
        timeoutMs: 8000,
        maxBodyBytes: 2 * 1024 * 1024
      });
    }

    if (!manifestRes || !manifestRes.ok) {
      throw new Error(`Upstream manifest failed with status ${manifestRes ? manifestRes.status : 'timeout'}`);
    }

    const body = typeof manifestRes.text === 'function' ? await manifestRes.text() : String(manifestRes.body || '');
    const isMaster = body.includes('#EXT-X-STREAM-INF');

    let rewritten;
    let ttlMs = 4000;

    const baseManifestUrl = `/api/scorezone/manifest/${encodeURIComponent(sourceId)}/${encodeURIComponent(channelId)}.m3u8`;

    if (isMaster) {
      if (variantQuery !== undefined) {
        const v = parseInt(variantQuery, 10);
        const variants = extractMasterPlaylistVariants(body, playbackUrl);
        if (v < 0 || v >= variants.length) {
          const err = new Error('Variant not found');
          err.statusCode = 404;
          throw err;
        }

        const targetVariantUrl = variants[v];
        if (new URL(targetVariantUrl).origin !== new URL(playbackUrl).origin) {
          const err = new Error('Cross-origin variant rejected');
          err.statusCode = 403;
          throw err;
        }

        const variantRes = await safeFetch(targetVariantUrl, {
          headers: SCOREZONE_HEADERS,
          timeoutMs: 8000,
          maxBodyBytes: 2 * 1024 * 1024
        });

        if (!variantRes || !variantRes.ok) {
          throw new Error('Failed to fetch variant media playlist');
        }

        const variantBody = typeof variantRes.text === 'function' ? await variantRes.text() : String(variantRes.body || '');
        rewritten = rewriteHlsPlaylist(variantBody, targetVariantUrl);

        const durMatch = variantBody.match(/#EXT-X-TARGETDURATION:(\d+)/);
        const targetDur = durMatch ? parseInt(durMatch[1], 10) : 4;
        ttlMs = Math.max(1000, Math.min(4000, Math.floor((targetDur / 2) * 1000)));
      } else {
        let variantIndex = 0;
        rewritten = rewriteHlsPlaylist(body, playbackUrl, {
          toPlaylistUrl: () => {
            const idx = variantIndex++;
            return `${baseManifestUrl}?v=${idx}`;
          }
        });
        ttlMs = 4000;
      }
    } else {
      if (variantQuery !== undefined) {
        const err = new Error('Variant not found on media playlist');
        err.statusCode = 404;
        throw err;
      }

      rewritten = rewriteHlsPlaylist(body, playbackUrl);
      const durMatch = body.match(/#EXT-X-TARGETDURATION:(\d+)/);
      const targetDur = durMatch ? parseInt(durMatch[1], 10) : 4;
      ttlMs = Math.max(1000, Math.min(4000, Math.floor((targetDur / 2) * 1000)));
    }

    setPlaylistCache(playlistCacheKey, {
      body: rewritten,
      expiresAt: Date.now() + ttlMs
    });

    return rewritten;
  })();

  playlistInFlight.set(playlistCacheKey, fetchPromise);
  try {
    const rewritten = await fetchPromise;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    return res.send(rewritten);
  } catch (err) {
    const status = err.statusCode || 502;
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    return res.status(status).send(err.message);
  } finally {
    playlistInFlight.delete(playlistCacheKey);
  }
});

module.exports = router;
module.exports.tokenCache = tokenCache;
module.exports.playlistCache = playlistCache;
module.exports.extractMasterPlaylistVariants = extractMasterPlaylistVariants;
