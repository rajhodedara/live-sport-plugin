'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const net = require('node:net');
const { Duplex, PassThrough } = require('node:stream');
const { provisionTestIdentity } = require('../src/services/ResolverIdentityProvision');
const { readResolverPublicIdentity } = require('../src/services/ResolverPublicIdentity');
const { createPinnedResolverUnixClients } = require('../src/services/ResolverUnixClients');

test('stale worker fails and updated worker connects after a simulated identity rotation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-rotate-'));
  const oldTls = tls.connect, oldNet = net.connect, streams = [];
  let requests = 0;
  try {
    const oldGeneration = provisionTestIdentity(dir), newGeneration = provisionTestIdentity(dir);
    const newCert = fs.readFileSync(newGeneration.certificatePath), newKey = fs.readFileSync(newGeneration.keyPath);
    net.connect = () => { throw new Error('unexpected network access'); };
    tls.connect = options => {
      const a = new PassThrough(), b = new PassThrough();
      const client = Duplex.from({ readable: b, writable: a }), peer = Duplex.from({ readable: a, writable: b });
      for (const stream of [a, b, client, peer]) { stream.on('error', () => {}); streams.push(stream); }
      const server = new tls.TLSSocket(peer, { isServer: true, secureContext: tls.createSecureContext({ cert: newCert, key: newKey }) });
      server.on('error', () => {}); server.on('data', () => { requests++; server.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'); });
      streams.push(server);
      // Trust the new fixture CA in both cases so the stale client reaches its
      // certificate pin check instead of failing earlier at chain validation.
      return oldTls({ ...options, ca: newCert, socket: client });
    };
    const makeClient = generation => createPinnedResolverUnixClients({ socketPath: '/run/nuvio-test/resolver.sock', legacyPort: 7004,
      tlsIdentity: readResolverPublicIdentity(generation.directory, generation.expectedHost) });
    const stale = makeClient(oldGeneration), updated = makeClient(newGeneration);
    try {
      await assert.rejects(stale.request('http://127.0.0.1:7004/api/cache/key', { signal: AbortSignal.timeout(3000) }));
      assert.equal(requests, 0);
      const response = await updated.request('http://127.0.0.1:7004/api/cache/key', { signal: AbortSignal.timeout(3000) });
      assert.equal(await response.text(), 'ok'); assert.equal(requests, 1);
    } finally { await Promise.all([stale.close(), updated.close()]); }
  } finally {
    for (const stream of streams) stream.destroy();
    tls.connect = oldTls; net.connect = oldNet;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
