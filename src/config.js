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

module.exports = { PORT, BASE_URL, getLocalIp, getRequestBaseUrl };
