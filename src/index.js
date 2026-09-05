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
const { handleCatalog, handleMeta } = require('./catalog');
const { handleStream } = require('./streams');
const { PORT, BASE_URL, getRequestBaseUrl } = require('./config');
const container = require('./container');



// Removed global User-Agent fix because it causes ECONNRESET on Streamed.pk

// ─── Spawn the Streamed.pk Resolver ───────────────────────────────────────────

// Use a dynamic random port between 20000-60000 for the internal resolver to prevent EADDRINUSE on shared hosts
const RESOLVER_PORT = process.env.RESOLVER_PORT || "7003";
let resolverProcess = null;
let isShuttingDown = false;

function spawnResolver() {
  if (isShuttingDown) return;
  const spawnEnv = { ...process.env, PORT: RESOLVER_PORT, HOST: '127.0.0.1' };
  if (process.env.LOW_MEMORY_MODE === 'true') {
    /* spawnEnv.NODE_OPTIONS removed to prevent 502 crashes */
  }

  // Decode 'server.js' from base64 at runtime so Webpack's asset relocator ignores it
  const scriptName = Buffer.from('c2VydmVyLmpz', 'base64').toString('utf8');
  const scriptPath = process.cwd() + '/resolver/src/' + scriptName;
  const args = [];
  args.push(scriptPath);

  resolverProcess = child_process['sp' + 'awn']('node', args, {
    stdio: 'inherit',
    env: spawnEnv
  });
  
  resolverProcess.on('error', (err) => console.error('[FATAL] Resolver spawn error:', err));
  
  resolverProcess.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    console.error(`[FATAL] Resolver process exited with code ${code} and signal ${signal}. Restarting in 2 seconds...`);
    setTimeout(spawnResolver, 2000);
  });
}

spawnResolver();

// Ensure child process is killed when the parent exits
function shutdownResolver() {
  isShuttingDown = true;
  if (resolverProcess && !resolverProcess.killed) {
    console.log('Shutting down Stream Resolver...');
    resolverProcess.kill();
  }
  // Shut down the headless browser sniffer if it was ever launched
  try { container.resolve('browserSniffer').shutdown(); } catch (_) {}
}
process.on('exit', shutdownResolver);
process.on('SIGINT', () => { shutdownResolver(); process.exit(0); });
process.on('SIGTERM', () => { shutdownResolver(); process.exit(0); });

// ─── Register Addon Handlers ──────────────────────────────────────────────────

builder.defineCatalogHandler(({ type, id, extra, config }) => handleCatalog(type, id, extra, config));
builder.defineMetaHandler(({ type, id, config })           => handleMeta(type, id, config));
builder.defineStreamHandler(({ type, id, config })         => handleStream(type, id, config));

// ─── Build Express App ────────────────────────────────────────────────────────

const app = express();

app.set('trust proxy', true);
app.use(cors());

// Serve the web debugger UI and Configuration Page
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get(['/configure', '/:config/configure'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'configure.html'));
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  const entry = await imageService.getImage(req.query.url);
  if (entry) {
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.send(entry.buffer);
  }
  const svg = imageService.svgPlaceholder(text, color);
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(svg);
});

// ─── Manifest proxy: shared client + validated short-TTL cache ──────────────
// Live HLS players reload /api/manifest every 2-6 s per viewer. A shared Impit
// client (keep-alive) + a validated short-TTL cache removes the per-viewer TLS
// handshake and repeated upstream fetches. Key = url|referer|origin (token
// binding depends on all three). Only bodies that passed the #EXT validation
// are cached. No HTTP Cache-Control is set - players must never cache live
// manifests client-side.
const MANIFEST_TTL_MS = 3000;
const MANIFEST_CACHE_MAX = 100;
const MANIFEST_NEGATIVE_TTL_MS = 15 * 1000;
const manifestCache = new Map();      // key -> { body, expiresAt, lastAccess }
const manifestInFlight = new Map();   // key -> Promise (coalesced upstream fetch)

let sharedImpitClient;                // lazy singleton; undefined = not tried yet
function getSharedImpitClient() {
  if (sharedImpitClient === undefined) {
    try {
      const { Impit } = require('impit');
      sharedImpitClient = new Impit();
    } catch (_) {
      sharedImpitClient = null;
    }
  }
  return sharedImpitClient;
}

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

function manifestCacheSet(key, body) {
  const now = Date.now();
  manifestCache.set(key, { body, expiresAt: now + MANIFEST_TTL_MS, lastAccess: now });
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

// Fetch + validate the upstream manifest. Throws on failure so coalesced
// waiters share the same outcome; successful bodies are cached by the caller.
async function fetchUpstreamManifest(targetUrl, referer, origin) {
  const headers = {
    'Referer': referer,
    'Origin': origin,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
  };
  try {
    const client = getSharedImpitClient();
    if (!client) throw new Error('impit unavailable');
    // Impit has no deadline here - race a hard 10 s timeout so a hung upstream
    // can never hold the viewer's poll (and its coalesced waiters).
    return await Promise.race([
      (async () => {
        const fetchRes = await client.fetch(targetUrl, { headers });
        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
        return await fetchRes.text();
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('impit timeout 10000ms')), 10000))
    ]);
  } catch (e) {
    // Fallback to undici (redirects followed)
    const { request } = require('undici');
    const fetchRes = await request(targetUrl, {
      headers,
      headersTimeout: 10000,
      bodyTimeout: 10000
      // NOTE: undici v8 rejects `maxRedirections` on request(); it must not be
      // passed here or the fallback path itself throws (see BaseProvider.proxyFetch).
    });
    return await fetchRes.body.text();
  }
}

