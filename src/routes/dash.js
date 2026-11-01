/**
 * routes/dash.js — DASH→HLS endpoints.
 *
 *   GET /api/dash/index.m3u8?d=<signed>            → HLS master playlist
 *   GET /api/dash/video.m3u8?d=<signed>            → video media playlist
 *   GET /api/dash/audio.m3u8?d=<signed>            → audio media playlist
 *   GET /api/dash/init.mp4?d=<signed>&k=&r=        → uncloaked init segment
 *   GET /api/dash/segment.mp4?d=<signed>&k=&r=&n=  → decrypted media segment
 *   GET /api/dash/key.ts?k=<hex>                   → DEPRECATED, see below
 *
 * Security model (see docs/DASH_CLEARKEY_HLS_IMPLEMENTATION_PLAN.md):
 *
 *  - `d` is HMAC-signed and expires; without a valid signature the server will
 *    not fetch anything. The client never supplies a URL — the segment URL is
 *    synthesised from the MPD's own template via `service.resolveSegment()`.
 *  - every upstream fetch goes through `fetchGuarded`, which enforces a host
 *    allowlist derived from the parsed MPD, blocks private/reserved addresses,
 *    and discards the body if a redirect landed somewhere else.
 *
 * `key.ts` is kept only because playlists already cached by players still
 * reference it; the new playlists never emit `#EXT-X-KEY`.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const { getRequestBaseUrl } = require('../config');
const { safeFetch } = require('../impitClient');
const DashToHlsService = require('../services/DashToHlsService');
const engine = require('../services/DashCencEngine');
const { signPayload, verifyPayload } = require('../services/DashPayload');
const { fetchGuarded, toBuffer, UpstreamError } = require('../services/DashUpstream');

const HEX_KEY_RE = /^[0-9a-fA-F]{32}$/;

const TOKEN_TTL_SEC = Number(process.env.DASH_TOKEN_TTL) || 6 * 3600;
const SEGMENT_CACHE_MAX = Number(process.env.DASH_SEGMENT_CACHE_MAX) || 96;
const SEGMENT_CACHE_TTL_MS = Number(process.env.DASH_SEGMENT_CACHE_TTL_MS) || 60 * 1000;
const INIT_CACHE_MAX = Number(process.env.DASH_INIT_CACHE_MAX) || 200;
const MAX_CONCURRENT = Number(process.env.DASH_MAX_CONCURRENT) || 24;
const SEGMENT_MAX_BYTES = Number(process.env.DASH_SEGMENT_MAX_BYTES) || 64 * 1024 * 1024;
const INIT_MAX_BYTES = 4 * 1024 * 1024;

/* ───────────────────────────── small helpers ───────────────────────────── */

class LruCache {
  constructor({ max, ttlMs }) {
    this.max = Math.max(1, max);
    this.ttlMs = ttlMs;
    this._map = new Map();
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return null;
    if (this.ttlMs > 0 && Date.now() - entry.at > this.ttlMs) {
      this._map.delete(key);
      return null;
    }
    // refresh recency
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this._map.delete(key);
    this._map.set(key, { at: Date.now(), value });
    while (this._map.size > this.max) {
      this._map.delete(this._map.keys().next().value);
    }
  }

  get size() {
    return this._map.size;
  }
}

/** Bounds fetch+decrypt work so a hundred simultaneous joins cannot allocate a GB. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    const job = queue.shift();
    active += 1;
    job.fn()
      .then(job.resolve, job.reject)
      .finally(() => { active -= 1; pump(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

/** One upstream fetch per in-flight key; every waiter shares the same promise. */
function singleFlight(map, key, fn) {
  const existing = map.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => map.delete(key));
  map.set(key, promise);
  return promise;
}

function streamHash(mpdUrl) {
  return crypto.createHash('sha1').update(String(mpdUrl)).digest('hex').slice(0, 16);
}

function kindFromRequest(req) {
  const queryKind = typeof req.query.k === 'string' ? req.query.k.toLowerCase() : '';
  if (queryKind === 'video' || queryKind === 'audio') return queryKind;
  return req.path.includes('video') ? 'video' : req.path.includes('audio') ? 'audio' : 'master';
}

function setStreamHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

/* ─────────────────────────────── router ────────────────────────────────── */

