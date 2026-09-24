/**
 * OutboundUrlGuard.js — shared SSRF gate for every endpoint that fetches a
 * caller-supplied URL (/api/fastmp4, /api/mp4proxy, /api/hlschunk, /img).
 *
 * Policy (in order, first failure wins):
 *   1. The URL must parse and its protocol must be http: or https:.
 *   2. If STREAM_PROXY_ALLOWED_HOSTS is set (comma-separated), the hostname must
 *      match one entry exactly or as a dot-suffix (`ok.ru` also matches
 *      `cdn.ok.ru`). Unset => no hostname restriction, so live playback through
 *      rotating CDN hosts keeps working by default.
 *   3. Reserved names (localhost, `*.local`, `*.internal`, hostnames that are
 *      already an IP literal, ...) are rejected without a DNS lookup.
 *   4. The hostname is resolved at request time and EVERY returned address is
 *      classified: loopback, private (RFC1918), link-local (incl. the
 *      169.254.169.254 cloud-metadata address), unique-local (fc00::/7), CGNAT
 *      (100.64/10) and the other reserved ranges are all rejected. A public
 *      hostname that resolves to a private address is therefore blocked too —
 *      a string-only check would be bypassable via DNS.
 *
 * The allowlist is an ADDITIONAL restriction, never an override: a hostname it
 * permits still has to pass the address checks.
 *
 * Callers must run the gate BEFORE their first outbound request; a rejection is
 * a plain 403 with a machine-readable `reason`.
 *
 * No new dependencies: Node built-in `dns` + `net` only.
 */
'use strict';

const dns = require('dns');
const net = require('net');

const ALLOWLIST_ENV = 'STREAM_PROXY_ALLOWED_HOSTS';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Names that resolve locally (or not at all) and must never be dialled, even
// though they look like ordinary hostnames.
const BLOCKED_HOST_EXACT = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);
const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.home.arpa',
  '.onion',
  '.invalid',
  '.test',
  '.example',
];

// [network, prefix length, label]
const BLOCKED_IPV4 = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4-relay'],
  ['192.' + '168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const BLOCKED_IPV6 = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['fc00::', 7, 'unique-local'],
  ['fe80::', 10, 'link-local'],
  ['ff00::', 8, 'multicast'],
  ['100::', 64, 'discard-only'],
  ['2001:db8::', 32, 'documentation'],
  ['2001::', 32, 'teredo'],
  ['2002::', 16, '6to4'],
];

// ─── IPv4 helpers ────────────────────────────────────────────────────────────

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    n = (n * 256) + value;
  }
  return n >>> 0;
}

