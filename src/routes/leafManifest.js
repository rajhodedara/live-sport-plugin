'use strict';

/**
 * routes/leafManifest.js - High-performance HLS manifest proxy & coalescer for Leaf (Highfly / Papacito)
 *
 * GET /api/leaf/manifest.m3u8?url=<signed_papacito_url>
 * GET /api/leaf/manifest.m3u8?d=<base64_encoded_state>
 * GET /api/leaf/m3u8/:state/index.m3u8
 *
 * Architecture & Zero Bandwidth Bleed Policy:
 *  - Papacito requires authenticated segment hashes (?a=<hash> or ?t=<hash>) on Cloudflare CDN edge.
 *    Without this auth hash, Cloudflare returns an invalid link / expired video slate.
 *  - This endpoint fetches the upstream ~800-byte text playlist on demand, preserving all authenticated
 *    segment URLs (?a=...).
 *  - High-traffic request coalescing (single-flight) and in-memory caching ensures that even
 *    with 10,000 concurrent viewers, only ONE lightweight 800-byte manifest fetch hits upstream every few seconds.
 *  - All media segments (.ts) resolve directly to Cloudflare edge CDN (e.g. https://w1.papacito.cfd),
 *    guaranteeing ZERO video bytes ever pass through the Nuvio server (100% Zero Bandwidth Bleed compliance).
 */

const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();
const providerOutbound = require('../services/ProviderOutbound');
const { validateLeafManifestUrl: validateTargetUrl } = require('../services/GuardedEgressPolicy');
const leafState = require('../services/LeafState');
const leafMint = require('../services/LeafMint');
const { resolveLeafInstallConfig } = require('../services/LeafInstallConfig');
const { isInconclusiveResolutionError } = require('../services/StreamResolutionOutcome');

// Live edge vs request budget: papacito's playlists run #EXT-X-TARGETDURATION:11
// (~10s segments, ~8 deep window), so a 6s shared cache never serves a segment that
// has already fallen out of the window, while collapsing N viewers into one upstream
// fetch. 2.5s was needlessly expensive upstream.
const MANIFEST_CACHE_TTL_MS = Math.max(2500, Number(process.env.LEAF_PLAYLIST_TTL_MS) || 6000);
const FALLBACK_TTL_MS = 60 * 1000; // 60s stale fallback in case upstream has transient timeout
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CACHE_ENTRIES = 1000;
const MAX_IN_FLIGHT_FETCHES = 128;
const RETRY_BACKOFF_MS = 2000;
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;
const TRANSIENT_NETWORK_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

const manifestCache = new Map(); // account/target -> body + immutable stale deadline, optional retry window
const inFlightFetches = new Map(); // account/target -> Promise<cache entry>

// Retain legacy session cache for backward compatibility / fallback
const sessionCache = new Map();

function storeManifestEntry(key, entry) {
  if (!manifestCache.has(key) && manifestCache.size >= MAX_CACHE_ENTRIES) {
    manifestCache.delete(manifestCache.keys().next().value);
  }
  manifestCache.set(key, entry);
}

function failureCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code : 'ERR_LEAF_UPSTREAM';
}

function sendFailure(res, error, invalidState = false) {
  const temporary = isTransientFetchFailure(error);
  const status = error.statusCode || (temporary ? 503 : 502);
  const delay = error.retryAfterMs || (temporary ? RETRY_BACKOFF_MS : 0);
  if (delay) res.setHeader('Retry-After', String(Math.ceil(Math.max(1000, Math.min(MAX_RETRY_AFTER_MS, delay)) / 1000)));
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(status).send(invalidState && status === 400 ? 'Invalid leaf state' : 'Failed to resolve Leaf playlist');
}