function createDashRouter(service, options = {}) {
  const fetcher = options.fetcher || safeFetch;
  const initCache = new LruCache({ max: INIT_CACHE_MAX, ttlMs: 6 * 3600 * 1000 });
  const segmentCache = new LruCache({ max: SEGMENT_CACHE_MAX, ttlMs: SEGMENT_CACHE_TTL_MS });
  const tracksByRep = new Map(); // repCacheKey -> Map<trackId, TrackInfo>
  const inflight = new Map();
  const prefetching = new Set();
  // Off by default: at 8 Mbps the upstream pipe is the bottleneck, so fetching
  // ahead only competes with the segment the player is waiting for (measured
  // 5.7 s for a prefetched number vs 2.4 s cold). Enable with DASH_PREFETCH=1
  // on a host that has headroom.
  const prefetchEnabled = options.prefetch === true ||
    (options.prefetch !== false && /^(1|true|on)$/i.test(String(process.env.DASH_PREFETCH || '')));
  const limit = createLimiter(MAX_CONCURRENT);

  const sanitize = (headers) => (typeof service._sanitizeUpstreamHeaders === 'function'
    ? service._sanitizeUpstreamHeaders(headers || {})
    : (headers || {}));

  const repCacheKey = (payload, kind, rep) => `${streamHash(payload.mpdUrl)}|${kind}|${rep.id}`;

  /** Loads (once) the uncloaked init segment and remembers its track table. */
  function loadInit(payload, kind, rep, policy) {
    const cacheKey = rep.initUrl;
    const cached = initCache.get(cacheKey);
    if (cached) {
      tracksByRep.set(repCacheKey(payload, kind, rep), cached.tracks);
      return Promise.resolve(cached);
    }
    return singleFlight(inflight, `init:${cacheKey}`, () => limit(async () => {
      const res = await fetchGuarded(rep.initUrl, {
        policy,
        headers: sanitize(payload.headers),
        timeoutMs: 10000,
        attempts: 2,
        maxBodyBytes: INIT_MAX_BYTES,
        fetcher
      });
      if (!res || !res.ok) {
        throw new UpstreamError('UPSTREAM_STATUS', `init segment HTTP ${res && res.status}`);
      }
      const raw = await toBuffer(res);
      const uncloaked = engine.uncloakInit(raw, { expectedKid: payload.kid });
      const entry = { buf: uncloaked.buf, tracks: uncloaked.tracks };
      initCache.set(cacheKey, entry);
      return entry;
    })).then((entry) => {
      tracksByRep.set(repCacheKey(payload, kind, rep), entry.tracks);
      return entry;
    });
  }

  /**
   * The KID -> key table for one stream. When the provider declared a KID, only
   * that KID is accepted (a mismatch must fail loudly); when it did not, the
   * single key we hold is the fallback.
   */
  function keysFor(payload) {
    const key = Buffer.from(payload.key, 'hex');
    if (payload.kid) return { [payload.kid]: key };
    return { __fallback: key };
  }

  async function fetchDecryptedSegment(payload, kind, rep, policy, url) {
    const cachedTracks = tracksByRep.get(repCacheKey(payload, kind, rep));
    const tracks = cachedTracks || (await loadInit(payload, kind, rep, policy)).tracks;

    const res = await fetchGuarded(url, {
      policy,
      headers: sanitize(payload.headers),
      timeoutMs: 20000,
      attempts: 2,
      maxBodyBytes: SEGMENT_MAX_BYTES,
      fetcher
    });
    if (!res || !res.ok) {
      throw new UpstreamError('UPSTREAM_STATUS', `segment HTTP ${res && res.status}`);
    }
    const raw = await toBuffer(res);
    return engine.decryptSegment(raw, { tracks, keysByKid: keysFor(payload) }).buf;
  }

  /**
   * Warms the next segments while the player is still busy with this one.
   *
   * The proxy has to download and decrypt a whole 2 MB segment before it can
   * answer, so every request costs the full store-and-forward latency. Fetching
   * n+1 and n+2 in the background turns that into a pipeline: by the time the
   * player asks, the bytes are already in the cache. Best effort — a failed
   * prefetch must never affect playback.
   */
  function prefetchAhead(payload, kind, rep, policy, number, ahead = 2) {
    for (let k = 1; k <= ahead; k++) {
      const n = number + k;
      const key = `${streamHash(payload.mpdUrl)}|${kind}|${rep.id}|${n}`;
      if (segmentCache.get(key) || inflight.has(key) || prefetching.has(key)) continue;
      prefetching.add(key);
      if (prefetching.size > 1024) prefetching.clear();
      singleFlight(inflight, key, () => limit(async () => {
        const target = await service.resolveSegment(payload, kind, rep.id, n);
        const buf = await fetchDecryptedSegment(payload, kind, target.rep, target.policy, target.url);
        segmentCache.set(key, buf);
        return buf;
      })).catch(() => {}).finally(() => prefetching.delete(key));
    }
  }

  /* ── token verification, applied to every endpoint ─────────────────────── */

  const requireToken = (req, res, next) => {
    const raw = req.query.d;
    const result = verifyPayload(typeof raw === 'string' ? raw : '', { signWith: options.signWith });
    if (!result.ok) {
      if (result.code === 'MISSING') return res.status(400).send('Missing d parameter');
      return res.status(result.status).send(`Invalid d parameter (${result.code})`);
    }
    req.dashPayload = result.payload;
    next();
  };

  const router = express.Router();
  router.use(['/api/dash/index.m3u8', '/api/dash/video.m3u8', '/api/dash/audio.m3u8',
    '/api/dash/init.mp4', '/api/dash/segment.mp4'], requireToken);

  /* ── playlists ─────────────────────────────────────────────────────────── */

  const playlistHandler = async (req, res) => {
    const kind = kindFromRequest(req);
    try {
      // Re-sign with a TTL: catalogue tokens are long-lived by design, but a
      // URL that leaks from a player's log must stop working.
      const signed = signPayload(req.dashPayload, { signWith: options.signWith, ttlSec: TOKEN_TTL_SEC });
      const reqBase = getRequestBaseUrl(req);
      const body = kind === 'master'
        ? await service.buildMaster(req.dashPayload, signed, reqBase)
        : await service.buildMediaPlaylist(req.dashPayload, kind, signed, reqBase, req.query.r);

      setStreamHeaders(res);
      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(body);
    } catch (err) {
      console.warn(`[DashToHls] ${kind} playlist failed for ${req.dashPayload.mpdUrl}: ${err.message}`);
      if (!res.headersSent) return res.status(/^SSRF_/.test(String(err && err.code || '')) ? 403 : 502).send('DASH-to-HLS conversion failed');
      return res.end();
    }
  };

  router.get(['/api/dash/index.m3u8', '/api/dash/video.m3u8', '/api/dash/audio.m3u8'], playlistHandler);

  /* ── init segment ──────────────────────────────────────────────────────── */

  router.get('/api/dash/init.mp4', async (req, res) => {
    const kind = kindFromRequest(req) === 'audio' ? 'audio' : 'video';
    try {
      const { rep, policy } = await service.resolveRepresentation(req.dashPayload, kind, req.query.r);
      if (!rep.initUrl) return res.status(404).send('Representation has no initialization segment');
      const entry = await loadInit(req.dashPayload, kind, rep, policy);

      setStreamHeaders(res);
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(entry.buf.length));
      res.setHeader('Accept-Ranges', 'none');
      // The init is derived from an immutable upstream init: safe to pin.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(entry.buf);
    } catch (err) {
      return respondError(res, err, req, 'init');
    }
  });

  /* ── media segment ─────────────────────────────────────────────────────── */

  router.get('/api/dash/segment.mp4', async (req, res) => {
    const kind = kindFromRequest(req) === 'audio' ? 'audio' : 'video';
    const number = Number(req.query.n);
    if (!Number.isInteger(number)) return res.status(400).send('Invalid n parameter');

    try {
      const target = await service.resolveSegment(req.dashPayload, kind, req.query.r, number);
      const cacheKey = `${streamHash(req.dashPayload.mpdUrl)}|${kind}|${target.rep.id}|${number}`;

      let buf = segmentCache.get(cacheKey);
      if (!buf) {
        buf = await singleFlight(inflight, cacheKey, () => limit(() =>
          fetchDecryptedSegment(req.dashPayload, kind, target.rep, target.policy, target.url)));
        segmentCache.set(cacheKey, buf);
      }

      if (prefetchEnabled) prefetchAhead(req.dashPayload, kind, target.rep, target.policy, number, 2);

      setStreamHeaders(res);
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'public, max-age=4');
      return res.end(buf);
    } catch (err) {
      return respondError(res, err, req, `segment ${number}`);
    }
  });

  /**
   * 502 for anything that means "the bytes are not what we promised". Never
   * partially write a segment: half-decrypted bytes decode into a green smear
   * and get reported as a player bug.
   */
  function respondError(res, err, req, what) {
    const code = err && err.code ? err.code : 'INTERNAL';
    console.warn(
      `[DashToHls] ${what} failed (${code}) mpd=${req.dashPayload && req.dashPayload.mpdUrl} ` +
      `rep=${req.query.r || ''} n=${req.query.n || ''}: ${err && err.message}`
    );
    if (!res.headersSent) return res.status(502).send(`DASH segment failed (${code})`);
    return res.end();
  }

  /* ── deprecated key endpoint ───────────────────────────────────────────── */

  router.get('/api/dash/key.ts', (req, res) => {
    const k = typeof req.query.k === 'string' ? req.query.k : '';
    if (!HEX_KEY_RE.test(k)) return res.status(400).send('Invalid key');
    setStreamHeaders(res);
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(Buffer.from(k, 'hex'));
  });

  router.__caches = { initCache, segmentCache, tracksByRep, inflight };
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
