'use strict';
// Native Impit -> private authenticated proxy -> pinned numeric address mapped
// by a trusted test dial to a loopback HTTP metadata origin. No public dials.
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { Impit } = require('impit');
const { createNativeGuardedFetch } = require('../../src/services/NativeGuardedFetch');
const sockets = new Set(), profiles = [], requests = [], holds = new Map();
let origin, socksServer, pool, constructs = 0, finished = false;
const waitFor = async predicate => {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Local fetch fixture condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const nativeModule = { Impit: class extends Impit {
  constructor(options) { super(options); constructs++; profiles.push(options.browser || 'vanilla'); }
} };
(async () => {
  delete process.env.WARP_PROXY_URL; delete process.env.DAMITV_PROXY_URL;
  try {
    origin = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      const entry = { path: url.pathname, headers: req.headers, method: req.method };
      requests.push(entry);
      if (url.pathname === '/private') { res.writeHead(302, { Location: 'http://127.0.0.1/private' }); res.end(); return; }
      if (url.pathname === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); return; }
      if (url.pathname === '/cross') { res.writeHead(302, { Location: 'http://b.example.org/return' }); res.end(); return; }
      if (url.pathname === '/return') { res.writeHead(302, { Location: 'http://a.example.org/capture' }); res.end(); return; }
      if (url.pathname === '/r301' || url.pathname === '/r307') {
        req.resume(); res.writeHead(Number(url.pathname.slice(2)), { Location: '/capture' }); res.end(); return;
      }
      if (url.pathname === '/large') { res.end(Buffer.alloc(4096, 'x')); return; }
      if (url.pathname === '/chain') {
        const timer = setTimeout(() => { res.writeHead(302, { Location: '/trickle' }); res.end(); }, 80);
        res.once('close', () => clearTimeout(timer)); return;
      }
      if (url.pathname === '/trickle') {
        res.writeHead(200); res.write('x');
        const timer = setInterval(() => res.write('x'), 20);
        res.once('close', () => clearInterval(timer)); return;
      }
      if (url.pathname.startsWith('/hold')) {
        holds.set(url.pathname, res); res.once('close', () => holds.delete(url.pathname)); return;
      }
      if (url.pathname === '/capture') {
        let body = '';
        req.on('data', bytes => { body += bytes.toString(); });
        req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ method: req.method, body, headers: req.headers })); });
        return;
      }
      res.setHeader('Content-Type', 'text/plain'); res.end('fixture');
    });
    origin.on('connection', socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    pool = createNativeGuardedFetch({ maxSlots: 2, slotOptions: {
      nativeModule, resolve: async () => ['93.184.216.34'],
      dial(address) {
        assert.equal(address.host, '93.184.216.34'); assert.equal(address.port, 80);
        return net.connect({ host: '127.0.0.1', port: origin.address().port });
      }
    } });
    for (let i = 0; i < 3; i++) {
      const response = await pool.fetch('http://a.example.org/ok');
      assert.equal(response.status, 200); assert.equal(await response.text(), 'fixture');
      assert.equal(response.headers.get('connection'), 'close');
      assert.equal(response.url, 'http://a.example.org/ok'); assert.equal(response.bodyTruncated, false);
    }
    assert.equal(constructs, 1); assert.equal(requests[0].headers.host, 'a.example.org');
    const manualCount = requests.length;
    const manual = await pool.fetch('http://a.example.org/cross', { redirect: 'manual' });
    assert.equal(manual.status, 302); assert.equal(manual.headers.get('location'), 'http://b.example.org/return');
    assert.equal(requests.length, manualCount + 1);
    await assert.rejects(pool.fetch('http://a.example.org/cross', { redirect: 'error' }), TypeError);
    const head = await pool.fetch('http://a.example.org/ok', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const isolated = await (await pool.fetch('http://a.example.org/cross', { headers: {
      Authorization: 'Bearer fixture', Cookie: 'fixture=yes', 'X-Api-Key': 'custom-retained',
      Host: 'untrusted', Connection: 'x-hop', 'X-Hop': 'transport-only'
    } })).json();
    assert.equal(isolated.headers.authorization, undefined); assert.equal(isolated.headers.cookie, undefined);
    assert.equal(isolated.headers['x-api-key'], 'custom-retained'); assert.equal(isolated.headers['x-hop'], undefined);
    assert.equal(isolated.headers.host, 'a.example.org');
    const sameOrigin = await (await pool.fetch('http://a.example.org/r301', {
      method: 'POST', body: 'metadata', headers: { Authorization: 'fixture', 'Content-Type': 'text/plain' }
    })).json();
    assert.equal(sameOrigin.method, 'GET'); assert.equal(sameOrigin.body, ''); assert.equal(sameOrigin.headers.authorization, 'fixture');
    const retained = await (await pool.fetch('http://a.example.org/r307', { method: 'POST', body: 'metadata' })).json();
    assert.equal(retained.method, 'POST'); assert.equal(retained.body, 'metadata');
    const large = await pool.fetch('http://a.example.org/large', { maxBodyBytes: 64 });
    assert.equal(large.bodyTruncated, true); assert.equal((await large.arrayBuffer()).byteLength, 64);
    const beforePrivate = requests.length;
    await assert.rejects(pool.fetch('http://a.example.org/private'), { code: 'ERR_OUTBOUND_BLOCKED' });
    assert.equal(requests.length, beforePrivate + 1);
    const beforeLoop = requests.length;
    await assert.rejects(pool.fetch('http://a.example.org/loop'), { code: 'ERR_OUTBOUND_REDIRECT_LIMIT' });
    assert.equal(requests.length, beforeLoop + 6);
    const began = Date.now();
    await assert.rejects(pool.fetch('http://a.example.org/chain', { timeoutMs: 220 }), { name: 'TimeoutError' });
    assert.ok(Date.now() - began < 1500); await waitFor(() => pool.stats.busy === 0);
    const caller = new AbortController(), reason = new DOMException('Viewer stopped', 'AbortError');
    const first = pool.fetch('http://a.example.org/hold-a', { signal: caller.signal }).catch(error => error);
    await waitFor(() => holds.has('/hold-a'));
    const second = pool.fetch('http://a.example.org/hold-b');
    await waitFor(() => holds.has('/hold-b'));
    await assert.rejects(pool.fetch('http://a.example.org/ok'), { code: 'ERR_NATIVE_POOL_BUSY' });
    caller.abort(reason); assert.equal(await first, reason);
    holds.get('/hold-b').end('fixture'); assert.equal(await (await second).text(), 'fixture');
    await waitFor(() => pool.stats.busy === 0); assert.equal(constructs, 2);
    await pool.close();
    assert.deepEqual(pool.stats, { slots: 0, busy: 0 });
    await assert.rejects(pool.fetch('http://a.example.org/ok'), { code: 'ERR_NATIVE_POOL_CLOSED' });
    const boundedClients = constructs;
    pool = createNativeGuardedFetch({ maxSlots: 3, slotOptions: {
      nativeModule, resolve: async () => ['93.184.216.34'],
      dial: () => net.connect({ host: '127.0.0.1', port: origin.address().port })
    } });
    process.env.WARP_PROXY_URL = 'http://127.0.0.1:1'; // deliberately unsupported; must never be contacted
    assert.equal(await (await pool.fetch('http://a.example.org/ok')).text(), 'fixture');
    const beforeProxy = requests.length;
    await assert.rejects(pool.fetch('http://messi.damitv.st/ok'), { code: 'ERR_NATIVE_TUNNEL_PROXY' });
    assert.equal(requests.length, beforeProxy);
    assert.equal(await (await pool.fetch('http://messi.damitv.st/ok', { proxyUrl: null })).text(), 'fixture');
    assert.deepEqual(profiles, ['chrome142', 'chrome142', 'chrome142', 'vanilla']);
    const socksTargets = [];
    socksServer = net.createServer(socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
      let bytes = Buffer.alloc(0), stage = 0;
      const receive = chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        if (!stage) {
          if (bytes.length < 2 || bytes.length < bytes[1] + 2) return;
          bytes = bytes.subarray(bytes[1] + 2); stage = 1; socket.write(Buffer.from([5, 0]));
        }
        if (stage !== 1 || bytes.length < 10) return;
        assert.equal(bytes[3], 1); assert.equal(bytes.readUInt16BE(8), 80);
        socksTargets.push([...bytes.subarray(4, 8)].join('.'));
        socket.removeListener('data', receive); socket.pause(); stage = 2;
        const head = bytes.subarray(10);
        const upstream = net.connect({ host: '127.0.0.1', port: origin.address().port }, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (head.length) upstream.write(head);
          socket.pipe(upstream); upstream.pipe(socket); socket.resume();
        });
        upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
        upstream.once('close', () => socket.destroy());
      };
      socket.on('data', receive);
    });
    await new Promise(resolve => socksServer.listen(0, '127.0.0.1', resolve));
    process.env.WARP_PROXY_URL = 'socks5://127.0.0.1:' + socksServer.address().port;
    assert.equal(await (await pool.fetch('http://messi.damitv.st/ok')).text(), 'fixture');
    assert.deepEqual(socksTargets, ['93.184.216.34']);
    const socksRedirect = await (await pool.fetch('http://messi.damitv.st/cross', { headers: { Authorization: 'fixture' } })).json();
    assert.equal(socksRedirect.headers.authorization, undefined);
    assert.deepEqual(socksTargets, Array(4).fill('93.184.216.34'));
    assert.deepEqual(profiles, ['chrome142', 'chrome142', 'chrome142', 'vanilla', 'vanilla']);
    delete process.env.WARP_PROXY_URL;
    const shutdownRead = pool.fetch('http://a.example.org/hold-shutdown').catch(error => error);
    await waitFor(() => holds.has('/hold-shutdown'));
    await pool.close(); assert.equal((await shutdownRead).name, 'AbortError');
    assert.deepEqual(pool.stats, { slots: 0, busy: 0 });

    // Slow creation remains bounded by the caller deadline and keeps one
    // reservation until the underlying creation settles; it cannot spawn more.
    let complete;
    const slow = createNativeGuardedFetch({ maxSlots: 1,
      slotOptions: { resolve: async () => ['93.184.216.34'] },
      createSlot: () => new Promise(resolve => { complete = resolve; }) });
    await assert.rejects(slow.fetch('http://a.example.org/ok', { timeoutMs: 30 }), { name: 'TimeoutError' });
    assert.equal(slow.stats.slots, 1);
    await assert.rejects(slow.fetch('http://a.example.org/ok'), { code: 'ERR_NATIVE_POOL_BUSY' });
    let disposed = 0;
    complete({ busy: false, close: async () => { disposed++; } });
    await slow.close(); assert.ok(disposed >= 1);
    const blockedPool = createNativeGuardedFetch({ createSlot: () => { throw Error('Blocked URL must not allocate native transport'); } });
    await assert.rejects(blockedPool.fetch('http://127.0.0.1/private'), { code: 'ERR_OUTBOUND_BLOCKED' });
    assert.equal(blockedPool.stats.slots, 0); await blockedPool.close();
    finished = true;
    process.stdout.write(JSON.stringify({ realNativeMetadata: true, crossOriginPolicy: true, methodsAndBodies: true,
      boundedBody: true, privateRedirectBlocked: true, redirectLimit: true, totalDeadline: true,
      boundedAdmission: true, isolatedAbort: true, creationDeadline: true, profilesAndProxySelection: true,
      validSocksProxy: true, shutdownCleanup: true, nativeClients: boundedClients }));
  } finally {
    if (pool) await pool.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, socksServer].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    if (!finished) process.exitCode = 1;
  }
})().catch(error => {
  process.stderr.write(error.stack + '\n' + JSON.stringify({ lastRequest: requests.at(-1)?.path, method: requests.at(-1)?.method }));
  process.exitCode = 1;
});
