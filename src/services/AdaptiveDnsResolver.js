/**
 * AdaptiveDnsResolver.js - Dynamic, self-healing DNS resolution and anti-censorship circuit breaker.
 *
 * WHY THIS EXISTS
 * ---------------
 * In several jurisdictions (e.g. Spain, Italy, UK), local ISPs enforce streaming site
 * blocks using DNS Sinkholing (returning 127.0.0.1, 0.0.0.0, or NXDOMAIN for legitimate
 * public domains like dlive.sx or fullraces.com). When Node connects to 127.0.0.1:443,
 * it immediately fails with `ECONNREFUSED 127.0.0.1:443`.
 *
 * HOW THIS WORKS (Adaptive Circuit Breaker)
 * -----------------------------------------
 * 1. Zero overhead happy-path: System DNS (node:dns lookup) is queried first.
 *    Localhost, local subnets (.local, .internal), and standard public domains work
 *    normally with zero network overhead.
 * 2. Automated Sinkhole Detection:
 *    If a public domain resolves to a loopback/unspecified IP (127.0.0.0/8, 0.0.0.0, ::1)
 *    or returns ENOTFOUND/EAI_AGAIN, the resolver detects the poisoning attempt.
 * 3. Secure Fallback & Circuit Breaker:
 *    - Immediately re-resolves via trusted uncensored resolvers (1.1.1.1, 8.8.8.8) with
 *      secondary DoH (DNS-over-HTTPS) fallback if UDP port 53 is intercepted.
 *    - Trips the Circuit Breaker for that hostname to 'OPEN' state for 30 minutes.
 *    - While OPEN, future requests for that host bypass the broken system DNS entirely,
 *      eliminating failed connection attempts and latency.
 *    - After TTL, transitions to 'HALF-OPEN' to re-probe system DNS (self-healing if VPN
 *      is connected or ISP block is removed).
 */

'use strict';

const dns = require('node:dns');

class AdaptiveDnsResolver {
  constructor(options = {}) {
    this.primaryDnsServers = options.servers || [
      '1.1.1.1',
      '8.8.8.8',
      '1.0.0.1',
      '8.8.4.4',
      '9.9.9.9'
    ];

    this.circuitResetMs = options.circuitResetMs || 30 * 60 * 1000; // 30 minutes
    this.cacheTtlMs = options.cacheTtlMs || 5 * 60 * 1000;         // 5 minutes
    this.maxEntries = options.maxEntries || 1000;

    // host -> { state: 'OPEN', trippedAt: number, reason: string, ips: string[], cachedAt: number }
    this.poisonedHosts = new Map();
    // host -> { ips: string[], expiresAt: number }
    this.dnsCache = new Map();

    this.resolver = new dns.promises.Resolver();
    this.resolver.setServers(this.primaryDnsServers);

    // Bind lookup method for use as drop-in replacement for dns.lookup
    this.lookup = this.lookup.bind(this);
  }

