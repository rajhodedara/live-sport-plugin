const container = require('./container');
const ChannelCountryService = require('./services/ChannelCountryService');
const { withRetry, isTransientStatus, isTransientError } = require('./services/retry');
const { rewriteHlsUri } = require('./services/HlsRewriteService');
const { parseLanguagePriority, compareStreams } = require('./services/LanguagePriorityService');
const { BASE_URL } = require('./config');
const { performance } = require('perf_hooks');

// Source selection (shared by handleStream and prewarmMatch)
function detectChannelCountry(channelName) {
  return ChannelCountryService.detectChannelCountry(channelName);
}

function isEventStreamSource(src) {
  if (!src) return false;
  if (src.source === 'daddylive') {
    const name = (src.channelName || src.channel_name || '').trim();
    return /^event\s*[-_]?\s*(sd\s*[-_]?\s*)?stream/i.test(name) ||
           /^event\s*[-_]?\s*sd\b/i.test(name) ||
           /\bevent\s*(sd\s*)?stream\b/i.test(name);
  }
  return false;
}

function selectSources(matchSources, config) {
  const cleanSources = (matchSources || []).filter(src => !isEventStreamSource(src));
  const SOURCE_PRIORITY = { admin: 1, echo: 1, golf: 1, delta: 1, 'ppvst': 1, 'daddylive': 2, 'replayzone': 2, 'livetv': 2, 'watchfooty': 2, 'damitv': 3, 'cdnlive': 3, 'streamsports99': 4, 'timstreams': 9, 'streamsports': 13, 'embedindia': 5, 'embedst': 5, 'streamedpk': 5 };
  const sortedSources = [...cleanSources].sort((a, b) => {
    // Unknown sources that are not known fallback providers are likely new
    // Streamed.pk sources - priority 1.5 keeps them near the top.
    const getPriority = (src) => SOURCE_PRIORITY[src] ?? (['daddylive', 'watchfooty', 'cdnlive', 'streamsports99', 'timstreams', 'streamsports', 'replayzone', 'livetv', 'embedindia', 'embedst', 'streamedpk'].includes(src) ? 99 : 1.5);
    const pa = getPriority(a.source);
    const pb = getPriority(b.source);
    if (pa !== pb) return pa - pb;
    return 0;
  });

  if (config && typeof config.sources === 'string' && config.sources !== 'none') {
    const enabled = config.sources.split(',');
    // embedindia / embedst / streamedpk are the same embed chain — all three are
    // controlled by the single 'streamedpk' toggle on the configure page.
    const KNOWN_FALLBACKS = ['ppvst', 'daddylive', 'watchfooty', 'cdnlive', 'streamsports99', 'timstreams', 'streamsports', 'embedindia', 'embedst', 'streamedpk', 'replayzone', 'livetv', 'damitv'];
    return sortedSources.filter(src => {
      if (src.source.startsWith('yaml_')) return true;
      const isFallback = KNOWN_FALLBACKS.includes(src.source);
      if (!isFallback) return false;
      // embedindia and embedst are gated by the 'streamedpk' checkbox
      if (src.source === 'embedindia' || src.source === 'embedst') return enabled.includes('streamedpk');
      return enabled.includes(src.source);
    });
  }

  // Default path (no config in URL) — allow all known active providers
  const KNOWN_FALLBACKS = ['ppvst', 'daddylive', 'watchfooty', 'cdnlive', 'streamsports99', 'timstreams', 'streamsports', 'embedindia', 'embedst', 'streamedpk', 'replayzone', 'livetv', 'damitv'];
  return sortedSources.filter(src => {
    if (src.source.startsWith('yaml_')) return true;
    return KNOWN_FALLBACKS.includes(src.source);
  });
}

