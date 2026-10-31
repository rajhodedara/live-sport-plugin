/**
 * routes/dash.js — Zero-bandwidth DASH→HLS conversion endpoints
 *
 *   GET /api/dash/index.m3u8?d=<base64url payload>   → HLS master playlist
 *   GET /api/dash/video.m3u8?d=...                   → video media playlist
 *   GET /api/dash/audio.m3u8?d=...                   → audio media playlist
 *   GET /api/dash/key.ts?k=<32-char hex>             → 16 raw AES key bytes
 *
 * The `d` payload is { mpdUrl, key, kid, headers } emitted by the AK47 /
 * SK Tech providers. Media segments always point directly at the upstream
 * CDN — this router only ever serves playlist text and the binary key.
 */

'use strict';

const express = require('express');
const { getRequestBaseUrl } = require('../config');
const DashToHlsService = require('../services/DashToHlsService');

const HEX_KEY_RE = /^[0-9a-fA-F]{32}$/;

function decodeDashPayload(req, res) {
  const raw = req.query.d;
  if (!raw || typeof raw !== 'string') {
    res.status(400).send('Missing d parameter');
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (_) {
    res.status(400).send('Invalid d parameter');
    return null;
  }
  if (!payload || typeof payload.mpdUrl !== 'string' || !/^https?:\/\//i.test(payload.mpdUrl)) {
    res.status(400).send('Invalid mpdUrl');
    return null;
  }
  if (typeof payload.key !== 'string' || !HEX_KEY_RE.test(payload.key)) {
    res.status(400).send('Invalid key');
    return null;
  }
  return { payload, raw };
}

function createDashRouter(service) {
  const router = express.Router();

  const playlistHandler = async (req, res) => {
    const decoded = decodeDashPayload(req, res);
    if (!decoded) return;
    const kind = req.path.includes('video') ? 'video' : (req.path.includes('audio') ? 'audio' : 'master');
    try {
      const body = kind === 'master'
        ? await service.buildMaster(decoded.payload, decoded.raw, getRequestBaseUrl(req))
        : await service.buildMediaPlaylist(decoded.payload, kind, decoded.raw, getRequestBaseUrl(req));
      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      return res.send(body);
    } catch (err) {
      console.warn(`[DashToHls] ${kind} playlist failed for ${decoded.payload.mpdUrl}: ${err.message}`);
      if (!res.headersSent) return res.status(502).send('DASH-to-HLS conversion failed');
      return res.end();
    }
  };

  router.get(['/api/dash/index.m3u8', '/api/dash/video.m3u8', '/api/dash/audio.m3u8'], playlistHandler);

  router.get('/api/dash/key.ts', (req, res) => {
    const k = typeof req.query.k === 'string' ? req.query.k : '';
    if (!HEX_KEY_RE.test(k)) return res.status(400).send('Invalid key');
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    return res.send(Buffer.from(k, 'hex'));
  });

  return router;
}

const router = createDashRouter(new DashToHlsService());

// SoccerFull's `/hls/<sid>.m3u8` playlists are the same shape of endpoint as the
// DASH ones above: this only ever serves playlist text, and every media segment
// stays a direct CDN URI. Mounted here so the two zero-bandwidth playlist
// endpoints live together; see routes/soccerFullManifest.js.
router.use(require('./soccerFullManifest'));
router.createDashRouter = createDashRouter;

module.exports = router;
