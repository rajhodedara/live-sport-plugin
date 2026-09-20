/**
 * index.js — Nuvio Live Sports Plugin Entry Point
 *
 * Builds a single Express server that serves:
 *   - /manifest.json          → addon manifest (via SDK getRouter)
 *   - /catalog/tv/*.json      → match lists
 *   - /meta/tv/*.json         → match detail
 *   - /stream/tv/*.json       → stream URLs
 *   - /watch                  → HTML proxy page for embed streams
 *
 * CORS headers are explicitly set so Nuvio can reach the manifest
 * from any origin without a networkError_manifestLoadError.
 */

const express = require('express');
const cors    = require('cors');
const { getRouter } = require('stremio-addon-sdk');
const { createProxyMiddleware } = require('http-proxy-middleware');
const child_process = require('child_process');
const path = require('path');

const { builder } = require('./manifest');
const { handleCatalog, handleMeta, isReplayMatch } = require('./catalog');
const { handleStream } = require('./streams');
const { PORT, BASE_URL, getRequestBaseUrl, getLocalIp } = require('./config');
const container = require('./container');
const https = require('https');
const http = require('http');

const hlsChunkHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 15000
});
const hlsChunkHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 15000
});



// Removed global User-Agent fix because it causes ECONNRESET on Streamed.pk

// ─── Spawn the Streamed.pk Resolver ───────────────────────────────────────────

// In PM2 cluster mode, each worker gets its own isolated resolver port (7003, 7004, 7005, 7006...)
const workerOffset = parseInt(process.env.NODE_APP_INSTANCE || process.env.pm_id || "0", 10);
const RESOLVER_PORT = process.env.RESOLVER_PORT || String(7003 + workerOffset);
let resolverProcess = null;
let isShuttingDown = false;
let resolverRestarts = 0;
let resolverStableTimer = null;

// Locate resolver/src/server.js.
//
// The script NAME is kept as separate character codes concatenated at runtime
// (never a literal "server.js") because the bundler's asset relocator rewrites
// path-like string literals. A plain literal caused it to point at `dist/src` —
// a DIRECTORY that exists, so the existence check passed and the child was
// spawned against a folder, failing with "Cannot find module ...\dist\src".
//
// Candidate NAMES (not absolute paths) are resolved against each base directory
// at runtime, so there is nothing for the bundler to rewrite. In a bundle the
// resolver sources are emitted next to the bundle itself (see the build script),
// which is why __dirname is a first-class candidate.
const RESOLVER_BASENAME = String.fromCharCode(115, 101, 114, 118, 101, 114) + '.' +
                          String.fromCharCode(106, 115); // 'server.js'

function resolverCandidatePaths() {
  const name = RESOLVER_BASENAME;
  const bases = [
    path.join(process.cwd(), 'resolver', 'src'),   // repo root layout (npm start from root)
    path.join(__dirname, 'resolver', 'src'),       // resolver shipped beside the entrypoint
    path.join(__dirname, 'src'),                   // bundled layout: dist/src
    path.join(__dirname, '..', 'resolver', 'src'), // one level up (dist/ -> repo root)
  ];
  return bases.map((b) => path.join(b, name));
}

function resolveResolverScript() {
  const fs = require('fs');
  for (const candidate of resolverCandidatePaths()) {
    try {
      // Must be a FILE — a directory of the same name must never match.
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return null;
}

function spawnResolver() {
  if (isShuttingDown) return;
  const spawnEnv = { ...process.env, PORT: RESOLVER_PORT, HOST: '127.0.0.1' };

  const scriptPath = resolveResolverScript();

  if (!scriptPath) {
    console.error(
      `[FATAL] Could not locate the resolver entrypoint (${RESOLVER_BASENAME}). Stream resolution will be unavailable. ` +
      `Searched:\n  ` + resolverCandidatePaths().join('\n  ') + '\n' +
      `Ensure the 'resolver/' directory exists at the app root, or that the build copied the resolver sources into dist/.`
    );
    return; // Do NOT respawn: a missing script can never fix itself, and a tight loop only hides the cause.
  }

  resolverProcess = child_process['sp' + 'awn']('node', [scriptPath], {
    stdio: 'inherit',
    env: spawnEnv
  });

  resolverProcess.on('error', (err) => console.error('[FATAL] Resolver spawn error:', err));

  // Treat a run that survives this long as healthy and reset the backoff, so a
  // single crash-loop cannot permanently degrade the restart delay.
  if (resolverStableTimer) clearTimeout(resolverStableTimer);
  resolverStableTimer = setTimeout(() => { resolverRestarts = 0; }, 60000);
  if (resolverStableTimer.unref) resolverStableTimer.unref();

  resolverProcess.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    resolverRestarts++;
    // Exponential backoff, capped: 2s, 4s, 8s, 16s, 30s, 30s...
    const delay = Math.min(2000 * Math.pow(2, resolverRestarts - 1), 30000);
    console.error(
      `[FATAL] Resolver process exited (code ${code}, signal ${signal}). ` +
      `Restart #${resolverRestarts} in ${Math.round(delay / 1000)}s...`
    );
    setTimeout(spawnResolver, delay).unref?.();
  });
}

spawnResolver();

// Idempotent: 'exit', SIGINT and SIGTERM can all fire; the resolver must be
// killed exactly once and the flag must not be reset mid-shutdown.
let shutdownDone = false;
function shutdownResolver() {
  isShuttingDown = true;
  if (shutdownDone) return;
  shutdownDone = true;
  if (resolverStableTimer) clearTimeout(resolverStableTimer);
  if (resolverProcess && !resolverProcess.killed) {
    console.log('Shutting down Stream Resolver...');
    try { resolverProcess.kill(); } catch (_) {}
  }
  // Shut down the headless browser sniffer if it was ever launched
  try { container.resolve('browserSniffer').shutdown(); } catch (_) {}
}
process.on('exit', shutdownResolver);
process.on('SIGINT', () => { shutdownResolver(); process.exit(0); });
process.on('SIGTERM', () => { shutdownResolver(); process.exit(0); });

// A single unhandled error must not take down a long-running stream server.
// Log loudly and keep serving; fatal state is handled by the supervisor.
process.on('unhandledRejection', (reason) => {
  // Client disconnects abort in-flight fetches; those rejections are expected and
  // would otherwise spam the log with AbortError stack traces.
  if (reason && (reason.name === 'AbortError' || reason.__expected)) return;
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

// ─── Register Addon Handlers ──────────────────────────────────────────────────

builder.defineCatalogHandler(({ type, id, extra, config }) => handleCatalog(type, id, extra, config));
builder.defineMetaHandler(({ type, id, config })           => handleMeta(type, id, config));
builder.defineStreamHandler(({ type, id, config })         => handleStream(type, id, config));

// ─── Build Express App ────────────────────────────────────────────────────────

const app = express();

app.set('trust proxy', true);
app.use(cors());

// Serve the web debugger UI, posters, and Configuration Page
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/posters', express.static(path.join(__dirname, '..', 'public', 'posters')));
app.use('/posters', express.static(path.join(__dirname, 'public', 'posters')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get(['/configure', '/:config/configure'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'configure.html'));
});

// ─── Nuvio Native Collections ─────────────────────────────────────────
// Serves Nuvio Collections JSON schema for Sports Replays & Live Sports.
// Compatible with Nuvio's Collection import from URL or file.
const { generateCollections } = require('./collections');

app.get(['/collections.json', '/nuvio-collections.json', '/:config/collections.json', '/:config/nuvio-collections.json'], (req, res) => {
  const reqBaseUrl = getRequestBaseUrl(req);
  const config = req.params.config || '';
  const collections = generateCollections(reqBaseUrl, config);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(collections);
});

app.get(['/api/collections/download', '/:config/api/collections/download'], (req, res) => {
  const reqBaseUrl = getRequestBaseUrl(req);
  const config = req.params.config || '';
  const collections = generateCollections(reqBaseUrl, config);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="nuvio-sports-collections.json"');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(JSON.stringify(collections, null, 2));
});

app.get('/api/server-info', (req, res) => {
  const reqBaseUrl = getRequestBaseUrl(req);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    baseUrl: reqBaseUrl,
    localIp: getLocalIp ? getLocalIp() : '127.0.0.1',
    port: PORT
  });
});

app.get('/api/matches', (req, res) => {
  const matches = container.resolve('cacheService').getMatches();
  res.json(matches);
});

// ─── Self-hosted image pipeline ───────────────────────────────────────
// /img?url=...          → cached upstream image, or a generated category-colored
//                         placeholder on any failure (dead URL, non-image body,
//                         timeout) so the client never sees a broken image.
// /img/placeholder?...  → generated poster card. Replaces the external
//                         placehold.co dependency.
const imageService = require('./services/ImageService');