function isTransientFetchFailure(error) {
  // A timeout/capacity wrapper must not hide a guard refusal or invalid body.
  const chain = [];
  try {
    for (let item = error; item && typeof item === 'object'; item = item.cause) {
      if (chain.includes(item) || chain.length >= 8) return false;
      chain.push(item);
    }
    const capacity = item => item.code === 'ERR_OUTBOUND_CAPACITY' || /^ERR_NATIVE_(POOL|SLOT)_(BUSY|CAPACITY)$/.test(item.code || '');
    if (chain.some(item => item.code === 'ERR_OUTBOUND_BLOCKED' ||
        /^ERR_(?:LEAF_(?:MANIFEST_(?:URL|REDIRECT|BODY)|BODY_LIMIT|UPSTREAM_DENIED|TOKEN_EXPIRED)|OUTBOUND_BODY_LIMIT)$/.test(item.code || '') ||
        (item.isFatal === true && !capacity(item)) ||
        (Number.isInteger(item.upstreamStatus) && item.upstreamStatus > 0 && !isTransientStatus(item.upstreamStatus)))) return false;
    return isInconclusiveResolutionError(error) || chain.some(item => item.leafTransient === true ||
      TRANSIENT_NETWORK_CODES.has(item.code) || isTransientStatus(item.upstreamStatus) ||
      item.rateLimit === true || item.cooldown === true ||
      item.code === 'ERR_LEAF_MINT_RATE_LIMIT' || item.code === 'ERR_LEAF_MINT_COOLDOWN');
  } catch (_) { return false; }
}

function isTransientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function retryAfterMs(headers, fallback = RETRY_BACKOFF_MS) {
  const value = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
  let delay = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value) * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay)) delay = fallback;
  return Math.max(1000, Math.min(MAX_RETRY_AFTER_MS, delay));
}

function tokenExpiresAt(targetUrl) {
  try {
    const parts = new URL(targetUrl).searchParams.get('ft')?.split('.');
    if (parts?.length !== 3) return Infinity;
    const exp = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).exp;
    return typeof exp === 'number' && Number.isFinite(exp) && Math.abs(exp * 1000) <= Number.MAX_SAFE_INTEGER
      ? exp * 1000 : Infinity;
  } catch (_) { return Infinity; }
}

function expiredTokenError() {
  return Object.assign(new Error('Leaf manifest credential has expired'), { code: 'ERR_LEAF_TOKEN_EXPIRED' });
}

function installFingerprint(install) {
  return crypto.createHash('sha256').update(install.apiBase).digest('base64url').slice(0, 20);
}

function rawManifestAuth(url) {
  return url.search.slice(1).split('&').find(part => {
    try { return decodeURIComponent(part.split('=')[0]) === 'ft'; } catch (_) { return false; }
  });
}

function withStateContext(body, context, sourceUrl) {
  if (!context.stateToken) return body;
  const parent = new URL(sourceUrl);
  const minted = new URL(context.mintedUrl || sourceUrl);
  const directory = minted.pathname.slice(0, minted.pathname.lastIndexOf('/') + 1);
  const auth = parent.searchParams.get('ft');
  // Preserve the legacy nested child URL representation, and bind each child
  // to the account that produced this parent playlist.
  return body.replace(/(^|\n|URI=")\/api\/leaf\/manifest\.m3u8\?url=([^\s"]+)/g, (match, prefix, encoded) => {
    let child;
    try { child = new URL(decodeURIComponent(encoded)); } catch (_) { return match; }
    // Preserve the existing guarded URL route for CDN splits or redirects
    // outside the minted channel directory. Such a child cannot be refreshed
    // safely from this channel's mint, so do not emit a state link that fails.
    if (child.origin !== minted.origin || !child.pathname.startsWith(directory) ||
        /%(?:2f|5c|2e)/i.test(child.pathname)) return match;
    const inherited = auth && child.origin === parent.origin && child.searchParams.get('ft') === auth;
    return `${prefix}/api/leaf/m3u8/${encodeURIComponent(context.stateToken)}/index.m3u8?url=${encoded}` +
      `&i=${installFingerprint(context.install)}${inherited ? '&f=1' : ''}`;
  });
}

/**
 * Sanitize and ensure all segment lines in upstream m3u8 body have absolute CDN URLs.
 */
