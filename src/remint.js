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


module.exports = {
  REMINT_TIMEOUT_MS, REMINT_MIN_CACHE_MS, remintCache,
  mergeRemintedUrl, getRemintCacheKey, readRck, isExpiryStatus, rckCandidates, attemptRemint
};
