/**
 * DashUpstream — the only place that is allowed to fetch a URL on behalf of
 * /api/dash/*.
 *
 * Threat model: the URL is synthesised by the server from a signed payload, so
 * a client cannot name a host. The remaining ways an upstream fetch could reach
 * somewhere it should not:
 *
 *   1. a tampered/forged payload        -> handled by DashPayload (HMAC)
 *   2. a host that is not the CDN       -> host allowlist built from the MPD
 *   3. an IP literal / private hostname -> blocked before the request
 *   4. an allowlisted host that 302s to 169.254.169.254
 *                                       -> the *final* URL is re-checked after
 *                                          the fetch and the body is discarded
 *                                          if the host changed
 *
 * (4) is why `fetchGuarded` looks at `res.url` rather than trusting the request
 * URL. It cannot prevent the outbound connection — safeFetch owns the redirect
 * loop — but it does prevent returning the bytes, which is the exfiltration
 * step that matters.
 */

'use strict';

const net = require('net');

class UpstreamError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'UpstreamError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[/, '').replace(/\]$/, '');
}

function isBlockedIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;          // this-host, private, loopback
  if (p[0] === 169 && p[1] === 254) return true;                        // link-local incl. cloud metadata
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;            // private
  if (p[0] === 192 && p[1] === 168) return true;                        // private
  if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;            // IETF protocol assignments
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;           // CGNAT
  if (p[0] >= 224) return true;                                         // multicast / reserved
  return false;
}

function isBlockedIPv6(ip) {
  const h = ip.toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;  // link-local, ULA
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  return false;
}

function isBlockedHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (host === 'metadata.google.internal') return true;

  const family = net.isIP(host);
  if (family === 4) return isBlockedIPv4(host);
  if (family === 6) return isBlockedIPv6(host);
  return false;
}

/**
 * Builds the allowlist for one stream: the MPD host plus every host the parsed
 * MPD itself pointed at (segment/init URLs). Nothing client-supplied lands here.
 */
function buildPolicy(mpdUrl, extraUrls = []) {
  let base;
  try {
    base = new URL(mpdUrl);
  } catch (_) {
    throw new UpstreamError('INVALID_MPD_URL', `not a URL: ${mpdUrl}`);
  }
  const policy = {
    protocol: base.protocol,
    port: base.port || '',
    hosts: new Set([normalizeHost(base.hostname)])
  };
  for (const candidate of extraUrls) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      // Only same-protocol siblings; a http->https hop is never needed by these CDNs.
      if (url.protocol !== policy.protocol) continue;
      if ((url.port || '') !== policy.port) continue;
      const host = normalizeHost(url.hostname);
      if (!isBlockedHost(host)) policy.hosts.add(host);
    } catch (_) { /* ignore malformed */ }
  }
  return policy;
}

function assertAllowed(rawUrl, policy) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    throw new UpstreamError('SSRF_INVALID_URL', `not a URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamError('SSRF_PROTOCOL', `protocol ${url.protocol} not allowed`);
  }
  if (url.username || url.password) {
    throw new UpstreamError('SSRF_CREDENTIALS', 'credentials in URL are not allowed');
  }
  // Private/reserved targets are rejected before any policy comparison: they are
  // never legitimate, whatever the stream thinks its allowlist is.
  const host = normalizeHost(url.hostname);
  if (isBlockedHost(host)) {
    throw new UpstreamError('SSRF_PRIVATE_HOST', `host ${host} is private/reserved`);
  }
  if (policy && policy.protocol && url.protocol !== policy.protocol) {
    throw new UpstreamError('SSRF_PROTOCOL', `protocol ${url.protocol} not allowed`);
  }
  if (policy && policy.port !== undefined && (url.port || '') !== policy.port) {
    throw new UpstreamError('SSRF_PORT', `port ${url.port || '(default)'} not allowed`);
  }
  if (policy && policy.hosts && !policy.hosts.has(host)) {
    throw new UpstreamError('SSRF_HOST_NOT_ALLOWED', `host ${host} is not part of this stream`);
  }
  return url;
}

/**
 * @param {string} url
 * @param {object} opts {policy, headers, timeoutMs, attempts, maxBodyBytes, fetcher}
 * @returns {Promise<object>} the fetcher's response, with the final URL verified
 */
async function fetchGuarded(url, opts = {}) {
  assertAllowed(url, opts.policy);

  const fetcher = opts.fetcher;
  if (typeof fetcher !== 'function') throw new UpstreamError('NO_FETCHER', 'no fetcher configured');

  const res = await fetcher(url, {
    headers: opts.headers || {},
    timeoutMs: opts.timeoutMs || 15000,
    attempts: opts.attempts || 2,
    maxBodyBytes: opts.maxBodyBytes
  });

  const finalUrl = res && res.url;
  if (finalUrl && finalUrl !== url) {
    assertAllowed(finalUrl, opts.policy);
  }
  if (res && res.bodyTruncated) {
    throw new UpstreamError('BODY_TOO_LARGE', `upstream body exceeded ${opts.maxBodyBytes} bytes`);
  }
  return res;
}

/** Normalises a fetcher response into a Buffer without assuming arrayBuffer(). */
async function toBuffer(res) {
  if (!res) return Buffer.alloc(0);
  if (typeof res.arrayBuffer === 'function') {
    const ab = await res.arrayBuffer();
    return Buffer.isBuffer(ab) ? ab : Buffer.from(ab);
  }
  if (typeof res.text === 'function') return Buffer.from(await res.text(), 'utf8');
  if (Buffer.isBuffer(res.body)) return res.body;
  return Buffer.alloc(0);
}

module.exports = {
  UpstreamError,
  buildPolicy,
  assertAllowed,
  fetchGuarded,
  toBuffer,
  isBlockedHost,
  normalizeHost
};
