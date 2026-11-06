'use strict';

const DEFAULT_FREE_ORIGIN = 'https://sports.highfly.to';
const DEFAULT_PREMIUM_ORIGIN = 'https://premium.highfly.to';
const PUBLIC_LEAF_ORIGINS = Object.freeze(['to', 'dev'].flatMap(tld =>
  ['sports', 'premium', 'premium-us2', 'premium-eu1'].map(host => `https://${host}.highfly.${tld}`)));
const PREMIUM_ORIGINS = PUBLIC_LEAF_ORIGINS.filter(origin => !origin.startsWith('https://sports.'));
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_REGEX = /^p[a-z0-9]{6}$/;

function configError() {
  return Object.assign(new Error('Invalid Leaf configuration'), { code: 'ERR_LEAF_CONFIG' });
}

function isHighflyHost(host) {
  return host === 'highfly.to' || host.endsWith('.highfly.to') ||
    host === 'highfly.dev' || host.endsWith('.highfly.dev');
}

function isPremiumOrigin(origin) {
  try { return /(?:^|\.)premium(?:-[a-z0-9-]+)?\.highfly\.(?:to|dev)$/i.test(new URL(origin).hostname); }
  catch (_) { return false; }
}

function stripManifest(value) {
  return value.replace(/\/+$/, '').replace(/(?:^|\/)manifest\.json$/i, '').replace(/\/+$/, '');
}