function sanitizeManifestBody(body, targetUrl = 'https://w1.papacito.cfd/') {
  if (!body || !body.includes('#EXT')) {
    throw new Error('Upstream returned non-m3u8 body');
  }

  if (/_antipiracy|antipiracy|stream_notice/i.test(body)) {
    throw Object.assign(new Error('Upstream returned denied media'), { code: 'ERR_LEAF_UPSTREAM_DENIED' });
  }

  const lines = body.split('\n');
  const resolveUri = uri => /^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : new URL(uri, targetUrl).href;
  const resolveMediaUri = uri => {
    // Papacito's apex serves playlists while its w1 host serves media. Only
    // rewrite relative media from this exact HTTPS apex: absolute URLs,
    // protocol-relative URLs and other playlist origins retain their hosts.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(uri)) return resolveUri(uri);
    const base = new URL(targetUrl);
    if (base.protocol !== 'https:' || base.hostname !== 'papacito.cfd' || base.port || base.username || base.password) return resolveUri(uri);
    base.hostname = 'w1.papacito.cfd';
    // Older Papacito playlists supply `leaf/...` as a CDN-root path without
    // the leading slash. Retain that upstream convention; other relative
    // paths still resolve against the actual playlist directory.
    return new URL(/^leaf\//.test(uri) ? '/' + uri : uri, base).href;
  };
  const playlistUri = uri => {
    let absolute = resolveUri(uri);
    const parent = new URL(targetUrl);
    const child = new URL(absolute);
    // Leaf's ft credential is scoped to the manifest origin. Preserve its raw
    // query bytes, and never replace an explicitly signed child credential.
    if (child.origin === parent.origin && !child.searchParams.has('ft')) {
      const auth = rawManifestAuth(parent);
      if (auth) {
        const hashAt = absolute.indexOf('#');
        const hash = hashAt < 0 ? '' : absolute.slice(hashAt);
        absolute = hashAt < 0 ? absolute : absolute.slice(0, hashAt);
        absolute += `${child.search ? '&' : '?'}${auth}${hash}`;
      }
    }
    return `/api/leaf/manifest.m3u8?url=${encodeURIComponent(absolute)}`;
  };

  const sanitizedLines = [];
  let isNextLineVariant = false;
  let isNextLineMedia = false;

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Directives and comments
    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
        isNextLineVariant = true;
      }
      if (trimmed.startsWith('#EXTINF:')) isNextLineMedia = true;
      const childDirective = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|IMAGE-STREAM-INF|RENDITION-REPORT):/.test(trimmed);
      const mediaDirective = /^#EXT-X-(?:PART|MAP):/.test(trimmed) ||
        (/^#EXT-X-PRELOAD-HINT:/.test(trimmed) && /\bTYPE=(?:PART|MAP)(?:,|$)/.test(trimmed));
      sanitizedLines.push(trimmed.replace(/\bURI="([^"]*)"/g, (_match, uri) =>
        `URI="${childDirective ? playlistUri(uri) : mediaDirective ? resolveMediaUri(uri) : resolveUri(uri)}"`));
      continue;
    }

    // Master playlist child variant playlist line
    const absoluteUri = resolveUri(trimmed);
    const playlistPath = /\.m3u8$/i.test(new URL(absoluteUri).pathname);
    if (isNextLineVariant || (!isNextLineMedia && playlistPath)) {
      isNextLineVariant = false;
      isNextLineMedia = false;
      sanitizedLines.push(playlistUri(trimmed));
      continue;
    }

    // Media segment URL: ensure absolute URL while preserving all query parameters (?a=..., ?t=...)
    isNextLineMedia = false;
    sanitizedLines.push(resolveMediaUri(trimmed));
  }

  return sanitizedLines.join('\n') + '\n';
}

/**
 * Fetch live upstream manifest with single-flight request coalescing and micro-caching.
 */
