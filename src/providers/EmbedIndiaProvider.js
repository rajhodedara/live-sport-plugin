/**
 * EmbedIndiaProvider.js
 *
 * A client-IP-aware provider for resolving embedindia.st and structurally
 * similar embed-based sports stream providers into direct HLS/M3U8 streams.
 *
 * Architecture (per multi-agent review — decision log D-01 through D-08):
 *
 *  Tier 1 — Server-side extraction (for non-CF-protected domains only):
 *    Attempt to fetch the embed HTML from the server and run the EmbedExtractorChain.
 *    Short-circuits after the first failure for 5 minutes (failureCache / D-08).
 *    Uses direct fetch(), NOT proxyFetch(), to preserve CF Worker quota (D-04).
 *
 *  Tier 2 — Client-side extraction via enhanced /watch page (D-05):
 *    Returns externalUrl → /watch?mode=extract&embed=<url>
 *    The browser fetches /api/proxy-embed, runs extraction client-side, plays via hls.js.
 *    This is IP-consistent because all network calls originate from the user's browser.
 *
 *  Tier 3 — Raw embed fallback (UA-03):
 *    Always appended as last-resort: opens the raw embed URL in the browser.
 *
 * Production safety:
 *  - This provider is DISABLED by default (not in KNOWN_FALLBACKS in streams.js).
 *  - It must be explicitly opted in via the user config: sources=embedindia,...
 *  - Zero changes to any existing provider files.
 */

const BaseProvider = require('./BaseProvider');
const StreamEntity = require('../domain/StreamEntity');
const path = require('path');
const { execFile } = require('child_process');

// 🔒
// Domain flags: known CF-protected domains that must skip server-side scraping.
// Add new domains here - no code change to the provider class required.
// 🔒
const CF_PROTECTED_DOMAINS = new Set([
  'embedindia.st',
  'embedindia.com',
  'embedsport.xyz',
]);

// 🕵️
// Server-side User-Agent string (realistic Chrome on Windows)
// 🕵️
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

class EmbedIndiaProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'EmbedIndia';
    this._failureCache = new Map();
    this.FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  }

  async getMatches() {
    return [];
  }

  _shouldSkipServerSide(embedUrl) {
    if (process.env.RESIDENTIAL_PROXY) return false;
    try {
      const { hostname } = new URL(embedUrl);
      if (CF_PROTECTED_DOMAINS.has(hostname)) return true;
      const lastFail = this._failureCache.get(hostname);
      if (lastFail && Date.now() - lastFail < this.FAILURE_TTL_MS) return true;
    } catch (_) {}
    return false;
  }

  _markFailure(embedUrl) {
    try {
      const { hostname } = new URL(embedUrl);
      this._failureCache.set(hostname, Date.now());
    } catch (_) {}
  }

  async _tryWasmExtraction(embedUrl, referer, matchTitle) {
    try {
      if (!embedUrl.includes('embedindia')) return null;
      
      const match = embedUrl.match(/embed(?:-noads)?\/(?:admin\/)?([^\/?]+)/);
      if (!match) return null;
      const channelId = match[1];

      const scriptPath = path.join(__dirname, 'run_gasm_india.js');
      const origin = new URL(embedUrl).origin;

      const stdout = await new Promise((resolve) => {
        execFile('node', [scriptPath, channelId, referer], { timeout: 15000 }, (err, stdout, stderr) => {
          resolve(stdout + '\n' + stderr);
        });
      });

      const m = stdout.match(/"file":\s*"(https?:\/\/[^"]+\.m3u8.*?)"/);
      if (m) {
        console.log(`[EmbedIndia] Native WASM Extracted M3U8: ${m[1]}`);
        const { BASE_URL } = require('../config');
        const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m[1])}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;

        return new StreamEntity({
          name: 'EmbedIndia',
          title: `EmbedIndia (${matchTitle})`,
          url: proxyUrl,
          behaviorHints: { 
            notWebReady: true
          },
          resolution: 'HD'
        });
      }
    } catch (err) {
      console.warn(`[${this.name}] WASM extraction failed for ${embedUrl}: ${err.message}`);
    }
    return null;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];

    const embedUrl = src.embedUrl || sourceId;
    if (!embedUrl || !embedUrl.startsWith('http')) {
      console.warn(`[${this.name}] Invalid embed URL: ${embedUrl}`);
      return streams;
    }

    let referer = src.referer;
    if (!referer) {
      try {
        referer = new URL(embedUrl).origin + '/';
      } catch (err) {
        referer = 'https://embedindia.st/';
      }
    }

    // 🌟 Tier 1: Native WASM Extraction 🌟
    if (streams.length === 0) {
      const wasmStream = await this._tryWasmExtraction(embedUrl, referer, matchTitle);
      if (wasmStream) {
        streams.push(wasmStream);
      }
    }

    // 🛡️ Tier 2: Client-side extraction via /watch?mode=extract 🛡️
    if (streams.length === 0) {
      streams.push(new StreamEntity({
        name: 'EmbedIndia',
        title: `${matchTitle} (Extract)`,
        externalUrl: `/watch?mode=extract&embed=${encodeURIComponent(embedUrl)}&referer=${encodeURIComponent(referer)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
      }));
    }

    // 🌍 Tier 3: Raw embed fallback - ALWAYS appended 🌍
    streams.push(new StreamEntity({
      name: 'EmbedIndia',
      title: `${matchTitle} (Web Player)`,
      externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
    }));

    return streams;
  }
}

module.exports = EmbedIndiaProvider;
