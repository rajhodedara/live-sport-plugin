'use strict';
const { readResolverPublicIdentity } = require('./ResolverPublicIdentity');
const { createPinnedResolverUnixClients } = require('./ResolverUnixClients');
const { X509Certificate, createHash } = require('node:crypto');

// Experimental composition only, not wired to startup. Absence of the mode
// preserves existing behavior; explicitly selecting it must never downgrade.
function createConfiguredResolverTransport(env, dependencies = {}) {
  const mode = env.RESOLVER_TRANSPORT;
  if (mode === undefined || mode === '') return null;
  if (mode !== 'systemd-unix-tls') throw new TypeError('Invalid resolver transport mode');
  const readIdentity = dependencies.readIdentity || readResolverPublicIdentity;
  const createClients = dependencies.createClients || createPinnedResolverUnixClients;
  const tlsIdentity = readIdentity(env.RESOLVER_CERT_DIR, env.RESOLVER_TLS_SERVERNAME);
  // A malformed injected or future reader must fail before any socket request.
  if (!tlsIdentity || typeof tlsIdentity.certificatePem !== 'string' || !tlsIdentity.certificatePem ||
      typeof tlsIdentity.expectedHost !== 'string' || !tlsIdentity.expectedHost) {
    throw new Error('Resolver public certificate unavailable');
  }
  const clients = createClients({ socketPath: env.RESOLVER_SOCKET_PATH, legacyPort: env.RESOLVER_PORT || '7003', tlsIdentity });
  if (env.RESOLVER_IDENTITY_DIAGNOSTICS === 'true') {
    // This is the same DER certificate given to the transport, not a fresh
    // read of a file that might have changed since initialization. Logging is
    // best effort and opt-in; no paths, hostnames or certificate bytes escape.
    try {
      const sha256 = createHash('sha256').update(new X509Certificate(tlsIdentity.certificatePem).raw).digest('hex');
      (dependencies.identityLogger || console.info)('[ResolverIdentity]', JSON.stringify({ role: 'worker', pid: process.pid, sha256 }));
    } catch (_) { /* diagnostics must not change transport behavior */ }
  }
  return clients;
}

module.exports = { createConfiguredResolverTransport };