function ipv4InCidr(ipInt, base, bits) {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// ─── IPv6 helpers ────────────────────────────────────────────────────────────

function groupsToBytes(groups) {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const value = parseInt(groups[i], 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function ipv6ToBytes(ip) {
  let s = String(ip).toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);

  // Expand a dotted-quad tail (::ffff:127.0.0.1) into two hex groups.
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = ipv4ToInt(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = s.slice(0, lastColon + 1)
      + ((v4 >>> 16) & 0xffff).toString(16) + ':'
      + (v4 & 0xffff).toString(16);
  }

  const gap = s.indexOf('::');
  if (gap >= 0) {
    const head = s.slice(0, gap);
    const tail = s.slice(gap + 2);
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail ? tail.split(':') : [];
    const fill = 8 - headGroups.length - tailGroups.length;
    if (fill < 0) return null;
    return groupsToBytes([...headGroups, ...Array(fill).fill('0'), ...tailGroups]);
  }

  const groups = s.split(':');
  if (groups.length !== 8) return null;
  return groupsToBytes(groups);
}

function ipv6InCidr(bytes, base, bits) {
  const baseBytes = ipv6ToBytes(base);
  if (!bytes || !baseBytes) return false;
  const wholeBytes = bits >> 3;
  for (let i = 0; i < wholeBytes; i++) {
    if (bytes[i] !== baseBytes[i]) return false;
  }
  const remainder = bits & 7;
  if (remainder) {
    const mask = (0xff << (8 - remainder)) & 0xff;
    if ((bytes[wholeBytes] & mask) !== (baseBytes[wholeBytes] & mask)) return false;
  }
  return true;
}

/**
 * IPv4 address embedded in an IPv6 literal, if any: IPv4-mapped (::ffff:a.b.c.d),
 * NAT64 (64:ff9b::/96) and 6to4 (2002:AABB:CCDD::/48) forms.
 */
function extractEmbeddedIPv4(ip) {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return null;
  const dotted = (offset) => [...bytes.subarray(offset, offset + 4)].join('.');

  // ::ffff:0:0/96 — the address is the IPv4 one, so 127.0.0.1 can arrive as
  // ::ffff:127.0.0.1 and must inherit the IPv4 verdict.
  if (bytes.subarray(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return dotted(12);
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return dotted(12);                                 // 64:ff9b::/96 NAT64
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {        // 2002::/16 6to4
    return dotted(2);
  }
  return null;
}

// ─── Address classification ──────────────────────────────────────────────────

/**
 * Returns a short label ('loopback', 'private', ...) when the address must not
 * be dialled, or null when it is a usable public address.
 */
function classifyAddress(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') return null;
  let ip = rawIp.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!ip) return null;

  if (net.isIPv4(ip)) {
    const ipInt = ipv4ToInt(ip);
    if (ipInt === null) return 'malformed';
    for (const [base, bits, label] of BLOCKED_IPV4) {
      if (ipv4InCidr(ipInt, base, bits)) return label;
    }
    return null;
  }

  if (net.isIPv6(ip)) {
    const embedded = extractEmbeddedIPv4(ip);
    if (embedded) {
      const inner = classifyAddress(embedded);
      return inner ? `${inner} (embedded ${embedded})` : null;
    }
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return 'malformed';
    for (const [base, bits, label] of BLOCKED_IPV6) {
      if (ipv6InCidr(bytes, base, bits)) return label;
    }
    return null;
  }

  return null;
}

function isBlockedAddress(ip) {
  return classifyAddress(ip) !== null;
}

// ─── Hostname allowlist ──────────────────────────────────────────────────────

/**
 * Parse STREAM_PROXY_ALLOWED_HOSTS. Returns null when the operator has not set
 * it (or set it to an empty value) — meaning "no hostname restriction".
 */
function getAllowedHosts(raw = process.env[ALLOWLIST_ENV]) {
  if (typeof raw !== 'string') return null;
  const entries = raw
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .map(entry => (entry.startsWith('*.') ? entry.slice(2) : entry))
    .map(entry => (entry.startsWith('.') ? entry.slice(1) : entry))
    .filter(Boolean);
  return entries.length ? entries : null;
}

function matchesAllowedHost(hostname, patterns) {
  if (!patterns || !patterns.length) return true;   // unset => unrestricted
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return patterns.some(pattern => host === pattern || host.endsWith(`.${pattern}`));
}

// ─── Hostname safety ─────────────────────────────────────────────────────────

function isReservedHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (BLOCKED_HOST_EXACT.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

// ─── Default resolver ────────────────────────────────────────────────────────

async function defaultResolve(hostname) {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}

// ─── The gate ────────────────────────────────────────────────────────────────

/**
 * Validate an outbound URL.
 *
 * @param {string} rawUrl       the exact string that will be handed to fetch()
 * @param {object} [options]
 * @param {string[]|null} [options.allowedHosts] override the env allowlist
 * @param {Function} [options.resolve]           injectable DNS resolver
 * @returns {Promise<{ok:true,url:string,hostname:string,addresses:string[]}
 *                 | {ok:false,reason:string,detail:string}>}
 */
async function checkOutboundUrl(rawUrl, options = {}) {
  const allowedHosts = options.allowedHosts !== undefined
    ? options.allowedHosts
    : getAllowedHosts();
  const resolve = options.resolve || defaultResolve;

  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, reason: 'invalid_url', detail: 'missing url' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return { ok: false, reason: 'invalid_url', detail: 'url did not parse' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: 'protocol_not_allowed', detail: parsed.protocol.replace(/:$/, '') };
  }

  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (!hostname) {
    return { ok: false, reason: 'invalid_url', detail: 'missing hostname' };
  }

  // An IP literal is classified directly; there is nothing to resolve.
  const isLiteral = net.isIPv4(hostname) || net.isIPv6(hostname);

  if (!matchesAllowedHost(hostname, allowedHosts)) {
    return { ok: false, reason: 'host_not_allowlisted', detail: hostname };
  }

  if (isLiteral) {
    const label = classifyAddress(hostname);
    if (label) return { ok: false, reason: 'blocked_address', detail: `${hostname} (${label})` };
    return { ok: true, url: parsed.toString(), hostname, addresses: [hostname] };
  }

  if (isReservedHostname(hostname)) {
    return { ok: false, reason: 'blocked_host', detail: hostname };
  }

  let addresses;
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    // Fail closed: an unresolvable host could not have been fetched anyway, and
    // resolving after the connection is exactly the race this gate exists for.
    return { ok: false, reason: 'dns_resolution_failed', detail: `${hostname}: ${err && err.code ? err.code : 'lookup failed'}` };
  }

  if (!addresses || !addresses.length) {
    return { ok: false, reason: 'dns_resolution_failed', detail: `${hostname}: no addresses` };
  }

  for (const address of addresses) {
    const label = classifyAddress(address);
    if (label) return { ok: false, reason: 'blocked_address', detail: `${address} (${label})` };
  }

  return { ok: true, url: parsed.toString(), hostname, addresses };
}

/**
 * Send the canonical 403 for a failed verdict. Returns true so callers can write
 * `if (!verdict.ok) return rejectBlockedUrl(res, verdict, tag);`.
 */
function rejectBlockedUrl(res, verdict, tag = 'ssrf-guard') {
  const reason = verdict && verdict.reason ? verdict.reason : 'blocked';
  const detail = verdict && verdict.detail ? verdict.detail : '';
  console.warn(`[${tag}] Blocked outbound URL (${reason}): ${detail}`);
  if (res.headersSent) return true;
  res.status(403).json({ error: 'Blocked outbound URL', reason, detail });
  return true;
}

module.exports = {
  ALLOWLIST_ENV,
  checkOutboundUrl,
  rejectBlockedUrl,
  classifyAddress,
  isBlockedAddress,
  getAllowedHosts,
  matchesAllowedHost,
  isReservedHostname,
};
