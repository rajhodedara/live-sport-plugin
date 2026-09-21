/**
 * routes/watch.js - /watch embed player page
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const express = require('express');
const router = express.Router();

// ─── /watch — Embed Proxy Page ────────────────────────────────────────────────

// When the user clicks a stream, Nuvio opens this URL in the browser.
// It serves a clean full-screen HTML page that wraps the embed in an iframe,
// bypassing the referrer/origin restrictions that the raw embed.st URLs have.
//
// Query params:
//   ?url=<encoded embed URL>     the stream embed to display
//   ?title=<encoded match title> shown in the page heading

router.get('/watch', (req, res) => {
  // If request contains a YouTube URL or video ID, directly redirect to YouTube (skip /watch iframe)
  const candidateUrl = req.query.url || req.query.embed || req.query.v || req.query.ytId || '';
  if (/youtube\.com|youtu\.be/i.test(candidateUrl) || req.query.ytId || req.query.v) {
    let ytTarget = candidateUrl;
    const match = candidateUrl.match(/(?:embed\/|watch\?v=|\/v\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    const videoId = (match && match[1]) || req.query.ytId || req.query.v;
    if (videoId) {
      ytTarget = `https://www.youtube.com/watch?v=${videoId}`;
    }
    return res.redirect(ytTarget);
  }

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
          // Live-window reality: these providers publish ~4 segments (~15 s) per
          // playlist. lowLatencyMode is a no-op (no EXT-X-PART) and only tightens
          // targets, so it is dropped. Syncing 2 segments back leaves ~2 segments
          // of slack inside a 4-segment window, and the max-latency ceiling (3)
          // stays below the window instead of being unreachable at 5.
          const hls = new Hls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 3 });
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
    // If originalUrl contains youtube, redirect immediately
    const origMatch = req.originalUrl && req.originalUrl.match(/(?:youtube\.com|youtu\.be)[^\s&"']+/i);
    if (origMatch) {
      return res.redirect('https://' + origMatch[0].replace(/^https?:\/\//, ''));
    }
    return res.status(400).send(`
      <!DOCTYPE html><html><body style="background:#111;color:#eee;font-family:sans-serif;text-align:center;padding-top:60px;">
        <h2>No Stream URL Provided</h2>
        <p>This stream link was opened without a valid ?url parameter.</p>
        <p><a href="/" style="color:#f44;text-decoration:none;">Return to Nuvio</a></p>
      </body></html>
    `);
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

  // Never embed YouTube in an iframe — redirect directly to YouTube
  if (/youtube\.com|youtu\.be/i.test(safeUrl)) {
    return res.redirect(safeUrl);
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
          startHls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 3,
                     enableWorker: false,
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
          startHls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 3,
                     enableWorker: false });
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


module.exports = router;
