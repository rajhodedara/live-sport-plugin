const container = require('./container');
const ChannelCountryService = require('./services/ChannelCountryService');
const ChannelIdentityService = require('./services/ChannelIdentityService');
const { withRetry, isTransientStatus, isTransientError } = require('./services/retry');
const { rewriteHlsUri } = require('./services/HlsRewriteService');
const { parseLanguagePriority, compareStreams } = require('./services/LanguagePriorityService');
const { BASE_URL } = require('./config');
const { performance } = require('perf_hooks');
const SkTechCrypto = require('./resolver/sktech/SkTechCrypto');
const StreamResolveCache = require('./services/StreamResolveCache');

function resolveKey(src, matchId) {
  return StreamResolveCache.resolveKey(src, matchId);
}

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

const SOURCE_PRIORITY = {
  leaf: 1,
  daddylive: 1,
  vavoo: 2,
  sktech: 2,
  ppvst: 2,
  damitv: 2,
  ak47live: 2,
  golf: 2,
  delta: 2,
  echo: 2,
  replayzone: 2,
  livetv: 2,
  soccerfull: 2,
  basketballvideo: 2,
  nflvideo: 2,
  fullraces: 2,
  hockeyreplays: 2,
  mlblive: 2,
  watchfooty: 2,
  admin: 3,
  streamedpk: 3,
  embedindia: 3,
  embedst: 3,
  cdnlive: 3,
  streamsports99: 4,
  timstreams: 9,
  streamsports: 13
};

const KNOWN_REPLAY_SOURCES = ['replayzone', 'livetv', 'soccerfull', 'basketballvideo', 'nflvideo', 'fullraces', 'hockeyreplays', 'mlblive'];
const KNOWN_LIVE_SOURCES = ['ppvst', 'daddylive', 'watchfooty', 'cdnlive', 'streamsports99', 'timstreams', 'streamsports', 'embedindia', 'embedst', 'streamedpk', 'damitv', 'sktech', 'vavoo', 'ak47live', 'leaf'];
const KNOWN_FALLBACKS = ['ppvst', 'daddylive', 'watchfooty', 'cdnlive', 'streamsports99', 'timstreams', 'streamsports', 'embedindia', 'embedst', 'streamedpk', 'replayzone', 'livetv', 'damitv', 'soccerfull', 'basketballvideo', 'nflvideo', 'fullraces', 'hockeyreplays', 'mlblive', 'sktech', 'vavoo', 'ak47live', 'leaf'];

function isReplaySource(sourceName) {
  return KNOWN_REPLAY_SOURCES.includes(sourceName);
}

