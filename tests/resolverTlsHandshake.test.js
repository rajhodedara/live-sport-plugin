'use strict';
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { Duplex, PassThrough } = require('node:stream');
const { createPinnedResolverIdentity } = require('../src/services/ResolverPinnedIdentity');

const dir = path.join(__dirname, 'fixtures/guarded-tls');
const cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');

// TLS runs over an in-memory duplex pair: no listener, port or network access.
async function handshake({ trustedCa, pin, servername = 'cdn.example.org' }) {
  const clientToServer = new PassThrough(), serverToClient = new PassThrough();
  const clientStream = Duplex.from({ readable: serverToClient, writable: clientToServer });
  const serverStream = Duplex.from({ readable: clientToServer, writable: serverToClient });
  for (const stream of [clientToServer, serverToClient, clientStream, serverStream]) stream.on('error', () => {});
  const server = new tls.TLSSocket(serverStream, { isServer: true, secureContext: tls.createSecureContext({ key, cert }) });
  server.on('error', () => {});
  const client = tls.connect({ socket: clientStream, ca: trustedCa, servername, rejectUnauthorized: true,
    checkServerIdentity: createPinnedResolverIdentity({ certificatePem: pin, expectedHost: servername }) });
  client.on('error', () => {});
  try {
    return await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'test_timeout' }), 3000);
      client.once('secureConnect', () => { clearTimeout(timer); resolve({ ok: true }); });
      client.once('error', error => { clearTimeout(timer); resolve({ ok: false, reason: error.code || error.message }); });
    });
  } finally {
    client.destroy(); server.destroy(); clientToServer.destroy(); serverToClient.destroy();
  }
}

test('a TLS handshake succeeds only with the trusted certificate and matching pin', async () => {
  expect(await handshake({ trustedCa: cert, pin: cert })).toEqual({ ok: true });
});

test('a TLS handshake rejects a different pin even if the server certificate is trusted', async () => {
  const result = await handshake({ trustedCa: cert, pin: tls.rootCertificates[0] });
  expect(result.ok).toBe(false);
  expect(result.reason).not.toBe('test_timeout');
});

test('a TLS handshake rejects an untrusted certificate even if the pin matches', async () => {
  const result = await handshake({ trustedCa: tls.rootCertificates[0], pin: cert });
  expect(result.ok).toBe(false);
  expect(result.reason).not.toBe('test_timeout');
});

test('a TLS handshake rejects the wrong hostname even when CA and pin match', async () => {
  const result = await handshake({ trustedCa: cert, pin: cert, servername: 'other.example.org' });
  expect(result.ok).toBe(false);
  expect(result.reason).not.toBe('test_timeout');
});