app.get(['/img/collection/:sport', '/:config/img/collection/:sport'], (req, res) => {
  const sport = (req.params.sport || 'football').toLowerCase();
  const svg = imageService.generateSportSvg(sport, 'landscape', {
    badge: 'REPLAYS'
  });
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.send(svg);
});

app.get('/img/placeholder', (req, res) => {
  const svg = imageService.svgPlaceholder(req.query.text || 'Live Sports', req.query.color || '333333');
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.send(svg);
});

app.get('/img', async (req, res) => {
  const text = req.query.text || 'Live Sports';
  const color = req.query.color || '333333';
  const embed = req.query.embed === '1' || req.query.embed === 'true';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  const entry = await imageService.getImage(req.query.url);
  if (entry) {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    if (embed && !entry.contentType.includes('svg')) {
      const bg = /^([0-9a-fA-F]{6})$/.test(String(color)) ? `#${color}` : '#333333';
      const b64 = entry.buffer.toString('base64');
      const cleanTitle = String(text || '').replace(/\b(24\/7|live|stream|raw|hd)\b/gi, '').trim();
      const showTitle = cleanTitle.length > 0 && cleanTitle.length <= 36;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="450" viewBox="0 0 800 450">
  <defs>
    <linearGradient id="cardBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#191c24"/>
      <stop offset="50%" stop-color="#111319"/>
      <stop offset="100%" stop-color="#090a0d"/>
    </linearGradient>
    <radialGradient id="spotlight" cx="50%" cy="50%" r="55%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="60%" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.45"/>
    </radialGradient>
    <filter id="logoShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000000" flood-opacity="0.75"/>
    </filter>
  </defs>
  <rect width="800" height="450" fill="url(#cardBg)"/>
  <rect width="800" height="450" fill="url(#spotlight)"/>
  <rect x="0" y="0" width="800" height="4" fill="${bg}"/>
  <rect x="0" y="446" width="800" height="4" fill="${bg}"/>
  ${showTitle ? `<text x="50%" y="38" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="700" letter-spacing="2" fill="rgba(255,255,255,0.72)" text-anchor="middle">${cleanTitle.toUpperCase().replace(/[&<>'"]/g, '')}</text>` : ''}
  <image href="data:${entry.contentType};base64,${b64}" xlink:href="data:${entry.contentType};base64,${b64}" x="120" y="55" width="560" height="320" preserveAspectRatio="xMidYMid meet" filter="url(#logoShadow)"/>
</svg>`;
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.send(svg);
    }
    res.setHeader('Content-Type', entry.contentType);
    return res.send(entry.buffer);
  }
  const svg = imageService.svgPlaceholder(text, color);
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(svg);
});

// ─── Shared safe HTTP client (impit + undici fallback) ───────────────────────
// Works on Windows, Linux x64/ARM64, Alpine/musl. If impit native binary is
// absent, all fetches silently use undici — streams continue to work.
const { safeFetch: _safeFetch } = require('./impitClient');

// ─── Manifest proxy: short-TTL cache + request coalescing ───────────────────
// Live HLS players reload /api/manifest every 2-6 s per viewer. A validated
// short-TTL cache removes per-viewer TLS handshakes and repeated upstream
// fetches. Key = url|referer|origin. Only bodies containing #EXT are cached.
const MANIFEST_TTL_MS = 3000;
const MANIFEST_CACHE_MAX = 100;
const MANIFEST_NEGATIVE_TTL_MS = 15 * 1000;
const manifestCache = new Map();      // key -> { body, expiresAt, lastAccess }
const manifestInFlight = new Map();   // key -> Promise (coalesced upstream fetch)

// Returns the stored cache ENTRY (positive or negative), or null when

// missing/expired (expired entries are deleted as before).
function manifestCacheGet(key) {
  const e = manifestCache.get(key);
  if (!e) return null;
  const now = Date.now();
  if (now > e.expiresAt) {
    manifestCache.delete(key);
    return null;
  }
  e.lastAccess = now;
  return e;
}

function manifestCacheSet(key, body, ttlMs = MANIFEST_TTL_MS) {
  const now = Date.now();
  manifestCache.set(key, { body, expiresAt: now + ttlMs, lastAccess: now });
  evictManifestCacheIfNeeded();
}

function evictManifestCacheIfNeeded() {
  if (manifestCache.size > MANIFEST_CACHE_MAX) {
    const byAccess = [...manifestCache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const excess = manifestCache.size - MANIFEST_CACHE_MAX;
    for (let i = 0; i < excess; i++) manifestCache.delete(byAccess[i][0]);
  }
}

// Negative caching: dead upstreams (non-m3u8 body / fetch failure) are stored
// briefly so player polls stop re-fetching them until the entry expires.
function manifestCacheSetNegative(key, status, body) {
  const now = Date.now();
  manifestCache.set(key, { negative: true, status, body, expiresAt: now + MANIFEST_NEGATIVE_TTL_MS, lastAccess: now });
  evictManifestCacheIfNeeded();
}

// When upstream reports a proxied stream dead, the most likely cause is the
// time-limited upstream token embedded in that proxy URL having expired.
// Downgrade the originating resolve-cache entry so the next click re-mints a
// fresh token instead of replaying the same dead URL for the rest of its TTL.
// Takes the incoming request URL (which carries the `rck` param added by
// streams.js), not the cache key. Fully defensive: a missing param, unknown
// key or failed lookup must never affect the response the player receives.
function notifyResolveCacheOfDeadStream(requestUrl) {
  try {
    const rck = new URL('http://localhost' + requestUrl).searchParams.get('rck');
    if (!rck) return;
    container.resolve('streamResolveCache').noteFailure(rck);
  } catch (_) {
    // Recovery hint only — never surface this to the request path.
  }
}

// A playlist that references no URI at all (no segments, no variant streams) is
// unusable. Live providers do serve such headers while a source has no segments
// yet; a player handed one simply stalls. Treat it as dead so the client can
// fail over instead of hanging.
function playlistHasContent(text) {
  return String(text).split('\n').some((line) => {
    const t = line.trim();
    return t.length > 0 && !t.startsWith('#');
  });
}

// Fetch + validate the upstream manifest. Throws on failure so coalesced
// waiters share the same outcome; successful bodies are cached by the caller.
async function fetchUpstreamManifest(targetUrl, referer, origin) {
  const headers = {
    'Referer': referer,
    'Origin': origin,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
  };
  // _safeFetch: impit (browser TLS fingerprint) with automatic undici fallback.
  // A hard 10 s timeout ensures a hung upstream can never hold the viewer's poll.
  const attempt = async () => {
    const result = await _safeFetch(targetUrl, { headers, timeoutMs: 10000 });
    if (!result.ok) {
      // Carry the upstream status so the caller can tell "the token/CDN said no"
      // apart from "our proxy is broken" — they need different HTTP responses.
      const err = new Error(`HTTP ${result.status}`);
      err.statusCode = result.status;
      throw err;
    }
    return await result.text();
  };

  try {
    return await attempt();
  } catch (err) {
    // Transient upstream trouble: these load balancers (lb*.wfty.st, strmd.st) are
    // observed to throw 500/502/503/504 intermittently or reset connections (ECONNRESET)
    // during high load. A single retry after a short pause recovers the large majority.
    const status = err && err.statusCode;
    const isNetworkTransient = err && (
      err.code === 'ECONNRESET' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'UND_ERR_SOCKET' ||
      (err.message && /reset|timeout|socket/i.test(err.message))
    );
    const isTransient = status === 500 || status === 502 || status === 503 || status === 504 || isNetworkTransient;
    if (!isTransient) throw err;
    await new Promise((r) => setTimeout(r, 400));
    console.warn(`[ManifestProxy] Upstream ${status || err.code || 'network glitch'} — retrying once: ${String(targetUrl).slice(0, 90)}`);
    return await attempt(); // a second failure propagates with statusCode intact
  }
}

// Range-aware MP4 proxy for ok.ru direct video files
// ─── /api/fastmp4 — parallel-range MP4 proxy ─────────────────────────────
// ok.ru throttles each connection to roughly 226 KB/s (~1.8 Mbps) but does NOT
// throttle per IP: measured 1/2/4/8 connections = 226/451/887/1792 KB/s, i.e. a
// near-linear ~7.9x at 8. A single-connection player therefore cannot sustain
// 1080p from these links, which is what makes ReplayZone replays buffer.
//
// This endpoint fetches the requested byte range as several parallel sub-ranges
// and streams them back IN ORDER, multiplying effective throughput. Correctness
// (byte-for-byte ordering) matters more than speed here, so a strictly ordered
// writer is used rather than a naive parallel pipe.
//
// Defaults: 6 connections x 1 MB chunks. Bounded memory (~6 MB in flight) and a
// deliberate cap so a single viewer cannot stampede the upstream.
const FASTMP4_CHUNK = 1 * 1024 * 1024;
const FASTMP4_CONCURRENCY = 6;

function parseClientRange(rangeHeader, total) {
  // 'bytes=start-end' | 'bytes=start-' ; returns {start,end} or null
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m) return null;
  let [, s, e] = m;
  let start = s === '' ? null : parseInt(s, 10);
  let end = e === '' ? null : parseInt(e, 10);
  if (start === null && end === null) return null;
  if (start === null) { // suffix range: last N bytes
    start = total != null ? Math.max(0, total - end) : 0;
    end = total != null ? total - 1 : null;
  }
  if (Number.isNaN(start)) return null;
  if (end != null && Number.isNaN(end)) end = null;
  if (end != null && end < start) return null;
  return { start, end };
}

async function fetchRangeBuf(url, start, end, headers, signal) {
  try {
    const r = await fetch(url, {
      headers: { ...headers, Range: `bytes=${start}-${end}` },
      signal,
    });
    if (r.status !== 206 && r.status !== 200) {
      const err = new Error(`upstream ${r.status}`);
      err.statusCode = r.status;
      throw err;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return buf;
  } catch (e) {
    // On client disconnect we abort() the whole batch. Those rejections are
    // expected and already handled at the await site, but the not-yet-awaited
    // siblings would otherwise surface as unhandledRejection. Mark them handled.
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
      e.__expected = true;
    }
    throw e;
  }
}

app.get('/api/fastmp4', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://ok.ru/';
  if (!targetUrl) return res.status(400).send('Missing url');

  const concurrency = Math.min(
    Math.max(parseInt(req.query.concurrency, 10) || FASTMP4_CONCURRENCY, 1), 12
  );
  const chunkSize = Math.min(
    Math.max(parseInt(req.query.chunk, 10) || FASTMP4_CHUNK, 256 * 1024), 4 * 1024 * 1024
  );

  const upstreamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Referer': referer,
    'Accept': '*/*',
  };

  // Probe with a 1-byte range to learn the real Content-Range/total length.
  let total = null;
  let contentType = 'video/mp4';
  try {
    const probe = await fetch(targetUrl, {
      headers: { ...upstreamHeaders, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(15000),
    });
    if (probe.status !== 206 && probe.status !== 200) {
      return res.status(probe.status === 400 ? 502 : probe.status).send('upstream refused');
    }
    const cr = probe.headers.get('content-range');
    if (cr) {
      const m = /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(cr);
      if (m && m[1] !== '*') total = parseInt(m[1], 10);
    }
    if (probe.headers.get('content-type')) contentType = probe.headers.get('content-type');
    // drain the tiny body
    try { await probe.arrayBuffer(); } catch (_) {}
  } catch (e) {
    console.error('[FastMP4] probe failed:', e.message);
    return res.status(502).send('upstream probe failed');
  }

  const reqRange = parseClientRange(req.headers['range'], total);
  const start = reqRange ? reqRange.start : 0;
  const end = reqRange && reqRange.end != null
    ? reqRange.end
    : (total != null ? total - 1 : null);

  const isPartial = !!reqRange;
  const contentLength = end != null ? (end - start + 1) : null;

  res.status(isPartial ? 206 : 200);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  if (contentLength != null) res.setHeader('Content-Length', String(contentLength));
  if (isPartial && total != null) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);

  if (req.method === 'HEAD') return res.end();

  // Ordered parallel fetch.
  const ac = new AbortController();
  req.on('close', () => { try { ac.abort(); } catch (_) {} });

  const pending = new Map(); // seq -> Promise<Buffer>
  let nextOffset = start;
  let nextSeq = 0;
  let exhausted = false;

  // Attach a no-op catch to every queued promise the moment it is created, so an
  // abort cannot produce an unhandledRejection before/after we await it.
  const track = (p) => { p.catch(() => {}); return p; };

  const launch = () => {
    if (exhausted) return;
    if (end != null && nextOffset > end) { exhausted = true; return; }
    const s = nextOffset;
    const e = end != null ? Math.min(s + chunkSize - 1, end) : (s + chunkSize - 1);
    nextOffset = e + 1;
    const seq = nextSeq++;
    pending.set(seq, track(fetchRangeBuf(targetUrl, s, e, upstreamHeaders, ac.signal)));
  };

  let aborted = false;
  res.on('close', () => { aborted = true; try { ac.abort(); } catch (_) {} });

  try {
    for (let i = 0; i < concurrency; i++) launch();
    let serve = 0;
    while (pending.has(serve)) {
      let buf;
      try {
        buf = await pending.get(serve);
      } catch (e) {
        pending.delete(serve);
        if (aborted || (e && e.__expected)) return; // client went away; normal
        console.error('[FastMP4] chunk failed:', e.message);
        break; // stop; headers already sent
      }
      pending.delete(serve);
      if (aborted) return;
      if (buf && buf.length) {
        if (!res.write(buf)) {
          await new Promise(r => res.once('drain', r));
        }
      }
      // a short read means upstream had nothing more for this window
      if (!buf || buf.length < chunkSize) {
        if (end == null) exhausted = true;
      }
      serve++;
      launch();
    }
    res.end();
  } catch (e) {
    if (aborted || (e && e.__expected)) return;
    console.error('[FastMP4] error:', e.message);
    if (!res.headersSent) res.status(502).send('Proxy error');
    else res.end();
  }
});

// ─── /api/mp4proxy — single-connection MP4 passthrough (kept for compatibility)
app.get('/api/mp4proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://ok.ru/';
  if (!targetUrl) return res.status(400).send('Missing url');

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Referer': referer,
      'Origin': 'https://ok.ru',
      'Accept': '*/*',
    };
    if (req.headers['range']) {
      headers['Range'] = req.headers['range'];
    }

    const upstream = await fetch(targetUrl, { headers, redirect: 'follow' });

    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    if (upstream.headers.get('content-type')) res.setHeader('Content-Type', upstream.headers.get('content-type'));
    if (upstream.headers.get('content-length')) res.setHeader('Content-Length', upstream.headers.get('content-length'));
    if (upstream.headers.get('content-range')) res.setHeader('Content-Range', upstream.headers.get('content-range'));

    const { Readable } = require('stream');
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    console.error('[MP4Proxy] Error:', e.message);
    if (!res.headersSent) res.status(500).send('Proxy error');
  }
});

function createSegmentUncloakStream() {
  const { Transform } = require('stream');
  let buffered = Buffer.alloc(0);
  let stripping = true;

  return new Transform({
    transform(chunk, encoding, callback) {
      if (!stripping) {
        this.push(chunk);
        return callback();
      }

      buffered = Buffer.concat([buffered, chunk]);

      // Direct clean TS packet
      if (buffered.length >= 4 && buffered[0] === 0x47) {
        stripping = false;
        this.push(buffered);
        return callback();
      }

      // PNG cloaked TS (WatchFooty / sportsembed) - starts with \x89PNG
      if (buffered.length >= 4 && buffered[0] === 0x89 && buffered[1] === 0x50 && buffered[2] === 0x4e && buffered[3] === 0x47) {
        const iend = buffered.indexOf(Buffer.from('IEND'));
        if (iend >= 0 && iend + 8 <= buffered.length) {
          stripping = false;
          this.push(buffered.subarray(iend + 8));
          return callback();
        }
        return callback();
      }

      // RIFF / WEBP cloaked TS (Streamed.pk / TikTok CDN)
      if (buffered.length >= 12 && buffered[0] === 0x52 && buffered[1] === 0x49 && buffered[2] === 0x46 && buffered[3] === 0x46) {
        const exif = buffered.indexOf(Buffer.from('EXIF'));
        if (exif >= 0 && exif + 8 <= buffered.length) {
          stripping = false;
          this.push(buffered.subarray(exif + 8));
          return callback();
        }
        if (buffered.length >= 43 && buffered[42] === 0x47) {
          stripping = false;
          this.push(buffered.subarray(42));
          return callback();
        }
        return callback();
      }

      // General scan for TS 188-byte sync byte pattern (verify at least 2 consecutive sync points)
      for (let i = 0; i < Math.min(buffered.length, 65536); i++) {
        if (buffered[i] === 0x47 && i + 188 < buffered.length && buffered[i + 188] === 0x47) {
          if (i + 376 >= buffered.length || buffered[i + 376] === 0x47) {
            stripping = false;
            this.push(buffered.subarray(i));
            return callback();
          }
        }
      }

      // If more than 128KB collected without sync byte, pass through as-is
      if (buffered.length > 131072) {
        stripping = false;
        this.push(buffered);
        return callback();
      }

      callback();
    },
    flush(callback) {
      if (stripping && buffered.length > 0) {
        this.push(buffered);
      }
      callback();
    }
  });
}

app.get('/api/hlschunk', (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer;
  const origin = req.query.origin;
  if (!targetUrl) return res.status(400).send('Missing url');

  try {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? hlsChunkHttpsAgent : hlsChunkHttpAgent;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    };
    if (referer) headers['Referer'] = referer;
    if (origin) headers['Origin'] = origin;
    if (req.headers['range']) headers['Range'] = req.headers['range'];

    const upstreamReq = client.get(targetUrl, {
      agent,
      headers,
      timeout: 15000
    }, upstreamRes => {
      res.status(upstreamRes.statusCode);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'video/mp2t');

      const uncloakStream = createSegmentUncloakStream();
      upstreamRes.pipe(uncloakStream).pipe(res);
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('Upstream timeout'));
    });

    upstreamReq.on('error', err => {
      console.error('[HLSChunk] Upstream request error:', err.message);
      if (!res.headersSent) res.status(502).send('Upstream error');
    });

    req.on('close', () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    });
  } catch (e) {
    console.error('[HLSChunk] Error:', e.message);
    if (!res.headersSent) res.status(500).send('Proxy error');
  }
});

// ─── Silent upstream-token re-mint ──────────────────────────────────
// Proxied stream URLs embed a time-limited upstream token. When it expires the
// player's next poll is refused by the CDN. Rather than handing that refusal to
// the viewer, mint a fresh token server-side and serve the new manifest as if
// nothing happened. Key format (`rck`, added by streams.js): `${source}:${matchId}:${srcId}`.
// ─── Silent upstream-token re-mint ──────────────────────────────────
// Proxied stream URLs embed a time-limited upstream token. When it expires the
// player's next poll is refused by the CDN. Rather than handing that refusal to
// the viewer, mint a fresh token server-side and serve the new manifest as if
// nothing happened. Key format (`rck`, added by streams.js): `${source}:${matchId}:${srcId}`.
const REMINT_TIMEOUT_MS = 12000;
// After a re-mint, hold the rewritten manifest at least this long so we do not
// re-mint on every 3-6 s player poll (that would hammer the provider).
const REMINT_MIN_CACHE_MS = 45 * 1000;
const remintCache = new Map(); // rck -> { freshUrl, expiresAt }

// ─── Provider-Specific Token Mechanisms ──────────────────────────────────────
// Each provider structures and places its authorization tokens differently:
// 1. WatchFooty: Token AND expiry timestamp in URL path:
//    /secure/<TOKEN>/<FLAVOR>/<SLUG>/<NUM>/<MATCHID>/<EXPIRY>/<FILE>
// 2. DaddyLive: Authorization signature & expiry in query parameters:
//    /hls/<CHANNEL_KEY>.m3u8?s=<SIG>&e=<EXPIRY>
// 3. Streamed.pk / embed.st: RTMP stream session hash and stream ID in path:
//    /rtmp/stream/<SESSION_HASH>/<STREAM_NUM>/<VARIANT>

function mergeRemintedUrl(heldUrl, freshUrl, rck = '') {
  try {
    const held = new URL(heldUrl);
    const fresh = new URL(freshUrl);
    const provider = rck ? String(rck).split(':')[0]?.toLowerCase() : '';

    // 1. DaddyLive: Query-token replacement mechanism (?s=...&e=...)
    if (provider === 'daddylive' || fresh.searchParams.has('s') || held.pathname.includes('/hls/')) {
      const merged = new URL(heldUrl);
      if (fresh.searchParams.has('s')) merged.searchParams.set('s', fresh.searchParams.get('s'));
      if (fresh.searchParams.has('e')) merged.searchParams.set('e', fresh.searchParams.get('e'));
      merged.host = fresh.host;
      merged.protocol = fresh.protocol;
      return merged.toString();
    }

    // 2. WatchFooty: Path-token replacement mechanism
    // /secure/<NEW_TOKEN>/<FLAVOR>/<SLUG>/<NUM>/<MATCHID>/<NEW_EXPIRY>/<HELD_FILE>
    if (provider === 'watchfooty' || fresh.pathname.includes('/secure/')) {
      const freshDir = fresh.pathname.substring(0, fresh.pathname.lastIndexOf('/'));
      const heldFile = held.pathname.substring(held.pathname.lastIndexOf('/') + 1) || 'playlist.m3u8';
      const merged = new URL(freshUrl);
      merged.pathname = `${freshDir}/${heldFile}`;
      return merged.toString();
    }

    // 3. Streamed.pk / embed.st: Path-token replacement mechanism
    if (provider === 'streamedpk' || provider === 'embedst' || fresh.pathname.includes('/rtmp/stream/')) {
      const freshBase = fresh.pathname.replace(/\/playlist\.m3u8.*$/, '');
      const heldSuffix = held.pathname.includes('/rtmp/stream/')
        ? held.pathname.split(/\/rtmp\/stream\/[^/]+\/\d+\/?/)[1]
        : '';
      const merged = new URL(freshUrl);
      if (heldSuffix && !heldSuffix.startsWith('playlist.m3u8')) {
        merged.pathname = `${freshBase}/${heldSuffix}`;
      }
      return merged.toString();
    }

    // Generic fallback: preserve filename, update base directory & query
    const heldParts = held.pathname.split('/');
    const freshParts = fresh.pathname.split('/');
    const dirCount = freshParts.length - 1;
    const mergedParts = freshParts.slice(0, dirCount).concat(heldParts.slice(dirCount));
    const merged = new URL(freshUrl);
    merged.pathname = mergedParts.join('/');
    return merged.toString();
  } catch (_) {
    return freshUrl;
  }
}

function getRemintCacheKey(rck, url) {
  if (!rck) return null;
  if (!url) return rck;
  try {
    const u = new URL(url);
    const provider = String(rck).split(':')[0]?.toLowerCase();

    // 1. WatchFooty: Stable key based on flavor (any NATO/custom flavor) and stream number
    if (provider === 'watchfooty' || u.pathname.includes('/secure/')) {
      const wf = u.pathname.match(/\/secure\/[^/]+\/([^/]+)\/[^/]+\/(\d+)\//i);
      if (wf) return `${rck}:${wf[1].toLowerCase()}:${wf[2]}`;
    }

    // 2. DaddyLive: Stable key based on channel key in path
    if (provider === 'daddylive' || u.pathname.includes('/hls/')) {
      const dl = u.pathname.match(/\/hls\/([^/.]+)/i);
      if (dl) return `${rck}:${dl[1]}`;
    }

    // 3. Streamed.pk / embed.st: Stable key based on stream number
    if (provider === 'streamedpk' || provider === 'embedst' || u.pathname.includes('/rtmp/stream/')) {
      const spk = u.pathname.match(/\/rtmp\/stream\/[^/]+\/(\d+)\//i);
      if (spk) return `${rck}:${spk[1]}`;
    }

    // Generic fallback
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length > 1) {
      return `${rck}:${parts.slice(0, parts.length - 1).join('/')}`;
    }
    return `${rck}:${u.pathname}`;
  } catch (_) {
    return rck;
  }
}

function readRck(req) {
  try {
    const raw = req.originalUrl || req.url || '';
    const q = raw.indexOf('?');
    if (q < 0) return null;
    return new URLSearchParams(raw.slice(q + 1)).get('rck');
  } catch (_) { return null; }
}

// Upstream refused because the embedded token is gone (not because we are broken).
function isExpiryStatus(err) {
  const s = err && err.statusCode;
  return s === 401 || s === 403 || s === 404 || s === 410;
}

// Mint a fresh upstream URL for one source. Returns null when we cannot.
// Never throws: a failed re-mint must degrade to the existing 404 behaviour.
function rckCandidates(rck) {
  const parts = String(rck).split(':');
  if (parts.length < 3) return [];
  const sourceName = parts[0];
  const rest = parts.slice(1);
  const out = [];
  for (let i = 0; i < rest.length - 1; i++) {
    const matchId = rest.slice(0, i + 1).join(':');
    const srcId = rest.slice(i + 1).join(':');
    if (sourceName && matchId && srcId) out.push({ sourceName, matchId, srcId });
  }
  return out;
}

async function attemptRemint(rck, heldUrl = '') {
  try {
    if (!rck || typeof rck !== 'string') return null;
    const candidates = rckCandidates(rck);
    if (candidates.length === 0) return null;

    const matches = container.resolve('cacheService').getMatches();
    let resolved = null;
    for (const c of candidates) {
      const match = matches.find(m => m && m.id === c.matchId);
      if (!match) continue;
      const src = (match.sources || []).find(s => s && s.id === c.srcId);
      if (!src) continue;
      resolved = { match, src };
      break;
    }
    if (!resolved) return null;

    const { resolveSource } = require('./streams');
    const minted = await Promise.race([
      resolveSource(resolved.src, resolved.match, null),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('re-mint timeout')), REMINT_TIMEOUT_MS)),
    ]);
    if (!Array.isArray(minted) || minted.length === 0) return null;

    // Collect all candidate fresh URLs from minted streams.
    const freshUrls = [];
    for (const s of minted) {
      if (s && typeof s.url === 'string') {
        if (s.url.includes('/api/manifest?')) {
          const inner = new URL('http://localhost' + s.url).searchParams.get('url');
          if (inner) freshUrls.push(inner);
        } else if (s.url.startsWith('http')) {
          freshUrls.push(s.url);
        }
      }
    }
    if (freshUrls.length === 0) return null;

    const provider = String(rck).split(':')[0]?.toLowerCase();

    // Match against currently held URL using provider-specific logic
    if (heldUrl) {
      try {
        const heldParsed = new URL(heldUrl);
        const heldPath = heldParsed.pathname;

        // 1. WatchFooty: Match by flavor (any NATO/custom flavor) and stream number
        if (provider === 'watchfooty' || heldPath.includes('/secure/')) {
          const wfMatch = heldPath.match(/\/secure\/[^/]+\/([^/]+)\/[^/]+\/(\d+)\//i);
          if (wfMatch) {
            const [, flavor, streamNum] = wfMatch;
            const matched = freshUrls.find(u => {
              const up = new URL(u).pathname;
              return up.toLowerCase().includes(`/${flavor.toLowerCase()}/`) && up.includes(`/${streamNum}/`);
            });
            if (matched) return matched;

            const flavorMatched = freshUrls.find(u => new URL(u).pathname.toLowerCase().includes(`/${flavor.toLowerCase()}/`));
            if (flavorMatched) return flavorMatched;
          }
        }

        // 2. DaddyLive: Match by channel key
        if (provider === 'daddylive' || heldPath.includes('/hls/')) {
          const dlMatch = heldPath.match(/\/hls\/([^/.]+)/i);
          if (dlMatch) {
            const channelKey = dlMatch[1];
            const matched = freshUrls.find(u => new URL(u).pathname.includes(`/hls/${channelKey}`));
            if (matched) return matched;
          }
        }

        // 3. Streamed.pk / embed.st: Match by stream number
        if (provider === 'streamedpk' || provider === 'embedst' || heldPath.includes('/rtmp/stream/')) {
          const spkMatch = heldPath.match(/\/rtmp\/stream\/[^/]+\/(\d+)\//i);
          if (spkMatch) {
            const streamNum = spkMatch[1];
            const matched = freshUrls.find(u => new URL(u).pathname.includes(`/${streamNum}/`));
            if (matched) return matched;
          }
        }

        // Fallback: Segment overlap heuristic
        const heldSegments = heldPath.split('/').filter(s => s.length > 2 && !/^[0-9a-fA-F_-]{16,}$/.test(s) && !/^\d+$/.test(s));
        const heldStreamNum = (heldPath.match(/\/(\d+)\/[^/]+$/) || [])[1] || null;

        let bestMatch = null;
        let maxScore = 0;
        for (const candidate of freshUrls) {
          const cPath = new URL(candidate).pathname;
          let overlap = 0;
          for (const seg of heldSegments) {
            if (cPath.includes(seg)) overlap++;
          }
          const candStreamNum = (cPath.match(/\/(\d+)\/[^/]+$/) || [])[1] || null;
          const numBonus = (heldStreamNum && candStreamNum && heldStreamNum === candStreamNum) ? 0.5 : 0;
          const score = overlap + numBonus;
          if (score > maxScore) {
            maxScore = score;
            bestMatch = candidate;
          }
        }
        if (bestMatch && maxScore > 0) return bestMatch;
      } catch (_) {}
    }

    return freshUrls[0];
  } catch (e) {
    console.warn('[ManifestProxy] re-mint failed:', e.message);
    return null;
  }
}

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

app.get('/api/manifest', async (req, res) => {
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

// ─── /api/proxy-embed — CORS-safe embed HTML fetcher (SSRF-protected) ────────
// Fetches the HTML of a sports embed page on behalf of the client browser.
// The browser cannot fetch embedindia.st directly (CORS), but this endpoint
// can. It then returns the raw HTML so client-side JS can run the extractor.
//
// SSRF mitigation: only allowed embed domains are accepted (CG-05 / D-05).

const ALLOWED_EMBED_DOMAINS = new Set([
  'embedindia.st',
  'embedindia.com',
  'embedsport.xyz',
  'embed.st',
  'embedme.top',
  'embedstream.me',
  'embedstream.top',
  'streamtape.com',
  'sportsurge.net',
  'vecloud.net',
  'viprow.me',
  'vipbox.lc',
]);

const PROXY_EMBED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

app.get('/api/proxy-embed', async (req, res) => {
  const rawUrl = req.query.url;
  const referer = req.query.referer || '';

  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url parameter' });

  let parsed;
  try {
    parsed = new URL(decodeURIComponent(rawUrl));
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Invalid URL protocol' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // SSRF protection: reject any domain not in the allowlist
  if (!ALLOWED_EMBED_DOMAINS.has(parsed.hostname)) {
    console.warn(`[proxy-embed] Blocked SSRF attempt for domain: ${parsed.hostname}`);
    return res.status(403).json({ error: `Domain ${parsed.hostname} is not in the allowed embed domain list.` });
  }

  try {
    const headers = {
      'User-Agent': PROXY_EMBED_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };
    if (referer) headers['Referer'] = referer;

    const upstream = await fetch(parsed.toString(), {
      headers,
      signal: AbortSignal.timeout(12000),
      redirect: 'follow'
    });

    const html = await upstream.text();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(html);
  } catch (err) {
    console.error(`[proxy-embed] Fetch failed for ${parsed.hostname}: ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch embed page', detail: err.message });
  }
});


// Mount the HLS Video Proxy (routes to the internal resolver on port RESOLVER_PORT)
app.use('/api', createProxyMiddleware({
  target: `http://127.0.0.1:${RESOLVER_PORT}/api`,
  changeOrigin: true,
  xfwd: true,
  logLevel: 'debug',
  onError: (err, req, res) => {
    console.error('[Proxy Error] Failed to proxy /api request to internal resolver:', err.message);
    if (!res.headersSent) {
      res.status(502).send('Bad Gateway: Internal stream resolver is not responding.');
    }
  }
}));

// ─── Universal Dynamic Base URL Response Rewriter ─────────────────────────────
// Intercepts /manifest.json, /catalog/*, /meta/*, and /stream/* responses to
// dynamically rewrite all internal proxy URLs (/img, /watch, /api/manifest)
// to match the client's incoming Host and Protocol.
app.use((req, res, next) => {
  const isAddonRoute = req.path === '/manifest.json' || 
                       req.path.endsWith('/manifest.json') ||
                       req.path.includes('/catalog/') || 
                       req.path.includes('/meta/') || 
                       req.path.includes('/stream/');
  
  if (!isAddonRoute) return next();

  const currentBaseUrl = getRequestBaseUrl(req);
  const originalWrite = res.write;
  const originalEnd = res.end;
  const chunks = [];

  res.write = function (chunk, encoding, callback) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
    // Honour the Node write contract: invoke a trailing callback and return a
    // boolean so callers that check backpressure are not misled.
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };

  res.end = function (chunk, encoding, callback) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

    if (chunks.length > 0) {
      const bodyBuffer = Buffer.concat(chunks);
      const bodyString = bodyBuffer.toString('utf8');

      try {
        const body = JSON.parse(bodyString);
        let modified = false;

        const rewriteUrl = (url) => {
          if (!url || typeof url !== 'string') return url;
          // Relative URLs
          if (url.startsWith('/img') || url.startsWith('/watch') || url.startsWith('/api/manifest') || url.startsWith('/logo') || url.startsWith('/api/mp4proxy') || url.startsWith('/api/fastmp4') || url.startsWith('/api/hlschunk') || url.startsWith('/posters')) {
            modified = true;
            return `${currentBaseUrl}${url}`;
          }
          // Absolute URLs with legacy/static base or localhost/LAN IP
          const match = url.match(/^(?:https?:\/\/[^\/]+)(\/(?:img|watch|api\/manifest|api\/mp4proxy|api\/fastmp4|api\/hlschunk|logo|posters)(?:[?\/].*)?)$/);
          if (match) {
            modified = true;
            return `${currentBaseUrl}${match[1]}`;
          }
          return url;
        };

        // 1. Streams payload (/stream/*/*.json)
        if (body && Array.isArray(body.streams)) {
          body.streams.forEach(s => {
            if (s.url) s.url = rewriteUrl(s.url);
            if (s.externalUrl) s.externalUrl = rewriteUrl(s.externalUrl);
          });
        }

        // 2. Catalog payload (/catalog/*/*.json)
        if (body && Array.isArray(body.metas)) {
          body.metas.forEach(meta => {
            if (meta.poster) meta.poster = rewriteUrl(meta.poster);
            if (meta.background) meta.background = rewriteUrl(meta.background);
            if (meta.logo) meta.logo = rewriteUrl(meta.logo);
          });
        }

        // 3. Meta detail payload (/meta/*/*.json)
        if (body && body.meta) {
          if (body.meta.poster) body.meta.poster = rewriteUrl(body.meta.poster);
          if (body.meta.background) body.meta.background = rewriteUrl(body.meta.background);
          if (body.meta.logo) body.meta.logo = rewriteUrl(body.meta.logo);
          if (Array.isArray(body.meta.videos)) {
            body.meta.videos.forEach(v => {
              if (v.thumbnail) v.thumbnail = rewriteUrl(v.thumbnail);
            });
          }
        }

        // 4. Manifest payload (/manifest.json)
        if (body && (body.logo || body.background)) {
          if (body.logo) body.logo = rewriteUrl(body.logo);
          if (body.background) body.background = rewriteUrl(body.background);
        }

        if (modified) {
          const newBodyString = JSON.stringify(body);
          const newBuffer = Buffer.from(newBodyString, 'utf8');
          res.setHeader('Content-Length', newBuffer.length);
          return originalEnd.call(res, newBuffer, 'utf8', callback);
        }
      } catch (_) {
        // Not JSON or parse failure; fall through
      }
    }

    const finalBuffer = Buffer.concat(chunks);
    originalEnd.call(res, finalBuffer, encoding, callback);
  };

  next();
});

