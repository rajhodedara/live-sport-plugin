'use strict';
// Real proxy/Undici implementations, but sockets are simulated in memory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { PassThrough, Duplex, Writable } = require('node:stream');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createResolverUnixClients } = require('../src/services/ResolverUnixClients');
const StreamResolveCache = require('../src/services/StreamResolveCache');

test('socket adapter routes cache and proxy requests through the configured socket path', async () => {
  const oldConnect = net.connect, oldCreateConnection = net.createConnection;
  const streams = [], destinations = [], requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); res.setHeader('connection', 'close'); res.end('ok'); });
  const connect = (...args) => {
    const opts = args[0];
    destinations.push(typeof opts === 'string' ? opts : opts?.path);
    const a = new PassThrough(), b = new PassThrough();
    const client = Duplex.from({ readable: b, writable: a });
    const peer = Duplex.from({ readable: a, writable: b });
    for (const stream of [a, b, client, peer]) { stream.on('error', () => {}); streams.push(stream); }
    client.setNoDelay = client.setKeepAlive = client.setTimeout = () => client;
    peer.setNoDelay = peer.setKeepAlive = peer.setTimeout = () => peer;
    setImmediate(() => { server.emit('connection', peer); client.emit('connect'); });
    return client;
  };
  net.connect = connect; net.createConnection = connect;
  const clients = createResolverUnixClients({ socketPath: '/run/nuvio-test/resolver.sock', legacyPort: 7004 });
  try {
    const response = await clients.request('http://127.0.0.1:7004/api/cache/key', { signal: AbortSignal.timeout(3000) });
    assert.equal(await response.text(), 'ok');
    const req = new PassThrough();
    Object.assign(req, { method: 'GET', url: '/stream', headers: { host: 'localhost' }, httpVersion: '1.1', httpVersionMajor: 1, socket: { writable: true } });
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
    assert.deepEqual(requests, ['/api/cache/key', '/api/stream']);
    assert.deepEqual(destinations, ['/run/nuvio-test/resolver.sock', '/run/nuvio-test/resolver.sock']);
  } finally {
    await clients.close();
    for (const stream of streams) stream.destroy();
    server.close();
    net.connect = oldConnect; net.createConnection = oldCreateConnection;
  }
});

test('an unavailable socket rejects the cache request without a TCP fallback', async () => {
  const oldConnect = net.connect, oldCreateConnection = net.createConnection;
  const destinations = [];
  const connect = opts => {
    destinations.push(typeof opts === 'string' ? opts : opts?.path);
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    socket.setNoDelay = socket.setKeepAlive = socket.setTimeout = () => socket;
    process.nextTick(() => socket.destroy(Object.assign(new Error('socket unavailable'), { code: 'ENOENT' })));
    return socket;
  };
  net.connect = connect; net.createConnection = connect;
  const clients = createResolverUnixClients({ socketPath: '/run/nuvio-test/resolver.sock', legacyPort: 7004 });
  try {
    await assert.rejects(clients.request('http://127.0.0.1:7004/api/cache/key', { signal: AbortSignal.timeout(3000) }));
    assert.deepEqual(destinations, ['/run/nuvio-test/resolver.sock']);
  } finally {
    await clients.close();
    net.connect = oldConnect; net.createConnection = oldCreateConnection;
  }
});

