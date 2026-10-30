'use strict';
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const net = require('node:net');
const https = require('node:https');
const { Duplex, PassThrough } = require('node:stream');
const { createPinnedResolverClients } = require('../src/services/ResolverPinnedClients');

const dir = path.join(__dirname, 'fixtures/guarded-tls');
const cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');

async function exercise(pin, mode = 'cache') {
  const realConnect = tls.connect;
  const created = [];
  let plaintextRequests = 0, configured;
  const noNetwork = jest.spyOn(net, 'connect').mockImplementation(() => { throw new Error('unexpected network access'); });
  const connect = jest.spyOn(tls, 'connect').mockImplementation(options => {
    configured = options;
    const clientToServer = new PassThrough(), serverToClient = new PassThrough();
    const clientStream = Duplex.from({ readable: serverToClient, writable: clientToServer });
    const serverStream = Duplex.from({ readable: clientToServer, writable: serverToClient });
    for (const stream of [clientToServer, serverToClient, clientStream, serverStream]) stream.on('error', () => {});
    const server = new tls.TLSSocket(serverStream, { isServer: true, secureContext: tls.createSecureContext({ key, cert }) });
    server.on('error', () => {});
    server.on('data', () => {
      plaintextRequests++;
      server.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
    created.push(server, clientStream, serverStream, clientToServer, serverToClient);
    // Keep Undici's options, but inject a memory socket and the test CA. This
    // lets the wrong-pin case reach the identity callback without a real port.
    return realConnect({ ...options, socket: clientStream, ca: cert });
  });
  const clients = createPinnedResolverClients({ certificatePem: pin, expectedHost: 'cdn.example.org', port: 7004 });
  try {
    let body, failure;
    if (mode === 'cache') {
      try {
        const response = await clients.request('http://127.0.0.1:7004/api/cache/fixture', { signal: AbortSignal.timeout(3000) });
        body = await response.text();
      } catch (error) { failure = error; }
    } else {
      const result = await new Promise(resolve => {
        const req = https.request({ host: '127.0.0.1', port: 7004, path: '/api/stream',
          agent: clients.proxyOptions.agent, rejectUnauthorized: clients.proxyOptions.secure, signal: AbortSignal.timeout(3000) }, res => {
          let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
          res.on('end', () => resolve({ body: data }));
          res.on('error', error => resolve({ failure: error }));
        });
        req.on('error', error => resolve({ failure: error }));
        req.end();
      });
      body = result.body; failure = result.failure;
    }
    return { response: body || null, failed: !!failure, configured, plaintextRequests };
  } finally {
    await clients.close();
    for (const stream of created) stream.destroy();
    connect.mockRestore(); noNetwork.mockRestore();
  }
}

test('installed Undici forwards pinned TLS options and completes an in-memory request', async () => {
  const result = await exercise(cert);
  expect(result.failed).toBe(false);
  expect(result.response).toBe('ok');
  expect(result.plaintextRequests).toBe(1);
  expect(result.configured).toMatchObject({ rejectUnauthorized: true, servername: 'cdn.example.org' });
  expect(typeof result.configured.checkServerIdentity).toBe('function');
}, 10000);

test('installed Undici rejects a wrong pin before sending an HTTP request', async () => {
  const result = await exercise(tls.rootCertificates[0]);
  expect(result.failed).toBe(true);
  expect(result.plaintextRequests).toBe(0);
  expect(typeof result.configured.checkServerIdentity).toBe('function');
}, 10000);

test('HTTPS proxy agent enforces the configured pin in an in-memory request', async () => {
  const result = await exercise(cert, 'proxy');
  expect(result).toMatchObject({ failed: false, response: 'ok', plaintextRequests: 1 });
  expect(result.configured).toMatchObject({ rejectUnauthorized: true, servername: 'cdn.example.org' });
  expect(typeof result.configured.checkServerIdentity).toBe('function');
}, 10000);

test('HTTPS proxy agent rejects a wrong pin before sending an HTTP request', async () => {
  const result = await exercise(tls.rootCertificates[0], 'proxy');
  expect(result.failed).toBe(true);
  expect(result.plaintextRequests).toBe(0);
  expect(typeof result.configured.checkServerIdentity).toBe('function');
}, 10000);