async function getOrFetchLiveManifest(targetUrl, context = {}) {
  validateTargetUrl(targetUrl);
  const install = context.install || resolveLeafInstallConfig();
  context = { ...context, install };
  const key = install.configured || install.apiBase !== 'https://sports.highfly.to'
    ? JSON.stringify([install.apiBase, targetUrl]) : targetUrl;
  const now = Date.now();
  const credentialExpiresAt = tokenExpiresAt(targetUrl);
  if (now >= credentialExpiresAt) {
    manifestCache.delete(key);
    throw expiredTokenError();
  }
  const cached = manifestCache.get(key);

  if (cached?.retryUntil > now) {
    if (cached.body && now < cached.staleUntil) {
      return withStateContext(cached.body, context, cached.sourceUrl || targetUrl);
    }
    throw Object.assign(new Error('Leaf manifest is temporarily unavailable'), cached.retryFailure, {
      leafTransient: true, statusCode: 503, retryAfterMs: cached.retryUntil - now
    });
  }
  if (cached && now < cached.expiresAt && now < cached.staleUntil) {
    return withStateContext(cached.body, context, cached.sourceUrl || targetUrl);
  }

  let fetchPromise = inFlightFetches.get(key);
  if (!fetchPromise) {
    if (inFlightFetches.size >= MAX_IN_FLIGHT_FETCHES) {
      const error = Object.assign(new Error('Leaf manifest capacity is busy'), {
        code: 'ERR_OUTBOUND_CAPACITY', isFatal: true, statusCode: 503,
        retryAfterMs: RETRY_BACKOFF_MS, leafTransient: true
      });
      if (cached && now < cached.staleUntil) return withStateContext(cached.body, context, cached.sourceUrl || targetUrl);
      throw error;
    }
    // Install the in-flight entry before a synchronous dependency failure can
    // clear it, so a failed request cannot leave a permanently rejected entry.
    fetchPromise = Promise.resolve().then(async () => {
      try {
        const res = await providerOutbound.safeFetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
            'Referer': `${install.origin}/`,
            'Origin': install.origin,
            'Accept': '*/*'
          },
          timeoutMs: 6000,
          maxBodyBytes: MAX_MANIFEST_BYTES,
          diagnosticOwner: 'manifest'
        });

        // Check hard metadata boundaries before interpreting an HTTP failure as
        // transient, including when a transport supplies a redirected response.
        if (res?.url) {
          try { validateTargetUrl(res.url); }
          catch (_) {
            throw Object.assign(new Error('Invalid Leaf manifest redirect'), { code: 'ERR_LEAF_MANIFEST_REDIRECT' });
          }
        }
        if (res?.bodyTruncated) {
          throw Object.assign(new Error('Leaf manifest exceeds its body limit'), { code: 'ERR_LEAF_BODY_LIMIT' });
        }
        if (!res || !res.ok) {
          throw Object.assign(new Error(`HTTP ${res ? res.status : 'No response'}`), {
            code: 'ERR_LEAF_UPSTREAM_STATUS',
            upstreamStatus: res ? res.status : 0,
            leafTransient: Boolean(res && isTransientStatus(res.status)),
            ...(res && isTransientStatus(res.status) ? {
              statusCode: 503,
              retryAfterMs: retryAfterMs(res.headers, res.status === 429 ? 30000 : RETRY_BACKOFF_MS)
            } : {})
          });
        }
        const rawBody = await res.text();
        if (typeof rawBody !== 'string' || !/^\uFEFF?#EXTM3U(?:\r?\n|$)/.test(rawBody)) {
          throw Object.assign(new Error('Upstream returned non-m3u8 body'), { code: 'ERR_LEAF_MANIFEST_BODY' });
        }
        // Store a neutral body so every viewer of this account shares one
        // upstream fetch even when their signed application states differ.
        const sanitizedBody = sanitizeManifestBody(rawBody, res.url || targetUrl);
        const completedAt = Date.now();
        const hardExpiry = Math.min(credentialExpiresAt, tokenExpiresAt(res.url || targetUrl));
        if (completedAt >= hardExpiry) throw expiredTokenError();

        const entry = {
          body: sanitizedBody,
          sourceUrl: res.url || targetUrl,
          expiresAt: Math.min(completedAt + MANIFEST_CACHE_TTL_MS, hardExpiry),
          staleUntil: Math.min(completedAt + FALLBACK_TTL_MS, hardExpiry)
        };
        storeManifestEntry(key, entry);

        return entry;
      } catch (err) {
        const failedAt = Date.now();
        const temporary = isTransientFetchFailure(err);
        const throttled = temporary && err.upstreamStatus === 429;
        if (temporary) {
          const delay = throttled
            ? Math.max(1000, Math.min(MAX_RETRY_AFTER_MS, err.retryAfterMs || 30000)) : RETRY_BACKOFF_MS;
          const entry = cached || { body: null, expiresAt: 0, staleUntil: 0 };
          entry.retryUntil = failedAt + delay;
          entry.retryFailure = { code: failureCode(err),
            ...(Number.isInteger(err.upstreamStatus) ? { upstreamStatus: err.upstreamStatus } : {}) };
          storeManifestEntry(key, entry);
        }
        // Only transient transport/server failures may reuse a short-lived
        // window. Authorization, guard and malformed-body failures stay errors.
        if (cached?.body && temporary && failedAt < cached.staleUntil) {
          // Extend cache expiration by 2s backoff to avoid immediate retry stampede
          cached.expiresAt = Math.min(failedAt + RETRY_BACKOFF_MS, cached.staleUntil, credentialExpiresAt);
          return cached;
        }
        if (!temporary) manifestCache.delete(key);
        throw err;
      } finally {
        if (inFlightFetches.get(key) === fetchPromise) inFlightFetches.delete(key);
      }
    });

    inFlightFetches.set(key, fetchPromise);
  }

  const result = await fetchPromise;
  return withStateContext(result.body, context, result.sourceUrl || targetUrl);
}

