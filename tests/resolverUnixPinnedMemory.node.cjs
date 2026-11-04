'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const net = require('node:net');
const { Duplex, PassThrough, Writable } = require('node:stream');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createPinnedResolverUnixClients } = require('../src/services/ResolverUnixClients');

const fixture = path.join(__dirname, 'fixtures/guarded-tls');
const cert = fs.readFileSync(path.join(fixture, 'cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(fixture, 'key.pem'), 'utf8');

async function exercise(pin, mode) {
  const oldTls = tls.connect, oldNet = net.connect, streams = [];
  let requests = 0, optionsSeen, reportError;
  net.connect = () => { throw new Error('unexpected network access'); };
  tls.connect = options => {
    optionsSeen = options;
    const a = new PassThrough(), b = new PassThrough();
    const client = Duplex.from({ readable: b, writable: a });
    const peer = Duplex.from({ readable: a, writable: b });
    for (const stream of [a, b, client, peer]) { stream.on('error', () => {}); streams.push(stream); }
    const server = new tls.TLSSocket(peer, { isServer: true, secureContext: tls.createSecureContext({ key, cert }) });
    server.on('error', () => {});
    server.on('data', () => { requests++; server.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'); });
    streams.push(server);
    // Override only the transport and fixture CA so an incorrect pin reaches
    // the identity callback. No actual Unix or TCP socket is opened.
    const socket = oldTls({ ...options, socket: client, ca: cert });
    socket.on('error', error => reportError?.(error));
    return socket;
  };
  const clients = createPinnedResolverUnixClients({ socketPath: '/run/nuvio-test/resolver.sock', legacyPort: 7004,
    tlsIdentity: { certificatePem: pin, expectedHost: 'cdn.example.org' } });
  try {
    let result;
    if (mode === 'cache') {
      try { const response = await clients.request('http://127.0.0.1:7004/api/cache/key', { signal: AbortSignal.timeout(3000) }); result = { body: await response.text() }; }
      catch (failure) { result = { failure }; }
    } else {
      const req = new PassThrough();
      Object.assign(req, { method: 'GET', url: '/stream', headers: { host: 'localhost' }, httpVersion: '1.1', httpVersionMajor: 1, socket: { writable: true } });
      let body = '';
      const res = new Writable({ write(chunk, encoding, done) { body += chunk.toString(); done(); } });
      res.setHeader = () => {};
      const middleware = createProxyMiddleware({ ...clients.proxyOptions, logger: { info() {}, warn() {}, error() {} }, on: { error() {} } });
      result = await new Promise(resolve => {
        const timer = setTimeout(() => resolve({ failure: new Error('test timeout') }), 3000);
        reportError = failure => { clearTimeout(timer); resolve({ failure }); };
        res.once('finish', () => { clearTimeout(timer); resolve({ body }); });
        res.once('error', failure => { clearTimeout(timer); resolve({ failure }); });
        middleware(req, res, failure => { if (failure) { clearTimeout(timer); resolve({ failure }); } });
        req.end();
      });
    }
    return { ...result, requests, optionsSeen };
  } finally {
    await clients.close();
    for (const stream of streams) stream.destroy();
    tls.connect = oldTls; net.connect = oldNet;
  }
}

for (const mode of ['cache', 'proxy']) {
  test(`${mode} verifies the pinned certificate over the simulated Unix transport`, async () => {
    const result = await exercise(cert, mode);
    assert.equal(result.failure, undefined);
    assert.equal(result.body, 'ok'); assert.equal(result.requests, 1);
    assert.equal(result.optionsSeen.path, '/run/nuvio-test/resolver.sock');
    assert.equal(result.optionsSeen.rejectUnauthorized, true);
  });
  test(`${mode} rejects a different pin before sending HTTP`, async () => {
    const result = await exercise(tls.rootCertificates[0], mode);
    assert.ok(result.failure); assert.notEqual(result.failure.message, 'test timeout');
    assert.equal(result.requests, 0);
  });
}