/**
 * Decodes a config URL segment. Accepts URL-encoded JSON or base64url JSON.
 * Returns null when the segment is not a valid config.
 */
function decodeConfigSegment(configStr) {
  try {
    let parsed;
    if (configStr.startsWith('%7B') || configStr.startsWith('{')) {
      parsed = JSON.parse(decodeURIComponent(configStr));
    } else {
      let base64 = configStr.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) {
        base64 += '=';
      }
      parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}
app.get('/:config?/manifest.json', (req, res, next) => {
  const { manifest } = require('./manifest');
  let parsedConfig = {};
  if (req.params.config) {
    parsedConfig = decodeConfigSegment(req.params.config);
    if (parsedConfig === null) return next();
  }

  // Clone manifest catalogs
  const newManifest = JSON.parse(JSON.stringify(manifest));
  
  if (typeof parsedConfig.sports === 'string' && parsedConfig.sports !== 'all') {
    const enabledSports = parsedConfig.sports.split(',');
    
    // General catalogs to always keep
    const keepCatalogs = ['nuvio_sports_live', 'nuvio_sports_upcoming', 'nuvio_sports_teams', 'nuvio_sports_networks', 'nuvio_sports_replays'];
    
    // Add specific catalogs based on selection
    const sportCatalogs = ['football', 'cricket', 'basketball', 'motorsport', 'hockey', 'baseball', 'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts'];
    for (const sport of sportCatalogs) {
      if (enabledSports.includes(sport)) {
        keepCatalogs.push(`nuvio_sports_${sport}`);
      }
    }
    if (enabledSports.includes('other')) keepCatalogs.push('nuvio_sports_other');
    
    newManifest.catalogs = newManifest.catalogs.filter(c => {
      if (keepCatalogs.includes(c.id)) return true;
      if (c.id.startsWith('nuvio_sports_replays_')) {
        return enabledSports.some(sport => c.id.startsWith(`nuvio_sports_replays_${sport}`));
      }
      return false;
    });
  }
  
  // Remove teams catalog if the user hasn't configured any teams
  if (typeof parsedConfig.teams !== 'string' || parsedConfig.teams.trim() === '') {
    newManifest.catalogs = newManifest.catalogs.filter(c => c.id !== 'nuvio_sports_teams');
  }

  // Catalog management: hide sport catalogs that currently have no content.
  // Dead shelves (a catalog chip that always opens empty) are worse UX than an
  // absent one. Guarded so this only applies once a sync has actually produced
  // matches — on a cold start the cache is empty and hiding everything would be
  // far worse than showing a temporary empty shelf.
  try {
    const cached = container.resolve('cacheService').getMatches();
    if (Array.isArray(cached) && cached.length > 0) {
      const present = new Set(cached.map(m => m && m.category).filter(Boolean));
      const replaysAvailable = new Set(
        cached.filter(m => isReplayMatch(m)).map(m => m.category).filter(Boolean)
      );

      // Always-keep catalogs: not tied to a single sport.
      const ALWAYS_KEEP = new Set([
        'nuvio_sports_live', 'nuvio_sports_upcoming',
        'nuvio_sports_teams', 'nuvio_sports_other', 'nuvio_sports_networks'
      ]);
      newManifest.catalogs = newManifest.catalogs.filter((c) => {
        if (ALWAYS_KEEP.has(c.id)) return true;

        // Keep all replay catalogs in manifest so Nuvio Collections can query them!
        // Because they have isRequired: true on 'skip', Stremio/Nuvio will NOT display them on the Home screen.
        if (c.id === 'nuvio_sports_replays' || c.id.startsWith('nuvio_sports_replays_')) {
          return true;
        }

        const cat = c.id.replace('nuvio_sports_', '');
        // Keep 24/7 network-carried sports even when no fixture is scheduled.
        if (present.has(cat)) return true;
        if (cached.some(m => m && m.category === 'networks')) {
          const titleLower = (m => String((m && m.title) || '').toLowerCase());
          if (cached.some(m => m && m.category === 'networks' && titleLower(m).includes(cat))) return true;
        }
        return false;
      });
    }
  } catch (_) {
    // Never let catalog curation break the manifest.
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send(newManifest);
});

// The SDK router JSON.parses the raw config segment. Nuvio installs use a
// base64url config, so rewrite it to URL-encoded JSON before the SDK sees it.
app.use((req, res, next) => {
  const m = req.url.match(/^\/([A-Za-z0-9_-]+)(\/(?:catalog|meta|stream)\/.+)$/);
  if (m && !m[1].startsWith('%7B')) {
    const parsed = decodeConfigSegment(m[1]);
    if (parsed !== null) {
      req.url = `/${encodeURIComponent(JSON.stringify(parsed))}${m[2]}`;
    }
  }
  next();
});

// ─── Direct Handler for Nuvio Collection Sub-Catalogs ─────────────────────────
// Nuvio Collection folders query catalogs directly by ID (e.g. nuvio_sports_replays_football_recent).
// Handling them before the SDK router allows collection folders to work seamlessly
// without polluting the main manifest with 15+ home-screen rows.
app.get([
  '/catalog/:type/:id.json',
  '/catalog/:type/:id/:extra.json',
  '/:config/catalog/:type/:id.json',
  '/:config/catalog/:type/:id/:extra.json'
], async (req, res, next) => {
  const { type, id } = req.params;
  if (id && id.startsWith('nuvio_sports_replays_') && id !== 'nuvio_sports_replays') {
    const config = req.params.config ? decodeConfigSegment(req.params.config) : {};
    let extra = {};
    if (req.params.extra) {
      try {
        const parts = req.params.extra.split('&');
        for (const p of parts) {
          const [k, v] = p.split('=');
          if (k && v) extra[k] = decodeURIComponent(v);
        }
      } catch (_) {}
    }
    const result = await handleCatalog(type, id, extra, config);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json(result);
  }
  next();
});

// Mount the Stremio addon router
app.use(getRouter(builder.getInterface()));

// ─── /watch — Embed Proxy Page ────────────────────────────────────────────────

// When the user clicks a stream, Nuvio opens this URL in the browser.
// It serves a clean full-screen HTML page that wraps the embed in an iframe,
// bypassing the referrer/origin restrictions that the raw embed.st URLs have.
//
// Query params:
//   ?url=<encoded embed URL>     the stream embed to display
//   ?title=<encoded match title> shown in the page heading

app.get('/watch', (req, res) => {
  const mode     = req.query.mode;
  const title    = req.query.title || 'Live Sports';

  // ─── mode=extract — Client-side HLS extraction for IP-locked embed providers ─
  // Architecture: browser fetches /api/proxy-embed → runs extractor → plays via hls.js
  // This ensures all CDN requests originate from the user's own IP (IP consistency).
  if (mode === 'extract') {
    const embedUrl  = req.query.embed;
    const referer   = req.query.referer || '';

    if (!embedUrl) return res.status(400).send('Missing ?embed parameter');

    let safeEmbed, safeReferer;
    try {
      let rawEmbed = embedUrl;
      try { if (typeof rawEmbed === 'string' && rawEmbed.includes('%')) rawEmbed = decodeURIComponent(rawEmbed); } catch (_) {}
      const parsedEmbed = new URL(rawEmbed);
      if (!['http:', 'https:'].includes(parsedEmbed.protocol)) {
        return res.status(400).send('Invalid embed URL protocol');
      }
      safeEmbed = parsedEmbed.toString();
      let rawReferer = referer || safeEmbed;
      try { if (typeof rawReferer === 'string' && rawReferer.includes('%')) rawReferer = decodeURIComponent(rawReferer); } catch (_) {}
      safeReferer = new URL(rawReferer).toString();
    } catch {
      return res.status(400).send('Invalid embed URL');
    }

    const safeTitle = String(title)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>\uD83D\uDD34 ${safeTitle} | Extracting Stream</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #0a0a0a; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #fff; }
    #stage { position: fixed; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 16px; }
    .spinner { width: 52px; height: 52px; border: 4px solid rgba(255,255,255,0.1);
      border-top-color: #f44; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #status { font-size: 15px; opacity: 0.8; text-align: center; padding: 0 24px; }
    #title  { font-size: 19px; font-weight: 700; text-align: center; padding: 0 24px; }
    #error  { display: none; flex-direction: column; align-items: center; gap: 12px; }
    #error p { font-size: 14px; opacity: 0.6; text-align: center; max-width: 340px; }
    #open-btn {
      margin-top: 6px; padding: 10px 24px; background: #f44; color: #fff;
      border: none; border-radius: 8px; font-size: 14px; font-weight: 600;
      cursor: pointer; text-decoration: none;
    }
    #video-player { display: none; position: fixed; inset: 0; width: 100%; height: 100%; background: #000; }
    #topbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 10;
      background: linear-gradient(to bottom, rgba(0,0,0,0.85), transparent);
      padding: 12px 20px; color: #fff; font-size: 14px; font-weight: 600;
      display: flex; align-items: center; gap: 10px;
      animation: fadeOut 1s ease 4s forwards;
    }
    #topbar .dot { width: 10px; height: 10px; background: #f44; border-radius: 50%;
      flex-shrink: 0; animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    @keyframes fadeOut { to { opacity: 0; pointer-events: none; } }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
</head>
<body>
  <div id="topbar"><span class="dot"></span><span>${safeTitle}</span></div>
  <video id="video-player" controls autoplay playsinline></video>
  <div id="stage">
    <div class="spinner" id="spinner"></div>
    <p id="title">\uD83D\uDD34 ${safeTitle}</p>
    <p id="status">Fetching stream&hellip;</p>
    <div id="error">
      <p>Could not extract a direct stream from this embed.<br>Try opening it in your browser instead.</p>
      <a id="open-btn" href="${safeEmbed}" target="_blank" rel="noopener noreferrer">Open in Browser</a>
    </div>
  </div>
  <script>
    (async () => {
      const embedUrl = ${JSON.stringify(safeEmbed)};
      const referer  = ${JSON.stringify(safeReferer)};
      const status   = document.getElementById('status');
      const spinner  = document.getElementById('spinner');
      const errorDiv = document.getElementById('error');
      const video    = document.getElementById('video-player');
      const stage    = document.getElementById('stage');

      function showError() {
        spinner.style.display = 'none';
        status.style.display  = 'none';
        errorDiv.style.display = 'flex';
      }

      function playM3u8(url) {
        stage.style.display = 'none';
        video.style.display = 'block';
        if (Hls.isSupported()) {
          const hls = new Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 5, lowLatencyMode: true });
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
          hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { stage.style.display = 'flex'; video.style.display = 'none'; showError(); } });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
        } else {
          showError();
        }
      }

      // ── Extraction patterns (client-side mirror of EmbedExtractorChain) ──
      function extractM3u8(html) {
        // Pattern A — plain M3U8 URL in source
        const a = html.match(/(https?:\\/\\/[^\\s"'<>]+\\.m3u8[^\\s"'<>]*)/i);
        if (a) return a[1];

        // Pattern D — JSON player config keys
        for (const k of ['source','file','src','url','hls','stream','streamUrl','hlsUrl']) {
          const d = html.match(new RegExp('["\\']' + k + '["\\'\\\\]\\\\s*:\\\\s*["\\'\\\\](https?:\\\\/\\\\/[^"\\'+]+\\\\.m3u8[^"\\'+]*)["\\'\\\\]', 'i'));
          if (d) return d[1];
        }

        // Pattern B — atob() encoded URL
        const atobRe = /atob\\s*\\(\\s*["']([A-Za-z0-9+\\/=_-]{20,})["']\\s*\\)/g;
        let m;
        while ((m = atobRe.exec(html)) !== null) {
          try {
            const decoded = atob(m[1].replace(/-/g,'+').replace(/_/g,'/'));
            if (decoded.includes('.m3u8')) {
              const u = decoded.match(/(https?:\\/\\/[^\\s"'<>]+\\.m3u8[^\\s"'<>]*)/i);
              if (u) return u[1];
            }
          } catch(_) {}
        }
        return null;
      }

      try {
        status.textContent = 'Fetching embed page\u2026';
        const proxyUrl = '/api/proxy-embed?url=' + encodeURIComponent(embedUrl) + '&referer=' + encodeURIComponent(referer);
        const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });

        if (!resp.ok) {
          console.warn('[extract] proxy-embed returned', resp.status);
          showError();
          return;
        }

        status.textContent = 'Analysing stream\u2026';
        const html = await resp.text();
        const m3u8 = extractM3u8(html);

        if (m3u8) {
          status.textContent = 'Starting playback\u2026';
          playM3u8(m3u8);
        } else {
          console.warn('[extract] No M3U8 URL found in embed HTML');
          showError();
        }
      } catch (err) {
        console.error('[extract] Error:', err);
        showError();
      }
    })();
  </script>
</body>
</html>`);
  }

  // ─── Default mode — iframe embed proxy (original behaviour, unchanged) ────
  const embedUrl = req.query.url;
  if (!embedUrl) {
    return res.status(400).send('Missing ?url parameter');
  }

  // Validate — only allow http/https URLs
  let safeUrl;
  try {
    let rawUrl = embedUrl;
    try { if (typeof rawUrl === 'string' && rawUrl.includes('%')) rawUrl = decodeURIComponent(rawUrl); } catch (_) {}
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).send('Invalid URL protocol');
    }
    safeUrl = parsed.toString();
  } catch {
    return res.status(400).send('Invalid URL');
  }

  const safeTitle = String(title)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <meta name="referrer" content="no-referrer">
  <title>\uD83D\uDD34 ${safeTitle} | Live Sports</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #000; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }

    #topbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 10;
      background: linear-gradient(to bottom, rgba(0,0,0,0.85), transparent);
      padding: 12px 20px; color: #fff; font-size: 14px; font-weight: 600;
      display: flex; align-items: center; gap: 10px;
      animation: fadeOut 1s ease 4s forwards;
      pointer-events: none;
    }
    #topbar .dot {
      width: 10px; height: 10px; background: #f44;
      border-radius: 50%; flex-shrink: 0;
      animation: pulse 1s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.5; transform: scale(1.3); }
    }
    @keyframes fadeOut { to { opacity: 0; } }

    #fs-btn {
      position: fixed; top: 12px; right: 16px; z-index: 100;
      display: flex; align-items: center; gap: 8px;
      background: rgba(20, 20, 20, 0.85); color: #fff;
      border: 2px solid rgba(255, 255, 255, 0.3); border-radius: 10px;
      padding: 10px 18px; font-size: 14px; font-weight: 700;
      cursor: pointer; backdrop-filter: blur(8px);
      transition: all 0.25s ease, opacity 0.6s ease;
      box-shadow: 0 4px 16px rgba(0,0,0,0.6);
      user-select: none; outline: none;
    }
    #fs-btn:hover, #fs-btn:focus {
      background: #f44; border-color: #fff;
      transform: scale(1.08); box-shadow: 0 0 20px rgba(255,68,68,0.8);
    }
    #fs-btn.fade-out { opacity: 0.15; }
    #fs-btn.fade-out:hover, #fs-btn.fade-out:focus { opacity: 1; }

    #player {
      position: fixed; top: 0; left: 0;
      width: 100vw; height: 100vh;
      border: none; display: block; background: #000;
    }

    #video-player {
      position: fixed; top: 0; left: 0;
      width: 100vw; height: 100vh;
      border: none; display: none; background: #000;
    }
    #loader {
      position: fixed; inset: 0; background: #111;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 20px; color: #fff; z-index: 5;
      transition: opacity 0.6s ease;
    }
    #loader.hidden { opacity: 0; pointer-events: none; }
    #loader .spinner {
      width: 48px; height: 48px;
      border: 4px solid rgba(255,255,255,0.15);
      border-top-color: #f44; border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #loader .match { font-size: 18px; font-weight: 600; text-align: center; padding: 0 24px; }
    #loader .hint  { font-size: 13px; opacity: 0.5; }
    
    #p2p-status {
      position: fixed; bottom: 20px; right: 20px; background: rgba(0,0,0,0.7); color: #0f0;
      padding: 5px 10px; border-radius: 4px; font-size: 12px; font-family: monospace; z-index: 20;
      display: none;
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/p2p-media-loader-core@latest/build/p2p-media-loader-core.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/p2p-media-loader-hlsjs@latest/build/p2p-media-loader-hlsjs.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
</head>
<body>
  <div id="loader">
    <div class="spinner"></div>
    <p class="match">\uD83D\uDD34 ${safeTitle}</p>
    <p class="hint">Loading stream\u2026</p>
    <a id="embed-fallback" href="${safeUrl}" target="_blank" rel="noopener noreferrer"
       style="display:none; margin-top:16px; padding:10px 22px; background:#f44; color:#fff;
              border-radius:8px; font-size:14px; font-weight:600; text-decoration:none;">
      Stream did not start \u2014 open in browser
    </a>
  </div>

  <div id="topbar">
    <span class="dot"></span>
    <span>${safeTitle}</span>
  </div>

  <button id="fs-btn" tabindex="0" title="Toggle Fullscreen (or Press OK on Remote)">
    <span>\u26F6 Fullscreen</span>
  </button>

  <div id="p2p-status">P2P Active: 0 Peers</div>

  <iframe
    id="player"
    allowfullscreen
    allow="autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope"
    scrolling="no"
    loading="eager"
  ></iframe>

  <video id="video-player" controls autoplay playsinline></video>

  <script>
    const fsBtn = document.getElementById('fs-btn');
    function toggleFullscreen() {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        const docEl = document.documentElement;
        const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
        if (req) req.call(docEl).catch(() => {});
        fsBtn.innerHTML = '<span>\u2715 Exit Fullscreen</span>';
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
        if (exit) exit.call(document).catch(() => {});
        fsBtn.innerHTML = '<span>\u26F6 Fullscreen</span>';
      }
    }
    fsBtn.addEventListener('click', toggleFullscreen);

    // Auto-dim button after 5 seconds of inactivity, wake up on remote key/mouse move
    let fsTimer;
    function resetFsButtonTimer() {
      fsBtn.classList.remove('fade-out');
      clearTimeout(fsTimer);
      fsTimer = setTimeout(() => {
        if (document.activeElement !== fsBtn) fsBtn.classList.add('fade-out');
      }, 5000);
    }
    window.addEventListener('mousemove', resetFsButtonTimer);
    window.addEventListener('keydown', (e) => {
      resetFsButtonTimer();
      // If user presses Enter or Space while focusing the body, toggle fullscreen
      if ((e.key === 'Enter' || e.key === ' ' || e.keyCode === 13) && document.activeElement === document.body) {
        toggleFullscreen();
      }
    });
    resetFsButtonTimer();

    const loader = document.getElementById('loader');
    const iframe = document.getElementById('player');
    const video = document.getElementById('video-player');
    const p2pStatus = document.getElementById('p2p-status');
    const targetUrl = "${safeUrl}";
    const isM3u8 = targetUrl.includes('.m3u8');
    
    // Video streams play DIRECT from the upstream CDN (no server-side relay).
    let finalUrl = targetUrl;

    // >>> TV-SAFE PLAYBACK: graceful degradation
    // TV WebViews vary widely: many block WebRTC (so P2P construction throws),
    // lack Web Workers, or block the cross-origin CDN scripts. Previously ANY
    // throw during P2P setup aborted this whole script, leaving a permanent
    // spinner - reported as a "sandbox error" on TV. Each capability is now
    // feature-detected, and every failure falls through to the next strategy.
    function showFatal(msg) {
      loader.classList.remove('hidden');
      var hint = loader.querySelector('.hint');
      if (hint) hint.textContent = msg;
      var fb = document.getElementById('embed-fallback');
      if (fb) fb.style.display = 'inline-block';
    }

    function startHls(opts) {
      var hls = new Hls(opts);
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        loader.classList.add('hidden');
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      });
      hls.on(Hls.Events.ERROR, function (evt, data) {
        if (data && data.fatal) {
          console.warn('[player] fatal HLS error:', data.type, data.details);
          showFatal('Playback error: ' + (data.details || data.type));
        }
      });
      hls.loadSource(finalUrl);
      hls.attachMedia(video);
      return hls;
    }

    if (isM3u8) {
      iframe.style.display = 'none';
      video.style.display = 'block';
      var started = false;

      // 1) P2P via WebRTC - optional, and the most likely to be blocked on TV.
      try {
        if (window.p2pml && p2pml.hlsjs && p2pml.hlsjs.Engine && p2pml.hlsjs.Engine.isSupported()) {
          p2pStatus.style.display = 'block';
          var engine = new p2pml.hlsjs.Engine();
          engine.on('peer_connect', function () { p2pStatus.innerText = 'P2P Active'; });
          // enableWorker disabled: TV engines frequently lack Worker support.
          startHls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 5,
                     lowLatencyMode: true, enableWorker: false,
                     loader: engine.createLoaderClass() });
          started = true;
        }
      } catch (e) {
        console.warn('[player] P2P unavailable, continuing without it:', e && e.message);
        p2pStatus.style.display = 'none';
      }

      // 2) Plain hls.js, worker disabled for maximum TV compatibility.
      if (!started && window.Hls && Hls.isSupported()) {
        try {
          startHls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 5,
                     lowLatencyMode: true, enableWorker: false });
          started = true;
        } catch (e) {
          console.warn('[player] hls.js failed:', e && e.message);
        }
      }

      // 3) Native HLS (Safari/iOS and some TV engines).
      if (!started && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = finalUrl;
        video.addEventListener('loadedmetadata', function () {
          loader.classList.add('hidden');
          var p = video.play();
          if (p && p.catch) p.catch(function () {});
        });
        video.addEventListener('error', function () { showFatal('Native playback failed'); });
        started = true;
      }

      if (!started) showFatal('No compatible video player on this device');
    } else {
      video.style.display = 'none';
      let iframeLoaded = false;
      iframe.src = targetUrl;
      iframe.addEventListener('load', () => {
        iframeLoaded = true;
        loader.classList.add('hidden');
      });
      // A blocked, hung or black-holed embed may never fire its load event at all.
      // Rather than freezing on an eternal spinner, reveal a manual escape hatch
      // so the user always has a way to reach the stream.
      setTimeout(() => {
        if (iframeLoaded) return;
        loader.classList.add('hidden');
        const fallback = document.getElementById('embed-fallback');
        if (fallback) fallback.style.display = 'inline-block';
      }, 12000);
    }
  </script>
</body>
</html>`);
});

// ─── Health Check ─────────────────────────────────────────────────────────────
// Render pings this to confirm the service is alive

app.get('/health', (_, res) => {
  let cache = null;
  try { cache = container.resolve('streamResolveCache').stats(); } catch (_) {}
  // Surface tripped circuit breakers: a provider can look "down" for minutes
  // while its upstream is healthy, and this is the only way to tell.
  let breakers = null;
  let openBreakers = [];
  try {
    const cb = container.resolve('circuitBreaker');
    if (cb && cb.getStatus) breakers = cb.getStatus();
    if (cb && cb.getOpenBreakers) openBreakers = cb.getOpenBreakers();
  } catch (_) {}
  res.json({
    status: 'ok',
    service: 'nuvio-live-sports',
    openBreakers,
    breakerCount: breakers ? Object.keys(breakers).length : null,
    streamResolveCache: cache
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

// In cluster mode, only the primary worker instance runs background cron syncs
if (workerOffset === 0) {
  container.resolve('cronService').start();
}

const BIND_HOST = process.env.HOST || process.env.IP || '0.0.0.0';
app.listen(PORT, BIND_HOST, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          🔴 Nuvio Live Sports Plugin                 ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Port       : ${String(PORT).padEnd(39)}║`);
  console.log(`║  Public URL : ${BASE_URL.padEnd(39)}║`);
  console.log('║                                                      ║');
  console.log('║  📋 Paste into Nuvio → Settings → Addons:           ║');
  console.log(`║  ${(BASE_URL + '/manifest.json').padEnd(52)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});



