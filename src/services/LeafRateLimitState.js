'use strict';

const { createHash } = require('node:crypto');
const MAX_RETRY_MS = 10 * 60 * 1000;
const cooldowns = new Map();

function accountKey(base) {
  let url;
  try { url = new URL(base); }
  catch (_) {
    // Whole-base operator overrides are validated by guarded transport. Quota
    // bookkeeping must not expose their text through a URL parser exception.
    return createHash('sha256').update('invalid\0' + String(base)).digest('hex');
  }
  let selector = url.pathname.split('/').filter(Boolean)[0] || '';
  try {
    const decoded = JSON.parse(Buffer.from(selector, 'base64url').toString('utf8'));
    if (typeof decoded?.freeUserId === 'string') selector = decoded.freeUserId;
    else if (typeof decoded?.userId === 'string') selector = decoded.userId;
  } catch (_) {}
  // UUID account identifiers are case-insensitive; profile path components
  // and regional hosts must not accidentally create separate quota buckets.
  selector = selector.replace(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\.|$)/i,
    value => value.toLowerCase());
  const host = url.hostname.toLowerCase();
  const family = host === 'highfly.to' || host.endsWith('.highfly.to') ||
    host === 'highfly.dev' || host.endsWith('.highfly.dev') ? 'highfly' : url.origin;
  // Keep account selectors out of diagnostic keys; regional hosts and profiles
  // still refer to the same upstream account-wide stream quota.
  return createHash('sha256').update(family + '\0' + selector).digest('hex');
}

function boundedDelay(value, fallback = 30000) {
  return Math.max(1000, Math.min(MAX_RETRY_MS, Number.isFinite(value) ? value : fallback));
}

function rateLimitDelay(response, streams = []) {
  const hints = [];
  try {
    const headers = response?.headers;
    const raw = typeof headers?.get === 'function' ? headers.get('retry-after') :
      Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
    const text = String(raw ?? '').trim();
    const ms = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 :
      /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) ? Date.parse(text) - Date.now() : NaN;
    if (Number.isFinite(ms)) hints.push(ms);
  } catch (_) {}
  for (const row of Array.isArray(streams) ? streams : []) {
    for (const text of [row?.name, row?.title, row?.description]) {
      if (typeof text !== 'string') continue;
      const match = text.match(/\b(?:please\s+)?wait\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i);
      if (!match) continue;
      const units = match[2].toLowerCase();
      const ms = Number(match[1]) * (units.startsWith('h') ? 3600000 : units.startsWith('m') ? 60000 : 1000);
      if (Number.isFinite(ms)) hints.push(ms);
    }
  }
  return boundedDelay(hints.length ? Math.max(...hints) : undefined);
}

function recordAccountRateLimit(base, retryAfterMs) {
  const key = accountKey(base);
  const now = Date.now();
  for (const [candidate, until] of cooldowns) if (until <= now) cooldowns.delete(candidate);
  const until = Math.max(cooldowns.get(key) || 0, now + boundedDelay(retryAfterMs));
  cooldowns.set(key, until);
  if (cooldowns.size > 64) cooldowns.delete(cooldowns.keys().next().value);
  return until - now;
}

function accountCooldownRemaining(base) {
  const key = accountKey(base);
  const remaining = (cooldowns.get(key) || 0) - Date.now();
  if (remaining <= 0) { cooldowns.delete(key); return 0; }
  return remaining;
}

function resetAccountRateLimits() { cooldowns.clear(); }

module.exports = { rateLimitDelay, recordAccountRateLimit, accountCooldownRemaining, resetAccountRateLimits };