  /**
   * Identifies if a hostname is local or already an IP literal.
   */
  isLocalOrReserved(hostname) {
    if (!hostname || typeof hostname !== 'string') return true;
    const h = hostname.toLowerCase().trim();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.test')) {
      return true;
    }
    // IPv4 literal: 1.2.3.4
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    // IPv6 literal: [::1] or fe80::...
    if (h.includes(':')) return true;
    return false;
  }

  /**
   * Checks if an IP address belongs to standard DNS sinkhole ranges.
   */
  isSinkholedIp(ip) {
    if (!ip || typeof ip !== 'string') return false;
    const clean = ip.trim();
    return clean.startsWith('127.') || clean === '0.0.0.0' || clean === '::1' || clean === '::';
  }

  /**
   * Checks whether the circuit breaker is currently OPEN for this host.
   */
  isPoisonedHost(hostname) {
    if (!hostname || this.isLocalOrReserved(hostname)) return false;
    const hostKey = hostname.toLowerCase().trim();
    const entry = this.poisonedHosts.get(hostKey);
    if (!entry) return false;

    if (Date.now() - entry.trippedAt > this.circuitResetMs) {
      // Transition to HALF-OPEN: allow a fresh system check
      this.poisonedHosts.delete(hostKey);
      return false;
    }

    return true;
  }

  /**
   * Trip the circuit breaker for a host explicitly (e.g. from connection refused on 127.0.0.1).
   */
  markPoisoned(hostname, reason = 'sinkholed') {
    if (this.isLocalOrReserved(hostname)) return;
    const hostKey = hostname.toLowerCase().trim();
    if (this.poisonedHosts.size >= this.maxEntries) {
      const oldest = this.poisonedHosts.keys().next().value;
      if (oldest) this.poisonedHosts.delete(oldest);
    }
    this.poisonedHosts.set(hostKey, {
      state: 'OPEN',
      trippedAt: Date.now(),
      reason: String(reason)
    });
  }

  /**
   * Resolves a hostname using uncensored public DNS, with fallback to DoH.
   */
  async resolveSecure(hostname) {
    const hostKey = hostname.toLowerCase().trim();
    const cached = this.dnsCache.get(hostKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.ips;
    }

    // Step 1: Direct UDP/TCP query via secure resolver (1.1.1.1, 8.8.8.8)
    try {
      const ips = await this.resolver.resolve4(hostKey);
      if (Array.isArray(ips) && ips.length > 0) {
        this._cacheResolved(hostKey, ips);
        return ips;
      }
    } catch (_) {
      // Step 2: Fallback to DoH (DNS-over-HTTPS) in case UDP port 53 is blocked/intercepted
      try {
        const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostKey)}&type=A`;
        const res = await fetch(dohUrl, {
          headers: { accept: 'application/dns-json' },
          signal: AbortSignal.timeout(3500)
        });
        if (res.ok) {
          const data = await res.json();
          const dohIps = (data.Answer || [])
            .filter(ans => ans.type === 1 && typeof ans.data === 'string')
            .map(ans => ans.data);
          if (dohIps.length > 0) {
            this._cacheResolved(hostKey, dohIps);
            return dohIps;
          }
        }
      } catch (dohErr) {
        // DoH also failed
      }
    }

    throw new Error(`AdaptiveDnsResolver: failed to resolve ${hostKey} via secure DNS`);
  }

  _cacheResolved(hostKey, ips) {
    if (this.dnsCache.size >= this.maxEntries) {
      const oldest = this.dnsCache.keys().next().value;
      if (oldest) this.dnsCache.delete(oldest);
    }
    this.dnsCache.set(hostKey, {
      ips,
      expiresAt: Date.now() + this.cacheTtlMs
    });
  }

  /**
   * Drop-in replacement for dns.lookup(hostname, [options], callback)
   */
  lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    // Pass-through for local, subnets, and raw IP literals
    if (this.isLocalOrReserved(hostname)) {
      return dns.lookup(hostname, options, callback);
    }

    const hostKey = hostname.toLowerCase().trim();

    // Fast-path: Circuit breaker is OPEN (known poisoned host)
    if (this.isPoisonedHost(hostKey)) {
      this.resolveSecure(hostKey)
        .then(ips => {
          if (options && options.all) {
            callback(null, ips.map(ip => ({ address: ip, family: 4 })));
          } else {
            callback(null, ips[0], 4);
          }
        })
        .catch(() => {
          // If secure resolution failed, fallback to system lookup as last resort
          dns.lookup(hostname, options, callback);
        });
      return;
    }

    // Standard path: Probe system DNS first
    dns.lookup(hostname, options, async (err, address, family) => {
      let isSinkholed = false;
      let badDetail = null;

      if (!err) {
        if (Array.isArray(address)) {
          isSinkholed = address.some(record => this.isSinkholedIp(record.address));
          badDetail = address.map(r => r.address).join(', ');
        } else if (this.isSinkholedIp(address)) {
          isSinkholed = true;
          badDetail = address;
        }
      }

      // Check if system DNS poisoned the response or threw NXDOMAIN
      const isDnsFailure = err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'ECONNREFUSED');
      const shouldFallback = isSinkholed || isDnsFailure;

      if (shouldFallback) {
        try {
          const ips = await this.resolveSecure(hostKey);
          if (ips && ips.length > 0) {
            this.markPoisoned(hostKey, badDetail || err?.code || 'sinkholed');
            console.log(`[AdaptiveDNS] 🛡️ DNS sinkhole/failure detected for "${hostKey}" (${badDetail || err?.code}). Dynamically routed through secure DNS -> ${ips.join(', ')}`);
            if (options && options.all) {
              return callback(null, ips.map(ip => ({ address: ip, family: 4 })));
            }
            return callback(null, ips[0], 4);
          }
        } catch (_) {
          // Both system and secure resolution failed, return original error/result
        }
      }

      return callback(err, address, family);
    });
  }
}

// Global Singleton
const adaptiveDnsResolver = new AdaptiveDnsResolver();

module.exports = adaptiveDnsResolver;
module.exports.AdaptiveDnsResolver = AdaptiveDnsResolver;