/**
 * Parse upstream manifest body into anchor session parameters (legacy/testing export).
 */
function parseUpstreamManifest(body, targetUrl) {
  if (!body || !body.includes('#EXT')) {
    throw new Error('Upstream returned non-m3u8 body');
  }

  if (/_antipiracy|antipiracy|stream_notice/i.test(body)) {
    throw new Error('Upstream returned anti-piracy trap');
  }

  const durMatch = body.match(/#EXT-X-TARGETDURATION:(\d+)/);
  const targetDuration = durMatch ? parseInt(durMatch[1], 10) : 6;

  const discMatch = body.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/);
  const discontinuitySeq = discMatch ? parseInt(discMatch[1], 10) : 0;

  const segRegex = /(?:(https?:\/\/[^\s\/]+))?\/leaf\/([^\s\/]+)\/([^\s\/]+)\/seg_(\d+)\.ts/g;
  const matches = [...body.matchAll(segRegex)];

  if (!matches || matches.length === 0) {
    throw new Error('No valid Papacito media segments found in upstream manifest');
  }

  const firstMatch = matches[0];
  let defaultCdnBase = 'https://w1.papacito.cfd';
  if (targetUrl) {
    try {
      const u = new URL(targetUrl);
      if (!u.hostname.includes('papacito.cfd')) {
        defaultCdnBase = u.origin;
      }
    } catch (_) {}
  }
  const cdnBase = firstMatch[1] || defaultCdnBase;
  const slug = firstMatch[2];
  const session = firstMatch[3];
  const edge = parseInt(firstMatch[4], 10);

  return {
    cdnBase,
    slug,
    session,
    edge,
    targetDuration,
    discontinuitySeq,
    at: Date.now(),
    expiresAt: Date.now() + 4 * 60 * 60 * 1000
  };
}

/**
 * Generate RFC 8216 HLS sliding-window playlist text (fallback/testing export).
 */
function generateSlidingPlaylist(sessionData) {
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - sessionData.at) / 1000);
  const dur = sessionData.targetDuration || 6;
  const seqOffset = Math.floor(elapsedSec / dur);

  const liveEdge = sessionData.edge + seqOffset;
  const windowSize = 8;
  const mediaSeq = Math.max(sessionData.edge, liveEdge - windowSize);

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${dur}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${sessionData.discontinuitySeq || 0}`,
    '#EXT-X-ALLOW-CACHE:NO'
  ];

  for (let i = 0; i < windowSize; i++) {
    const s = mediaSeq + i;
    lines.push(`#EXTINF:${dur.toFixed(3)},`);
    lines.push(`${sessionData.cdnBase}/leaf/${sessionData.slug}/${sessionData.session}/seg_${s}.ts`);
  }

  return lines.join('\n') + '\n';
}

router.get(['/api/leaf/manifest.m3u8', '/api/leaf/live.m3u8'], async (req, res) => {
  let targetUrl = req.query.url;
  const stateEncoded = req.query.d;

  // Reconstruct unencoded targetUrl if Express query parser split on unencoded ampersands (&)
  if (targetUrl && req.url) {
    const urlIdx = req.url.indexOf('url=');
    if (urlIdx !== -1) {
      const rawTarget = req.url.slice(urlIdx + 4);
      if (rawTarget.includes('&') && (rawTarget.startsWith('http://') || rawTarget.startsWith('https://'))) {
        targetUrl = rawTarget;
      }
    }
  }

  try {
    let playlist = null;

    if (targetUrl) {
      playlist = await getOrFetchLiveManifest(targetUrl);
    } else if (stateEncoded) {
      try {
        const decodedStr = Buffer.from(stateEncoded, 'base64url').toString('utf8');
        const sessionData = JSON.parse(decodedStr);
        playlist = generateSlidingPlaylist(sessionData);
      } catch (err) {
        return res.status(400).send('Invalid state payload');
      }
    } else {
      return res.status(400).send('Missing url or d parameter');
    }

    if (!playlist) {
      return res.status(502).send('Failed to obtain Leaf playlist');
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).send(playlist);
  } catch (err) {
    // Fetch errors can contain signed URLs; log only the failure class.
    console.error('[LeafManifest] Failed to resolve Leaf playlist:', failureCode(err));
    return sendFailure(res, err);
  }
});

