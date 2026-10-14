/**
 * config.js — Shared runtime configuration
 *
 * Centralizes the server's base URL so every module can build
 * correct absolute URLs (e.g. for the /watch proxy page).
 *
 * Priority order for base URL:
 *  1. RENDER_EXTERNAL_URL — automatically set by Render.com
 *  2. ADDON_URL           — manually set in .env (for other hosts)
 *  3. http://localhost:PORT — fallback for local development
 */

const os = require('os');
const path = require('path');

function getLocalIp() {
  try {
    const interfaces = os.networkInterfaces();
    const candidates = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
      const isVirtual = /warp|wsl|vethernet|virtual|vmware|loopback/i.test(name);
      for (const iface of addrs) {
        if (iface.family === 'IPv4' && !iface.internal) {
          // Prioritize non-virtual Wi-Fi or Ethernet LAN IPs (192.168.x.x or 10.x.x.x)
          if (!isVirtual && (iface.address.startsWith('192.168.') || iface.address.startsWith('10.'))) {
            return iface.address;
          }
          candidates.push({ address: iface.address, isVirtual });
        }
      }
    }
    const physical = candidates.find(c => !c.isVirtual);
    if (physical) return physical.address;
    if (candidates.length > 0) return candidates[0].address;
  } catch (_) {}
  return '127.0.0.1';
}

const PORT = parseInt(process.env.PORT, 10) || 7000;

function getRequestBaseUrl(req) {
  if (!req) return BASE_URL;
  if (process.env.ADDON_URL) return process.env.ADDON_URL.replace(/\/$/, '');

  // Protocol extraction (handles reverse proxies, Cloudflare, ngrok)
  let proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  if (typeof proto === 'string' && proto.includes(',')) {
    proto = proto.split(',')[0].trim();
  }
  if (req.headers['x-forwarded-ssl'] === 'on') {
    proto = 'https';
  }
  if (req.headers['cf-visitor']) {
    try {
      const visitor = JSON.parse(req.headers['cf-visitor']);
      if (visitor && visitor.scheme) proto = visitor.scheme;
    } catch (_) {}
  }

  // Host extraction (handles X-Forwarded-Host, Host header)
  let host = req.headers['x-forwarded-host'] || (req.get && req.get('host')) || req.headers.host;
  if (typeof host === 'string' && host.includes(',')) {
    host = host.split(',')[0].trim();
  }

  if (host) {
    if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
      return BASE_URL;
    }
    return `${proto}://${host}`.replace(/\/$/, '');
  }

  return BASE_URL;
}

const BASE_URL = (
  process.env.ADDON_URL ||                                      // Manual override for other hosts
  process.env.RENDER_EXTERNAL_URL ||                            // Render sets this automatically
  (process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : null) || // Azure automatically sets this
  `http://${getLocalIp()}:${PORT}`                              // Local dev fallback to LAN IP
).replace(/\/$/, '');                                           // Strip trailing slash if any

function envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function envInt(value, fallback, min) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min || 0, parsed);
}

function loadAuthConfig(env = process.env) {
  const required = envBool(env.AUTH_REQUIRED, false);
  const pepper = String(env.AUTH_TOKEN_PEPPER || '');
  if (required && pepper.length < 32) {
    throw new Error('AUTH_TOKEN_PEPPER must be at least 32 characters when AUTH_REQUIRED=true');
  }
  return {
    required,
    dbDriver: String(env.AUTH_DB_DRIVER || 'sqlite').toLowerCase(),
    dbPath: env.AUTH_DB_PATH || path.join(process.cwd(), 'data', 'auth.sqlite'),
    tokenPepper: pepper || 'development-only-auth-pepper-change-before-enabling',
    sessionTtlMs: envInt(env.AUTH_SESSION_TTL_HOURS, 168, 1) * 60 * 60 * 1000,
    deviceTokenTtlMs: envInt(env.AUTH_DEVICE_TOKEN_TTL_DAYS, 0, 0) * 24 * 60 * 60 * 1000,
    playbackTtlMs: envInt(env.AUTH_PLAYBACK_TTL_MINUTES, 30, 1) * 60 * 1000,
    playbackSessionTtlMs: envInt(env.AUTH_PLAYBACK_SESSION_TTL_HOURS, 12, 1) * 60 * 60 * 1000,
    cookieSecure: env.AUTH_COOKIE_SECURE === 'auto' || env.AUTH_COOKIE_SECURE === undefined
      ? /^https:/i.test(
        env.ADDON_URL ||
        env.RENDER_EXTERNAL_URL ||
        (env.WEBSITE_HOSTNAME ? `https://${env.WEBSITE_HOSTNAME}` : '')
      )
      : envBool(env.AUTH_COOKIE_SECURE, false),
    cookieName: 'nuvio_session',
  };
}

const AUTH_CONFIG = loadAuthConfig();

module.exports = { PORT, BASE_URL, getLocalIp, getRequestBaseUrl, AUTH_CONFIG, loadAuthConfig };
