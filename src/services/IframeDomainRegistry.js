'use strict';
/**
 * IframeDomainRegistry — self-healing knowledge base for DaddyLive-family
 * embed/iframe domains.
 *
 * WHY THIS EXISTS
 * DaddyLive rotates the domains it embeds through (new subdomains appear, node
 * numbers change, whole families are swapped). Hard-coding each one in the
 * provider means a new domain silently breaks resolution until someone edits
 * code. This registry instead remembers, per domain family:
 *
 *   - what ROLE the domain plays (wrapper / embed / provider)
 *   - which DECODER STRATEGY actually worked on it
 *   - the Referer that made the manifest load
 *
 * Lookup is by registrable suffix, so rotating node prefixes
 * (edgestream5.pro, <32-hex>.dynproclaim.net) collapse onto one family. The
 * provider consults this before falling back to blind trial, and records any
 * strategy it discovers at runtime — so a rotated domain is learned on first
 * use rather than requiring a code change.
 *
 * Newly-learned hosts live in memory only. Junk domains learned from volatile
 * player pages (vk.com, cloudflare, analytics hosts...) are never persisted,
 * and are deprioritised on lookup. Use scripts/selfheal-iframe-domains.js --update
 * to promote discoveries into src/data/iframe_domains.json.
 *
 * It is advisory: a registry miss or an unavailable file must never stop a
 * stream from resolving.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'iframe_domains.json');

// Domains that are platform/CDN noise rather than stream embeds. Learned but
// never persisted, and not offered as candidates.
const IGNORED_SLUGS = new Set([
  'vk.com', 'cloudflare.com', 'jsdelivr.net', 'jquery.com', 'jquery.org',
  'google.com', 'gstatic.com', 'googleapis.com', 'googletagmanager.com',
  'amung.us', 'histats.com', 'doubleclick.net', 'facebook.net', 'facebook.com',
  'twitter.com', 'youtube.com', 'bootstrapcdn.com', 'cdnjs.cloudflare.com',
  'google-analytics.com', 'hotjar.com', 'sentry.io', 'unpkg.com',
  'w3.org', 'schema.org', 'example.com', 'stremio-addons.net',
  'clappr.io', 'swarmcloud.net', 'hlspatch.net'
]);

function normalizeHost(host) {
  if (!host || typeof host !== 'string') return '';
  let h = host.trim().toLowerCase();
  h = h.replace(/:\d+$/, '');           // strip port
  h = h.replace(/^\.+/, '').replace(/\.+$/, '');
  return h;
}

/**
 * Collapse a hostname onto its registrable-ish suffix so rotating node prefixes
 * collapse onto one family:  b9x39g.a737cozfwjmm.net -> a737cozfwjmm.net
 *                            edgestream7.pro         -> edgestream.pro
 *                            <32hex>.dynproclaim.net -> dynproclaim.net
 *
 * Not a full public-suffix-list implementation (no dependency); the two-part
 * rule is sufficient because every family observed uses either a 2-label apex
 * or a numbered/nonce'd prefix on one.
 */
function toSlug(host) {
  const h = normalizeHost(host);
  if (!h || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
  const parts = h.split('.');
  if (parts.length <= 2) {
    // Even a bare "edgestream7.pro" must collapse to "edgestream.pro" - the
    // node number rotates, so matching the literal host would miss the next one.
    const [sld2, tld2] = parts;
    if (parts.length === 2 && /^edgestream\d*$/.test(sld2)) return `edgestream.${tld2}`;
    return h;
  }
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  // known multi-part TLDs used by these providers
  const multiTlds = new Set(['co.uk', 'com.au', 'co.nz', 'com.br']);
  const lastTwo = `${sld}.${tld}`;
  if (multiTlds.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  // Collapse a rotating numeric / hex node prefix onto the base family.
  if (/^edgestream\d*$/.test(sld)) return `edgestream.${tld}`;
  return `${sld}.${tld}`;
}

function safeReadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const j = JSON.parse(raw);
    return {
      families: (j && j.families) || {},
      terminal_hosts: (j && j.terminal_hosts) || {}
    };
  } catch (_) {
    return { families: {}, terminal_hosts: {} };
  }
}