/**
 * Mint-at-fetch path: `/api/leaf/m3u8/<signed-state>/index.m3u8`.
 *
 * The state carries only `{m: matchId, s: slug}`. Nothing upstream-facing is stored, so
 * upstream credentials are held only in a bounded server-side cache. A denied answer (`stream_notice`)
 * is rejected and backed off. The route never generates a replacement identity or
 * retries an upstream denial with a cache buster.
 */
async function resolveViaState(stateToken, query = {}) {
  const payload = leafState.verify(stateToken);
  if (!payload) {
    throw Object.assign(new Error('Invalid or expired leaf state'), {
      code: 'ERR_LEAF_STATE', statusCode: 400
    });
  }

  const install = resolveLeafInstallConfig();
  let childUrl = query.url;
  if (childUrl !== undefined) {
    validateTargetUrl(childUrl);
    if (query.i !== installFingerprint(install)) {
      throw Object.assign(new Error('Leaf child playlist account changed'), { code: 'ERR_LEAF_STATE', statusCode: 400 });
    }
  }
  const minted = await leafMint.mintUrl(payload.m, payload.s);
  if (childUrl !== undefined) {
    const parent = new URL(minted);
    const child = new URL(childUrl);
    const directory = parent.pathname.slice(0, parent.pathname.lastIndexOf('/') + 1);
    // A state child must never mint or select a different channel. Other
    // upstream layouts retain the existing guarded URL route when emitted.
    if (child.origin !== parent.origin || !child.pathname.startsWith(directory) ||
        /%(?:2f|5c|2e)/i.test(child.pathname)) {
      throw Object.assign(new Error('Invalid Leaf child playlist context'), { code: 'ERR_LEAF_STATE', statusCode: 400 });
    }
    if (query.f === '1') {
      const auth = rawManifestAuth(parent);
      if (!auth) throw Object.assign(new Error('Leaf child playlist credential changed'), { code: 'ERR_LEAF_STATE', statusCode: 400 });
      const hashAt = childUrl.indexOf('#');
      const hash = hashAt < 0 ? '' : childUrl.slice(hashAt);
      const withoutHash = hashAt < 0 ? childUrl : childUrl.slice(0, hashAt);
      const queryAt = withoutHash.indexOf('?');
      const rest = queryAt < 0 ? [] : withoutHash.slice(queryAt + 1).split('&').filter(part => {
        try { return decodeURIComponent(part.split('=')[0]) !== 'ft'; } catch (_) { return true; }
      });
      childUrl = `${queryAt < 0 ? withoutHash : withoutHash.slice(0, queryAt)}?${[...rest, auth].join('&')}${hash}`;
    }
  }
  try {
    return { playlist: await getOrFetchLiveManifest(childUrl || minted, { install, stateToken, mintedUrl: minted }), payload };
  } catch (err) {
    // An upstream denial or invalid body is not permission to bypass it by
    // re-minting with a cache buster. Discard that credential and back off.
    if (childUrl === undefined && !isTransientFetchFailure(err)) {
      leafMint.invalidate(payload.m, payload.s, { base: install.apiBase });
      leafMint.noteFailure(payload.m, payload.s, {
        reason: err?.code || 'ERR_LEAF_PLAYLIST', error: err, base: install.apiBase
      });
    }
    throw err;
  }
}

router.get(['/api/leaf/m3u8/:state/index.m3u8', '/api/leaf/m3u8/:state'], async (req, res) => {
  try {
    const { playlist } = await resolveViaState(req.params.state, req.query);
    if (!playlist) throw new Error('empty playlist');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).send(playlist);
  } catch (err) {
    const status = err.statusCode || (isTransientFetchFailure(err) ? 503 : 502);
    if (status >= 500) console.warn('[LeafManifest] state route failed:', failureCode(err));
    return sendFailure(res, err, true);
  }
});

module.exports = router;
module.exports.sanitizeManifestBody = sanitizeManifestBody;
module.exports.getOrFetchLiveManifest = getOrFetchLiveManifest;
module.exports.parseUpstreamManifest = parseUpstreamManifest;
module.exports.generateSlidingPlaylist = generateSlidingPlaylist;
module.exports.manifestCache = manifestCache;
module.exports.isTransientFetchFailure = isTransientFetchFailure;
module.exports.sessionCache = sessionCache;
