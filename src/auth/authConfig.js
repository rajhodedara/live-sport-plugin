'use strict';

const crypto = require('crypto');

const DISCORD_SNOWFLAKE_RE = /^\d{17,22}$/;
const DISCORD_PUBLIC_KEY_RE = /^[0-9a-fA-F]{64}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function envInt(env, name, fallback) {
  const n = Number.parseInt(env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseCanonicalOrigin(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    return '';
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return '';
  if (parsed.pathname && parsed.pathname !== '/') return '';
  if (parsed.protocol === 'https:') return parsed.hostname ? parsed.origin : '';
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return parsed.origin;
  }
  return '';
}

function parseEd25519PublicKeyHex(rawHex) {
  const hex = String(rawHex || '').trim();
  if (!DISCORD_PUBLIC_KEY_RE.test(hex)) return '';
  try {
    crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return hex.toLowerCase();
  } catch (_) {
    return '';
  }
}

function loadDiscordConfig(env, baseEnabled) {
  const applicationId = String(env.AUTH_DISCORD_APPLICATION_ID || '').trim();
  const guildId = String(env.AUTH_DISCORD_GUILD_ID || '').trim();
  const roleId = String(env.AUTH_DISCORD_ROLE_ID || '').trim();
  const publicKeyHex = parseEd25519PublicKeyHex(env.AUTH_DISCORD_PUBLIC_KEY);
  const canonicalOrigin = parseCanonicalOrigin(env.ADDON_URL);
  const roleValid = roleId === '' || DISCORD_SNOWFLAKE_RE.test(roleId);

  const enabled = Boolean(
    baseEnabled
    && canonicalOrigin
    && DISCORD_SNOWFLAKE_RE.test(applicationId)
    && DISCORD_SNOWFLAKE_RE.test(guildId)
    && publicKeyHex
    && roleValid
  );

  return {
    enabled,
    applicationId,
    publicKeyHex,
    guildId,
    roleId,
    canonicalOrigin,
  };
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
    publicUrl: String(env.ADDON_URL || '').trim().replace(/\/+$/, ''),
    discord: loadDiscordConfig(env, enabled),
  };
}

module.exports = { loadAuthConfig, DISCORD_SNOWFLAKE_RE, ED25519_SPKI_PREFIX };
