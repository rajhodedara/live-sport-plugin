'use strict';
// Isolated Unix socket only: no TCP listener or external network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough, Writable } = require('node:stream');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createResolverUnixClients } = require('../src/services/ResolverUnixClients');

test('installed Undici and proxy middleware route through the isolated Unix socket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-socket-'));
  const socketPath = path.join(dir, 'r.sock');
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.url); res.end('ok'); });
  const clients = createResolverUnixClients({ socketPath, legacyPort: 7004 });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const cached = await clients.request('http://127.0.0.1:7004/api/cache/fixture');
    assert.equal(await cached.text(), 'ok');
    const req = new PassThrough();
    Object.assign(req, { method: 'GET', url: '/stream', headers: { host: 'localhost' },
      httpVersion: '1.1', httpVersionMajor: 1, socket: { writable: true } });
    let body = '';
    const res = new Writable({ write(chunk, encoding, callback) { body += chunk.toString(); callback(); } });
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
    assert.deepEqual(seen, ['/api/cache/fixture', '/api/stream']);
  } finally {
    await clients.close();
    await new Promise(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