// Ask one provider for its streams. Extracted from resolveSource so the whole
// dispatch can be retried as a unit without duplicating the chain.
async function dispatchToProvider(sourceName, src, match) {
  let resStreams = [];

  if (sourceName === 'timstreams') {
    const provider = container.resolve('timStreamsProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title);
  } else if (sourceName === 'damitv') {
    const provider = container.resolve('damiTvProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'watchfooty') {
    const provider = container.resolve('watchFootyProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title);
  } else if (sourceName === 'cdnlive') {
    const provider = container.resolve('cdnLiveProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title);
  } else if (sourceName === 'streamsports99') {
    const provider = container.resolve('streamSports99Provider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title);
  } else if (sourceName === 'embedindia') {
    const provider = container.resolve('embedIndiaProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'embedst') {
    const provider = container.resolve('embedStProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'streamedpk') {
    const provider = container.resolve('streamedPkProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'replayzone') {
    const provider = container.resolve('replayzoneProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'livetv') {
    const provider = container.resolve('liveTvProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'daddylive') {
    const provider = container.resolve('daddyLiveProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'ppvst') {
    const provider = container.resolve('ppvStProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName.startsWith('yaml_')) {
    const yamlProviders = container.resolve('yamlProviders');
    const pName = sourceName.replace('yaml_', '');
    const provider = yamlProviders.find(p => p.name === pName);
    if (provider) {
      resStreams = await provider.resolveStream(src.id, match.category, match.title);
    }
  } else {
    // Unknown or unsupported source, ignore
    resStreams = [];
  }

  return resStreams;
}

// How hard to try a provider before giving up on this source for the mint.
// Providers do multi-hop network work (embed page -> extractor -> CDN), so a
// single reset or edge timeout is common and is not evidence the source is
// dead; but the budget stays small because handleStream is racing a deadline
// and a slow source simply lands in the resolve cache for the next request.
const RESOLVE_ATTEMPTS = Number(process.env.RESOLVE_ATTEMPTS || 2);
const RESOLVE_TOTAL_BUDGET_MS = Number(process.env.RESOLVE_TOTAL_BUDGET_MS || 12000);

// Resolve a single source (extracted from handleStream, logic unchanged)
async function resolveSource(src, match, config) {
  if (isEventStreamSource(src)) {
    return [];
  }
  const streamScorer = container.resolve('streamScorer');
  const sourceName = src.source;
  let resStreams = [];

  try {
    const deadlineAt = Date.now() + RESOLVE_TOTAL_BUDGET_MS;
    resStreams = await withRetry(() => dispatchToProvider(sourceName, src, match), {
      attempts: RESOLVE_ATTEMPTS,
      baseDelayMs: 300,
      maxDelayMs: 1200,
      deadlineAt,
      label: `resolve:${sourceName}`,
      // An empty result is a real answer ("nothing on offer"), not a failure —
      // retrying it would spend the budget to be told the same thing twice.
      onRetry: ({ attempt, delay, error }) =>
        console.warn(`[streams.js] ${sourceName}/${src.id} transient on attempt ${attempt} (${error.message}); retrying in ${delay}ms`),
    }) || [];

    for (const s of resStreams) {
      s.score = streamScorer.calculateScore(s, sourceName);
      s._source = sourceName;
    }
  } catch (e) {
    // Distinguish "the network flaked and kept flaking" from "this provider is
    // broken": the first is expected noise, the second wants a stack trace.
    if (isTransientError(e)) {
      console.warn(`[streams.js] ${sourceName}/${src.id} unreachable after ${RESOLVE_ATTEMPTS} attempt(s): ${e.message}`);
    } else {
      console.error(`[streams.js] ${sourceName}/${src.id} failed to resolve:`, e && e.stack ? e.stack : e);
    }
  }

  return resStreams;
}

// Safe impit+undici helper — works on all platforms (Windows, Linux x64/ARM64, musl).
// impit is tried first for browser TLS fingerprinting; undici is the automatic fallback.
const { safeFetch: _safeFetch } = require('./impitClient');

// How long one verification ping may take, and how long all its retries may
// take together. The total stays under handleStream's soft deadline so a
// retrying verification can still make it into the first response.
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 5000);
const VERIFY_TOTAL_BUDGET_MS = Number(process.env.VERIFY_TOTAL_BUDGET_MS || 9000);
const VERIFY_ATTEMPTS = Number(process.env.VERIFY_ATTEMPTS || 3);

// Speed probe: one ranged segment fetch per stream, used to derive speedScore.
// The range must be large enough that transfer time dominates TTFB, otherwise
// the measured rate just reflects latency instead of throughput.
const SPEED_PROBE_TIMEOUT_MS = Number(process.env.SPEED_PROBE_TIMEOUT_MS || 5000);
const SPEED_PROBE_RANGE_BYTES = Number(process.env.SPEED_PROBE_RANGE_BYTES || 524288);
const ENABLE_SPEED_PROBE = process.env.ENABLE_SPEED_PROBE !== 'false';

// Proxied /api/manifest URLs wrap an upstream token that expires on its own
// schedule. Tag the URL with the resolve-cache key that produced it so the
// manifest proxy can evict that entry the moment upstream reports it dead,
// forcing the next click to re-mint a fresh token instead of serving a stale
// URL for the remainder of the TTL. Absent/!manifest URLs pass through untouched.
function withResolveKey(url, cacheKey) {
  if (!url || !cacheKey || typeof url !== 'string') return url;
  if (!url.includes('/api/manifest?')) return url;
  if (/[?&]rck=/.test(url)) return url;
  return url + '&rck=' + encodeURIComponent(cacheKey);
}

// ─── Speed scoring ───────────────────────────────────────────────────────────

function parseManifestProxyUrl(rawUrl) {
  try {
    const urlObj = new URL(rawUrl, 'http://localhost');
    if (!urlObj.pathname.includes('/api/manifest')) return null;
    return {
      targetUrl: urlObj.searchParams.get('url') || rawUrl,
      referer: urlObj.searchParams.get('referer') || '',
      origin: urlObj.searchParams.get('origin') || '',
    };
  } catch (_) {
    return null;
  }
}

// Build the exact URL the player would fetch for this segment, so the probe
// measures the real playback path (CF worker / hlschunk / direct) and not a
// shortcut that bypasses it.
function buildPlayerSegmentUrl(segmentUri, manifestUrl, referer, origin) {
  return rewriteHlsUri(segmentUri, manifestUrl, { referer, origin, absoluteAddonBaseUrl: BASE_URL });
}

/**
 * Total object size from a Content-Range header ("bytes 0-65535/4084906").
 * Returns null when absent — a partial byte count cannot yield a valid
 * implied bitrate, so callers must skip scoring in that case.
 */
function getContentRangeTotal(headers) {
  try {
    const raw = headers && typeof headers.get === 'function' ? headers.get('content-range') : null;
    const match = raw && raw.match(/\/(\d+)$/);
    return match ? Number(match[1]) : null;
  } catch (_) {
    return null;
  }
}

/**
 * 0-100 speed score blending throughput headroom (75%) with latency (25%).
 * headroom = implied bitrate / measured download rate: 1.0 means the link can
 * only just sustain realtime playback, so >=2 is comfortable.
 */
function calculateSpeedScore({ segmentTtfbMs, measuredDownloadRate, impliedBitrate }) {
  if (!measuredDownloadRate || !impliedBitrate) return null;
  const headroom = impliedBitrate / measuredDownloadRate;
  const throughputScore = Math.max(0, Math.min(100, Math.round((1 / Math.max(headroom, 0.01)) * 35 + 35)));
  const latencyScore = Math.max(0, Math.min(100, Math.round(100 - (segmentTtfbMs / 25))));
  return Math.max(0, Math.min(100, Math.round((throughputScore * 0.75) + (latencyScore * 0.25))));
}

/**
 * Best-effort probe of one segment. Never throws and never drops the stream:
 * a missing/slow/failed probe just leaves speedScore unset.
 *
 * deadlineAt is the shared verify deadline, so the probe cannot extend the
 * whole verification with a fresh timeout tail of its own.
 */
async function measureStreamSpeed(stream, manifestUrl, manifestText, referer, origin, m3u8Parser, deadlineAt) {
  try {
    const timeLeft = deadlineAt ? deadlineAt - Date.now() : SPEED_PROBE_TIMEOUT_MS;
    if (timeLeft < 250) return;

    const info = m3u8Parser && typeof m3u8Parser.parseMediaPlaylistInfo === 'function'
      ? m3u8Parser.parseMediaPlaylistInfo(manifestText)
      : null;

    if (info && info.targetDuration) {
      stream.targetDuration = info.targetDuration;
    }
    if (!info || !info.firstSegmentUri || !info.firstSegmentDuration) return;

    const segmentUrl = buildPlayerSegmentUrl(info.firstSegmentUri, manifestUrl, referer, origin);
    const controller = new AbortController();
    const probeTimeoutMs = Math.max(1, Math.min(SPEED_PROBE_TIMEOUT_MS, timeLeft - 150));
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    const probeHeaders = {
      'Range': `bytes=0-${Math.max(0, SPEED_PROBE_RANGE_BYTES - 1)}`,
    };
    if (referer) probeHeaders['Referer'] = referer;
    if (origin) probeHeaders['Origin'] = origin;

    try {
      const start = performance.now();
      const response = await withRetry(
        () => fetch(segmentUrl, { signal: controller.signal, headers: probeHeaders }),
        {
          attempts: 1,
          deadlineAt,
          label: 'speed-probe',
        }
      );
      const headersAt = performance.now();
      if (!response || !response.ok) return;
      let bytes = 0;
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        try {
          const { value } = await reader.read();
          if (value) bytes = value.byteLength;
        } finally {
          reader.cancel().catch(() => {});
          controller.abort();
        }
      } else {
        const buf = await response.arrayBuffer();
        bytes = buf.byteLength;
      }
      const end = performance.now();
      const segmentBytes = getContentRangeTotal(response.headers) || bytes;
      if (!segmentBytes || bytes === 0) return;
      // Exclude TTFB from the rate denominator: with a small ranged read the
      // body lands almost instantly, so including connect+first-byte latency
      // would make the "rate" a latency measurement and understate fast links.
      const transferSeconds = Math.max((end - headersAt) / 1000, 0.001);
      const measuredDownloadRate = (bytes * 8) / transferSeconds;
      const impliedBitrate = (segmentBytes * 8) / info.firstSegmentDuration;
      const speedScore = calculateSpeedScore({
        segmentTtfbMs: headersAt - start,
        measuredDownloadRate,
        impliedBitrate,
      });

      if (speedScore === null) return;
      stream.speedScore = speedScore;
      stream.segmentTtfbMs = Math.round(headersAt - start);
      stream.downloadMbps = Math.round((measuredDownloadRate / 1000000) * 10) / 10;
      stream.targetDuration = info.targetDuration || stream.targetDuration || null;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.log(`[SpeedProbe] Skipped stream timing: ${err.message}`);
  }
}

function getSpeedLabel(speedScore) {
  if (typeof speedScore !== 'number') return null;
  if (speedScore >= 75) return 'Fast';
  if (speedScore >= 45) return 'Average';
  return 'Slow';
}


// --- Stream Health Verification ---
// Pings each direct stream once and drops dead ones (404/403/5xx, or 200 bodies
// that are not M3U8). Web player links (no url or '/watch?') pass through
// untouched. Runs once per mint (see mintVerifiedSources), not per request, so
// cached results are served without re-verification.

// Registry of iframe/terminal hosts -> the Referer that makes them serve. It is
// advisory: verification must keep working with the hard-coded chain below, so
// every failure mode of this lookup resolves to null.
let _iframeDomainRegistry;
function getIframeDomainRegistry() {
  if (_iframeDomainRegistry !== undefined) return _iframeDomainRegistry;
  try {
    _iframeDomainRegistry = container.resolve('iframeDomainRegistry') || null;
  } catch (_) {
    _iframeDomainRegistry = null;
  }
  return _iframeDomainRegistry;
}

/**
 * Referer to retry a refused request with, derived from the host of the
 * upstream (terminal) URL. Two sources, in order of authority:
 *   1. the iframe-domain registry — it records which page actually serves a
 *      given terminal host, learned from live traffic and the committed data
 *      file, so it also covers hosts added after this code was written;
 *   2. the host-regex chain — hard-coded knowledge for hosts the registry has
 *      never seen.
 */
function repairRefererFor(targetUrl) {
  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch (_) {
    return 'https://sportsembed.su/';
  }
  if (!host) return 'https://sportsembed.su/';

  try {
    const registry = getIframeDomainRegistry();
    // knowsTerminalHost() first: refererFor() answers a generic self-origin for
    // anything it has never seen, which is indistinguishable from knowledge.
    if (registry && registry.knowsTerminalHost(host)) {
      const known = registry.terminalRefererFor(host);
      if (known) return known;
    }
  } catch (_) { /* fall through to the hard-coded chain */ }

  if (/\.wfty\.st$/.test(host) || /watchfooty/i.test(host)) return 'https://sportsembed.su/';
  if (/\.strmd\.st$/.test(host) || /streamed/i.test(host)) return 'https://embed.st/';
  if (/tiestep|dlive|dlstreams|daddylive|assetrage|romponalis/i.test(host) || /\.7odxv0l067ka\.net$/.test(host)) return 'https://assetrage.net/';
  // Terminal hosts discovered by the DaddyLive iframe-domain audit. These
  // are the endpoints the embed decoders actually point at, so the
  // referer must be the page that served the manifest, not a generic
  // origin. Verified live: each returns #EXTM3U with the matching referer.
  if (/dynproclaim\.net$/.test(host)) return `https://${host}/`;
  if (/hockey\.do$/.test(host)) return 'https://play.matchli.st/';
  // streame.center rotates its edge nodes (edgestream2/5/7.pro all
  // observed live), so match the family, not one numbered host.
  if (/edgestream[0-9]*\.pro$/.test(host)) return 'https://streame.center/';
  if (/\.a737cozfwjmm\.net$/.test(host)) return 'https://assetrage.net/';
  return `https://${host}/`;
}

async function verifyStreams(streams, cacheKey, m3u8Parser, resolveCache) {

  const checkedStreams = await Promise.all(streams.map(async (s) => {
    // We only pre-flight check direct streams (m3u8 urls). Web player links or direct VODs are kept blindly.
    if (!s.url || s.url.includes('/watch?') || s.url.includes('.mp4') || s.url.includes('pixeldrain.com') || s.url.includes('okcdn.ru') || (s.behaviorHints && s.behaviorHints.notWebReady === false)) return s;

    let targetUrl = s.url;
    let referer = '';
    let origin = '';
    // If the stream is routed through our manifest proxy, we extract the true upstream URL to ping
    if (targetUrl.includes('/api/manifest')) {
      const proxyInfo = parseManifestProxyUrl(targetUrl);
      if (proxyInfo) {
        targetUrl = proxyInfo.targetUrl;
        referer = proxyInfo.referer;
        origin = proxyInfo.origin;
      }
    }

    try {
      if (!referer && s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) {
        referer = s.behaviorHints.proxyHeaders.request.Referer || '';
      }
      if (!origin && referer) {
        try { origin = new URL(referer).origin; } catch (_) {}
      }

      let res;
      let bodySample = '';

      const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': referer
      };
      if (origin) reqHeaders['Origin'] = origin;

      // A verification ping is one sample of a flaky path: a CDN edge mid-
      // rotation, a reset socket, a 503 under load. Believing that single
      // sample used to drop a stream that plays perfectly well, and then
      // negative-cache it. Retry the transient answers, within a budget that
      // keeps the whole verification inside handleStream's soft deadline.
      const verifyDeadlineAt = Date.now() + VERIFY_TOTAL_BUDGET_MS;
      try {
        const result = await withRetry(
          async () => {
            // A fresh controller per attempt: a controller that already fired
            // aborts the retry the moment it starts.
            const attemptController = new AbortController();
            const attemptTimer = setTimeout(() => attemptController.abort(), VERIFY_TIMEOUT_MS);
            try {
              // _safeFetch handles impit -> undici fallback automatically on all platforms.
              // attempts:1 — retrying is this layer's job, so the two do not compound
              // into a multi-minute stall.
              const r = await _safeFetch(targetUrl, {
                method: 'GET',
                headers: reqHeaders,
                signal: attemptController.signal,
                timeoutMs: VERIFY_TIMEOUT_MS,
                attempts: 1,
              });
              return { status: r.status, body: await r.text() };
            } finally {
              clearTimeout(attemptTimer);
            }
          },
          {
            attempts: VERIFY_ATTEMPTS,
            deadlineAt: verifyDeadlineAt,
            label: 'verify',
            shouldRetryResult: (r) => isTransientStatus(r.status),
            onRetry: ({ attempt, delay, result, error }) => {
              const why = error ? error.message : `HTTP ${result.status}`;
              console.log(`[Filter] transient ${why} on attempt ${attempt}, retrying in ${delay}ms: ${targetUrl}`);
            },
          }
        );
        res = { status: result.status };
        bodySample = result.body;
      } catch (fetchErr) {
        const kind = isTransientError(fetchErr) ? 'unreachable after retries' : 'hard error';
        console.log(`[Filter] Dropped stream (${kind}): ${targetUrl} - ${fetchErr.message}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // ── Retry-once safety net ───────────────────────────────────────────
      // Two upstream behaviours answer 403/401 to an otherwise healthy stream,
      // and both are repaired by a Referer:
      //   - some CDNs (notably WatchFooty's wfty.st edge) refuse when the
      //     Referer is MISSING;
      //   - DaddyLive's segment CDN refuses when the Referer is PRESENT but
      //     from the wrong family: the iframe that happened to serve the
      //     manifest is not on its allow-list. DaddyLive always populates a
      //     Referer, so gating the repair on `!referer` never repaired that
      //     case and dropped a working stream as dead.
      // The candidate therefore comes from the TERMINAL host of the upstream
      // URL (registry first, host-regex chain second) and is tried at most
      // ONCE — no loop, so a stream that is truly dead costs one extra ping.
      if (res.status === 403 || res.status === 401) {
        try {
          const guess = repairRefererFor(targetUrl);
          // Re-sending the very Referer upstream just refused would only double
          // the latency of a stream that genuinely refuses this client.
          if (guess && guess !== referer) {
            console.log(`[Filter] ${res.status} with ${referer ? `refused referer ${referer}` : 'no referer'}; retrying once with ${guess}`);
            const r2 = await _safeFetch(targetUrl, {
              method: 'GET',
              headers: {
                'User-Agent': reqHeaders['User-Agent'],
                'Referer': guess,
                'Origin': guess.replace(/\/$/, ''),
              },
              timeoutMs: VERIFY_TIMEOUT_MS,
              attempts: 1,
            });
            res = { status: r2.status };
            bodySample = await r2.text();
            if (res.status === 200) referer = guess; // so a later noteFailure/keep decision is accurate
          }
        } catch (_) { /* fall through to the dead-stream handling below */ }
      }

      // Edge servers return 404 for dead streams, 403 for IP-locked/expired tokens, 502 for upstream failures
      if (res.status === 404 || res.status === 403 || res.status >= 500) {
        // A 403 that persisted through the repair attempt, with a referer still
        // attached, is a genuine refusal.
        // A 403 with no referer available at all is not proof of a dead stream,
        // so keep it and let the client try (failing over costs less than
        // silently discarding a working source).
        if (res.status === 403 && !referer) {
          console.log(`[Filter] Keeping stream despite 403 (no referer available): ${targetUrl}`);
          return s;
        }
        console.log(`[Filter] Dropped dead stream (${res.status}): ${targetUrl}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Some CDNs (like lb8.strmd.st) return 200 OK with "Not found" when token is expired.
      // If it doesn't contain #EXT, it's not a valid m3u8 playlist.
      if (!bodySample.includes('#EXT')) {
        console.log(`[Filter] Dropped fake 200 stream (Invalid M3U8 body): ${targetUrl}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Parse Master Playlist quality, framerate (FPS), and bitrate in real-time
      const parsedQuality = m3u8Parser.parseManifestText(bodySample);
      if (parsedQuality) {
        if (parsedQuality.qualityTag) s.quality = parsedQuality.qualityTag;
        if (parsedQuality.resolution) s.resolution = parsedQuality.resolution;
        if (parsedQuality.bitrateTag) s.bitrate = parsedQuality.bitrateTag;
      }

      if (ENABLE_SPEED_PROBE) {
        await measureStreamSpeed(s, targetUrl, bodySample, referer, origin, m3u8Parser, verifyDeadlineAt);
      }

      if (cacheKey) resolveCache.noteSuccess(cacheKey);
      return s;
    } catch (err) {
      console.log(`[Filter] Dropped timeout/error stream: ${targetUrl} - ${err.message}`);
      return null;
    }
  }));

  return checkedStreams.filter(Boolean);
}

// Mint streams for a single source and health-verify them before they enter the
// cache, so verification runs once per mint instead of on every request.
async function mintVerifiedSources(src, match, config, cacheKey, opts = {}) {
  const resolveCache = container.resolve('streamResolveCache');
  const m3u8Parser = container.resolve('m3u8Parser');
  const minted = await resolveSource(src, match, config);
  return verifyStreams(minted, cacheKey, m3u8Parser, resolveCache, opts);
}

// Prewarm: mint tokens for a match's top sources before the user clicks
// Prewarm all sources by default. This used to default to 3, which meant only the
// first three providers were minted up-front and the rest (WatchFooty is commonly
// 4th in priority order) were minted while the user was already waiting on the
// click. Callers can still pass an explicit smaller number if they ever want to
// cap it, but the safe default is "everything".
async function prewarmMatch(match, config, topN = Number.MAX_SAFE_INTEGER, opts = { skipSpeedProbe: true }) {
  try {
    if (!match || !match.sources || !match.sources.length) return;
    const resolveCache = container.resolve('streamResolveCache');
    const activeSources = selectSources(match.sources, config || null);
    const targets = activeSources.slice(0, topN);
    if (targets.length === 0) return;
    console.log(`[Prewarm] minting ${targets.length} sources for ${match.id}`);
    await Promise.allSettled(targets.map(src => {
      const key = `${src.source}:${match.id}:${src.id}`;
      if (resolveCache.get(key)) return Promise.resolve(null);
      return resolveCache.getOrCreate(key, () => mintVerifiedSources(src, match, config || null, key, opts));
    }));
  } catch (err) {
    console.warn('[Prewarm] failed:', err.message);
  }
}


async function handleStream(type, id, config) {
  if ((type !== 'tv' && type !== 'series' && type !== 'channel') || !id.startsWith('nuvio_sport_')) {
    return { streams: [] };
  }

  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  let rawId = id.replace('nuvio_sport_', '');
  let episodeIndex = null;
  let isHubEpisode = false;
  if (rawId.includes(':')) {
    const parts = rawId.split(':');
    rawId = parts[0];
    if (parts[1] && parts[1].startsWith('hub_')) {
      isHubEpisode = true;
    }
    episodeIndex = parseInt(parts[2], 10);
  }
  const matchId = rawId;

  if (!matchId) return { streams: [] };
  const match = matches.find(m => m.id === matchId);

  if (!match || !match.sources || match.sources.length === 0) {
    return { streams: [] };
  }

  const streams = [];

  let candidateSources = match.sources;
  if (!isHubEpisode && episodeIndex && !isNaN(episodeIndex) && episodeIndex > 0) {
    const isMultiPart = match.sources.some(s => s.name && /(part|half|period)\s*\d+/i.test(s.name));
    if (isMultiPart) {
      const cleanSources = match.sources.filter(s => s && s.url && !s.source?.includes('timstreams'));
      if (cleanSources[episodeIndex - 1]) {
        candidateSources = [cleanSources[episodeIndex - 1]];
      }
    }
  }

  const activeSources = selectSources(candidateSources, config);
  const streamScorer = container.resolve('streamScorer');

  const resolveCache = container.resolve('streamResolveCache');

  // ─── Concurrent resolution with a bounded, time-boxed wait ──────────────
  // Kicked off together, so the cost is the SLOWEST source rather than the SUM.
  // Returns as soon as usable streams exist, bounded by a soft deadline;
  // anything still running keeps going and lands in the resolve cache for the
  // next request. Previously every source had to settle before anything was
  // returned, so one slow provider (WatchFooty's embed chain: ~56s/variant)
  // stalled the whole response.
  const SOFT_DEADLINE_MS = Number(process.env.STREAM_SOFT_DEADLINE_MS || 6000);
  const HARD_DEADLINE_MS = Number(process.env.STREAM_HARD_DEADLINE_MS || 15000);

  const inFlight = [];        // { key, promise } for the fallback wait
  const races = activeSources.map((src) => {
    const key = `${src.source}:${matchId}:${src.id}`;
    const promise = resolveCache
      .getOrCreate(key, () => mintVerifiedSources(src, match, config, key))
      .then((minted) => (Array.isArray(minted) ? minted.map((st) => ({ ...st, _cacheKey: key })) : []))
      .catch(() => []);
    inFlight.push({ key, promise });
    // Wrap so we can tell "settled in time" from "still running".
    return Promise.race([
      promise.then((value) => ({ late: false, value })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ late: true, value: [] }), SOFT_DEADLINE_MS)
      ),
    ]);
  });

  const raced = await Promise.allSettled(races);
  let lateCount = 0;
  for (const r of raced) {
    if (r.status !== 'fulfilled') continue;
    if (r.value.late) { lateCount++; continue; }
    if (Array.isArray(r.value.value)) streams.push(...r.value.value);
  }

  // Never return an empty list merely because we were impatient: if nothing
  // usable arrived in time, wait for the remainder up to the hard ceiling.
  if (streams.length === 0 && inFlight.length > 0) {
    const remaining = Math.max(0, HARD_DEADLINE_MS - SOFT_DEADLINE_MS);
    await Promise.race([
      Promise.allSettled(inFlight.map((f) => f.promise)),
      new Promise((r) => setTimeout(r, remaining)),
    ]);
    for (const f of inFlight) {
      // Attach a handler first so a late rejection can never be unhandled.
      const v = await f.promise.catch(() => null);
      if (Array.isArray(v)) streams.push(...v);
    }
    lateCount = 0;
  } else if (lateCount > 0) {
    console.log(`[streams.js] Early return for ${matchId}: ${lateCount} source(s) still resolving (will be cached)`);
  }
  // Withhold per-team 24/7 channels until the fixture is actually in its
  // playable window (see suppressPreMatchTeamChannels). Applied to the assembled
  // set so it covers every source, not just streamsports99.
  //
  // NOTE: the helper may return the SAME array reference (when nothing needed
  // filtering, or when filtering would have emptied it). Only replace the
  // contents when it returned a genuinely different array — otherwise clearing
  // in place and then spreading the same reference yields zero streams.
  const playableStreams = suppressPreMatchTeamChannels(streams, match);
  if (playableStreams !== streams) {
    console.log(`[streams.js] Withheld ${streams.length - playableStreams.length} pre-match 24/7 channel(s) for ${matchId}`);
    streams.length = 0;
    streams.push(...playableStreams);
  }

  // Collapse duplicate streams that arise when several sources of one match
  // resolve to the same underlying clip (e.g. LiveTV's "Other Videos" siblings
  // are re-listed by every clip page). Keyed on the playable identity so real
  // multi-part streams are preserved.
  if (streams.length > 1) {
    const seenStreamKeys = new Set();
    const dedupedStreams = streams.filter((s) => {
      const key = s.ytId ? 'yt:' + s.ytId : (s.url ? 'url:' + s.url : (s.externalUrl ? 'ext:' + s.externalUrl : null));
      if (!key) return true;
      if (seenStreamKeys.has(key)) return false;
      seenStreamKeys.add(key);
      return true;
    });
    if (dedupedStreams.length !== streams.length) {
      console.log(`[streams.js] Dropped ${streams.length - dedupedStreams.length} duplicate stream(s) for ${matchId}`);
      streams.length = 0;
      streams.push(...dedupedStreams);
    }
  }

  // --- Inject relevant 24/7 channels based on category ---

  // Standardize Stream Labels
  const sportIcons = {
    football: '⚽', cricket: '🏏', motorsport: '🏎️',
    basketball: '🏀', american_football: '🏈', rugby: '🏉', networks: '📺'
  };
  const icon = sportIcons[match.category] || '📡';
  
  const niceNames = {
    daddylive: 'DaddyLive',
    timstreams: 'TimStreams',
    streamsports: 'StreamSports',
    streamsports99: 'StreamSports99',
    'embedindia': 'Streamed.pk', 'embedst': 'Streamed.pk', 'streamedpk': 'Streamed.pk',
    'replayzone': 'ReplayZone',
    'livetv': 'LiveTV',
    'damitv': 'DamiTV',
    'ppvst': 'PPV.st'
  };

  streams.forEach(s => {
    // Tag proxied manifest URLs with their resolve-cache key (see withResolveKey).
    s.url = withResolveKey(s.url, s._cacheKey);

    let quality = s.resolution || s.quality || 'Auto';
    if (String(quality).includes('x')) {
       const h = String(quality).split('x')[1];
       quality = h + 'p';
    }
    
    // If externalUrl is a wrapped /watch link containing a YouTube URL, unwrap it directly
    if (s.externalUrl && s.externalUrl.includes('/watch?')) {
      const match = s.externalUrl.match(/[?&](?:url|embed)=([^&]+)/);
      if (match) {
        try {
          const decoded = decodeURIComponent(match[1]);
          if (/youtube\.com|youtu\.be/i.test(decoded)) {
            s.externalUrl = decoded;
          }
        } catch (_) {}
      }
    }

    const isYouTube = !!s.ytId || (s.externalUrl && /youtube\.com|youtu\.be/i.test(s.externalUrl));
    if (isYouTube) {
      if (s.ytId && !s.externalUrl) {
        s.externalUrl = `https://www.youtube.com/watch?v=${s.ytId}`;
      }
    }

    const isWeb = !isYouTube && (!!s.externalUrl || s.name === 'Nuvio Web Player');
    let providerName = niceNames[s._source] || niceNames[Object.keys(niceNames).find(k => s.title && s.title.toLowerCase().includes(k))] || 'Streamed.pk';
    
    if (s.title && s.title.toLowerCase().includes('daddylive')) providerName = 'DaddyLive';
    else if (s.title && s.title.toLowerCase().includes('timstreams')) providerName = 'TimStreams';
    else if (s.title && s.title.toLowerCase().includes('watchfooty')) providerName = 'WatchFooty';
    else if (s.title && s.title.toLowerCase().includes('cdnlive')) providerName = 'CDNLiveTV';
    else if (s.title && s.title.toLowerCase().includes('streamsports99')) providerName = 'StreamSports99';

    let originalTitle = s.title || '';
    let channelName = '';
    let viewersText = '';
    if (originalTitle) {
      const vMatch = originalTitle.match(/👥\s*\d+\s*Viewers/);
      if (vMatch) viewersText = `\n${vMatch[0]}`;

      const match = originalTitle.match(/\(([^)]+)\)/);
      if (match && match[1]) {
        const inner = match[1];
        if (!inner.match(/^[0-9]{3,4}p$/i) && inner !== 'Auto' && !inner.toLowerCase().startsWith('stream')) {
          channelName = inner;
        }
      } else if (!originalTitle.includes('Stream') && !originalTitle.includes('Auto')) {
        channelName = originalTitle;
      }
    }
    // Determine Group
    if (isYouTube) {
      s.name = '▶️ YouTube';
    } else {
      s.name = isWeb ? '🌐 Web Stream' : '⚡ Direct Stream';
    }
    
    let countryTag = '';
    if (channelName) {
      channelName = channelName.trim();
      const countryInfo = detectChannelCountry(channelName);
      if (countryInfo) {
        countryTag = ` ${countryInfo.flag} [${countryInfo.name} • ${countryInfo.language}]`;
        s.language = countryInfo.language;
        s.country = countryInfo.name;
      }
    }
    
    let partLabel = '';
    const partMatch = originalTitle.match(/(?:^|[\s\[\]])(Part\s*\d+|[12]nd\s*Half|[12]st\s*Half|Full\s*Match|Full\s*Replay|Long\s*Highlights?|Highlights?|\d+:\d+)(?:[\s\]\()]|$)/i);
    if (partMatch) {
      partLabel = partMatch[1].trim();
    }
    if (channelName && (channelName.toLowerCase() === 'direct' || channelName.toLowerCase() === 'browser' || channelName.toLowerCase() === 'ok.ru' || channelName.toLowerCase() === partLabel.toLowerCase())) {
      channelName = '';
    }

    const partDisplay = partLabel ? ` | 🎬 ${partLabel}` : '';
    const channelDisplay = channelName ? ` | 📺 ${channelName}${countryTag}` : '';
    const speedLabel = getSpeedLabel(s.speedScore);
    const speedText = speedLabel ? `\n⏱ ${speedLabel}` : '';
    s.title = `${icon} ${providerName}${partDisplay}${channelDisplay}\n📺 Quality: ${quality}${viewersText}${speedText}`;
    
    // Add behaviorHints to group streams and handle CORS for direct streams
    s.behaviorHints = s.behaviorHints || {};
    s.behaviorHints.bingeGroup = `nuvio_sport_${matchId}`;
    
    // If it's a direct m3u8 stream and not routed through our proxy, mark it notWebReady
    if (s.url && s.url.includes('.m3u8') && !s.url.includes('/api/manifest')) {
      s.behaviorHints.notWebReady = true;
      
      let referer = '';
      if (providerName === 'DaddyLive') referer = 'https://dlive.sx/';
      else if (providerName === 'Streamed.pk') referer = 'https://embed.st/';
      else if (providerName === 'WatchFooty') referer = (s.url && s.url.includes('.wfty.st')) ? 'https://sportsembed.su/' : 'https://watchfooty.st/';
      else if (providerName === 'CDNLiveTV') referer = 'https://cdnlivetv.tv/';
      else if (providerName === 'StreamSports99' || providerName === 'StreamSports') referer = 'https://streamsports99.fun/';
      else if (providerName === 'DamiTV') referer = 'https://damitv.st/';
      
      if (referer) {
        if (!s.behaviorHints.proxyHeaders) {
          s.behaviorHints.proxyHeaders = {
            request: {
              "Referer": referer,
              "Origin": referer
            }
          };
        }
      }
    }
  });

  // ─── Prefer direct streams over web fallbacks ─────────────────────────
  // A web embed is a last resort for most providers. When a working direct
  // stream exists those provider web embeds are hidden (TV clients can't open
  // iframes). ReplayZone web streams (_rzWeb) are an exception — they are VOD
  // embeds (Dailymotion, ok.ru page, etc.) that carry content the direct
  // streams may not, so they are always kept alongside direct streams. LiveTV
  // replay clips (_livetvReplay, mostly YouTube ids) are kept for the same reason.
  const directOnly = streams.filter(s => s.name === '⚡ Direct Stream' || s.name === '▶️ YouTube' || s._rzWeb || s._livetvReplay);
  if (directOnly.length > 0 && directOnly.length < streams.length) {
    const hidden = streams.length - directOnly.length;
    // filter() returns a NEW array, so it is safe to clear and refill in place
    // (keeps the caller's reference valid).
    streams.length = 0;
    streams.push(...directOnly);
    console.log(`[streams.js] Hid ${hidden} non-RZ web fallback(s) — ${directOnly.length} stream(s) kept`);
  }

  // Ordering is: direct stream, then language rank, then rankScore.
  // Language rank is English (always first) -> the languages the user listed in
  // config.languages, in order -> unknown -> other known languages. With no
  // config that is exactly the old English -> unknown -> other ordering; see
  // LanguagePriorityService for the ranking and the alias handling.
  const languagePriorities = parseLanguagePriority(config);

  streams.sort((a, b) => compareStreams(a, b, languagePriorities));

  // Verification now happens once per mint (mintVerifiedSources), not per request.
  // Adaptive per-source TTLs keep tokens fresh, so clients may hold the list 30s.

  if (config && config.disableWebStreams === 'true') {
    const originalCount = streams.length;
    const filtered = streams.filter(s => {
      const isYouTube = !!s.ytId || (s.externalUrl && /youtube\.com|youtu\.be/i.test(s.externalUrl));
      if (isYouTube) return true;
      const isWebFallback = !!s.externalUrl || s.name === '🌐 Web Stream' || s.name === 'Nuvio Web Player' || !!s._rzWeb || !!s._livetvReplay;
      const requiresBrowser = s.behaviorHints && s.behaviorHints.notWebReady === true;
      return !isWebFallback && !requiresBrowser;
    });
    if (filtered.length !== originalCount) {
      console.log(`[streams.js] Disabled ${originalCount - filtered.length} web stream(s) for ${matchId}`);
      streams.length = 0;
      streams.push(...filtered);
    }
  }

  return {
    streams,
    cacheMaxAge: 30,
    staleRevalidate: 30,
    staleError: 60
  };
}

// ─── Pre-match stream suppression ────────────────────────────────────────
// Some providers (notably streamsports99) publish PER-TEAM 24/7 channels
// alongside the actual match feed — e.g. "MLB | Toronto Blue Jays". Those
// endpoints are live around the clock, so a fixture that has not started yet
// still "resolves" to working streams minutes or hours early, which makes an
// upcoming match look live and watchable when it is neither.
//
// These labels only appear on a per-TEAM IPTV listing, never on a real match
// feed, so any stream whose label matches is withheld until the fixture is
// actually in its playable window.
//
// NOTE: this lives here (not in index.js) because handleStream is the consumer.
const TEAM_CHANNEL_LABEL_RE = /\bMLB\s*\|\s*/i;
const PREMATCH_LEAD_MS = 10 * 60 * 1000; // allow normal pre-kickoff lead tuning

function isLikelyPerTeamChannel(stream) {
  try {
    const label = String((stream && (stream.title || stream.name)) || '');
    return TEAM_CHANNEL_LABEL_RE.test(label);
  } catch (_) {
    return false;
  }
}

// Keep every non-team-channel stream; keep team channels only once the fixture
// is genuinely under way (or inside its normal pre-kickoff lead window).
// Returns the SAME array reference when nothing needs changing, so callers must
// not assume it is a fresh array.
function suppressPreMatchTeamChannels(streams, match) {
  try {
    if (!Array.isArray(streams) || streams.length === 0) return streams;
    const kickoff = match && match.date ? Number(match.date) : 0;
    // No usable kickoff time => not a scheduled fixture. Keep everything.
    if (!Number.isFinite(kickoff) || kickoff <= 0) return streams;
    if (Date.now() >= kickoff - PREMATCH_LEAD_MS) return streams;
    const kept = streams.filter(s => !isLikelyPerTeamChannel(s));
    // Never return nothing just because every option happened to be a team feed;
    // that would turn a display quirk into a silent outage.
    return kept.length > 0 ? kept : streams;
  } catch (_) {
    return streams;
  }
}

module.exports = {
  handleStream,
  prewarmMatch,
  selectSources,
  // Exported so the manifest proxy can transparently re-mint a single expired
  // source without going through the full stream-list path (see src/index.js).
  resolveSource,
  // Exported for tests: the retry/keep/drop policy is the part worth pinning
  // down, and driving it through handleStream would need the whole match cache.
  verifyStreams
};
