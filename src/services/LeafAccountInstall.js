'use strict';

/**
 * Per-account Leaf/Highfly install lookup. Kept dependency-free so Leaf code does
 * not import the auth stack; the server registers a resolver at startup.
 * Returns an install object ({configured, apiBase, origin, mode}) or null, in which
 * case callers fall back to the shared (operator) install.
 */
let resolver = null;

function setResolver(fn) { resolver = typeof fn === 'function' ? fn : null; }

function installForUser(userId) {
  if (!userId || typeof userId !== 'string' || !resolver) return null;
  try { return resolver(userId) || null; } catch (_) { return null; }
}

module.exports = { setResolver, installForUser };
