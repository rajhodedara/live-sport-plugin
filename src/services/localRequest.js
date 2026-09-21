/**
 * localRequest.js — is this request a DIRECT local hit, or did it arrive through
 * the public reverse proxy?
 *
 * Why this exists: the production reverse proxy runs on the SAME host as this
 * app, so every public request arrives with a loopback socket peer. Inferring
 * "local" from the socket address alone therefore marks the whole internet as
 * local. The reliable signal is the ABSENCE of forwarding headers: anything that
 * traversed the proxy carries at least one of them.
 *
 * Policy (all must hold to count as local):
 *   1. No forwarding header: x-forwarded-for, forwarded, x-real-ip,
 *      cf-connecting-ip.
 *   2. The TCP peer is loopback or RFC1918 (a LAN client hitting the app
 *      directly, e.g. a phone on the same network).
 *
 * Consumers: /api/server-info (only reveals the origin LAN IP to a local caller)
 * and /api/matches (local debugging surface).
 *
 * NOTE: deliberately does NOT use req.ip — with \`trust proxy\` enabled that value
 * is derived from X-Forwarded-For and is therefore caller-controlled.
 */
'use strict';

const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
];

function hasForwardingHeader(req) {
  if (!req || !req.headers) return false;
  return FORWARDING_HEADERS.some((name) => {
    const value = req.headers[name];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    return String(value).trim() !== '';
  });
}

function isPrivateOrLoopback(addr) {
  if (!addr) return false;
  let ip = String(addr);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  // 172.16.0.0 - 172.31.255.255
  const m = /^172\.(\d{1,3})\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function isLocalDirectRequest(req) {
  if (!req) return false;
  if (hasForwardingHeader(req)) return false;
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return isPrivateOrLoopback(addr);
}

module.exports = { isLocalDirectRequest, hasForwardingHeader, isPrivateOrLoopback, FORWARDING_HEADERS };
