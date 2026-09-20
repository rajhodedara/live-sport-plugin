/**
 * ImageService.js
 *
 * Self-hosted image pipeline for catalog artwork:
 *   - fetchAndCache(url): fetches a remote image once, validates it is really
 *     an image, caches it in memory (TTL + entry cap) and returns the entry.
 *     Returns null on ANY failure (timeout, non-image body, too large) so the
 *     caller can fall back to a generated placeholder.
 *   - svgPlaceholder(text, color): generates a category-colored poster card as
 *     an SVG string. Replaces the old external placehold.co dependency.
 *   - proxyUrl(baseUrl, sourceUrl, opts): builds the /img proxy URL that Nuvio
 *     fetches; the proxy serves the cached image or the generated placeholder,
 *     so a dead source URL can never produce a broken image in the client.
 *
 * No new dependencies: fetches use undici (already in the dependency tree).
 */

const { request } = require('undici');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const IMAGE_TTL_MS = 10 * 60 * 1000;   // 10 minutes
const CACHE_MAX_ENTRIES = 120;
const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 3000;

const cache = new Map();     // url -> { buffer, contentType, expiresAt }
const inFlight = new Map();  // url -> Promise
const negatives = new Map(); // url -> expiry ts (recently failed/slow sources)

const NEG_TTL_MS = 60 * 1000;

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const { generateSportSvg, generateDateSvg, generateMatchCardSvg } = require('./MinimalistPosterService');

/**
 * Generated minimalist poster card: balanced, modern dark slate background,
 * refined category accent, and clean typography. Replaces high-contrast dark imagery.
 */
function svgPlaceholder(text, color, w = 800, h = 450, shape = 'landscape') {
  if (shape === 'poster') {
    w = 600;
    h = 900;
  }
  const bg = /^([0-9a-fA-F]{6})$/.test(String(color)) ? `#${color}` : '#3b82f6';
  const rawLines = String(text || 'Live Sports').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3);
  const lines = rawLines.length ? rawLines : ['Live Sports'];
  const isPoster = h > w;
  const fontSize = isPoster 
    ? (lines.length >= 3 ? 28 : lines.length === 2 ? 34 : 40)
    : (lines.length >= 3 ? 32 : lines.length === 2 ? 40 : 48);
  const startY = h / 2 - ((lines.length - 1) * (fontSize + 12)) / 2 + fontSize * 0.35;
  const maxChars = isPoster ? 18 : 26;
  const textEls = lines.map((line, i) => {
    let l = line;
    if (l.length > maxChars) l = l.slice(0, maxChars - 1) + '…';
    const y = startY + i * (fontSize + 12);
    return `<text x="50%" y="${y.toFixed(1)}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="1.5" fill="#f8fafc" text-anchor="middle" dominant-baseline="middle">${escapeXml(l)}</text>`;
  }).join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="holderBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#141a29"/>
      <stop offset="60%" stop-color="#0d111c"/>
      <stop offset="100%" stop-color="#080a11"/>
    </linearGradient>
    <radialGradient id="holderSpot" cx="50%" cy="50%" r="55%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="60%" stop-color="#ffffff" stop-opacity="0.01"/>
      <stop offset="100%" stop-color="transparent"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#holderBg)"/>
  <rect width="${w}" height="${h}" fill="url(#holderSpot)"/>
  <rect x="1.5" y="1.5" width="${w - 3}" height="${h - 3}" rx="12" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1.5"/>
  <rect x="${(w - 60) / 2}" y="10" width="60" height="3" rx="1.5" fill="${bg}" opacity="0.85"/>
  ${textEls}
