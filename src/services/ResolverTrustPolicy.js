'use strict';

// Plain loopback TCP has no peer authentication. It is a compatibility mode
// only for operators who explicitly trust every process on the local host.
function allowsLegacyResolverTcp(env = process.env) {
  return (!env.RESOLVER_TRANSPORT || env.RESOLVER_TRANSPORT === '') &&
    env.RESOLVER_TRUST_LEGACY_TCP === 'true';
}

function allowsResolverRouting(env = process.env) {
  // Startup validates and constructs the pinned client before mounting routes.
  return env.RESOLVER_TRANSPORT === 'systemd-unix-tls' || allowsLegacyResolverTcp(env);
}

function createResolverTrustGate(env = process.env) {
  return function resolverTrustGate(_req, res, next) {
    if (allowsResolverRouting(env)) return next();
    return res.status(503).send('Internal stream resolver transport is not configured.');
  };
}

module.exports = { allowsLegacyResolverTcp, allowsResolverRouting, createResolverTrustGate };
