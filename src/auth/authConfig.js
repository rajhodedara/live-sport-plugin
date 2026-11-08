'use strict';

function envInt(env, name, fallback) {
  const n = Number.parseInt(env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Loads SSO/account configuration from an env object (testable; no globals).
 * Accounts are enabled only when a pepper is set and the secrets are long enough;
 * provider availability is decided separately by each provider's isConfigured().
 */
function loadAuthConfig(env = process.env) {
  const pepper = String(env.AUTH_TOKEN_PEPPER || '');
  const encryptionKey = String(env.AUTH_ENCRYPTION_KEY || '');
  const enabled = pepper.length >= 32 && encryptionKey.length >= 32;
  return {
    enabled,
    pepper,
    encryptionKey,
    dbPath: env.AUTH_DB_PATH || 'data/accounts.sqlite',
    sessionTtlMs: envInt(env, 'AUTH_SESSION_TTL_HOURS', 168) * 3600 * 1000,
    deviceTokenTtlMs: envInt(env, 'AUTH_DEVICE_TOKEN_TTL_DAYS', 0) * 86400 * 1000, // 0 = no expiry
    cookieSecure: env.AUTH_COOKIE_SECURE || 'auto',
    publicUrl: String(env.ADDON_URL || '').replace(/\/+$/, ''),
  };
}

module.exports = { loadAuthConfig };
