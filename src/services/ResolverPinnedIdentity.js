'use strict';
const { X509Certificate, createHash, timingSafeEqual } = require('node:crypto');
const { checkServerIdentity } = require('node:tls');

// Experimental certificate identity check, not wired to a client or server.
// A TLS handshake must also enforce trusted-CA and certificate validity checks
// with rejectUnauthorized enabled. This callback alone is not authentication.
function createPinnedResolverIdentity({ certificatePem, expectedHost }) {
  if (typeof certificatePem !== 'string' || Buffer.byteLength(certificatePem) > 65536 ||
      typeof expectedHost !== 'string' || !expectedHost || expectedHost.length > 255) {
    throw new TypeError('Invalid resolver identity configuration');
  }
  const pin = createHash('sha256').update(new X509Certificate(certificatePem).raw).digest();
  return function verifyResolverIdentity(host, peer) {
    try {
      if (host !== expectedHost || !peer || !Buffer.isBuffer(peer.raw)) return new Error('Resolver identity verification failed');
      if (checkServerIdentity(expectedHost, peer)) return new Error('Resolver identity verification failed');
      const actual = createHash('sha256').update(peer.raw).digest();
      if (!timingSafeEqual(pin, actual)) return new Error('Resolver identity verification failed');
      return undefined;
    } catch (_) { return new Error('Resolver identity verification failed'); }
  };
}

module.exports = { createPinnedResolverIdentity };