function selectSources(matchSources, config, match = null) {
  const cleanSources = (matchSources || []).filter(src => !isEventStreamSource(src));
  const sortedSources = [...cleanSources].sort((a, b) => {
    // Unknown sources that are not known fallback providers are likely new
    // Streamed.pk sources - priority 1.5 keeps them near the top.
    const getPriority = (src) => SOURCE_PRIORITY[src] ?? (KNOWN_FALLBACKS.includes(src) ? 99 : 1.5);
    const pa = getPriority(a.source);
    const pb = getPriority(b.source);
    if (pa !== pb) return pa - pb;
    return 0;
  });

  const checkAllowed = (srcName, enabledList) => {
    if (srcName.startsWith('yaml_')) return true;
    if (srcName === 'embedindia' || srcName === 'embedst') return enabledList.includes('streamedpk');
    return enabledList.includes(srcName);
  };

  // Case 1: Granular Live and/or Replay sources configuration
  const hasLiveConfig = config && typeof config.liveSources === 'string';
  const hasReplayConfig = config && typeof config.replaySources === 'string';

  if (hasLiveConfig || hasReplayConfig) {
    const liveAllowed = hasLiveConfig && config.liveSources !== 'none'
      ? config.liveSources.split(',').map(s => s.trim())
      : (hasLiveConfig && config.liveSources === 'none' ? [] : null);

    const replayAllowed = hasReplayConfig && config.replaySources !== 'none'
      ? config.replaySources.split(',').map(s => s.trim())
      : (hasReplayConfig && config.replaySources === 'none' ? [] : null);

    return sortedSources.filter(src => {
      if (src.source.startsWith('yaml_')) return true;
      const isReplay = isReplaySource(src.source);
      if (isReplay) {
        if (!hasReplayConfig) return KNOWN_FALLBACKS.includes(src.source);
        if (config.replaySources === 'none') return false;
        return checkAllowed(src.source, replayAllowed);
      } else {
        if (!hasLiveConfig) return KNOWN_FALLBACKS.includes(src.source);
        if (config.liveSources === 'none') return false;
        return checkAllowed(src.source, liveAllowed);
      }
    });
  }

  // Case 2: Legacy combined sources configuration (config.sources)
  if (config && typeof config.sources === 'string') {
    if (config.sources === 'none') {
      return sortedSources.filter(src => src.source.startsWith('yaml_'));
    }
    const enabled = config.sources.split(',').map(s => s.trim());
    return sortedSources.filter(src => {
      if (src.source.startsWith('yaml_')) return true;
      const isFallback = KNOWN_FALLBACKS.includes(src.source);
      if (!isFallback) return false;
      return checkAllowed(src.source, enabled);
    });
  }

  // Default path (no config in URL) — allow all known active providers
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
  } else if (sourceName === 'soccerfull') {
    const provider = container.resolve('soccerFullProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'basketballvideo') {
    const provider = container.resolve('basketballVideoProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'nflvideo') {
    const provider = container.resolve('nflVideoProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'fullraces') {
    const provider = container.resolve('fullRacesProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'hockeyreplays') {
    const provider = container.resolve('hockeyReplaysProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'mlblive') {
    const provider = container.resolve('mlbLiveProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'sktech') {
    const provider = container.resolve('skTechProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'vavoo') {
    const provider = container.resolve('vavooProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'ak47live') {
    const provider = container.resolve('ak47LiveProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'leaf') {
    const provider = container.resolve('leafProvider');
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
      cookie: urlObj.searchParams.get('cookie') || '',
      ua: urlObj.searchParams.get('ua') || '',
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

    if (info.firstSegmentUri && /\.image|tiktokcdn|byteoversea|ibytedtos/i.test(info.firstSegmentUri)) {
      stream.isTikTok = true;
      stream._isTikTok = true;
    }

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
      const segmentBytes = getContentRangeTotal(response.headers);
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

      // ── NEW: Persist the measured stream bitrate for display ─────────────────
      if (!stream.bitrate && impliedBitrate > 0) {
        stream.bitrate = impliedBitrate >= 1000000
          ? `${(impliedBitrate / 1000000).toFixed(1)} Mbps`
          : `${Math.round(impliedBitrate / 1000)} kbps`;
      }

      // ── NEW: Upgrade generic 'HD' placeholder to real resolution tier ─────────
      // Only applies when: (a) the provider set the fallback 'HD', AND
      // (b) we have a measured bitrate to base this on.
      // Master Playlist streams already have the exact resolution from parseManifestText().
      if (stream.resolution === 'HD' && impliedBitrate > 0) {
        if (impliedBitrate >= 5500000)      stream.resolution = '1080p60'; // 60fps sports broadcast
        else if (impliedBitrate >= 3800000) stream.resolution = '1080p';   // standard 1080p feed
        else if (impliedBitrate >= 2000000) stream.resolution = '720p';    // standard HD restream
        else                                stream.resolution = 'SD';      // sub-720p compressed
      }
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

function getBitrateLabel(bitrate) {
  if (!bitrate) return '';
  if (typeof bitrate === 'string') return bitrate;
  // Some providers store raw bps; render it as a label so the UI never
  // shows "1080p · 6200000". Same format as the measured-bitrate label above.
  const n = Number(bitrate);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 1000000
    ? `${(n / 1000000).toFixed(1)} Mbps`
    : `${Math.round(n / 1000)} kbps`;
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
  if (/tiestep|dlive|thedaddy|dlstreams|daddylive|assetrage|romponalis/i.test(host) || /\.7odxv0l067ka\.net$/.test(host)) return 'https://assetrage.net/';
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

// Read at most maxBytes of a response body without materializing the whole
// thing. Verification only needs the playlist head (EXT tags, takedown
// markers, quality attributes) — full bodies were the #1 heap allocator
// (91% of live allocations were Buffer.toString over full responses).
async function readBodySample(response, maxBytes = 64 * 1024) {
  try {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (total < maxBytes) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          chunks.push(value);
          total += value.byteLength;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    if (typeof response.arrayBuffer === 'function') {
      const buf = await response.arrayBuffer();
      return Buffer.from(buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf).toString('utf8');
    }
    if (typeof response.text === 'function') return String(await response.text()).slice(0, maxBytes);
  } catch (_) { /* fall through to text() */ }
  try { return String(await response.text()).slice(0, maxBytes); } catch (_) { return ''; }
}

async function verifyStreams(streams, cacheKey, m3u8Parser, resolveCache, opts = {}) {
  // Drop-kind tracking: an empty mint whose drops were ALL transient (timeouts,
  // 5xx, resets) is a load symptom, not proof of death — it gets a SHORT negative
  // TTL (45s) so the source recovers as soon as pressure drops. Hard answers
  // (404, takedown slates, invalid bodies) keep the full negative TTL.
  let transientDrops = 0;
  let hardDrops = 0;

  const checkedStreams = await Promise.all(streams.map(async (s) => {
    if (!s || !s.url) return null;

    // Filter out broken/dead SprintCDN links (edge*-*-sprintcdn.*) which fail on user devices
    if (s.url.includes('sprintcdn')) {
      console.log(`[Filter] Dropped SprintCDN stream (IP/ASN bound): ${s.url}`);
      return null;
    }

    // We only pre-flight check direct live streams (m3u8 urls). Web player links or direct VODs are kept blindly.
    if (s.url.includes('cdnlivetv.tv') || s.url.includes('/watch?') || s.url.includes('.mp4') || s.url.includes('pixeldrain.com') || s.url.includes('okcdn.ru') || s.url.includes('vkuser.net') || s.url.includes('mycdn.me') || s._source === 'hockeyreplays' || (s.behaviorHints && s.behaviorHints.notWebReady === false)) return s;

    let targetUrl = s.url;
    let referer = '';
    let origin = '';
    let cookie = '';
    let customUa = '';
    // If the stream is routed through our manifest proxy, we extract the true upstream URL to ping
    if (targetUrl.includes('/api/manifest')) {
      const proxyInfo = parseManifestProxyUrl(targetUrl);
      if (proxyInfo) {
        targetUrl = proxyInfo.targetUrl;
        referer = proxyInfo.referer;
        origin = proxyInfo.origin;
        cookie = proxyInfo.cookie;
        customUa = proxyInfo.ua;
      }
    }

    try {
      const proxyReq = (s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) || {};
      if (!referer) {
        referer = proxyReq['Referer'] || proxyReq['referer'] || '';
      }
      if (!origin && referer) {
        try { origin = new URL(referer).origin; } catch (_) {}
      }
      if (!origin) {
        origin = proxyReq['Origin'] || proxyReq['origin'] || '';
      }
      if (!cookie) {
        cookie = proxyReq['Cookie'] || proxyReq['cookie'] || '';
      }

      let res;
      let bodySample = '';

      const isMp4 = targetUrl.includes('.mp4') || targetUrl.includes('type=4') || (targetUrl.includes('okcdn.ru') && !targetUrl.includes('.m3u8'));

      const reqHeaders = {
        'User-Agent': customUa || proxyReq['User-Agent'] || proxyReq['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': referer
      };
      if (origin) reqHeaders['Origin'] = origin;
      if (cookie) reqHeaders['Cookie'] = cookie;
      if (isMp4) reqHeaders['Range'] = 'bytes=0-1024';

      // A verification ping is one sample of a flaky path: a CDN edge mid-
      // rotation, a reset socket, a 503 under load. Believing that single
      // sample used to drop a stream that plays perfectly well, and then
      // negative-cache it. Retry the transient answers, within a budget that
      // keeps the whole verification inside handleStream's soft deadline.
      const verifyDeadlineAt = Date.now() + VERIFY_TOTAL_BUDGET_MS;
      // Load-shed: when the mint semaphore is mostly consumed, single-attempt
      // verification keeps each mint short so slots turn over faster. A stream
      // that dies to a transient blip during a peak window is re-verified on
      // the next request instead of stalling every queued mint behind retries.
      const verifyAttempts = resolveCache && typeof resolveCache.isMintPressureHigh === 'function' && resolveCache.isMintPressureHigh()
        ? 2 // never 1: one sample of a flaky path drops working streams
        : VERIFY_ATTEMPTS;
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
              // Range keeps the CDN from handing us megabyte bodies; the cap
              // bounds what we decode even when an origin ignores Range.
              const r = await _safeFetch(targetUrl, {
                method: 'GET',
                headers: { ...reqHeaders, Range: 'bytes=0-65535' },
                signal: attemptController.signal,
                timeoutMs: VERIFY_TIMEOUT_MS,
                attempts: 1,
              });
              return { status: r.status, body: await readBodySample(r, 64 * 1024) };
            } finally {
              clearTimeout(attemptTimer);
            }
          },
          {
            attempts: verifyAttempts,
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
        if (kind === 'unreachable after retries') transientDrops++; else hardDrops++;
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
            const retryHeaders = {
              'User-Agent': reqHeaders['User-Agent'],
              'Referer': guess,
              'Origin': guess.replace(/\/$/, ''),
            };
            if (reqHeaders['Cookie']) retryHeaders['Cookie'] = reqHeaders['Cookie'];
            const r2 = await _safeFetch(targetUrl, {
              method: 'GET',
              headers: { ...retryHeaders, Range: 'bytes=0-65535' },
              timeoutMs: VERIFY_TIMEOUT_MS,
              attempts: 1,
            });
            res = { status: r2.status };
            bodySample = await readBodySample(r2, 64 * 1024);
            if (res.status === 200 || res.status === 206) referer = guess; // so a later noteFailure/keep decision is accurate
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
        if (res.status === 404 || res.status === 410) hardDrops++; else transientDrops++;
        if (res.status === 404 || res.status === 410) hardDrops++; else transientDrops++;
        console.log(`[Filter] Dropped dead stream (${res.status}): ${targetUrl}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Some CDNs (like lb8.strmd.st) return 200 OK with "Not found" when token is expired.
      // If it doesn't contain #EXT or <MPD (for DASH manifests), it's not a valid playlist.
      const isMpd = targetUrl.includes('.mpd') || bodySample.includes('<MPD') || bodySample.includes('<mpd');
      if (!isMpd && !isMp4 && !bodySample.includes('#EXT')) {
        hardDrops++;
        hardDrops++;
        console.log(`[Filter] Dropped fake 200 stream (Invalid M3U8 body): ${targetUrl}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Reject Pluto TV takedown slates ("That's a wrap" / "no longer available on this device" loops)
      if (/takedownslate|ptv_takedownslates/i.test(bodySample)) {
        hardDrops++;
        hardDrops++;
        console.log(`[Filter] Dropped Pluto takedown slate: ${targetUrl}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Parse Master Playlist quality, framerate (FPS), and bitrate in real-time (for HLS)
      if (!isMpd && !isMp4 && m3u8Parser && typeof m3u8Parser.parseManifestText === 'function') {
        const parsedQuality = m3u8Parser.parseManifestText(bodySample);
        if (parsedQuality) {
          if (parsedQuality.qualityTag) s.quality = parsedQuality.qualityTag;
          if (parsedQuality.resolution) s.resolution = parsedQuality.resolution;
          if (parsedQuality.bitrateTag) s.bitrate = parsedQuality.bitrateTag;
        }

        if (ENABLE_SPEED_PROBE && !opts.skipSpeedProbe && !(resolveCache && typeof resolveCache.isMintPressureHigh === 'function' && resolveCache.isMintPressureHigh())) {
          await measureStreamSpeed(s, targetUrl, bodySample, referer, origin, m3u8Parser, verifyDeadlineAt);
        }
      }

      // Detect TikTok CDN / ByteDance proxy-heavy streams (.image fake WebP chunks)
      const isTikTok = Boolean(
        s.isTikTok || s._isTikTok ||
        (bodySample && /tiktokcdn|byteoversea|ibytedtos|byteimg|bytegoofy|cowedd4855ws|bytedance|\.image|tplv-/i.test(bodySample)) ||
        (targetUrl && /tiktokcdn|byteoversea|ibytedtos|\.image/i.test(targetUrl)) ||
        (s.url && /tiktokcdn|byteoversea|ibytedtos|\.image/i.test(s.url))
      );
      if (isTikTok) {
        s.isTikTok = true;
        s._isTikTok = true;
        try {
          const streamScorer = container.resolve('streamScorer');
          if (streamScorer && typeof streamScorer.calculateScore === 'function') {
            s.score = streamScorer.calculateScore(s, s._source || '');
          }
        } catch (_) {}
      }

      if (cacheKey) resolveCache.noteSuccess(cacheKey);
      return s;
    } catch (err) {
      transientDrops++;
      transientDrops++;
      console.log(`[Filter] Dropped timeout/error stream: ${targetUrl} - ${err.message}`);
      return null;
    }
  }));

  const result = checkedStreams.filter(Boolean);
  if (result.length === 0 && transientDrops > 0 && hardDrops === 0) {
    result.negativeTtlMs = 45000; // transient-only: recover as soon as pressure drops
  }
  return result;
}

// Mint streams for a single source and health-verify them before they enter the
// cache, so verification runs once per mint instead of on every request.
async function mintVerifiedSources(src, match, config, cacheKey, opts = {}) {
  const options = opts || {};
  const resolveCache = container.resolve('streamResolveCache');
  const m3u8Parser = container.resolve('m3u8Parser');
  const minted = await resolveSource(src, match, config);
  return verifyStreams(minted, cacheKey, m3u8Parser, resolveCache, options);
}

// Prewarm: mint tokens for a match's top sources before the user clicks
// Prewarm all sources by default. This used to default to 3, which meant only the
// first three providers were minted up-front and the rest (WatchFooty is commonly
// 4th in priority order) were minted while the user was already waiting on the
// click. Callers can still pass an explicit smaller number if they ever want to
// cap it, but the safe default is "everything".
// Providers excluded from PREWARMING (not from on-demand resolution).
// Minting these is the heaviest work in the app:
//   - admin/echo/golf/delta/streamedpk/embedindia/embedst: Streamed.pk embed
//     chain — each variant spawns a WASM child process (StreamedPkProvider's
//     own comment), batches of 5 per mint.
//   - ppvst: spawns a full child Node process per resolve (PpvStProvider).
//   - watchfooty: resolves many variants per source via native extraction.
// Prewarming them all night is what saturated the origin at peak (measured:
// Cloudflare 524s). They still resolve normally when a user clicks them.
const DEFAULT_PREWARM_SKIP_PROVIDERS = 'admin,echo,golf,delta,streamedpk,embedindia,embedst,ppvst,watchfooty';

function prewarmSkipProvidersSet() {
  const raw = process.env.PREWARM_SKIP_PROVIDERS === undefined
    ? DEFAULT_PREWARM_SKIP_PROVIDERS
    : process.env.PREWARM_SKIP_PROVIDERS;
  if (!raw || !raw.trim()) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

// Global concurrency cap for prewarm mints. Measured on the live VPS: each
// in-flight mint holds ~1.4 MB of heap (verify scratch: scraper-page strings,
// parsed playlists) plus its socket fan-out, and unbounded concurrency (250+
// simultaneous mints under browse traffic) saturated the CPU, ballooned native
// memory and tripped the PM2 restart ceiling every ~10 minutes. The cap bounds
// the working set; overflow is skipped, never queued — the next meta view
// retries, and on-demand resolution is not gated by this. The counter is per
// worker (module state), so a 2-worker fleet runs up to 2x the cap.
const PREWARM_MAX_CONCURRENT = Number(process.env.PREWARM_MAX_CONCURRENT || 40);
let _prewarmActive = 0;

// True when the mint semaphore is mostly consumed by on-demand work. The meta
// fire-ahead (catalog.js) checks this before dispatching so prefetch never
// competes head-on with clicks during peaks — it runs when the system is idle
// instead, which still keeps the cache warm between bursts.
function mintUnderPressure() {
  try {
    const cache = container.resolve('streamResolveCache');
    return Boolean(cache && typeof cache.isMintPressureHigh === 'function' && cache.isMintPressureHigh());
  } catch (_) {
    return false;
  }
}

async function prewarmMatch(match, config, topN = Number.MAX_SAFE_INTEGER, opts = { skipSpeedProbe: true }) {
  try {
    if (!match || !match.sources || !match.sources.length) return;
    // 24/7 channels never prewarm — regardless of how the caller classified
    // the card. Channels are evergreen (no kickoff to anticipate), and each
    // channel prewarm re-verifies a stack of streams for content nobody is
    // "about to click" the way a live fixture is. This guards every prewarm
    // path (cron tick, meta-detail fire-ahead) against mis-categorized channel
    // cards slipping through the caller's own category filter.
    if (match.category === 'networks' || match.isChannel === true || /_ch_/.test(String(match.id || ''))) {
      return;
    }
    if (_prewarmActive >= PREWARM_MAX_CONCURRENT) return;
    // Yield to clicks: when mint slots are mostly consumed by on-demand
    // traffic, prewarm stands down entirely. Measured live: prefetch running
    // head-on against clicks left popular matches with 1 of 25 streams at the
    // 6 s soft deadline (mint=64/64, sheds climbing). Prewarm resumes as soon
    // as pressure drops, so idle periods still warm the cache fully.
    const resolveCache = container.resolve('streamResolveCache');
    if (resolveCache && typeof resolveCache.isMintPressureHigh === 'function' && resolveCache.isMintPressureHigh()) {
      return;
    }
    _prewarmActive++;
    try {
      await _prewarmMatchInner(match, config, topN, opts);
    } finally {
      _prewarmActive--;
    }
  } catch (err) {
    console.warn('[Prewarm] failed:', err.message);
  }
}

async function _prewarmMatchInner(match, config, topN, opts) {
  const resolveCache = container.resolve('streamResolveCache');
  const activeSources = selectSources(match.sources, config || null, match);
  const skip = prewarmSkipProvidersSet();
  const eligible = skip.size ? activeSources.filter((s) => !skip.has(String(s.source || '').toLowerCase())) : activeSources;
  const targets = eligible.slice(0, topN);
  if (targets.length === 0) return;
  const options = opts || { skipSpeedProbe: true };
  console.log(`[Prewarm] minting ${targets.length} sources for ${match.id} (in batches of 3)`);
  const BATCH_SIZE = 3;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(async (src) => {
      const key = resolveKey(src, match.id);
      if (resolveCache.get(key)) return null;
        return resolveCache.getOrCreate(key, () => mintVerifiedSources(src, match, config || null, key, options), { skipIfBusy: true });
    }));
  }
}


// Bound the response wait without cancelling the cache's background mint.
// Release timers when work finishes early so fast requests leave no tail.
async function settleBefore(promise, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolution Deduplication — pure function, exported for direct unit-testing.
 *
 * When a provider serves multiple quality variants of the same stream
 * (e.g. 240p, 360p, 480p, 720p, 1080p), keeps only the highest-resolution
 * variant to prevent UI clutter and ensure clients play at maximum clarity.
 * Streams without a recognised resolution tag (Auto HLS, etc.) are kept as-is.
 *
 * Mutates `streams` in-place and returns it for convenience.
 *
 * @param {Array<Object>} streams - Stremio stream objects with `name` / `title` fields
 * @returns {Array<Object>}
 */
function getVavooClusterKey(s) {
  if (!s) return 'main';
  if (s.cluster) return String(s.cluster).toLowerCase();
  if (s.serverCluster) {
    const sc = String(s.serverCluster).toLowerCase();
    if (sc.includes('server c') || sc === 'c') return 'c';
    if (sc.includes('server s') || sc === 's') return 's';
    if (sc.includes('server b') || sc === 'b') return 'b';
    if (sc.includes('hevc')) return 'hevc';
    if (sc.includes('raw')) return 'raw';
    if (sc.includes('backup')) return 'backup';
    return sc;
  }
  const text = `${s.title || ''} ${s.channelName || ''} ${s.name || ''} ${s._streamSource || ''}`.toLowerCase();
  if (/server\s*c|\.c\b/i.test(text)) return 'c';
  if (/server\s*s|\.s\b/i.test(text)) return 's';
  if (/server\s*b|\.b\b/i.test(text)) return 'b';
  if (/\bhevc\b|\bh265\b/i.test(text)) return 'hevc';
  if (/\braw\b/i.test(text)) return 'raw';
  return 'main';
}

function deduplicateResolutions(streams) {
  const streamGroupMap = new Map();
  const dedupedStreams = [];
  const seenUrls = new Set();

  for (const s of streams) {
    // Quality deduplication applies ONLY to SKTech and Vavoo streams.
    // NEVER apply to DaddyLive or other multi-mirror providers!
    const isDaddyLive = s._source === 'daddylive' || /\bdaddylive\b|\bdlhd\b/i.test(`${s.name || ''} ${s.title || ''}`);
    const isSktech = !isDaddyLive && (s._source === 'sktech' || /\bsk\s*tech\b|\bsktech\b/i.test(`${s.name || ''} ${s.title || ''}`));
    const isVavoo = !isDaddyLive && (s._source === 'vavoo' || /\bvavoo\b/i.test(`${s.name || ''} ${s.title || ''}`));

    if (!isSktech && !isVavoo) {
      dedupedStreams.push(s);
      continue;
    }

    // Deduplicate identical playback URLs for Vavoo & SKTech
    if (s.url && seenUrls.has(`${s._source || s.name}:${s.url}`)) {
      continue;
    }

    const rawTitle = (s.title || s.name || s.resolution || '').toLowerCase();

    if (isSktech) {
      const resM = rawTitle.match(/\b(1080p|720p|540p|480p|360p|240p|144p)\b/);
      if (!resM) {
        if (s.url) seenUrls.add(`${s._source || s.name}:${s.url}`);
        dedupedStreams.push(s);
        continue;
      }
      const resTag = resM[1];

      // For SKTech, 720p and 1080p work — drop lower resolutions (540p, 480p, 360p, 240p, 144p)
      if (resTag !== '1080p' && resTag !== '720p') {
        continue;
      }

      // Keep both 1080p and 720p per stream feed, preventing duplicate identical resolutions
      const baseKey = `sktech:${s.name || ''}:${resTag}:${rawTitle.replace(/\b(1080p|720p|540p|480p|360p|240p|144p)\b/g, '').replace(/[\s\(\)\[\]]+/g, ' ').trim()}`;

      if (!streamGroupMap.has(baseKey)) {
        streamGroupMap.set(baseKey, s);
        if (s.url) seenUrls.add(`${s._source || s.name}:${s.url}`);
        dedupedStreams.push(s);
      }
      continue;
    }

    if (isVavoo) {
      const resM = rawTitle.match(/\b(4k|uhd|1080p|720p|sd)\b/i);
      const resTag = resM ? resM[1].toLowerCase() : (s.resolution ? String(s.resolution).toLowerCase() : '1080p');
      const lang = (s.language || 'default').toLowerCase();
      // Normalize channel name via ChannelIdentityService so singular/plural brand stems
      // (e.g. TNT SPORT 1 vs TNT SPORTS 1 vs TNT SPORTS 1 HD) produce the exact same identity key
      const channelIdent = ChannelIdentityService.parseChannel(s.channelName || s.canonicalChannel || s.title || '');
      const channelKey = channelIdent.identityKey || 'vavoo_channel';
      const clusterKey = getVavooClusterKey(s);
      const baseKey = `vavoo:${channelKey}:${resTag}:${clusterKey}:${lang}`;

      if (streamGroupMap.has(baseKey)) {
        const existing = streamGroupMap.get(baseKey);
        // Prefer higher quality or non-backup feed
        if ((s.score || 0) > (existing.score || 0) || (!s.isBackup && existing.isBackup)) {
          const idx = dedupedStreams.indexOf(existing);
          if (idx !== -1) {
            dedupedStreams[idx] = s;
            streamGroupMap.set(baseKey, s);
            if (s.url) seenUrls.add(`${s._source || s.name}:${s.url}`);
          }
        }
        continue;
      }

      streamGroupMap.set(baseKey, s);
      if (s.url) seenUrls.add(`${s._source || s.name}:${s.url}`);
      dedupedStreams.push(s);
    }
  }

  streams.length = 0;
  streams.push(...dedupedStreams);
  return streams;
}

async function handleStream(type, id, config) {
  if ((type !== 'tv' && type !== 'series' && type !== 'channel') || !id.startsWith('nuvio_sport_')) {
    return { streams: [] };
  }

  const cacheService = container.resolve('cacheService');
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
  const match = cacheService.findMatch(matchId);

  if (!match || !match.sources || match.sources.length === 0) {
    return { streams: [] };
  }

  const streams = [];

  let candidateSources = match.sources;
  if (!isHubEpisode && episodeIndex && !isNaN(episodeIndex) && episodeIndex > 0) {
    const cleanSources = match.sources.filter(s => s && s.url && !s.source?.includes('timstreams'));
    // Prioritize dedicated full replay providers and ordered parts over goal clips
    const getReplaySourceRank = (s) => {
      const name = (s.name || '').toLowerCase();
      const prov = s.source || '';
      if (prov === 'soccerfull' || prov === 'replayzone' || prov === 'fullraces' || prov === 'basketballvideo' || prov === 'nflvideo' || prov === 'hockeyreplays') {
        if (/part\s*1|1st\s*half|full/i.test(name)) return 1;
        if (/part\s*2|2nd\s*half/i.test(name)) return 2;
        return 3;
      }
      if (/full\s*match|full\s*replay/i.test(name)) return 4;
      if (/part\s*1|1st\s*half/i.test(name)) return 5;
      if (/part\s*2|2nd\s*half/i.test(name)) return 6;
      if (/highlight/i.test(name)) return 8;
      if (/\d+:\d+/.test(name)) return 9;
      return 7;
    };
    cleanSources.sort((a, b) => getReplaySourceRank(a) - getReplaySourceRank(b));

    const isMultiPart = cleanSources.length > 1 || cleanSources.some(s => s.name && /(part|half|period|\d+\s*:\s*\d+|highlight|[12](?:st|nd)\s*half)/i.test(s.name));
    if (isMultiPart) {
      // Group by provider so a multi-source match (e.g. LiveTV clips + SoccerFull full match page)
      // retains all providers rather than discarding non-LiveTV providers.
      const selected = [];
      const byProvider = new Map();
      for (const s of cleanSources) {
        const prov = s.source || 'other';
        if (!byProvider.has(prov)) byProvider.set(prov, []);
        byProvider.get(prov).push(s);
      }
      for (const [prov, pSources] of byProvider.entries()) {
        if (pSources.length === 1) {
          // Single source provider (e.g. SoccerFull match page) contains full match or all parts
          selected.push(pSources[0]);
        } else {
          // Provider with multiple parts/clips: pick the one for this episode
          if (pSources[episodeIndex - 1]) {
            selected.push(pSources[episodeIndex - 1]);
          } else {
            // Fallback: search for explicit part/half matching episodeIndex
            const epRegex = new RegExp(`(?:part|half|period)\\s*${episodeIndex}\\b`, 'i');
            const found = pSources.find(s => s.name && epRegex.test(s.name));
            if (found) selected.push(found);
          }
        }
      }
      if (selected.length > 0) {
        candidateSources = selected;
      }
    }
  }

  // When match is a replay, strictly restrict to replay-capable providers
  // (Prevents live feeds or test/demo streams from masquerading as replays)
  try {
    const { isReplayMatch } = require('./catalog');
    if (isReplayMatch(match)) {
      const REPLAY_SOURCES = new Set(['replayzone', 'livetv', 'soccerfull', 'basketballvideo', 'nflvideo', 'fullraces', 'hockeyreplays', 'mlblive']);
      const replaySources = candidateSources.filter(s => s && REPLAY_SOURCES.has(s.source));
      if (replaySources.length > 0) {
        candidateSources = replaySources;
      }
    }
  } catch (_) {}

  const activeSources = selectSources(candidateSources, config, match);
  const streamScorer = container.resolve('streamScorer');

  const resolveCache = container.resolve('streamResolveCache');

  // ─── Concurrent resolution with a bounded, time-boxed wait ──────────────
  // Kicked off together, so the cost is the SLOWEST source rather than the SUM.
  // Returns as soon as usable streams exist, bounded by a soft deadline;
  // anything still running keeps going and lands in the resolve cache for the
  // next request. Previously every source had to settle before anything was
  // returned, so one slow provider (WatchFooty's embed chain: ~56s/variant)
  // stalled the whole response.
  const HARD_DEADLINE_MS = Number(process.env.STREAM_HARD_DEADLINE_MS || 8000);
  const SOFT_DEADLINE_MS = Math.min(Number(process.env.STREAM_SOFT_DEADLINE_MS || 2500), HARD_DEADLINE_MS);
  const resolutionStartedAt = Date.now();

  const inFlight = [];        // per-source promise + settled result for the fallback wait
  const races = activeSources.map((src) => {
    const key = resolveKey(src, matchId);
    const isPriority1 = src.source === 'daddylive' || SOURCE_PRIORITY[src.source] === 1;
    const state = { key, source: src.source, isPriority1, promise: null, settled: false, value: [] };
    const promise = resolveCache
      .getOrCreate(key, () => mintVerifiedSources(src, match, config, key), { priority: true })
      .then((minted) => {
        state.value = Array.isArray(minted) ? minted.map((st) => ({ ...st, _cacheKey: key })) : [];
        state.settled = true;
        return state.value;
      })
      .catch(() => { state.settled = true; return []; });
    state.promise = promise;
    inFlight.push(state);
    // Wrap so we can tell "settled in time" from "still running".
    return settleBefore(
      promise.then((value) => ({ late: false, value })),
      SOFT_DEADLINE_MS,
      { late: true, value: [] }
    );
  });

  const raced = await Promise.allSettled(races);
  let lateCount = 0;
  for (const r of raced) {
    if (r.status !== 'fulfilled') continue;
    if (r.value.late) { lateCount++; continue; }
    if (Array.isArray(r.value.value)) streams.push(...r.value.value);
  }

  // If nothing usable arrived by the soft deadline, OR if priority-1 sources (DaddyLive)
  // are still in flight, wait for them up to the remaining hard budget.
  // This guarantees fast streams (e.g. Vavoo) do not cut off DaddyLive with an early return,
  // while still returning instantly as soon as DaddyLive completes (or when already cached).
  const priority1InFlight = inFlight.filter(f => f.isPriority1 && !f.settled);
  // If no streams have arrived yet, wait up to the remaining hard budget for in-flight sources.
  // If we already have playable streams, return immediately — do not stall for 15s waiting for a dead/hanging priority-1 source.
  const shouldWait = streams.length === 0 && inFlight.length > 0;

  if (shouldWait) {
    const remaining = Math.max(0, HARD_DEADLINE_MS - (Date.now() - resolutionStartedAt));
    if (remaining > 0) {
      // If we already have streams and are waiting for Priority-1 (DaddyLive), wait specifically
      // for the Priority-1 promises to complete so we return immediately without stalling.
      const waitTargets = priority1InFlight.length > 0
        ? priority1InFlight.map((f) => f.promise)
        : inFlight.map((f) => f.promise);

      await settleBefore(
        Promise.allSettled(waitTargets),
        remaining,
        null
      );
    }
    for (const f of inFlight) {
      // Snapshot newly settled resolutions without duplicating
      if (f.settled && Array.isArray(f.value)) {
        for (const st of f.value) {
          if (!streams.includes(st)) {
            streams.push(st);
          }
        }
      }
    }
    lateCount = inFlight.filter(f => !f.settled).length;
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
    vavoo: 'Vavoo',
    cdnlive: 'CDNLiveTV',
    watchfooty: 'WatchFooty',
    daddylive: 'DaddyLive',
    timstreams: 'TimStreams',
    streamsports: 'StreamSports',
    streamsports99: 'StreamSports99',
    'embedindia': 'Streamed.pk', 'embedst': 'Streamed.pk', 'streamedpk': 'Streamed.pk',
    'replayzone': 'ReplayZone',
    'livetv': 'LiveTV',
    'damitv': 'DamiTV',
    'ppvst': 'PPV.st',
    'soccerfull': 'SoccerFull',
    'sktech': 'SKTech',
    'basketballvideo': 'BasketballVideo',
    'nflvideo': 'NFLVideo',
    'fullraces': 'FullRaces',
    'hockeyreplays': 'HockeyReplays',
    'mlblive': 'MLBLive',
    admin: 'Streamed.pk',
    echo: 'Streamed.pk',
    golf: 'Streamed.pk',
    delta: 'Streamed.pk'
  };

  // ─── Eliminate DASH (.mpd) & ClearKey DRM streams completely ──────────
  // ExoPlayer on stock Android apps lacks MediaDrm callbacks, causing black
  // screen + timer. The addon's own /api/manifest proxy wraps BOTH HLS (.m3u8)
  // and DASH (.mpd) upstreams, so the proxy URL string is NOT evidence of DASH
  // — only the wrapped target is. Keying on "/api/manifest" eliminated every
  // proxied live HLS stream (DaddyLive et al. always proxy), which surfaced as
  // "no sources except sktech". sktech's DASH feeds are never wanted, so they
  // are additionally matched on a DASH path/DRM signal.
  const nonDash = streams.filter(s => {
    const rawUrl = String(s.url || s.streamUrl || s._rawMpdUrl || '');
    const lower = rawUrl.toLowerCase();
    let target = lower;
    if (lower.includes('/api/manifest')) {
      try {
        const info = parseManifestProxyUrl(rawUrl);
        if (info && info.targetUrl) target = String(info.targetUrl).toLowerCase();
      } catch (_) {}
    }
    const typeIsDash = !!(s.type && String(s.type).toLowerCase().includes('dash'));
    const genericDash = target.includes('.mpd') || !!s.clearkey || s.format === 'dash' || typeIsDash;
    // sktech: never serve DASH, even if it is not tagged ClearKey.
    const isSktechDash = String(s._source || '') === 'sktech' &&
      (/\.mpd(\?|#|$)/.test(target) || /\/dash\//.test(target) || !!s.clearkey || s.format === 'dash' || typeIsDash);
    return !(genericDash || isSktechDash);
  });
  if (nonDash.length < streams.length) {
    const droppedCount = streams.length - nonDash.length;
    streams.length = 0;
    streams.push(...nonDash);
    console.log(`[streams.js] Eliminated ${droppedCount} DASH stream(s) for ${matchId}`);
  }

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
    let providerName = niceNames[s._source] ||
      (s._source ? (s._source.charAt(0).toUpperCase() + s._source.slice(1)) : null) ||
      niceNames[Object.keys(niceNames).find(k => s.title && s.title.toLowerCase().includes(k))] ||
      'Streamed.pk';
    
    if (s._source === 'vavoo' || (s.title && s.title.toLowerCase().includes('vavoo'))) providerName = 'Vavoo';
    else if (s._source === 'cdnlive' || (s.title && s.title.toLowerCase().includes('cdnlive'))) providerName = 'CDNLiveTV';
    else if (s._source === 'watchfooty' || (s.title && s.title.toLowerCase().includes('watchfooty'))) providerName = 'WatchFooty';
    else if (s._source === 'daddylive' || (s.title && s.title.toLowerCase().includes('daddylive'))) providerName = 'DaddyLive';
    else if (s._source === 'timstreams' || (s.title && s.title.toLowerCase().includes('timstreams'))) providerName = 'TimStreams';
    else if (s._source === 'streamsports99' || (s.title && s.title.toLowerCase().includes('streamsports99'))) providerName = 'StreamSports99';
    else if (s._source === 'sktech' || (s.title && s.title.toLowerCase().includes('sk tech')) || (s.title && s.title.toLowerCase().includes('sktech'))) providerName = 'SKTech';
    else if (s._source === 'hockeyreplays' || (s.title && s.title.toLowerCase().includes('hockeyreplays'))) providerName = 'HockeyReplays';
    else if (s._source === 'mlblive' || (s.title && s.title.toLowerCase().includes('mlblive'))) providerName = 'MLBLive';
    else if (s._source === 'damitv' || (s.title && s.title.toLowerCase().includes('damitv'))) providerName = 'DamiTV';
    else if (s._source === 'ppvst' || (s.title && s.title.toLowerCase().includes('ppvst'))) providerName = 'PPV.st';
    else if (s._source === 'livetv' || (s.title && s.title.toLowerCase().includes('livetv'))) providerName = 'LiveTV';
    else if (s._source === 'replayzone' || (s.title && s.title.toLowerCase().includes('replayzone'))) providerName = 'ReplayZone';

    let originalTitle = s.title || '';
    let channelName = '';
    let viewersText = '';
    if (originalTitle) {
      const vMatch = originalTitle.match(/👥\s*\d+\s*Viewers/);
      if (vMatch) viewersText = `\n${vMatch[0]}`;

      const match = originalTitle.match(/\(([^)]+)\)/);
      if (match && match[1]) {
        const inner = match[1];
        // Skip resolution/bitrate placeholders and Auto/stream markers — they
        // are quality tags, not channel names (e.g. Leaf's "(FHD)").
        if (!/^(?:\d{3,4}p\d{0,2}|sd|hd|fhd|uhd|4k(?:\s+uhd)?|8k)$/i.test(inner) && inner !== 'Auto' && !inner.toLowerCase().startsWith('stream')) {
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
    
    const isChannelCard = Boolean(match && (match.category === 'networks' || match.isChannel || match.date === '0' || String(match.id || '').includes('_ch_')));
    if (isChannelCard && s.canonicalChannel) {
      channelName = s.canonicalChannel;
    } else if (!channelName && isChannelCard) {
      channelName = s.canonicalChannel || s.channelName || (match && match.title) || '';
    }

    let countryInfo = null;
    // 1. If stream already has group or explicit country metadata, detect country from it FIRST!
    if (s.group && !/^(?:live tv|general|channels|networks|other|multi-region)$/i.test(String(s.group).trim())) {
      countryInfo = detectChannelCountry(s.group);
    }
    if (!countryInfo && s.country) {
      countryInfo = detectChannelCountry(s.country);
    }
    // 2. Fall back to stream's specific channelName if available
    if (!countryInfo && s.channelName) {
      countryInfo = detectChannelCountry(s.channelName);
    }
    // 3. Fall back to normalized channelName / card title
    if (!countryInfo && channelName) {
      channelName = channelName.trim();
      countryInfo = detectChannelCountry(channelName);
    }
    if (!countryInfo) {
      const fallbackChannel = s.canonicalChannel || s.channelName || (match && match.title) || '';
      if (fallbackChannel) {
        countryInfo = detectChannelCountry(fallbackChannel);
      }
    }

    if (countryInfo) {
      if (!s.language) s.language = countryInfo.language;
      if (!s.country) s.country = countryInfo.country || countryInfo.name;
      if (!s.countryCode) s.countryCode = countryInfo.name;
      if (!s.countryFlag) s.countryFlag = countryInfo.flag;
    }

    if (channelName) {
      channelName = channelName
        .replace(/\s*[-–—]{1,3}\s*(?:Poland|Germany|UK|USA?|France|Spain|Italy|Portugal|Turkey|Netherlands|Canada|Australia|Austria|Switzerland|India|Argentina|Chile|Brazil|[A-Za-z]{2,})\s*$/i, '')
        .replace(/\s*[-–—]{2,}\s*/g, ' ')
        .replace(/\s*[–—]\s*/g, ' ')
        .trim();
    }

    const flag = s.countryFlag || (countryInfo && countryInfo.flag) || '';
    const code = s.countryCode || (s.country && s.country.length === 2 ? s.country.toUpperCase() : '') || (countryInfo && countryInfo.name) || (countryInfo && countryInfo.country) || '';
    const lang = s.language || (countryInfo && countryInfo.language) || '';
    let countryTag = '';
    if (code && lang) {
      countryTag = ` ${flag ? flag + ' ' : ''}[${code} • ${lang}]`;
    } else if (flag && lang) {
      countryTag = ` ${flag} [${lang}]`;
    } else if (flag) {
      countryTag = ` ${flag}`;
    }

    let partLabel = '';
    const partMatch = originalTitle.match(/(?:^|[\s\[\]])(Part\s*\d+|[12]nd\s*Half|[12]st\s*Half|Full\s*Match|Full\s*Replay|Long\s*Highlights?|Highlights?|\d+:\d+)(?:[\s\]\()]|$)/i);
    if (partMatch) {
      partLabel = partMatch[1].trim();
    }
    if (channelName && (channelName.toLowerCase() === 'direct' || channelName.toLowerCase() === 'browser' || channelName.toLowerCase() === 'ok.ru' || channelName.toLowerCase() === partLabel.toLowerCase())) {
      channelName = isChannelCard ? (s.canonicalChannel || (match && match.title) || '') : '';
    }

    let serverBadge = '';
    const rawServer = s.serverCluster || s._streamSource || s.streamSource;
    if (rawServer && typeof rawServer === 'string') {
      const trimmed = rawServer.trim();
      if (trimmed) {
        serverBadge = ` [${trimmed}]`;
      }
    }

    const isBackup = Boolean(s.isBackup || s._isBackup || (s.title && /\bbackup\b/i.test(s.title)) || (originalTitle && /\bbackup\b/i.test(originalTitle)));
    const backupTag = (isBackup && !serverBadge.toLowerCase().includes('backup')) ? ' [Backup]' : '';
    const isTimeshift = Boolean(s.isTimeshift || s._isTimeshift || (s.title && /(?:\+1|\bdelay\b)/i.test(s.title)) || (originalTitle && /(?:\+1|\bdelay\b)/i.test(originalTitle)));
    const timeshiftTag = isTimeshift ? ' [+1 Delay]' : '';

    const speedLabel = getSpeedLabel(s.speedScore);
    const speedText = speedLabel ? `\n⏱ ${speedLabel}` : '';
    const bitrateLabel = getBitrateLabel(s.bitrate);
    const bitrateText = bitrateLabel ? ` · ${bitrateLabel}` : '';

    const partDisplay = partLabel ? ` | 🎬 ${partLabel}` : '';
    const channelDisplay = channelName ? ` | 📺 ${channelName}${countryTag}${backupTag}${timeshiftTag}` : `${backupTag}${timeshiftTag}`;
    s.title = `${icon} ${providerName}${serverBadge}${partDisplay}${channelDisplay}\n📺 Quality: ${quality}${bitrateText}${viewersText}${speedText}`;
    
    // Add behaviorHints to group streams and handle CORS for direct streams
    s.behaviorHints = s.behaviorHints || {};
    s.behaviorHints.bingeGroup = `nuvio_sport_${matchId}`;
    
    // If it's a direct m3u8 stream and not routed through our proxy, mark it notWebReady (unless explicitly web-ready like SprintCDN)
    if (s.url && s.url.includes('.m3u8') && !s.url.includes('/api/manifest') && s.behaviorHints.notWebReady !== false) {
      s.behaviorHints.notWebReady = true;
      
      let referer = '';
      if (providerName === 'DaddyLive') referer = 'https://thedaddy.pk/';
      else if (providerName === 'Streamed.pk') referer = 'https://embed.st/';
      else if (providerName === 'WatchFooty') referer = (s.url && s.url.includes('.wfty.st')) ? 'https://sportsembed.su/' : 'https://watchfooty.st/';
      else if (providerName === 'CDNLiveTV') referer = 'https://cdnlivetv.tv/';
      else if (providerName === 'StreamSports99' || providerName === 'StreamSports') referer = 'https://streamsports99.fun/';
      else if (providerName === 'DamiTV') referer = 'https://damitv.st/';
      else if (providerName === 'Vavoo') referer = 'https://vavoo.to/';
      
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

  if (config && config.webStreams === 'disabled') {
    const nonWeb = streams.filter(s => {
      if (s.name === '⚡ Direct Stream' || s.name === '▶️ YouTube') return true;
      if (s.name === '🌐 Web Stream') return false;
      if (s.externalUrl && !s.ytId && !s.url) return false;
      return true;
    });
    if (nonWeb.length < streams.length) {
      console.log(`[streams.js] Hid ${streams.length - nonWeb.length} web stream(s) due to config for ${matchId}`);
      streams.length = 0;
      streams.push(...nonWeb);
    }
  }

  // ─── Resolution Deduplication: Suppress redundant lower-bitrate variants ──
  deduplicateResolutions(streams);

  // Ordering is: direct stream, then language rank, then rankScore.
  // Language rank is English (always first) -> the languages the user listed in
  // config.languages, in order -> unknown -> other known languages. With no
  // config that is exactly the old English -> unknown -> other ordering; see
  // LanguagePriorityService for the ranking and the alias handling.
  const languagePriorities = parseLanguagePriority(config);

  streams.sort((a, b) => compareStreams(a, b, languagePriorities));

  // Pinned donation link: unshifted to index 0 so it appears at the top of every match
  const donationUrl = process.env.DONATION_URL || '/donate';
  if (streams.length > 0 && donationUrl && donationUrl !== 'disabled' && donationUrl !== 'false') {
    streams.unshift({
      name: '🧿 Support Us',
      title: '❤️ Help keep servers & streams alive\nTap to open Donation Center (Ko-fi / Crypto)',
      externalUrl: donationUrl
    });
  }

  // Verification now happens once per mint (mintVerifiedSources), not per request.
  // Adaptive per-source TTLs keep tokens fresh, so clients may hold the list 30s.


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
/**
 * Formats a clean, explicit stream label for 24/7 channels:
 * Provider | Channel — Country [Flag] — Language — Quality [Backup] [+1 Delay]
 */
function formatChannelStreamTitle(s, match, providerNameOverride, countryInfo, qualityOverride, channelNameOverride, originalTitleOverride) {
  const niceNames = {
    daddylive: 'DaddyLive',
    watchfooty: 'WatchFooty',
    cdnlive: 'CDNLiveTV',
    streamsports99: 'StreamSports99',
    timstreams: 'TimStreams',
    streamsports: 'StreamSports',
    embedindia: 'Streamed.pk',
    embedst: 'Streamed.pk',
    streamedpk: 'Streamed.pk',
    replayzone: 'ReplayZone',
    livetv: 'LiveTV',
    damitv: 'DamiTV',
    soccerfull: 'SoccerFull',
    basketballvideo: 'BasketballVideo',
    nflvideo: 'NFLVideo',
    fullraces: 'FullRaces',
    hockeyreplays: 'HockeyReplays',
    mlblive: 'MLBLive',
    sktech: 'SKTech',
    vavoo: 'Vavoo',
    ppvst: 'PPV.st',
    ak47live: 'AK47Live',
    leaf: 'Leaf'
  };

  const srcKey = s._source || s.sourceName || (s.name && s.name.toLowerCase());
  let providerName = providerNameOverride || niceNames[srcKey] ||
    (srcKey ? (srcKey.charAt(0).toUpperCase() + srcKey.slice(1)) : null) ||
    'Stream';
  if (srcKey === 'vavoo' || (s.title && s.title.toLowerCase().includes('vavoo'))) providerName = 'Vavoo';
  else if (srcKey === 'cdnlive' || (s.title && s.title.toLowerCase().includes('cdnlive'))) providerName = 'CDNLiveTV';
  else if (srcKey === 'daddylive' || (s.title && s.title.toLowerCase().includes('daddylive'))) providerName = 'DaddyLive';
  else if (srcKey === 'sktech' || (s.title && s.title.toLowerCase().includes('sk tech')) || (s.title && s.title.toLowerCase().includes('sktech'))) providerName = 'SKTech';

  const origTitle = originalTitleOverride !== undefined ? originalTitleOverride : (s.title || '');
  let displayChName = s.canonicalChannel || s.channelName || (match && match.title) || channelNameOverride || 'Live Channel';
  displayChName = displayChName
    .replace(/\s*[-–—]{1,3}\s*(?:Poland|Germany|UK|USA?|France|Spain|Italy|Portugal|Turkey|Netherlands|Canada|Australia|Austria|Switzerland|India|Argentina|Chile|Brazil|[A-Za-z]{2,})\s*$/i, '')
    .replace(/\s*[-–—]{2,}\s*/g, ' ')
    .replace(/\s*[–—]\s*/g, ' ')
    .trim() || displayChName;
  const displayCountry = s.country || s.countryName || (countryInfo && (countryInfo.country || countryInfo.name)) || (s.countryCode ? s.countryCode : '');
  const displayFlag = s.countryFlag || (countryInfo && countryInfo.flag) || '';
  const displayCountryPart = displayCountry ? ` — ${displayCountry}${displayFlag ? ' ' + displayFlag : ''}` : '';
  const displayLanguage = s.language || (countryInfo && countryInfo.language) || 'English';
  const displayQuality = qualityOverride || s.quality || s.resolution || 'HD';
  const isBackup = Boolean(s.isBackup || s._isBackup || (s.title && /\bbackup\b/i.test(s.title)) || (origTitle && /\bbackup\b/i.test(origTitle)));
  const backupTag = isBackup ? ' [Backup]' : '';
  const isTimeshift = Boolean(s.isTimeshift || s._isTimeshift || (s.title && /(?:\+1|\bdelay\b)/i.test(s.title)) || (origTitle && /(?:\+1|\bdelay\b)/i.test(origTitle)));
  const timeshiftTag = isTimeshift ? ' [+1 Delay]' : '';

  return `${providerName} | ${displayChName}${displayCountryPart} — ${displayLanguage} — ${displayQuality}${backupTag}${timeshiftTag}`;
}

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
  resolveKey,
  mintUnderPressure,
  prewarmSkipProvidersSet,
  selectSources,
  // Exported so the manifest proxy can transparently re-mint a single expired
  // source without going through the full stream-list path (see src/index.js).
  resolveSource,
  // Exported for tests: the retry/keep/drop policy is the part worth pinning
  // down, and driving it through handleStream would need the whole match cache.
  verifyStreams,
  // Exported for direct unit testing of the resolution deduplication algorithm
  // without requiring a live container / IoC / match-cache setup.
  deduplicateResolutions,
  formatChannelStreamTitle,
  KNOWN_LIVE_SOURCES,
  KNOWN_REPLAY_SOURCES
};
