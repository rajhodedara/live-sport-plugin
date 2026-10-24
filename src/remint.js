/**
 * remint.js - silent upstream token re-mint
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const container = require('./container');

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
const MAX_REMINT_CACHE_ENTRIES = 5000;

class BoundedRemintMap extends Map {
  set(key, value) {
    if (this.size >= MAX_REMINT_CACHE_ENTRIES && !this.has(key)) {
      const oldestKey = this.keys().next().value;
      if (oldestKey !== undefined) this.delete(oldestKey);
    }
    return super.set(key, value);
  }
}

const remintCache = new BoundedRemintMap(); // rck -> { freshUrl, expiresAt }

// Single-flight coalescing: concurrent viewers of the same stream share one in-flight scrape
const mintInFlight = new Map(); // rck -> Promise<Array>

// Periodically clean up expired entries to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of remintCache.entries()) {
    if (now > v.expiresAt) remintCache.delete(k);
  }
}, 60 * 1000).unref();

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

    // 1. DaddyLive: Query-token replacement mechanism (?s=...&e=..., ?token=..., etc.)
    if (provider === 'daddylive' || fresh.searchParams.has('s') || fresh.searchParams.has('token') || held.pathname.includes('/hls/')) {
      const merged = new URL(heldUrl);
      for (const p of ['s', 'e', 'token', 't', 'auth', 'expires', 'exp', 'sig', 'signature', 'wmsAuthSign']) {
        if (fresh.searchParams.has(p)) merged.searchParams.set(p, fresh.searchParams.get(p));
      }
      merged.host = fresh.host;
      merged.protocol = fresh.protocol;
      return merged.toString();
    }

    // 2. WatchFooty/EmbedIndia: Path-token replacement mechanism
    if (provider === 'watchfooty' || provider === 'embedindia' || fresh.pathname.includes('/secure/')) {
      const freshMatch = fresh.pathname.match(/^(\/secure\/[^/]+\/\d+\/\d+\/[^/]+\/)(.*)$/);
      const heldMatch = held.pathname.match(/^\/secure\/[^/]+\/\d+\/\d+\/[^/]+\/(.*)$/);
      
      const merged = new URL(freshUrl);
      if (freshMatch && heldMatch) {
        merged.pathname = freshMatch[1] + heldMatch[1];
      } else {
        const freshDir = fresh.pathname.substring(0, fresh.pathname.lastIndexOf('/'));
        const heldParts = held.pathname.split('/');
        const freshParts = fresh.pathname.split('/');
        let div = 0;
        for (let i = 0; i < Math.min(heldParts.length, freshParts.length); i++) {
            if (heldParts[i] === 'secure') { div = i + 5; break; }
        }
        if (div > 0 && div < heldParts.length && div < freshParts.length) {
            merged.pathname = freshParts.slice(0, div).concat(heldParts.slice(div)).join('/');
        } else {
            const heldFile = held.pathname.substring(held.pathname.lastIndexOf('/') + 1) || 'playlist.m3u8';
            merged.pathname = `${freshDir}/${heldFile}`;
        }
      }
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

    // 1. WatchFooty/EmbedIndia: Stable key based on flavor (any NATO/custom flavor) and stream number
    if (provider === 'watchfooty' || provider === 'embedindia' || u.pathname.includes('/secure/')) {
      const wf = u.pathname.match(/\/secure\/[^/]+\/([^/]+)\/[^/]+\/([^/]+)\//i);
      if (wf) return `${rck}:${wf[1].toLowerCase()}:${wf[2]}`;
    }

    // 2. DaddyLive: Stable key based on channel key in path
    if (provider === 'daddylive' || u.pathname.includes('/hls/')) {
      const dl = u.pathname.match(/\/hls\/([^/.]+)/i);
      if (dl) return `${rck}:${dl[1]}`;
      const bt = u.pathname.match(/^\/([^/]+)\//);
      if (bt) return `${rck}:${bt[1].toLowerCase()}`;
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

    const cacheService = container.resolve('cacheService');
    let resolved = null;
    for (const c of candidates) {
      // O(1) indexed lookup via findMatch: prevents full-catalog deep clone (~60 MB heap churn)
      const match = (cacheService && typeof cacheService.findMatch === 'function')
        ? cacheService.findMatch(c.matchId)
        : ((cacheService && typeof cacheService.getMatchesReadOnly === 'function')
          ? cacheService.getMatchesReadOnly()
          : (cacheService ? cacheService.getMatches() : [])).find(m => m && m.id === c.matchId);
      if (!match) continue;
      const src = (match.sources || []).find(s => {
        if (!s) return false;
        const sId = String(s.id);
        const cId = String(c.srcId);
        if (sId === cId) return true;
        if (cId.startsWith(sId + ':')) return true;
        if (s.streamId && String(s.streamId) === cId) return true;
        return false;
      });
      if (!src) continue;
      let remintSrcCandidate = { ...src };
      const sId = String(src.id);
      const cId = String(c.srcId);
      if (cId.startsWith(sId + ':')) {
        const subParts = cId.slice(sId.length + 1).split(':');
        if (subParts[0]) remintSrcCandidate.streamSource = subParts[0];
        if (subParts[1]) remintSrcCandidate.streamId = subParts[1];
      }
      resolved = { match, src: remintSrcCandidate };
      break;
    }
    if (!resolved) return null;

    const { resolveSource } = require('./streams');
    const remintSrc = { ...resolved.src, forceRefresh: true, skipCache: true };

    // Single-flight coalescing: concurrent viewers of the same stream share one in-flight scrape
    let mintPromise = mintInFlight.get(rck);
    if (!mintPromise) {
      mintPromise = Promise.race([
        resolveSource(remintSrc, resolved.match, null),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('re-mint timeout')), REMINT_TIMEOUT_MS)),
      ]).finally(() => {
        mintInFlight.delete(rck);
      });
      mintInFlight.set(rck, mintPromise);
    }
    const minted = await mintPromise;
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

        // 1. WatchFooty/EmbedIndia: Match by flavor (any NATO/custom flavor) and stream number
        if (provider === 'watchfooty' || provider === 'embedindia' || heldPath.includes('/secure/')) {
          const wfMatch = heldPath.match(/\/secure\/[^/]+\/([^/]+)\/[^/]+\/([^/]+)\//i);
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
          const btMatch = heldPath.match(/^\/([^/]+)\//);
          if (btMatch) {
            const channelKey = btMatch[1].toLowerCase();
            const matched = freshUrls.find(u => new URL(u).pathname.toLowerCase().includes(`/${channelKey}/`));
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


module.exports = {
  REMINT_TIMEOUT_MS, REMINT_MIN_CACHE_MS, MAX_REMINT_CACHE_ENTRIES, remintCache, mintInFlight,
  mergeRemintedUrl, getRemintCacheKey, readRck, isExpiryStatus, rckCandidates, attemptRemint
};