class IframeDomainRegistry {
  constructor() {
    const seed = safeReadData();
    /** slug -> record (seeded from disk + runtime discoveries) */
    this.families = new Map();
    for (const [slug, rec] of Object.entries(seed.families)) {
      this.families.set(slug, Object.assign({ source: 'file' }, rec));
    }
    /** terminal host slug -> { referer } */
    this.terminalHosts = new Map(Object.entries(seed.terminal_hosts));

    /** slots (slug -> strategy) discovered at runtime this process */
    this._learnedStrategies = new Map();
    this._loadError = null;
  }

  /** True when the registry loaded a non-empty knowledge base from disk. */
  get isLoaded() {
    return this.families.size > 0;
  }

  /** Record for a host, or null. Matches by family slug. */
  get(host) {
    const slug = toSlug(host);
    if (!slug) return null;
    return this.families.get(slug) || null;
  }

  /** True when we already know this host family. */
  has(host) {
    return !!this.get(host);
  }

  /** True when the host is platform noise that should never become a candidate. */
  isIgnored(host) {
    const slug = toSlug(host);
    return IGNORED_SLUGS.has(slug) || IGNORED_SLUGS.has(normalizeHost(host));
  }

  /** Referer to use for a terminal stream host (falls back to its own origin). */
  refererFor(host) {
    const h = normalizeHost(host);
    const slug = toSlug(h);
    for (const key of [h, slug]) {
      const rec = this.terminalHosts.get(key);
      if (rec && rec.referer) return rec.referer;
    }
    return `https://${h}/`;
  }

  /** The strategy known to work for this host, if any. */
  strategyFor(host) {
    const discovered = this._learnedStrategies.get(toSlug(host));
    if (discovered) return discovered;
    const rec = this.get(host);
    return rec && rec.strategy && rec.strategy !== 'unknown' ? rec.strategy : null;
  }

  /**
   * Learn (or correct) the strategy that actually resolved a host. Runtime-only:
   * a strategy must repeat to be considered stable, and we never overwrite a
   * file-seeded entry with a single observation.
   */
  learn(host, strategy, meta = {}) {
    const slug = toSlug(host);
    if (!slug || !strategy) return false;
    if (this.isIgnored(host)) return false;

    const existing = this.families.get(slug);
    if (existing) {
      // already known: only annotate timing, never clobber the documented strategy
      if (meta.referer && !existing.referer) existing.referer = meta.referer;
      return false;
    }

    this._learnedStrategies.set(slug, strategy);
    this.families.set(slug, Object.assign({
      role: 'unknown',
      strategy,
      referer: meta.referer || `https://${normalizeHost(host)}/`,
      first_seen: new Date().toISOString().slice(0, 10),
      source: 'runtime'
    }, meta.role ? { role: meta.role } : {}));
    return true;
  }

  /**
   * Candidate hosts worth probing for a frame, ordered by likelihood:
   * known embed hosts first, unknown second, platform noise dropped.
   * @param {string[]} hosts
   */
  rankCandidates(hosts) {
    const uniq = [...new Set((hosts || []).map(normalizeHost).filter(Boolean))];
    const scored = uniq.map((h) => {
      if (this.isIgnored(h)) return { host: h, score: -1 };
      const rec = this.get(h);
      let score = 0;
      if (rec) {
        if (rec.role === 'embed') score += 30;
        else if (rec.role === 'wrapper') score += 20;
        else if (rec.role === 'provider') score += 5;
        if (rec.strategy && rec.strategy !== 'unknown') score += 15; // known decoder
      }
      return { host: h, score };
    });
    return scored
      .filter((s) => s.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.host);
  }

  /** Snapshot for diagnostics/scripts. */
  toJSON() {
    return {
      loaded: this.isLoaded,
      families: Object.fromEntries(
        [...this.families.entries()].map(([k, v]) => [k, {
          role: v.role, strategy: v.strategy, referer: v.referer,
          first_seen: v.first_seen, source: v.source
        }])
      ),
      terminal_hosts: Object.fromEntries(this.terminalHosts)
    };
  }
}

module.exports = IframeDomainRegistry;
module.exports.toSlug = toSlug;
module.exports.normalizeHost = normalizeHost;
module.exports.IGNORED_SLUGS = IGNORED_SLUGS;
