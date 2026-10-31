'use strict';
// A synthetic SOCKS server forwards only to a synthetic local TLS origin.
// It records the requested public numeric destination, never contacts it.
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
// Observe pending JavaScript timers as well as TCP closure. A closed SOCKS
// socket can otherwise leave its authentication timeout alive for five seconds.
const setTimer = global.setTimeout, clearTimer = global.clearTimeout;
const pendingTimers = new Set();
global.setTimeout = (callback, delay, ...args) => {
  const timer = setTimer(() => { pendingTimers.delete(timer); callback(...args); }, delay);
  pendingTimers.add(timer); return timer;
};
global.clearTimeout = timer => { pendingTimers.delete(timer); return clearTimer(timer); };
const { Impit } = require('impit');
const { createNativeRequestTunnel } = require('./NativeRequestTunnel');
const key = fs.readFileSync(path.join(__dirname, 'guarded-tls/key.pem'));
const cert = fs.readFileSync(path.join(__dirname, 'guarded-tls/cert.pem'));
const context = tls.createSecureContext({ key, cert });
const sockets = new Set(), proxySockets = new Set(), tunnels = new Set();
const destinations = [], names = [];
let silent = false, origin, proxy, proxyUrl, originBytes = 0;
let outcome;
const track = socket => {
  sockets.add(socket); socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket)); return socket;
};
const waitFor = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Local SOCKS fixture condition timed out');
    await new Promise(r => setTimeout(r, 5));
  }
};
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', r));
const create = async options => {
  const tunnel = await createNativeRequestTunnel('https://cdn.example.org/metadata', {
    proxyUrl, resolve: async () => ['93.184.216.34'], timeoutMs: 2500, ...options
  });
  tunnels.add(tunnel); return tunnel;
};
const fetchNative = tunnel => {
  const client = new Impit({ proxyUrl: tunnel.proxyUrl, browser: 'chrome142',
    http3: false, followRedirects: false, ignoreTlsErrors: false, timeout: 2500 });
  return client.fetch('https://cdn.example.org/metadata', {
    signal: tunnel.signal, redirect: 'manual', timeout: 2500
  }).catch(error => error);
};
(async () => {
  delete process.env.WARP_PROXY_URL; delete process.env.DAMITV_PROXY_URL;
  try {
    origin = tls.createServer({ key, cert, SNICallback(name, callback) {
      names.push(name); callback(null, context);
    } }, socket => socket.on('data', data => { originBytes += data.length; }));
    origin.on('connection', track); origin.on('tlsClientError', () => {});
    await listen(origin);
    proxy = net.createServer(socket => {
      track(socket); proxySockets.add(socket);
      socket.once('close', () => proxySockets.delete(socket));
      const stalled = silent;
      let bytes = Buffer.alloc(0), stage = 'greeting';
      const receive = chunk => {
        if (stalled) return;
        bytes = Buffer.concat([bytes, chunk]);
        if (stage === 'greeting') {
          if (bytes.length < 2 || bytes.length < 2 + bytes[1]) return;
          assert.equal(bytes[0], 5);
          bytes = bytes.subarray(2 + bytes[1]);
          socket.write(Buffer.from([5, 0])); stage = 'connect';
        }
        if (stage !== 'connect' || bytes.length < 10) return;
        assert.equal(bytes[3], 1, 'SOCKS must receive a numeric IPv4 address');
        destinations.push([...bytes.subarray(4, 8)].join('.') + ':' + bytes.readUInt16BE(8));
        socket.removeListener('data', receive); socket.pause(); stage = 'forward';
        const head = bytes.subarray(10);
        const upstream = track(net.connect({ host: '127.0.0.1', port: origin.address().port }, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (head.length) upstream.write(head);
          socket.pipe(upstream); upstream.pipe(socket); socket.resume();
        }));
        socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
      };
      socket.on('data', receive);
    });
    await listen(proxy); proxyUrl = 'socks5://127.0.0.1:' + proxy.address().port;
    const identity = await create();
    const certificateError = await fetchNative(identity);
    // Do not emit native errors: they can contain the local proxy credential.
    assert.match(certificateError.message, /certificate|UnknownIssuer|invalid peer/i);
    assert.deepEqual(destinations, ['93.184.216.34:443']);
    assert.deepEqual(names, ['cdn.example.org']); assert.equal(originBytes, 0);
    await identity.close(); await waitFor(() => proxySockets.size === 0);

    const beforeRebind = destinations.length;
    let lookups = 0;
    const rebound = await create({ resolve: async () => [++lookups === 1 ? '93.184.216.34' : '127.0.0.1'] });
    const blocked = await fetchNative(rebound);
    assert.ok(blocked instanceof Error);
    assert.equal(destinations.length, beforeRebind); assert.equal(proxySockets.size, 0);
    await rebound.close();

    silent = true;
    const caller = new AbortController();
    const stalled = await create({ signal: caller.signal });
    const pending = fetchNative(stalled);
    await waitFor(() => proxySockets.size === 1);
    silent = false;
    const healthy = await create();
    assert.match((await fetchNative(healthy)).message, /certificate|UnknownIssuer|invalid peer/i);
    await healthy.close(); await waitFor(() => proxySockets.size === 1);
    const reason = new DOMException('Viewer stopped', 'AbortError'); caller.abort(reason);
    assert.equal(await pending, reason);
    await stalled.close(); await waitFor(() => proxySockets.size === 0);

    silent = true;
    const deadline = await create({ timeoutMs: 300 });
    const timed = fetchNative(deadline);
    await waitFor(() => proxySockets.size === 1);
    assert.equal((await timed).name, 'TimeoutError');
    await deadline.close(); await waitFor(() => proxySockets.size === 0);
    outcome = { numericDestination: destinations[0],
      preservedSni: names[0], certificateRejected: true, originBytes,
      rebindingBlocked: true, isolatedAbort: true, handshakeDeadline: true,
      remainingProxySockets: proxySockets.size };
  } finally {
    await Promise.all([...tunnels].map(t => t.close()));
    for (const socket of sockets) socket.destroy();
    await Promise.all([proxy, origin].filter(Boolean).map(server => new Promise(r => server.close(r))));
  }
  const referencedTimers = [...pendingTimers].filter(timer => timer.hasRef());
  assert.equal(referencedTimers.length, 0, 'Canceled SOCKS handshake left a referenced timer alive: ' +
    JSON.stringify(referencedTimers.map(timer => ({ delay: timer._idleTimeout }))));
  process.stdout.write(JSON.stringify(outcome));
})().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
