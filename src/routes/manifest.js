/**
 * routes/manifest.js - /api/manifest HLS playlist proxy
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const express = require('express');
const router = express.Router();
const {
  MANIFEST_TTL_MS, playlistHasContent,
  manifestCacheGet, manifestCacheSet, manifestCacheSetNegative,
  notifyResolveCacheOfDeadStream, fetchUpstreamManifest,
  manifestInFlight
} = require('../manifestProxy');
const {
  readRck, getRemintCacheKey, remintCache, mergeRemintedUrl, isExpiryStatus, attemptRemint
} = require('../remint');
const { rewriteHlsUri } = require('../services/HlsRewriteService');
const { safeFetch: _safeFetch } = require('../impitClient');
const { getRequestBaseUrl } = require('../config');

router.get('/api/manifest', async (req, res) => {
  const targetUrl = req.query.url;
  const isVavooTarget = Boolean(
    (targetUrl && (targetUrl.includes('/sunshine/') || targetUrl.includes('vavoo.') || targetUrl.includes(':8008'))) ||
    (req.query.referer && req.query.referer.includes('vavoo.'))
  );
  const defaultReferer = isVavooTarget ? 'https://vavoo.to/' : 'https://embed.st/';
  const defaultOrigin = isVavooTarget ? 'https://vavoo.to' : 'https://embed.st';
  const referer = req.query.referer || defaultReferer;
  const origin = req.query.origin || defaultOrigin;

  if (!targetUrl) return res.status(400).send('Missing url');
  if (targetUrl.includes('.mpd')) return handleDashManifestProxy(req, res);

  // Playlist-only proxy (same as WatchFooty / Streamed.pk .ts): this host fetches
  // the m3u8 with the CDN Referer, then the player pulls every media byte from the CDN.
  // Recovery key for this stream, if the URL was emitted by our own resolver.
  const rck = readRck(req);
  // Recovery can select another upstream URL, and rewritten child playlists
  // carry this key. Positive/negative entries and in-flight work must therefore
  // share only within the same recovery identity. Keep tuple boundaries explicit.
  const cacheKey = JSON.stringify([targetUrl, referer, origin, rck || '']);
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
          let remintTtl = 150 * 1000;
          try {
            const uObj = new URL(fresh);
            const token = uObj.searchParams.get('token');
            if (token) {
              const b64 = token.split('.')[0];
              const decoded = Buffer.from(b64, 'base64').toString('utf8');
              const parts = decoded.split('|');
              if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1])) {
                const exp = parseInt(parts[parts.length - 1], 10);
                const expMs = exp < 1e11 ? exp * 1000 : exp;
                const rem = expMs - Date.now();
                if (rem > 0) remintTtl = Math.min(remintTtl, Math.max(30000, rem - 30000));
              }
            }
          } catch (_) {}
          const remintExpiresAt = Date.now() + remintTtl;
          const subKey = getRemintCacheKey(rck, effectiveUrl || targetUrl);
          if (subKey) remintCache.set(subKey, { freshUrl: fresh, expiresAt: remintExpiresAt });
          remintCache.set(rck, { freshUrl: fresh, expiresAt: remintExpiresAt });
          
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

          return rewriteHlsUri(l, effectiveUrl, { referer, origin, rckSuffix, absoluteAddonBaseUrl: getRequestBaseUrl(req) });
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

// ─── DASH MPD Manifest Proxy & ClearKey License Support ───────────────────────
// Injects BaseURL pointing to upstream CDN so media chunks stream directly to player
// Injects W3C/DASH-IF ClearKey ContentProtection tags pointing to our local license endpoint
// Result: 0% server bandwidth for media chunks; standard ExoPlayer clients decrypt cleanly.

const CLEARKEY_UUID_EXOPLAYER = 'e2719d58-a985-b3c9-781a-b030af78d30e';
const CLEARKEY_UUID_W3C = '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b';

function toKidBuffer(kid) {
  if (Buffer.isBuffer(kid)) return kid;
  if (!kid || typeof kid !== 'string') return null;
  const cleanHex = kid.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(cleanHex)) {
    return Buffer.from(cleanHex, 'hex');
  }
  try {
    const buf = Buffer.from(kid, 'base64url');
    if (buf.length === 16) return buf;
  } catch (_) {}
  return null;
}

function toBase64Url(val) {
  if (!val || typeof val !== 'string') return '';
  const trimmed = val.trim();
  const cleanHex = trimmed.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(cleanHex)) {
    return Buffer.from(cleanHex, 'hex').toString('base64url');
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length >= 32) {
    return Buffer.from(trimmed, 'hex').toString('base64url');
  }
  return trimmed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHyphenatedGuid(kid) {
  const buf = toKidBuffer(kid);
  if (!buf || buf.length !== 16) return '';
  const hex = buf.toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function generateClearKeyPssh(kids, systemIdHex = '1077efecc0b24d02ace33c1e52e2fb4b') {
  const kidList = Array.isArray(kids) ? kids : [kids];
  const kidBuffers = [];
  for (const k of kidList) {
    const kidVal = typeof k === 'object' && k ? (k.kid || k.keyId) : k;
    const buf = toKidBuffer(kidVal);
    if (buf && buf.length === 16) {
      kidBuffers.push(buf);
    }
  }

  if (kidBuffers.length === 0) return '';

  const cleanSystemId = (systemIdHex || '').replace(/-/g, '');
  const systemId = Buffer.from(cleanSystemId, 'hex');
  const kidCount = kidBuffers.length;
  // Box size: 4 (size) + 4 ('pssh') + 4 (version 1 + flags 0) + 16 (systemId) + 4 (kidCount) + (16 * count) + 4 (dataSize = 0)
  const boxSize = 36 + (16 * kidCount);
  const psshBox = Buffer.alloc(boxSize);

  let offset = 0;
  psshBox.writeUInt32BE(boxSize, offset); offset += 4;
  psshBox.write('pssh', offset, 4, 'ascii'); offset += 4;
  psshBox.writeUInt8(1, offset); offset += 1; // version 1
  psshBox.writeUInt8(0, offset); offset += 1; // flags[0]
  psshBox.writeUInt8(0, offset); offset += 1; // flags[1]
  psshBox.writeUInt8(0, offset); offset += 1; // flags[2]
  systemId.copy(psshBox, offset); offset += 16;
  psshBox.writeUInt32BE(kidCount, offset); offset += 4;
  for (const kidBuf of kidBuffers) {
    kidBuf.copy(psshBox, offset); offset += 16;
  }
  psshBox.writeUInt32BE(0, offset); // dataSize = 0

  return psshBox.toString('base64');
}

function stripDrmProtection(mpd) {
  if (!mpd || typeof mpd !== 'string') return mpd;
  const drmUuids = [
    'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', // Widevine
    '9a04f079-9840-4286-ab92-e65be0885f95', // PlayReady
    '94ce86fb-07ff-4f43-adb8-93d2fa968ca2'  // FairPlay
  ];
  for (const uuid of drmUuids) {
    const selfClosing = new RegExp(`<ContentProtection\\b[^>]*${uuid}[^>]*\\/>\\s*`, 'gi');
    mpd = mpd.replace(selfClosing, '');
    const block = new RegExp(`<ContentProtection\\b[^>]*${uuid}[^>]*>[\\s\\S]*?<\\/ContentProtection>\\s*`, 'gi');
    mpd = mpd.replace(block, '');
  }
  const valueDrms = ['widevine', 'playready', 'mspr'];
  for (const val of valueDrms) {
    const selfClosing = new RegExp(`<ContentProtection\\b[^>]*value="${val}"[^>]*\\/>\\s*`, 'gi');
    mpd = mpd.replace(selfClosing, '');
    const block = new RegExp(`<ContentProtection\\b[^>]*value="${val}"[^>]*>[\\s\\S]*?<\\/ContentProtection>\\s*`, 'gi');
    mpd = mpd.replace(block, '');
  }
  return mpd;
}

function parseClearKeyToken(token) {
  if (!token) return [];
  if (typeof token === 'object') {
    const keysArr = Array.isArray(token)
      ? token
      : (token.keys || (token.keyId || token.kid ? [token] : []));
    return keysArr.map(k => ({
      kty: 'oct',
      kid: toBase64Url(k.kid || k.keyId),
      k: toBase64Url(k.k || k.key)
    })).filter(k => k.kid && k.k);
  }
  let str = token;
  if (typeof str !== 'string') return [];
  str = str.trim();
  // Try base64url decode
  if (!str.startsWith('{') && !str.startsWith('[') && !str.includes(':')) {
    try {
      const decoded = Buffer.from(str, 'base64url').toString('utf8');
      if (decoded.startsWith('{') || decoded.startsWith('[') || decoded.includes(':')) {
        str = decoded.trim();
      }
    } catch (_) {}
  }
  // Try JSON
  if (str.startsWith('{') || str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      const keysArr = Array.isArray(parsed)
        ? parsed
        : (parsed.keys || (parsed.keyId || parsed.kid ? [parsed] : []));
      return keysArr.map(k => ({
        kty: 'oct',
        kid: toBase64Url(k.kid || k.keyId),
        k: toBase64Url(k.k || k.key)
      })).filter(k => k.kid && k.k);
    } catch (_) {
      return [];
    }
  }
  // Try hex colon pairs (e.g. kId1:kVal1,kId2:kVal2)
  const pairs = str.split(',').map(p => p.trim()).filter(Boolean);
  const keys = [];
  for (const p of pairs) {
    if (p.includes(':') && !p.includes('{') && !p.includes('}')) {
      const [kid, k] = p.split(':');
      const b64Kid = toBase64Url(kid.trim());
      const b64K = toBase64Url(k.trim());
      if (b64Kid && b64K) {
        keys.push({
          kty: 'oct',
          kid: b64Kid,
          k: b64K
        });
      }
    }
  }
  return keys;
}

async function handleDashManifestProxy(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');

  const token = req.query.token || req.query.keys || '';
  const referer = req.query.referer || '';
  const origin = req.query.origin || (referer ? (() => { try { return new URL(referer).origin; } catch (_) { return ''; } })() : '');
  const cookie = req.query.cookie || '';
  const ua = req.query.ua || req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

  const headers = { 'User-Agent': ua };
  if (referer) headers['Referer'] = referer;
  if (origin) headers['Origin'] = origin;
  if (cookie) headers['Cookie'] = cookie;

  try {
    const result = await _safeFetch(targetUrl, { headers, timeoutMs: 10000 });
    if (!result.ok) {
      return res.status(result.status).send(`Upstream returned HTTP ${result.status}`);
    }

    let mpd = await result.text();
    if (!mpd.includes('<MPD') && !mpd.includes('<mpd')) {
      return res.status(502).send('Upstream returned non-MPD body');
    }

    const upstreamBase = new URL('.', targetUrl).toString();

    // 1. Resolve any existing relative <BaseURL> tags against upstreamBase
    if (/<BaseURL[^>]*>/i.test(mpd)) {
      mpd = mpd.replace(/<BaseURL([^>]*)>([\s\S]*?)<\/BaseURL>/gi, (match, attrs, uri) => {
        const trimmedUri = uri.trim();
        try {
          const resolved = new URL(trimmedUri, upstreamBase).toString();
          return `<BaseURL${attrs}>${resolved}</BaseURL>`;
        } catch (_) {
          return match;
        }
      });
    }

    // 2. If no <BaseURL> tag exists at all, inject upstreamBase at top level
    if (!/<BaseURL[^>]*>/i.test(mpd)) {
      mpd = mpd.replace(/(<MPD[^>]*>)/i, `$1\n  <BaseURL>${upstreamBase}</BaseURL>`);
    }

    // 3. Strip upstream Widevine & PlayReady ContentProtection tags case-insensitively
    mpd = stripDrmProtection(mpd);

    // 4. Inject ClearKey ContentProtection if keys are present
    const keys = parseClearKeyToken(token);
    if (keys.length > 0) {
      const reqBase = getRequestBaseUrl(req);
      const licenseUrl = `${reqBase}/api/clearkey/license?token=${encodeURIComponent(token)}`;
      const psshW3c = generateClearKeyPssh(keys, CLEARKEY_UUID_W3C);
      const psshExo = generateClearKeyPssh(keys, CLEARKEY_UUID_EXOPLAYER);
      const defaultKidGuid = toHyphenatedGuid(keys[0].kid);

      if (!mpd.includes('xmlns:cenc=')) {
        mpd = mpd.replace(/(<MPD\b[^>]*)/i, '$1 xmlns:cenc="urn:mpeg:cenc:2013"');
      }

      // Handle cenc:default_KID and cenc:pssh on urn:mpeg:dash:mp4protection:2011
      let cencTag = '';
      if (defaultKidGuid) {
        if (mpd.includes('urn:mpeg:dash:mp4protection:2011')) {
          // If self-closing: replace with block containing pssh
          mpd = mpd.replace(
            /<ContentProtection\b([^>]*schemeIdUri="urn:mpeg:dash:mp4protection:2011"[^>]*?)\/>/gi,
            (match, attrs) => {
              let updatedAttrs = attrs;
              if (/cenc:default_KID=/i.test(updatedAttrs)) {
                updatedAttrs = updatedAttrs.replace(/cenc:default_KID="[^"]*"/i, `cenc:default_KID="${defaultKidGuid}"`);
              } else {
                updatedAttrs += ` cenc:default_KID="${defaultKidGuid}"`;
              }
              return `<ContentProtection${updatedAttrs}>${psshW3c ? `\n      <cenc:pssh>${psshW3c}</cenc:pssh>\n    ` : ''}</ContentProtection>`;
            }
          );
          // If block tag: update cenc:default_KID and replace/inject cenc:pssh
          mpd = mpd.replace(
            /<ContentProtection\b([^>]*schemeIdUri="urn:mpeg:dash:mp4protection:2011"[^>]*?)>([\s\S]*?)<\/ContentProtection>/gi,
            (match, attrs, inner) => {
              let updatedAttrs = attrs;
              if (/cenc:default_KID=/i.test(updatedAttrs)) {
                updatedAttrs = updatedAttrs.replace(/cenc:default_KID="[^"]*"/i, `cenc:default_KID="${defaultKidGuid}"`);
              } else {
                updatedAttrs += ` cenc:default_KID="${defaultKidGuid}"`;
              }
              let updatedInner = inner;
              if (/<cenc:pssh\b/i.test(updatedInner)) {
                updatedInner = updatedInner.replace(/<cenc:pssh[^>]*>[\s\S]*?<\/cenc:pssh>/gi, `<cenc:pssh>${psshW3c}</cenc:pssh>`);
              } else if (psshW3c) {
                updatedInner = `\n      <cenc:pssh>${psshW3c}</cenc:pssh>${updatedInner}`;
              }
              return `<ContentProtection${updatedAttrs}>${updatedInner}</ContentProtection>`;
            }
          );
        } else {
          cencTag = `\n    <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="${defaultKidGuid}">${psshW3c ? `\n      <cenc:pssh>${psshW3c}</cenc:pssh>\n    ` : ''}</ContentProtection>`;
        }
      }

      const psshTagExo = psshExo ? `\n      <cenc:pssh>${psshExo}</cenc:pssh>` : '';
      const psshTagW3c = psshW3c ? `\n      <cenc:pssh>${psshW3c}</cenc:pssh>` : '';
      const ckTags = `${cencTag}
    <ContentProtection schemeIdUri="urn:uuid:${CLEARKEY_UUID_EXOPLAYER}" value="ClearKey1.0">${psshTagExo}
      <clearkey:Laurl xmlns:clearkey="http://dashif.org/guidelines/clearkey">${licenseUrl}</clearkey:Laurl>
      <dashif:laurl xmlns:dashif="urn:mpeg:dash:schema:dashif:laurl:2020">${licenseUrl}</dashif:laurl>
      <dashif:Laurl xmlns:dashif="urn:mpeg:dash:schema:dashif:laurl:2020">${licenseUrl}</dashif:Laurl>
    </ContentProtection>
    <ContentProtection schemeIdUri="urn:uuid:${CLEARKEY_UUID_W3C}" value="ClearKey1.0">${psshTagW3c}
      <clearkey:Laurl xmlns:clearkey="http://dashif.org/guidelines/clearkey">${licenseUrl}</clearkey:Laurl>
      <dashif:laurl xmlns:dashif="urn:mpeg:dash:schema:dashif:laurl:2020">${licenseUrl}</dashif:laurl>
      <dashif:Laurl xmlns:dashif="urn:mpeg:dash:schema:dashif:laurl:2020">${licenseUrl}</dashif:Laurl>
    </ContentProtection>`;

      // Strip existing ClearKey tags to avoid duplicates
      mpd = mpd.replace(new RegExp(`<ContentProtection\\b[^>]*urn:uuid:(?:${CLEARKEY_UUID_EXOPLAYER}|e2719d58-a985-b3c9-781a-b030a7d0e82e|${CLEARKEY_UUID_W3C})[^>]*\\/>\\s*`, 'gi'), '');
      mpd = mpd.replace(new RegExp(`<ContentProtection\\b[^>]*urn:uuid:(?:${CLEARKEY_UUID_EXOPLAYER}|e2719d58-a985-b3c9-781a-b030a7d0e82e|${CLEARKEY_UUID_W3C})[^>]*>[\\s\\S]*?<\\/ContentProtection>\\s*`, 'gi'), '');

      // Inject into AdaptationSet
      mpd = mpd.replace(/(<AdaptationSet[^>]*>)/gi, `$1${ckTags}`);
    }

    res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(mpd);
  } catch (err) {
    console.error('[ManifestProxy] DASH error:', err.message);
    return res.status(502).send('Manifest proxy error: ' + err.message);
  }
}

router.get('/api/manifest.mpd', handleDashManifestProxy);

router.use(['/api/clearkey/license', '/api/license'], express.json());
router.use(['/api/clearkey/license', '/api/license'], express.urlencoded({ extended: true }));

router.options(['/api/clearkey/license', '/api/license'], (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.status(204).end();
});

router.all(['/api/clearkey/license', '/api/license'], (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  let rawToken = req.query.token || (req.body && req.body.token) || req.query.keys || '';
  if (!rawToken && req.body && (req.body.keys || req.body.keyId)) {
    rawToken = JSON.stringify(req.body);
  }
  const keys = parseClearKeyToken(rawToken);

  return res.json({
    keys,
    type: 'temporary'
  });
});

router.parseClearKeyToken = parseClearKeyToken;
router.generateClearKeyPssh = generateClearKeyPssh;
router.toHyphenatedGuid = toHyphenatedGuid;
router.stripDrmProtection = stripDrmProtection;
router.CLEARKEY_UUID_EXOPLAYER = CLEARKEY_UUID_EXOPLAYER;
router.CLEARKEY_UUID_W3C = CLEARKEY_UUID_W3C;

module.exports = router;
