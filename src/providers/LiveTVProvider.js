'use strict';
/**
 * LiveTVProvider — drop-in source for the Nuvio Live Sports plugin.
 *
 * Conforms to the plugin's provider contract (matches ReplayZoneProvider):
 *   - class with `getMatches()` -> array of match objects
 *   - `resolveStream(sourceId, category, team, srcObj)` -> array of stream objects
 *   - match.sources entries: { source, id, name, url, type }
 *
 * Install: copy this file to  <addon>/src/providers/LiveTVProvider.js
 * Then apply the 4 edits in ../INTEGRATION.md. Nothing else changes.
 *
 * Why this works with zero stream-extraction: ~85% of livetv.sx replay clips
 * embed a YouTube video, so we return a `ytId` stream (Stremio/Nuvio plays it
 * natively). Anything else falls back to the clip page as an externalUrl.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const MIRRORS = ['https://livetv.sx', 'https://livetv904.me', 'https://m.livetv904.me'];

// Reuse the plugin's browser-fingerprint fetch when present; fall back to fetch.
let safeFetch = null;
try {
  ({ safeFetch } = require('../impitClient'));
} catch (_) {
  safeFetch = null;
}

async function httpGet(url, { timeoutMs = 15000, attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = safeFetch
        ? await safeFetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, timeoutMs, signal: ctrl.signal })
        : await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: ctrl.signal });
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 350 * Math.pow(2, i)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function httpGetMirrored(path) {
  let lastErr;
  for (const base of MIRRORS) {
    try {
      return await httpGet(base + path);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();
const decode = (s) =>
  String(s || '').replace(/&ndash;/g, '-').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const CANONICAL = new Set([
  'football', 'cricket', 'basketball', 'motorsport', 'hockey', 'baseball',
  'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts', 'college', 'other',
]);

function normalizeCategory(raw) {
  const c = String(raw || '').toLowerCase();
  if (c.includes('nhl') || c.includes('hockey')) return 'hockey';
  if (c.includes('mlb') || c.includes('baseball')) return 'baseball';
  if (c.includes('wnba') || c.includes('nba') || c.includes('basketball') || c.includes('lnbp') || c.includes('3x3')) return 'basketball';
  if (c.includes('nfl') || c.includes('american football')) return 'american_football';
  if (c.includes('tennis') || c.includes('wta') || c.includes('atp')) return 'tennis';
  if (c.includes('rugby')) return 'rugby';
  if (c.includes('cricket')) return 'cricket';
  if (c.includes('mml') || c.includes('ufc') || c.includes('boxing') || c.includes('fight')) return 'mma';
  if (c.includes('golf') || c.includes('pga')) return 'golf';
  if (c.includes('formula') || c.includes('motogp') || c.includes('racing') || c.includes('nascar')) return 'motorsport';
  if (c.includes('volleyball') || c.includes('gymnastics') || c.includes('athletics')) return 'other';

  // Ice-hockey families that did not match the explicit checks above. Word
  // boundaries keep short codes (DEL, SHL, NBL) from matching inside longer
  // football league names such as Estonia Meistriliiga.
  if (/\b(?:khl|vhl|mhl|whl|ohl|qmjhl|ahl|nhl|del|shl|ebel)\b/i.test(c) || c.includes('ice hockey') || c.includes('hockey') || /\bliiga\b/i.test(c) || c.includes('extraleague')) return 'hockey';
  if (/\b(?:wnbl|nbl|enbl|lnb|lkl|tbl|acb|kbl)\b/i.test(c) || c.includes('ldb')) return 'basketball';
  // Football/soccer is the dominant archive sport; match on competition naming
  // patterns before falling back, so leagues don't land in "Other Sports".
  const FOOTBALL_HINTS = [
    'football', 'soccer', 'liga', 'copa', 'serie', 'premier', 'division', 'primera',
    'bundesliga', 'eredivisie', 'ekstraklasa', 'championship', 'league', 'cup',
    'mls', 'usl', 'super lig', 'ligue', 'libertadores', 'sudamericana', 'uefa',
    'afc', 'concacaf', 'qualification', 'world cup', 'euro', 'friendly', 'premiership',
  ];
  if (FOOTBALL_HINTS.some((h) => c.includes(h))) return 'football';
  return CANONICAL.has(c) ? c : 'other';
}

function ymdDash(ymd) {
  return ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8);
}

function parseArchive(html, ymd) {
  const headerRe = /<a class="main" href="\/enx\/videotourney\/(\d+)\/"><b>([\s\S]*?)<\/b><\/a>/g;
  const headers = [];
  let hm;
  while ((hm = headerRe.exec(html)) !== null) {
    headers.push({ name: clean(hm[2]), index: hm.index });
  }
  const compFor = (idx) => {
    let cur = null;
    for (const h of headers) { if (h.index < idx) cur = h; else break; }
    return cur ? cur.name : '';
  };

  const blocks = html.split(/<table[^>]+height=27/i);
  const out = [];

  let currentBlockIndex = 0;
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    currentBlockIndex = html.indexOf(block, currentBlockIndex);
    if (!block.includes('showvideo')) continue;
    const teams = block.match(/<b>([^<]+)&ndash;([^<]+)<\/b>/);
    if (!teams) continue;
    const score = block.match(/<font color="#949494"><b>(\d+:\d+)<\/b><\/font>/);
    const time = block.match(/<span class="date">([^<]+)<\/span>/);
    const league = compFor(currentBlockIndex !== -1 ? currentBlockIndex : i);

    const linkRe = /<a class="small" href="(\/enx\/showvideo\/(\d+)_[^"]*)">([^<]*)<\/a>/g;
    const sources = [];
    const seen = new Set();
    let lm;
    while ((lm = linkRe.exec(block)) !== null) {
      const path = lm[1];
      const vid = lm[2];
      const label = clean(lm[3]);
      if (!label || seen.has(path)) continue;
      seen.add(path);
      sources.push({ source: 'livetv', id: path, name: label, url: MIRRORS[0] + path, type: 'iframe' });
    }
    if (!sources.length) continue;

    const home = decode(teams[1]);
    const away = decode(teams[2]);
    const title = `${home} - ${away}`;
    const idSafe = title.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + ymd;
    out.push({
      id: `livetv_${idSafe}`,
      title,
      category: normalizeCategory(league),
      league,
      date: ymdDash(ymd),
      status: 'finished',
      score: score ? score[1] : '',
      time: time ? time[1] : '',
      thumbnail_url: '',
      team1: home.trim() ? { name: home.trim() } : null,
      team2: away.trim() ? { name: away.trim() } : null,
      sources,
    });
  }
  return out;
}

async function unshorten(url) {
  if (!url || typeof url !== 'string') return url;
  let curr = url.trim();
  for (let step = 0; step < 5; step++) {
    if (/youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)([A-Za-z0-9_-]{6,})/i.test(curr) || /youtu\.be\/([A-Za-z0-9_-]{6,})/i.test(curr) || curr.includes('.mp4')) {
      return curr;
    }
    try {
      const res = await fetch(curr, {
        method: 'GET',
        headers: { 'User-Agent': UA },
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) {
          curr = new URL(loc, curr).href;
          continue;
        }
      }
      break;
    } catch (_) {
      break;
    }
  }
  return curr;
}

class LiveTVProvider {
  constructor() {
    this.sourceName = 'livetv';
    this.daysBack = Number(process.env.LIVETV_DAYS_BACK || 21);
    this.enabled = process.env.LIVETV_DISABLED !== 'true';
    this._streamCache = new Map(); // path -> { at, value }
    this._cacheTtlMs = Number(process.env.LIVETV_STREAM_TTL_MS || 6 * 3600 * 1000);
  }

  _recentYmd() {
    const out = [];
    for (let i = 0; i < this.daysBack; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const p = (n) => String(n).padStart(2, '0');
      out.push(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`);
    }
    return out;
  }

  async getMatches() {
    if (!this.enabled) return [];
    try {
      const days = this._recentYmd();
      const results = await Promise.allSettled(
        days.map(async (ymd) => parseArchive(await httpGetMirrored(`/enx/video/${ymd}/`), ymd))
      );
      let matches = [];
      for (const r of results) {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) matches = matches.concat(r.value);
      }
      console.log(`[LiveTV] Extracted ${matches.length} replay events across ${days.length} day(s)`);
      return matches;
    } catch (error) {
      console.error('[LiveTV] Error fetching matches:', error.message);
      return [];
    }
  }

  async resolveStream(sourceId, category, team, srcObj) {
    const path = sourceId || (srcObj && (srcObj.id || srcObj.url)) || '';
    if (!path) return [];

    const cacheKey = path;
    const cached = this._streamCache.get(cacheKey);
    if (cached && Date.now() - cached.at < this._cacheTtlMs) return cached.value;

    const baseLabel = (srcObj && srcObj.name) || 'Replay';
    let streams = [];
    try {
      const pagePath = path.startsWith('/') ? path : new URL(path).pathname;
      const html = await httpGetMirrored(pagePath);
      
      const clipsToProcess = [];
      
      // 1. Root clip
      let rootTarget = null;
      const ogMatch = html.match(/property=["']og:video["']\s+content=["']([^"']+)["']/i);
      if (ogMatch) rootTarget = ogMatch[1];
      if (!rootTarget) {
          const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+player\/video\.php[^"']+|[^"']+youtube[^"']+)["']/i);
          if (iframeMatch) rootTarget = iframeMatch[1];
      }
      if (!rootTarget) {
          const ytMatch = html.match(/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{6,})/) ||
                     html.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
          if (ytMatch) rootTarget = `https://www.youtube.com/watch?v=${ytMatch[1]}`;
      }
      
      if (rootTarget) {
          clipsToProcess.push({ label: baseLabel, target: rootTarget });
      } else {
          streams.push({
            name: 'LiveTV (Web)',
            title: `LiveTV | ${baseLabel}`,
            externalUrl: MIRRORS[0] + pagePath,
            _livetvReplay: true,
          });
      }
      
      // 2. Other Videos
      const otherVideosMatch = html.match(/<b>Other\s+Videos:<\/b>(.*?)<\/table>/is);
      if (otherVideosMatch) {
          const linkRe = /<a[^>]+href=["'](\/enx\/showvideo\/[^"']+)["'][^>]*>(.*?)<\/a>/gi;
          let m;
          while ((m = linkRe.exec(otherVideosMatch[1]))) {
              const oPath = m[1];
              const oLabel = clean(m[2]);
              if (oPath !== pagePath) { 
                  try {
                      const oHtml = await httpGetMirrored(oPath);
                      let oTarget = null;
                      const oOg = oHtml.match(/property=["']og:video["']\s+content=["']([^"']+)["']/i);
                      if (oOg) oTarget = oOg[1];
                      if (!oTarget) {
                          const oIframe = oHtml.match(/<iframe[^>]+src=["']([^"']+player\/video\.php[^"']+|[^"']+youtube[^"']+)["']/i);
                          if (oIframe) oTarget = oIframe[1];
                      }
                      if (oTarget) {
                          clipsToProcess.push({ label: oLabel, target: oTarget });
                      }
                  } catch(e) {
                      // skip failed fetch
                  }
              }
          }
      }
      
      // 3. Snipe final URLs
      for (const clip of clipsToProcess) {
          let currentUrl = clip.target.startsWith('//') ? 'https:' + clip.target : clip.target;
          if (currentUrl.startsWith('/')) currentUrl = MIRRORS[0] + currentUrl;
          currentUrl = currentUrl.replace(/emb\.apl\d+\.online/ig, 'emb.apl613.online');
          
          let finalUrl = currentUrl;
          let iters = 0;
          let ytId = null;
          let mp4Url = null;
          
          while (iters < 5) {
              iters++;

              // 1. Unshorten redirectors / shortener links (tinyurl, bit.ly, etc.)
              if (/(?:tinyurl\.com|bit\.ly|t\.co|goo\.gl|is\.gd|cutt\.ly|rb\.gy|shorturl\.at|ow\.ly)/i.test(currentUrl)) {
                  currentUrl = await unshorten(currentUrl);
              }

              // 2. Direct YouTube check on URL
              const yt = currentUrl.match(/youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)([A-Za-z0-9_-]{6,})/) ||
                         currentUrl.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
              if (yt) {
                  ytId = yt[1];
                  finalUrl = `https://www.youtube.com/watch?v=${ytId}`;
                  break;
              }
              
              // 3. Direct MP4 check on URL
              if (currentUrl.includes('.mp4')) {
                  mp4Url = currentUrl;
                  break;
              }
              
              try {
                  const clipHtml = await httpGet(currentUrl);
                  
                  // 4. Directly extract YouTube video identifiers from fetched HTML
                  const htmlYt = clipHtml.match(/["']videoId["']\s*:\s*["']([A-Za-z0-9_-]{11})["']/) ||
                                 clipHtml.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})["']/i) ||
                                 clipHtml.match(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']https?:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{11})["']/i) ||
                                 clipHtml.match(/youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)([A-Za-z0-9_-]{6,})/) ||
                                 clipHtml.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
                  if (htmlYt) {
                      ytId = htmlYt[1];
                      finalUrl = `https://www.youtube.com/watch?v=${ytId}`;
                      break;
                  }

                  if (clipHtml.includes('Antiphishing.biz checks the short link') || clipHtml.includes('Long link:')) {
                      const match = clipHtml.match(/Long link:.*?(\bhttps?:\/\/[^<]+)/is) || clipHtml.match(/Long link:[^>]*>(?:[^<]*<[^>]*>)*\s*(https?:\/\/[^\s<]+)/i);
                      if (match && match[1]) {
                          currentUrl = match[1].trim();
                          currentUrl = currentUrl.replace(/emb\.apl\d+\.online/ig, 'emb.apl613.online');
                          continue;
                      }
                  }
                  
                  const trimmed = clipHtml.trim();
                  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                      currentUrl = await unshorten(trimmed);
                      currentUrl = currentUrl.replace(/emb\.apl\d+\.online/ig, 'emb.apl613.online');
                      continue;
                  }
                  
                  const iframeMatch = clipHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
                  if (iframeMatch) {
                      const iframeSrc = iframeMatch[1].startsWith('//') ? 'https:' + iframeMatch[1] : iframeMatch[1];
                      // Filter out Google account / signin iframes
                      if (!iframeSrc.includes('/v3/signin') && !iframeSrc.includes('accounts.google.com')) {
                          currentUrl = await unshorten(iframeSrc);
                          currentUrl = currentUrl.replace(/emb\.apl\d+\.online/ig, 'emb.apl613.online');
                          continue;
                      }
                  }
                  
                  const sourceMatch = clipHtml.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i) || clipHtml.match(/file:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i);
                  if (sourceMatch) {
                      let extractedUrl = sourceMatch[1].split(',')[0];
                      mp4Url = extractedUrl.startsWith('//') ? 'https:' + extractedUrl : extractedUrl;
                      break;
                  }
                  
                  const metaMatch = clipHtml.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=['"]?([^"'>]+)["']?/i);
                  if (metaMatch) {
                      currentUrl = await unshorten(metaMatch[1]);
                      continue;
                  }
                  const jsMatch = clipHtml.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
                  if (jsMatch) {
                      currentUrl = await unshorten(jsMatch[1]);
                      continue;
                  }
                  
                  break; // nothing else to extract
              } catch (e) {
                  break;
              }
          }
          
          if (ytId) {
              streams.push({
                  name: 'LiveTV',
                  title: `LiveTV | ${clip.label}`,
                  ytId: ytId,
                  externalUrl: finalUrl,
                  // Keep _livetvReplay true so generic filters don't strip it if direct-only is active
                  _livetvReplay: true
              });
          } else if (mp4Url) {
              streams.push({
                  name: 'LiveTV',
                  title: `LiveTV | ${clip.label}`,
                  url: mp4Url,
                  behaviorHints: { 
                      notWebReady: true, 
                      proxyHeaders: { request: { 'User-Agent': UA, 'Referer': 'https://emb.apl613.online/' } } 
                  },
                  _livetvReplay: true
              });
          } else {
              streams.push({
                  name: 'LiveTV (Web)',
                  title: `LiveTV | ${clip.label} (Fallback)`,
                  externalUrl: finalUrl,
                  _livetvReplay: true
              });
          }
      }
      
    } catch (e) {
      console.warn(`[LiveTV] resolveStream failed for ${path}: ${e.message}`);
    }

    // Collapse duplicates: the root clip and its "Other Videos" siblings can
    // resolve to the same underlying video, producing the same stream twice.
    const seenKeys = new Set();
    streams = streams.filter((s) => {
      const key = s.ytId ? 'yt:' + s.ytId : (s.url ? 'url:' + s.url : (s.externalUrl ? 'ext:' + s.externalUrl : null));
      if (!key) return true;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    this._streamCache.set(cacheKey, { at: Date.now(), value: streams });
    return streams;
  }
}

module.exports = LiveTVProvider;
