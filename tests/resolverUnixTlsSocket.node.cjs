'use strict';
// Isolated integration test: real Unix socket, no TCP listener. Run only in
// an environment that permits local socket listeners and has OpenSSL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const { PassThrough, Writable } = require('node:stream');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { provisionTestIdentity } = require('../src/services/ResolverIdentityProvision');
const { readResolverPublicIdentity } = require('../src/services/ResolverPublicIdentity');
const { createPinnedResolverUnixClients } = require('../src/services/ResolverUnixClients');

test('pinned cache and proxy use a real TLS Unix socket and reject another certificate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-real-tls-'));
  const identity = provisionTestIdentity(dir), socketPath = path.join(dir, 'resolver.sock');
  const server = https.createServer({ cert: fs.readFileSync(identity.certificatePath), key: fs.readFileSync(identity.keyPath) },
    (req, res) => { seen.push(req.url); res.end('ok'); });
  const seen = [];
  const config = { socketPath, legacyPort: 7004, tlsIdentity: readResolverPublicIdentity(identity.directory, identity.expectedHost) };
  const clients = createPinnedResolverUnixClients(config);
  const wrong = createPinnedResolverUnixClients({ ...config, tlsIdentity: { certificatePem: tls.rootCertificates[0], expectedHost: identity.expectedHost } });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await assert.rejects(wrong.request('http://127.0.0.1:7004/api/cache/secret', { signal: AbortSignal.timeout(3000) }));
    assert.deepEqual(seen, []);
    const response = await clients.request('http://127.0.0.1:7004/api/cache/key', { signal: AbortSignal.timeout(3000) });
    assert.equal(await response.text(), 'ok');
    const req = new PassThrough();
    Object.assign(req, { method: 'GET', url: '/stream', headers: { host: 'localhost' }, httpVersion: '1.1', httpVersionMajor: 1, socket: { writable: true } });
    let body = '';
    const res = new Writable({ write(chunk, encoding, done) { body += chunk.toString(); done(); } });
    res.setHeader = () => {};
    const middleware = createProxyMiddleware({ ...clients.proxyOptions, logger: { info() {}, warn() {}, error() {} }, on: { error() {} } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('proxy test timeout')), 3000);
      res.once('finish', () => { clearTimeout(timer); resolve(); });
      res.once('error', error => { clearTimeout(timer); reject(error); });
      middleware(req, res, error => { if (error) { clearTimeout(timer); reject(error); } });
      req.end();
    });
    assert.equal(body, 'ok');
    assert.deepEqual(seen, ['/api/cache/key', '/api/stream']);
  } finally {
    await Promise.all([clients.close(), wrong.close()]);
    await new Promise(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