test('an unavailable socket makes the proxy fail without a TCP fallback', async () => {
  const oldConnect = net.connect, oldCreateConnection = net.createConnection;
  const destinations = [];
  const connect = opts => {
    destinations.push(typeof opts === 'string' ? opts : opts?.path);
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
    socket.setNoDelay = socket.setKeepAlive = socket.setTimeout = () => socket;
    process.nextTick(() => socket.destroy(Object.assign(new Error('socket unavailable'), { code: 'ENOENT' })));
    return socket;
  };
  net.connect = connect; net.createConnection = connect;
  const clients = createResolverUnixClients({ socketPath: '/run/nuvio-test/resolver.sock', legacyPort: 7004 });
  try {
    const req = new PassThrough();
    Object.assign(req, { method: 'GET', url: '/stream', headers: { host: 'localhost' }, httpVersion: '1.1', httpVersionMajor: 1, socket: { writable: true } });
    const res = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const failure = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('proxy test timeout')), 3000);
      const middleware = createProxyMiddleware({ ...clients.proxyOptions, logger: { info() {}, warn() {}, error() {} },
        on: { error(error) { clearTimeout(timer); resolve(error); } } });
      middleware(req, res, error => { if (error) { clearTimeout(timer); resolve(error); } });
      req.end();
    });
    assert.equal(failure.code, 'ENOENT');
    assert.deepEqual(destinations, ['/run/nuvio-test/resolver.sock']);
  } finally {
    await clients.close();
    net.connect = oldConnect; net.createConnection = oldCreateConnection;
  }
});

test('two cache instances share a simulated resolver over the configured socket', async () => {
  const oldConnect = net.connect, oldCreateConnection = net.createConnection;
  const oldShared = process.env.RESOLVE_CACHE_SHARED, oldPort = process.env.RESOLVER_PORT;
  process.env.RESOLVE_CACHE_SHARED = 'true'; process.env.RESOLVER_PORT = '7004';
  const streams = [], destinations = [];
  let entry = null, posts = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('connection', 'close'); res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const value = JSON.parse(body); entry = { status: 'ok', streams: value.streams, expiresAt: Date.now() + 60000 };
      posts++; res.end(JSON.stringify({ ok: true }));
    } else if (req.url.includes('claim=1')) res.end(JSON.stringify({ ok: true, ownerToken: 'fixture' }));
    else res.end(JSON.stringify(entry || { status: 'miss' }));
  });
  const connect = opts => {
    destinations.push(typeof opts === 'string' ? opts : opts?.path);
    const a = new PassThrough(), b = new PassThrough();
    const client = Duplex.from({ readable: b, writable: a });
    const peer = Duplex.from({ readable: a, writable: b });
    for (const stream of [a, b, client, peer]) { stream.on('error', () => {}); streams.push(stream); }
    client.setNoDelay = client.setKeepAlive = client.setTimeout = () => client;
    peer.setNoDelay = peer.setKeepAlive = peer.setTimeout = () => peer;
    setImmediate(() => { server.emit('connection', peer); client.emit('connect'); });
    return client;
  };
  net.connect = connect; net.createConnection = connect;
  const firstClient = createResolverUnixClients({ socketPath: '/run/nuvio-test/resolver.sock', legacyPort: 7004 });
  const secondClient = createResolverUnixClients({ socketPath: '/run/nuvio-test/resolver.sock', legacyPort: 7004 });
  try {
    const first = new StreamResolveCache({ sharedResolver: firstClient });
    const second = new StreamResolveCache({ sharedResolver: secondClient });
    let mints = 0;
    const mint = async () => { mints++; return [{ url: 'https://fixture.invalid/stream' }]; };
    const a = await first.getOrCreate('damitv:fixture:source', mint);
    const b = await second.getOrCreate('damitv:fixture:source', mint);
    assert.equal(a[0].url, 'https://fixture.invalid/stream');
    assert.equal(b[0].url, 'https://fixture.invalid/stream');
    assert.equal(mints, 1); assert.equal(posts, 1);
    assert.ok(destinations.length >= 4);
    assert.ok(destinations.every(destination => destination === '/run/nuvio-test/resolver.sock'));
  } finally {
    await Promise.all([firstClient.close(), secondClient.close()]);
    for (const stream of streams) stream.destroy();
    server.close(); net.connect = oldConnect; net.createConnection = oldCreateConnection;
    if (oldShared === undefined) delete process.env.RESOLVE_CACHE_SHARED; else process.env.RESOLVE_CACHE_SHARED = oldShared;
    if (oldPort === undefined) delete process.env.RESOLVER_PORT; else process.env.RESOLVER_PORT = oldPort;
  }
});
