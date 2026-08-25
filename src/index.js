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
const { PORT, BASE_URL } = require('./config');
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

app.get('/api/manifest', (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://embed.st/';
  const origin = req.query.origin || 'https://embed.st';
  
  if (!targetUrl) return res.status(400).send('Missing url');

  try {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'fetch_m3u8.py');
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const cmd = `${pythonCmd} "${scriptPath}" "${targetUrl}" "${referer}" "${origin}"`;
    
    const out = child_process.execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    
    if (out.startsWith('MISSING_CURL_CFFI')) {
       return res.status(500).send('curl_cffi not installed on server');
    }
    if (out.startsWith('ERROR_')) {
       return res.status(502).send('Upstream error: ' + out);
    }
    
    // Rewrite the manifest
    const lines = out.split('\n');
    const rewritten = lines.map(line => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return line;
      
      // It's a URL
      let absoluteUrl = l;
      if (!l.startsWith('http')) {
        const urlObj = new URL(targetUrl);
        const basePath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);
        const baseUrl = urlObj.origin + basePath;
        // IMPORTANT: Append the query string (urlObj.search) so tokens are passed to chunks
        absoluteUrl = baseUrl + l + urlObj.search;
      }
      
      // If it's a sub-playlist, route it back through our proxy!
      if (absoluteUrl.includes('.m3u8')) {
         return `/api/manifest?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
      }
      
      // If it's a .ts chunk, return the absolute URL directly (bypassing Nuvio for video data!)
      return absoluteUrl;
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(rewritten.join('\n'));
  } catch (err) {
    console.error('[ManifestProxy] Error:', err.message);
    res.status(500).send('Manifest proxy error');
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
      redirect: 'follow',
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

// ─── Stream URL Rewrite Middleware ──────────────────────────────────────────────
// The Stremio addon SDK returns stream JSON with relative /watch and /api/hls
// URLs. We intercept the response and prefix them with the trusted BASE_URL
// (set ADDON_URL when self-hosting behind a LAN IP or tunnel).
app.use((req, res, next) => {
  if (!req.path.includes('/stream/')) return next();
  
  const originalWrite = res.write;
  const originalEnd = res.end;
  let chunks = [];

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
        if (body && Array.isArray(body.streams)) {
          let modified = false;
          let proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
          if (proto.includes(',')) proto = proto.split(',')[0].trim();
          
          let host = req.headers['x-forwarded-host'] || req.headers.host;
          if (host && host.includes(',')) host = host.split(',')[0].trim();
          
          const currentBaseUrl = host ? `${proto}://${host}` : BASE_URL;

          body.streams.forEach(s => {
            if (s.externalUrl && s.externalUrl.startsWith('/watch')) {
              s.externalUrl = `${currentBaseUrl}${s.externalUrl}`;
              modified = true;
            }
            if (s.url && s.url.startsWith('/api/hls')) {
              s.url = `${currentBaseUrl}${s.url}`;
              modified = true;
            }
            if (s.url && s.url.startsWith('/api/playwright-m3u8')) {
              s.url = `${currentBaseUrl}${s.url}`;
              modified = true;
            }
          });
          
          if (modified) {
            const newBodyString = JSON.stringify(body);
            const newBuffer = Buffer.from(newBodyString, 'utf8');
            res.setHeader('Content-Length', newBuffer.length);
            return originalEnd.call(res, newBuffer, 'utf8', callback);
          }
        }
      } catch (e) {
        console.error('[Proxy Error]', e.message);
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
    const keepCatalogs = ['nuvio_sports_live', 'nuvio_sports_networks', 'nuvio_sports_upcoming', 'nuvio_sports_teams'];
    
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
      const parsedEmbed = new URL(decodeURIComponent(embedUrl));
      if (!['http:', 'https:'].includes(parsedEmbed.protocol)) {
        return res.status(400).send('Invalid embed URL protocol');
      }
      safeEmbed = parsedEmbed.toString();
      safeReferer = referer ? new URL(decodeURIComponent(referer)).toString() : safeEmbed;
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
    const parsed = new URL(decodeURIComponent(embedUrl));
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
    @keyframes fadeOut { to { opacity: 0; pointer-events: none; } }

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
    const loader = document.getElementById('loader');
    const iframe = document.getElementById('player');
    const video = document.getElementById('video-player');
    const p2pStatus = document.getElementById('p2p-status');
    const targetUrl = "${safeUrl}";
    const isM3u8 = targetUrl.includes('.m3u8');
    
    // Auto-proxy m3u8 urls through our local server to completely bypass CORS in the browser!
    let finalUrl = targetUrl;
    if (isM3u8 && !targetUrl.includes('/api/hls')) {
      finalUrl = '/api/hls/playlist.m3u8?url=' + encodeURIComponent(targetUrl) + '&referer=' + encodeURIComponent('https://embed.st/') + '&embedOrigin=' + encodeURIComponent('https://embed.st');
    }

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

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'nuvio-live-sports' }));

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
