'use strict';
// All real dials go to loopback fixtures. Public numeric IPs are recorded, not
// contacted; the private injection maps them to synthetic TLS/TCP endpoints.
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { Impit } = require('impit');
const { createNativeGuardedSlot } = require('../../src/services/NativeGuardedSlot');
const sockets = new Set(), stalledSockets = new Set(), slots = new Set();
const endpoints = [], dials = [], destinations = [], names = [];
let origin, stalled, proxy, constructs = 0, silent = false, outcome;
let lookup = async host => [host === 'b.example.org' ? '93.184.216.35' : host === 'stall.example.org' ? '93.184.216.36' : '93.184.216.34'];
const track = socket => {
  sockets.add(socket); socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket)); return socket;
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const waitFor = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Local guarded-slot fixture condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const nativeModule = { Impit: class extends Impit {
  constructor(options) { super(options); constructs++; endpoints.push(options.proxyUrl); }
} };
const create = async extra => {
  const slot = await createNativeGuardedSlot({ nativeModule, resolve: host => lookup(host),
    dial: address => {
      assert.ok(['93.184.216.34', '93.184.216.35', '93.184.216.36'].includes(address.host));
      assert.equal(address.port, 443); dials.push(address.host);
      return track(net.connect({ host: '127.0.0.1', port: address.host.endsWith('.36') ? stalled.address().port : origin.address().port }));
    }, ...extra });
  slots.add(slot); return slot;
};
const request = (slot, target, options) => slot.run(target, async client => {
  const response = await client.fetch(target, { timeout: 1500, redirect: 'manual' });
  return response.text();
}, options);
const certificateRejected = async operation => {
  await assert.rejects(operation, error => /certificate|UnknownIssuer|invalid peer/i.test(error.message));
};
function rawConnect(endpoint, host, authorized) {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: host,
      headers: authorized ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(url.username + ':' + url.password).toString('base64') } : {} });
    req.once('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    req.once('error', reject); req.end();
  });
}
(async () => {
  delete process.env.WARP_PROXY_URL; delete process.env.DAMITV_PROXY_URL;
  try {
    const key = fs.readFileSync(path.join(__dirname, 'guarded-tls/key.pem'));
    const cert = fs.readFileSync(path.join(__dirname, 'guarded-tls/cert.pem'));
    const context = tls.createSecureContext({ key, cert });
    origin = tls.createServer({ key, cert, SNICallback(name, callback) { names.push(name); callback(null, context); } });
    origin.on('connection', track); origin.on('tlsClientError', () => {}); await listen(origin);
    stalled = net.createServer(socket => {
      track(socket); stalledSockets.add(socket); socket.on('data', () => {});
      socket.once('close', () => stalledSockets.delete(socket));
    });
    await listen(stalled);
    const first = await create();
    for (const host of ['a', 'b', 'a']) await certificateRejected(request(first, 'https://' + host + '.example.org/metadata'));
    assert.equal(constructs, 1); assert.equal(endpoints.length, 1);
    assert.deepEqual(dials, ['93.184.216.34', '93.184.216.35', '93.184.216.34']);
    assert.deepEqual(names, ['a.example.org', 'b.example.org', 'a.example.org']);
    const before = dials.length;
    assert.equal(await first.run('https://a.example.org/', () => rawConnect(endpoints[0], 'a.example.org:443', false)), 407);
    await assert.rejects(first.run('https://a.example.org/', () => rawConnect(endpoints[0], 'b.example.org:443', true)), { code: 'ERR_OUTBOUND_BLOCKED' });
    assert.equal(dials.length, before);
    await assert.rejects(request(first, 'https://127.0.0.1/private'), { code: 'ERR_OUTBOUND_BLOCKED' });
    const normalLookup = lookup; let calls = 0;
    lookup = async () => [++calls === 1 ? '93.184.216.34' : '127.0.0.1'];
    await assert.rejects(request(first, 'https://a.example.org/rebind'), { code: 'ERR_OUTBOUND_BLOCKED' });
    assert.equal(dials.length, before); lookup = normalLookup;
    const second = await create();
    const caller = new AbortController(), reason = new DOMException('Viewer canceled', 'AbortError');
    const pending = request(first, 'https://stall.example.org/', { signal: caller.signal }).catch(error => error);
    await waitFor(() => stalledSockets.size === 1);
    await assert.rejects(request(first, 'https://a.example.org/'), { code: 'ERR_NATIVE_SLOT_BUSY' });
    await certificateRejected(request(second, 'https://b.example.org/'));
    caller.abort(reason); assert.equal(await pending, reason);
    await waitFor(() => !first.busy && stalledSockets.size === 0);
    await certificateRejected(request(first, 'https://a.example.org/after-abort'));
    assert.equal(constructs, 2);
    // Cancel a lease while its second DNS validation remains unresolved. Its
    // later DNS answer must not dial or acquire the next lease's authority.
    let releaseDns, dnsCalls = 0;
    lookup = async () => ++dnsCalls === 1 ? ['93.184.216.34'] : new Promise(resolve => { releaseDns = resolve; });
    const dnsCaller = new AbortController();
    const dnsPending = request(first, 'https://a.example.org/dns', { signal: dnsCaller.signal }).catch(error => error);
    await waitFor(() => releaseDns);
    const beforeLate = dials.length; dnsCaller.abort(reason); assert.equal(await dnsPending, reason);
    await waitFor(() => !first.busy); lookup = normalLookup;
    await certificateRejected(request(first, 'https://b.example.org/new-lease'));
    releaseDns(['93.184.216.34']); await new Promise(resolve => setImmediate(resolve));
    assert.equal(dials.length, beforeLate + 1);

    proxy = net.createServer(socket => {
      track(socket); const stalledGreeting = silent;
      let bytes = Buffer.alloc(0), stage = 0;
      const receive = chunk => {
        if (stalledGreeting) return;
        bytes = Buffer.concat([bytes, chunk]);
        if (stage === 0) {
          if (bytes.length < 2 || bytes.length < 2 + bytes[1]) return;
          bytes = bytes.subarray(2 + bytes[1]); socket.write(Buffer.from([5, 0])); stage = 1;
        }
        if (stage !== 1 || bytes.length < 10) return;
        assert.equal(bytes[3], 1);
        destinations.push([...bytes.subarray(4, 8)].join('.'));
        socket.removeListener('data', receive); socket.pause(); stage = 2;
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
    await listen(proxy);
    const socks = await create({ proxyUrl: 'socks5://127.0.0.1:' + proxy.address().port });
    await certificateRejected(request(socks, 'https://a.example.org/'));
    await certificateRejected(request(socks, 'https://b.example.org/'));
    assert.deepEqual(destinations, ['93.184.216.34', '93.184.216.35']);
    silent = true;
    await assert.rejects(request(socks, 'https://a.example.org/stall', { timeoutMs: 200 }), { name: 'TimeoutError' });
    await waitFor(() => !socks.busy); silent = false;
    await certificateRejected(request(socks, 'https://b.example.org/after-timeout'));
    assert.equal(constructs, 3);
    const fourth = await create();
    await assert.rejects(create(), { code: 'ERR_NATIVE_SLOT_CAPACITY' });
    const closingRun = fourth.run('https://a.example.org/', () => { throw Error('A closing slot must not start its operation'); });
    const closing = fourth.close();
    await assert.rejects(closingRun, { code: 'ERR_NATIVE_SLOT_CLOSED' }); await closing;
    await assert.rejects(request(fourth, 'https://a.example.org/'), { code: 'ERR_NATIVE_SLOT_CLOSED' });
    const replacement = await create(); await replacement.close();
    outcome = { repeatedNativeReuse: true, privateAndRebindingBlocked: true,
      originAndAuthRestricted: true, cancellationIsolated: true, lateDnsIsolated: true,
      socksNumericPinning: true, socksTimeoutRecovered: true, capacityRecovered: true };
  } finally {
    await Promise.all([...slots].map(slot => slot.close()));
    for (const socket of sockets) socket.destroy();
    await Promise.all([proxy, origin, stalled].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
  }
  process.stdout.write(JSON.stringify(outcome));
})().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