function installUrl(input) {
  if (/^(?:https?|stremio):\/\//i.test(input)) {
    try { return new URL(input); } catch (_) { throw configError(); }
  }
  if (/^(?:[a-z0-9-]+\.)*highfly\.(?:to|dev)(?:[/:?#]|$)/i.test(input)) {
    try { return new URL(`https://${input}`); } catch (_) { throw configError(); }
  }
  return null;
}

function jsonConfig(input) {
  for (const candidate of [input, Buffer.from(input, 'base64url').toString('utf8')]) {
    try {
      const parsed = JSON.parse(candidate);
      // Explicit free identifiers preserve every legacy metadata property.
      if (parsed && (parsed.freeUserId || parsed.userId)) return { kind: 'free', value: parsed, encoded: candidate !== input };
      if (parsed && typeof parsed === 'object' &&
          ['token', 'profile', 'premiumToken', 'premiumProfile'].some(key => Object.hasOwn(parsed, key))) return { kind: 'premium' };
    } catch (_) {}
  }
  return null;
}

function premiumPath(token, profile = '') {
  if (typeof token !== 'string' || !UUID_REGEX.test(token) ||
      typeof profile !== 'string' || (profile && !PROFILE_REGEX.test(profile))) throw configError();
  return `${token}${profile ? `/${profile}` : ''}`;
}

function configurePath(input) {
  const parts = input.slice('configure#'.length).split(':');
  if (parts.length > 2 || (parts.length === 2 && !parts[1])) throw configError();
  return premiumPath(parts[0], parts[1] || '');
}

function configPath(rawInput) {
  const parsed = installUrl(rawInput);
  if (!parsed) {
    if (/highfly\.(?:to|dev)/i.test(rawInput)) throw configError();
    return rawInput.startsWith('configure#') ? configurePath(rawInput) : rawInput;
  }
  const authority = rawInput.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  if (!isHighflyHost(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.port || parsed.search ||
      authority.includes('@') || /[\\\u0000-\u001f\u007f]/.test(rawInput) ||
      /\/(?:\.|%2e){1,2}(?:[/?#]|$)/i.test(rawInput)) throw configError();
  if (parsed.pathname === '/configure') return configurePath(`configure${parsed.hash}`);
  if (parsed.hash) throw configError();
  return parsed.pathname.replace(/^\/+/, '');
}

/** Preserve current origin detection, including schemeless URLs and bare UUIDs. */
function extractOrigin(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const input = rawInput.trim();
  try {
    const parsed = installUrl(input);
    if (parsed) return parsed.protocol === 'stremio:' ? `https://${parsed.host.toLowerCase()}` : parsed.origin;
  } catch (_) { return null; }
  const path = stripManifest(input);
  if (UUID_REGEX.test(path.split('/')[0]) || input.startsWith('configure#')) return DEFAULT_PREMIUM_ORIGIN;
  return null;
}

/** Keep free JSON formats and premium UUID/profile paths without losing profiles. */
function normalizeConfigBlob(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  const input = rawInput.trim();
  const json = jsonConfig(input);
  if (json?.kind === 'free') return json.encoded ? input : Buffer.from(JSON.stringify(json.value)).toString('base64url');
  if (json?.kind === 'premium') throw configError();
  const path = stripManifest(configPath(input)).replace(/^\/+|\/+$/g, '');
  if (!path) return '';
  const pathJson = jsonConfig(path);
  if (pathJson?.kind === 'free') return pathJson.encoded ? path : Buffer.from(JSON.stringify(pathJson.value)).toString('base64url');
  if (pathJson?.kind === 'premium') throw configError();
  const parts = path.split('/');
  if (UUID_REGEX.test(parts[0])) {
    if (parts.length > 2) throw configError();
    return premiumPath(parts[0], parts[1] || '');
  }
  if (parts.length > 1 && (PROFILE_REGEX.test(parts[1]) || !parts[0].includes('.'))) throw configError();
  if (path.includes('.') || path.length > 20) return Buffer.from(JSON.stringify({ freeUserId: path })).toString('base64url');
  return path;
}

function explicitPremiumOrigin(value) {
  if (typeof value !== 'string' ||
      !/^https:\/\/(?:premium|premium-us2|premium-eu1)\.highfly\.(?:to|dev)\/?$/i.test(value)) throw configError();
  const origin = new URL(value).origin;
  if (!PREMIUM_ORIGINS.includes(origin)) throw configError();
  return origin;
}

/**
 * Pure shared install selection. Legacy operator origins retain their precedence;
 * the guarded transport validates every actual request, DNS result and redirect.
 */
function resolveLeafInstallConfig(env = process.env) {
  if (env.LEAF_API_URL) {
    const apiBase = stripManifest(env.LEAF_API_URL);
    let origin = DEFAULT_FREE_ORIGIN;
    try { origin = new URL(apiBase).origin; } catch (_) {}
    return { configured: true, apiBase, origin, mode: 'override' };
  }
  if (env.LEAF_PREMIUM_TOKEN || env.LEAF_PREMIUM_PROFILE) {
    const origin = env.LEAF_API_ORIGIN ? explicitPremiumOrigin(env.LEAF_API_ORIGIN) : DEFAULT_PREMIUM_ORIGIN;
    const path = premiumPath(env.LEAF_PREMIUM_TOKEN, env.LEAF_PREMIUM_PROFILE || '');
    return { configured: true, apiBase: `${origin}/${path}`, origin, mode: 'premium' };
  }
  const rawConfig = env.LEAF_INSTALL_CONFIG || env.LEAF_FREE_USER_ID || '';
  const config = normalizeConfigBlob(rawConfig);
  const detectedOrigin = extractOrigin(rawConfig);
  const origin = (env.LEAF_API_ORIGIN || detectedOrigin || DEFAULT_FREE_ORIGIN).replace(/\/+$/, '');
  const premium = UUID_REGEX.test(config.split('/')[0]) || isPremiumOrigin(origin) || isPremiumOrigin(detectedOrigin);
  if (premium) {
    const parts = config.split('/');
    if (parts.length > 2) throw configError();
    premiumPath(parts[0], parts[1] || '');
  }
  return { configured: Boolean(config), apiBase: config ? `${origin}/${config}` : origin, origin, mode: premium ? 'premium' : 'free' };
}

module.exports = { resolveLeafInstallConfig, normalizeConfigBlob, extractOrigin, UUID_REGEX, PUBLIC_LEAF_ORIGINS };
