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
const { extract } = require('../services/EmbedExtractorChain');

// ─────────────────────────────────────────────────────────────────────────────
// Domain flags: known CF-protected domains that must skip server-side scraping.
// Add new domains here — no code change to the provider class required.
// ─────────────────────────────────────────────────────────────────────────────
const CF_PROTECTED_DOMAINS = new Set([
  'embedindia.st',
  'embedindia.com',
  'embedsport.xyz',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Server-side User-Agent string (realistic Chrome on Windows)
// ─────────────────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

class EmbedIndiaProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'EmbedIndia';

    /**
     * failureCache — in-memory map of embed domain → timestamp of last failure.
     * If a domain has failed within FAILURE_TTL_MS, skip server-side attempt.
     * Decision D-08: prevents wasted bandwidth on known-failing CF domains.
     */
    this._failureCache = new Map();
    this.FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    /**
     * Wrap the embed HTML fetch in a circuit breaker to prevent cascading failures.
     */
    this._fetchEmbed = this.circuitBreaker.wrap(
      `${this.name}_fetchEmbed`,
      async (url, referer) => {
        const headers = {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': referer || 'https://embedindia.st/',
          'Connection': 'keep-alive',
        };
        
        const fetchOpts = { headers, signal: AbortSignal.timeout(10000) };

        // Route through residential proxy if available (bypasses Cloudflare block natively)
        if (process.env.RESIDENTIAL_PROXY) {
          const { ProxyAgent } = require('undici');
          fetchOpts.dispatcher = new ProxyAgent(process.env.RESIDENTIAL_PROXY);
        }

        const res = await fetch(url, fetchOpts);
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return res.text();
      }
    );
  }

  /**
   * EmbedIndiaProvider does not supply its own match catalog.
   * It is a stream-resolver only — other providers surface the embed URL
   * as a source, and this provider resolves it to a direct stream.
   */
  async getMatches() {
    return [];
  }

  /**
   * Check if server-side extraction should be skipped for this embed URL.
   * @param {string} embedUrl
   * @returns {boolean}
   */
  _shouldSkipServerSide(embedUrl) {
    // If we have a residential proxy, we never skip (it bypasses CF)
    if (process.env.RESIDENTIAL_PROXY) return false;

    try {
      const { hostname } = new URL(embedUrl);
      // Skip if known CF-protected domain (D-03 / S-03)
      if (CF_PROTECTED_DOMAINS.has(hostname)) return true;
      // Skip if recently failed (D-08 / CG-02)
      const lastFail = this._failureCache.get(hostname);
      if (lastFail && Date.now() - lastFail < this.FAILURE_TTL_MS) return true;
    } catch (_) {}
    return false;
  }

  /**
   * Mark a domain as recently failed in the failure cache.
   * @param {string} embedUrl
   */
  _markFailure(embedUrl) {
    try {
      const { hostname } = new URL(embedUrl);
      this._failureCache.set(hostname, Date.now());
    } catch (_) {}
  }

  /**
   * Attempt server-side HTML extraction.
   * Returns a StreamEntity on success, or null on failure.
   *
   * @param {string} embedUrl   The embed page URL
   * @param {string} referer    The referer to use when fetching the embed
   * @param {string} matchTitle Human-readable match title for logging
   * @returns {Promise<StreamEntity|null>}
   */
  async _tryServerSideExtraction(embedUrl, referer, matchTitle) {
    try {
      const html = await this._fetchEmbed.fire(embedUrl, referer);
      const result = extract(html);
      if (result) {
        console.log(`[EmbedIndia] Extracted M3U8: ${result.m3u8}`);
        const { BASE_URL } = require('../config');
        
        const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(result.m3u8)}&referer=${encodeURIComponent(result.referer)}&origin=${encodeURIComponent(new URL(result.referer).origin)}`;

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
      console.warn(`[${this.name}] Server-side extraction failed for ${embedUrl}: ${err.message}`);
    }
    return null;
  }

  /**
   * Resolve an embed URL to direct stream(s).
   *
   * @param {string} sourceId     The embed URL (stored as source.id in MatchEntity)
   * @param {string} matchCategory
   * @param {string} matchTitle
   * @param {object} [src]        The full source object (may contain referer hints)
   * @returns {Promise<StreamEntity[]>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];

    // sourceId is the embed URL for this provider
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

    // CF Worker edge-scraper removed per user request
    // ─── Tier 1: Server-side extraction ──────────────────────────────────────
    if (streams.length === 0 && !this._shouldSkipServerSide(embedUrl)) {
      const directStream = await this._tryServerSideExtraction(embedUrl, referer, matchTitle);
      if (directStream) {
        streams.push(directStream);
      } else {
        // Mark failure so we don't keep hammering a CF-protected domain (D-08)
        this._markFailure(embedUrl);
      }
    }

    // ─── Tier 2: Client-side extraction via /watch?mode=extract ─────────────
    // Only add if Tier 1 did not succeed (to keep the stream list clean)
    if (streams.length === 0) {
      streams.push(new StreamEntity({
        name: 'EmbedIndia',
        title: `${matchTitle} (Extract)`,
        // URL rewrite middleware in index.js will prefix this with BASE_URL
        externalUrl: `/watch?mode=extract&embed=${encodeURIComponent(embedUrl)}&referer=${encodeURIComponent(referer)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
      }));
    }

    // ─── Tier 3: Raw embed fallback — ALWAYS appended (UA-03 / D-07) ────────
    streams.push(new StreamEntity({
      name: 'EmbedIndia',
      title: `${matchTitle} (Web Player)`,
      externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
    }));

    return streams;
  }
}

module.exports = EmbedIndiaProvider;
