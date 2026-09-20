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
const fs = require('fs');
const { RESOLVER_PORT, workerOffset } = require('./resolverManager');

// Removed global User-Agent fix because it causes ECONNRESET on Streamed.pk

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
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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

// Memoized composed match cards: an identical query set skips both the badge
// fetch and the base64 re-encode. Bounded so a hostile query space cannot grow
// it without limit.
const matchCardMemo = new Map();
const MATCH_CARD_MEMO_MAX = 500;

app.get(['/img/collection/:sport', '/:config/img/collection/:sport'], (req, res) => {
  const sport = (req.params.sport || 'football').toLowerCase().replace(/\.(jpg|jpeg|png|svg)$/i, '');
  const candidatePaths = [
    path.join(__dirname, '..', 'public', 'posters', 'collections', `${sport}.jpg`),
    path.join(__dirname, 'public', 'posters', 'collections', `${sport}.jpg`),
    path.join(process.cwd(), 'public', 'posters', 'collections', `${sport}.jpg`),
    path.join(process.cwd(), 'dist', 'public', 'posters', 'collections', `${sport}.jpg`)
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      return res.sendFile(p);
    }
  }
  const svg = imageService.generateSportSvg(sport, 'landscape', { badge: 'REPLAYS' });
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

// /img/match?...         → composed "broadcast" match card. Used when a fixture
//                          has no official provider artwork: the server designs a
//                          card from whatever badges/league/channel it could
//                          resolve, instead of a bare centred-text tile.
app.get(['/img/match', '/:config/img/match'], async (req, res) => {
  const qs = (v) => (typeof v === 'string' ? v.trim() : '');
  const query = req.query || {};
  const shape = qs(query.shape) === 'poster' ? 'poster' : 'landscape';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

  const memoKey = [
    qs(query.cat), qs(query.title), qs(query.t1), qs(query.t2), qs(query.b1), qs(query.b2),
    qs(query.lg), qs(query.lb), qs(query.ch), qs(query.cb), qs(query.cm),
    qs(query.st), qs(query.tm), shape
  ].join('|');

  const cached = matchCardMemo.get(memoKey);
  if (cached) {
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    return res.send(cached);
  }

  // Resolve each badge reference. We still fetch through the shared cache so a
  // dead crest is omitted (rather than drawn as an empty plate), but the card
  // only ever references it as a URL — never a base64 data URI — to stay inside
  // the Stremio poster size budget.
  const asUrl = async (raw) => {
    const v = qs(raw);
    if (!v) return null;
    const entry = await imageService.getImage(v);
    if (!entry) return null;
    return `${BASE_URL}/img/badge?url=${encodeURIComponent(v)}`;
  };

  const [badge1, badge2, leagueBadge, channelBadge] = await Promise.all([
    asUrl(query.b1),
    asUrl(query.b2),
    asUrl(query.lb),
    asUrl(query.cb)
  ]);

  // A channel logo promoted to the hero slot (24/7 stations).
  const channelMark = await asUrl(query.cm);

  const svg = imageService.generateMatchCardSvg({
    category: qs(query.cat),
    title: qs(query.title),
    team1: qs(query.t1),
    team2: qs(query.t2),
    badge1,
    badge2,
    leagueBadge,
    channelBadge,
    channelMark,
    league: qs(query.lg),
    channel: qs(query.ch),
    status: qs(query.st),
    time: qs(query.tm),
    shape
  });

  if (matchCardMemo.size >= MATCH_CARD_MEMO_MAX) matchCardMemo.clear();
  matchCardMemo.set(memoKey, svg);

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.send(svg);
});

// /img/badge?url=...     → a single cached crest as real binary, so composed
//                          cards stay under the Stremio poster size budget.
app.get(['/img/badge', '/:config/img/badge'], async (req, res) => {
  const raw = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (!raw) {
    res.status(400).end();
    return;
  }

  const entry = await imageService.getImage(raw);
  if (!entry) {
    // Transparent 1x1 PNG so a dead crest never shows a broken-image glyph.
    const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.send(px);
  }

  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.send(entry.buffer);
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
app.use(require('./routes/streamProxy'));
app.use(require('./routes/manifest'));
app.use(require('./routes/embed'));
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

app.use(require('./routes/watch'));
app.use(require('./routes/health'));
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



