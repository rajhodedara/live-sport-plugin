// Hardcoded CF proxy pool — add more URLs to multiply free-tier limits
const CF_PROXY_POOL = [];
if (process.env.CF_PROXY_URL) {
  CF_PROXY_POOL.push(process.env.CF_PROXY_URL);
}

// Safe impit wrapper — falls back to undici when impit native binary is
// unavailable (ARM64 VPS, Alpine/musl Linux, certain Windows Server builds).
const { safeFetch: _safeFetch } = require('../impitClient');

// Pick a random proxy from the pool
function getCfProxyUrl() {
  if (process.env.NODE_ENV === 'test') return null;
  if (CF_PROXY_POOL.length === 0) return null;
  return CF_PROXY_POOL[Math.floor(Math.random() * CF_PROXY_POOL.length)];
}

class BaseProvider {
  constructor({ circuitBreaker }) {
    this.circuitBreaker = circuitBreaker;
    this.name = 'BaseProvider';
  }

  /**
   * Fetch matches from the provider.
   * Should return an array of MatchEntity objects.
   */
  async getMatches() {
    throw new Error('getMatches() must be implemented by subclasses');
  }

  /**
   * Resolve a specific stream source.
   * Should return an array of StreamEntity objects.
   */
  async resolveStream(sourceId, matchCategory, matchTitle) {
    return [];
  }

  /**
   * Helper to normalize category strings across all providers
   */
  normalizeCategory(cat) {
    if (!cat) return 'other';
    if (typeof cat === 'object' && !Array.isArray(cat)) {
      cat = cat.name || cat.title || 'other';
    }
    cat = String(cat).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cat.includes('ncaa') || cat.includes('college')) return 'college';
    if (cat.includes('americanfootball') || cat.includes('nfl') || cat.includes('afl') || cat.includes('gridiron') || cat.includes('aussierules')) return 'american_football';
    if (cat.includes('soccer') || cat.includes('football')) return 'football';
    // 'mixedmartialarts' must be caught before the generic checks below — the
    // upstream label "Mixed Martial Arts" normalized to 'mixedmartialarts', a
    // string that matched no catalog id and no live-window duration, so every
    // MMA event was silently invisible (TimStreams was emitting this shape).
    if (cat.includes('mixedmartialart') || cat.includes('martialart') || cat.includes('mmaglobal')) return 'mma';
    if (cat.includes('fight') || cat.includes('mma') || cat.includes('boxing') || cat.includes('wrestling') || cat.includes('knuckle') || cat.includes('ufc')) return 'mma';
    if (cat.includes('formula1') || cat.includes('motogp') || cat.includes('moto') || cat.includes('motor') || cat.includes('racing') || cat.includes('cycling') || cat.includes('f1')) return 'motorsport';
    if (cat.includes('basketball') || cat.includes('nba')) return 'basketball';
    if (cat.includes('pga') || cat.includes('golf')) return 'golf';
    if (cat.includes('rugby')) return 'rugby';
    if (cat.includes('cricket')) return 'cricket';
    if (cat.includes('tennis')) return 'tennis';
    if (cat.includes('hockey') || cat.includes('nhl')) return 'hockey';
    if (cat.includes('baseball') || cat.includes('mlb')) return 'baseball';
    if (cat.includes('darts')) return 'darts';
    if (cat.includes('liveshow') || cat.includes('uncategorized')) return 'other';

    // Canonical allowlist. Anything the catalogs do not know about belongs in
    // 'other' (rendered as "Other Sports") rather than under its own ad-hoc id,
    // which no catalog queries and which therefore hides the event entirely.
    const CANONICAL = new Set([
      'football', 'cricket', 'basketball', 'motorsport', 'hockey', 'baseball',
      'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts',
      'college', 'networks', 'other'
    ]);
    if (CANONICAL.has(cat)) return cat;
    return 'other';
  }


  /**
   * Fetch wrapper that routes through Cloudflare proxy if configured
   */
  async proxyFetch(url, options = {}) {
    const cfProxyUrl = getCfProxyUrl();
    if (cfProxyUrl) {
      const proxyUrl = new URL(cfProxyUrl);
      proxyUrl.searchParams.set('url', url);
      
      if (options.headers) {
        let referer, origin;
        if (options.headers instanceof Headers) {
          referer = options.headers.get('referer') || options.headers.get('Referer');
          origin = options.headers.get('origin') || options.headers.get('Origin');
        } else {
          referer = options.headers.referer || options.headers.Referer;
          origin = options.headers.origin || options.headers.Origin;
        }
        
        if (referer) proxyUrl.searchParams.set('referer', referer);
        if (origin) proxyUrl.searchParams.set('origin', origin);
      }
      
      url = proxyUrl.toString();
    }
    
    // safeFetch tries impit first (browser TLS fingerprint), falls back to
    // undici automatically — works on Windows, Linux x64, ARM64, musl, etc.

    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      timeoutMs: 15000,
    };

    // safeFetch tries impit first (browser TLS fingerprint), falls back to
    // undici automatically — works on Windows, Linux x64, ARM64, musl, etc.
    return await _safeFetch(url, reqOptions);
  }

  /**
   * Helper to normalize strings for fuzzy matching
   */
  normalizeStr(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

module.exports = BaseProvider;
module.exports.getCfProxyUrl = getCfProxyUrl;