app.get('/api/manifest', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://embed.st/';
  const origin = req.query.origin || 'https://embed.st';

  if (!targetUrl) return res.status(400).send('Missing url');

  const cacheKey = `${targetUrl}|${referer}|${origin}`;
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
        const out = await fetchUpstreamManifest(targetUrl, referer, origin);
        if (!out.includes('#EXT')) {
          console.error('[ManifestProxy] Upstream returned non-m3u8 body for', targetUrl);
          throw new Error('Upstream returned non-m3u8 body');
        }

        // Rewrite the manifest
        const lines = out.split('\n');
        const rewritten = lines.map(line => {
          const l = line.trim();
          if (!l || l.startsWith('#')) return line;

          let absoluteUrl = l;
          try {
            const chunkUrl = new URL(l, targetUrl);
            const manifestUrl = new URL(targetUrl);

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
            return `/api/manifest?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
          }

          if ((absoluteUrl.includes('.image') || absoluteUrl.includes('.js')) && !absoluteUrl.includes('.ts') && !absoluteUrl.includes('.m3u8')) {
            absoluteUrl += '#.ts';
          }
          return absoluteUrl;
        });

        const rewrittenResult = rewritten.join('\n');
        manifestCacheSet(cacheKey, rewrittenResult);
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
    if (err.message === 'Upstream returned non-m3u8 body') {
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

  res.write = function (chunk) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
          if (url.startsWith('/img') || url.startsWith('/watch') || url.startsWith('/api/manifest') || url.startsWith('/logo')) {
            modified = true;
            return `${currentBaseUrl}${url}`;
          }
          // Absolute URLs with legacy/static base or localhost/LAN IP
          const match = url.match(/^(?:https?:\/\/[^\/]+)(\/(?:img|watch|api\/manifest|logo)(?:[?\/].*)?)$/);
          if (match) {
            modified = true;
            return `${currentBaseUrl}${match[1]}`;
          }
          return url;
        };

        // 1. Streams payload (/stream/tv/*.json)
        if (body && Array.isArray(body.streams)) {
          body.streams.forEach(s => {
            if (s.url) s.url = rewriteUrl(s.url);
            if (s.externalUrl) s.externalUrl = rewriteUrl(s.externalUrl);
          });
        }

        // 2. Catalog payload (/catalog/tv/*.json)
        if (body && Array.isArray(body.metas)) {
          body.metas.forEach(meta => {
            if (meta.poster) meta.poster = rewriteUrl(meta.poster);
            if (meta.background) meta.background = rewriteUrl(meta.background);
            if (meta.logo) meta.logo = rewriteUrl(meta.logo);
          });
        }

        // 3. Meta detail payload (/meta/tv/*.json)
        if (body && body.meta) {
          if (body.meta.poster) body.meta.poster = rewriteUrl(body.meta.poster);
          if (body.meta.background) body.meta.background = rewriteUrl(body.meta.background);
          if (body.meta.logo) body.meta.logo = rewriteUrl(body.meta.logo);
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
    const keepCatalogs = ['nuvio_sports_live', 'nuvio_sports_upcoming', 'nuvio_sports_teams'];
    
    // Add specific catalogs based on selection
    const sportCatalogs = ['football', 'cricket', 'basketball', 'motorsport', 'hockey', 'baseball', 'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts'];
    for (const sport of sportCatalogs) {
      if (enabledSports.includes(sport)) keepCatalogs.push(`nuvio_sports_${sport}`);
    }
    if (enabledSports.includes('other')) keepCatalogs.push('nuvio_sports_other');
    
    newManifest.catalogs = newManifest.catalogs.filter(c => keepCatalogs.includes(c.id));
  }
  
  // Remove teams catalog if the user hasn't configured any teams
  if (typeof parsedConfig.teams !== 'string' || parsedConfig.teams.trim() === '') {
    newManifest.catalogs = newManifest.catalogs.filter(c => c.id !== 'nuvio_sports_teams');
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

    if (isM3u8) {
      iframe.style.display = 'none';
      video.style.display = 'block';
      p2pStatus.style.display = 'block';

      if (p2pml.hlsjs.Engine.isSupported()) {
        const engine = new p2pml.hlsjs.Engine();
        
        engine.on('peer_connect', () => {
           p2pStatus.innerText = 'P2P Active: ' + engine.getSettings().swarmId + ' peers connected';
        });

        const hls = new Hls({
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 5,
          lowLatencyMode: true,
          enableWorker: true,
          loader: engine.createLoaderClass()
        });

        p2pml.hlsjs.initHlsJsPlayer(hls);
        hls.loadSource(finalUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(e => console.log('Autoplay blocked'));
          loader.classList.add('hidden');
        });
      } else if (Hls.isSupported()) {
        const hls = new Hls({
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 5,
          lowLatencyMode: true,
          enableWorker: true
        });
        hls.loadSource(finalUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play();
          loader.classList.add('hidden');
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = finalUrl;
        video.addEventListener('loadedmetadata', () => {
          video.play();
          loader.classList.add('hidden');
        });
      }
    } else {
      video.style.display = 'none';
      iframe.src = targetUrl;
      iframe.addEventListener('load', () => loader.classList.add('hidden'));
      setTimeout(() => loader.classList.add('hidden'), 6000);
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
  res.json({ status: 'ok', service: 'nuvio-live-sports', streamResolveCache: cache });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

container.resolve('cronService').start();

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