</svg>`;
}

function evictIfNeeded() {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const byAccess = [...cache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const excess = cache.size - CACHE_MAX_ENTRIES;
  for (let i = 0; i < excess; i++) cache.delete(byAccess[i][0]);
}

/**
 * Fetch a remote image once, validate it, cache it. Returns
 * { buffer, contentType } or null on any failure.
 */
async function getImage(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;

  const now = Date.now();
  const neg = negatives.get(url);
  if (neg) {
    if (now < neg) return null; // recently failed/slow: do not re-attempt yet
    negatives.delete(url);
  }

  const hit = cache.get(url);
  if (hit) {
    if (now < hit.expiresAt) { hit.lastAccess = now; return hit; }
    cache.delete(url);
  }

  const pending = inFlight.get(url);
  if (pending) return pending;

  const p = (async () => {
    let result = null;
    try {
      // AbortSignal caps the TOTAL request (headers + body): a slow-loris upstream
      // that trickles bytes can otherwise hang past headersTimeout/bodyTimeout.
      const res = await request(url, {
        headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*;q=0.8' },
        headersTimeout: FETCH_TIMEOUT_MS,
        bodyTimeout: FETCH_TIMEOUT_MS,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 1000)
      });

      const contentType = String(res.headers['content-type'] || '').split(';')[0].trim();
      // Intentional destroys below (non-image body / size cap) make the undici
      // body emit an 'error' event; without a listener that crashes the process.
      res.body.on('error', () => {});
      if (res.statusCode === 200 && contentType.startsWith('image/')) {
        // Read with a hard size cap so a huge file can never blow the heap.
        const chunks = [];
        let total = 0;
        let tooBig = false;
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > IMAGE_MAX_BYTES) { tooBig = true; res.body.destroy(); break; }
          chunks.push(chunk);
        }
        if (!tooBig && total >= 32) {
          result = {
            buffer: Buffer.concat(chunks),
            contentType,
            expiresAt: Date.now() + IMAGE_TTL_MS,
            lastAccess: Date.now()
          };
          cache.set(url, result);
          evictIfNeeded();
        }
      }
    } catch (_) {
      result = null;
    } finally {
      inFlight.delete(url);
    }
    if (result) negatives.delete(url);
    else {
      negatives.set(url, Date.now() + NEG_TTL_MS);
      if (negatives.size > 500) negatives.clear();
    }
    return result;
  })();

  inFlight.set(url, p);
  return p;
}

/**
 * Build the /img proxy URL that Nuvio fetches. The proxy serves the cached
 * upstream image or falls back to the generated placeholder, so a dead source
 * URL never reaches the client as a broken image.
 */
function proxyUrl(baseUrl, sourceUrl, { text = '', color = '333333', embed = false } = {}) {
  const validUrl = normalizeUrl(sourceUrl);
  if (!validUrl) return null;
  let url = `${baseUrl}/img?url=${encodeURIComponent(validUrl)}&text=${encodeURIComponent(text)}&color=${color}`;
  if (embed) url += '&embed=1';
  return url;
}

function placeholderUrl(baseUrl, text, color, shape = 'landscape') {
  return `${baseUrl}/img/placeholder?text=${encodeURIComponent(text || '')}&color=${color || '3b82f6'}&shape=${shape}`;
}

function sportPosterUrl(baseUrl, sport, shape = 'poster') {
  return `${baseUrl}/img/sport/${encodeURIComponent(sport)}?shape=${shape}`;
}

function datePosterUrl(baseUrl, displayDate, count = 0, sportKey = null, shape = 'poster') {
  let url = `${baseUrl}/img/date?date=${encodeURIComponent(displayDate)}&count=${encodeURIComponent(count)}&shape=${shape}`;
  if (sportKey) url += `&sport=${encodeURIComponent(sportKey)}`;
  return url;
}

/**
 * Build the composed match-card URL (/img/match). Used when a fixture has no
 * official provider artwork, so the server composes a designed card from the
 * available badges/league/channel instead of falling back to a bare text card.
 */
function matchCardUrl(baseUrl, spec = {}) {
  const params = new URLSearchParams();
  const put = (key, value) => {
    if (value === undefined || value === null) return;
    const str = String(value).trim();
    if (!str) return;
    params.set(key, str);
  };

  put('cat', spec.category);
  put('title', spec.title);
  put('t1', spec.team1);
  put('t2', spec.team2);
  put('b1', spec.badge1);
  put('b2', spec.badge2);
  put('lg', spec.league);
  put('lb', spec.leagueBadge);
  put('ch', spec.channel);
  put('cb', spec.channelBadge);
  put('cm', spec.channelMark);
  put('st', spec.status);
  put('tm', spec.time);
  put('shape', spec.shape);

  const qs = params.toString();
  return qs ? `${baseUrl}/img/match?${qs}` : `${baseUrl}/img/match`;
}

module.exports = {
  svgPlaceholder,
  getImage,
  proxyUrl,
  placeholderUrl,
  sportPosterUrl,
  datePosterUrl,
  matchCardUrl,
  generateSportSvg,
  generateDateSvg,
  generateMatchCardSvg,
  normalizeUrl
};
