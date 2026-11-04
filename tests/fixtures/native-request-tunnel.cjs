'use strict';
// All actual connections are loopback. Numeric public addresses are asserted
// before a private test dial maps them to the local metadata fixture.
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { Impit } = require('impit');
const { createNativeRequestTunnel } = require('./NativeRequestTunnel');
const target = 'https://cdn.example.org/fixture';
const resolve = async () => ['93.184.216.34'];
const checks = [], tunnels = new Set(), sockets = new Set(), originSockets = new Set();
let origin;
const track = socket => {
  sockets.add(socket); socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket)); return socket;
};
const waitFor = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Local fixture condition timed out');
    await new Promise(r => setTimeout(r, 5));
  }
};
const create = async options => {
  const tunnel = await createNativeRequestTunnel(target, { resolve, ...options });
  tunnels.add(tunnel); return tunnel;
};
const dial = (address, callback) => {
  assert.equal(address.host, '93.184.216.34'); assert.equal(address.port, 443);
  return track(net.connect({ host: '127.0.0.1', port: origin.address().port }, callback));
};
async function connect(tunnel, { auth = true, host = 'cdn.example.org:443' } = {}) {
  const url = new URL(tunnel.proxyUrl);
  const socket = track(net.connect({ host: url.hostname, port: Number(url.port) }));
  await once(socket, 'connect');
  const response = new Promise((resolve, reject) => {
    let bytes = '';
    const onData = data => {
      bytes += data.toString();
      if (bytes.includes('\r\n\r\n')) {
        socket.removeListener('data', onData); resolve(bytes);
      }
    };
    socket.on('data', onData); socket.once('error', reject);
    socket.once('close', () => { if (!bytes.includes('\r\n\r\n')) reject(Error('No CONNECT response')); });
  });
  const credentials = Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64');
  socket.write('CONNECT ' + host + ' HTTP/1.1\r\nHost: ' + host + '\r\n' +
    (auth ? 'Proxy-Authorization: Basic ' + credentials + '\r\n' : '') + '\r\n');
  return { socket, response: await response };
}
(async () => {
  delete process.env.WARP_PROXY_URL; delete process.env.DAMITV_PROXY_URL;
  try {
    let calls = 0;
    await assert.rejects(createNativeRequestTunnel('https://127.0.0.1/', { dial: () => { calls++; } }), { code: 'ERR_OUTBOUND_BLOCKED' });
    assert.equal(calls, 0); checks.push('private');
    await assert.rejects(create({ proxyUrl: 'http://127.0.0.1:1234' }), { code: 'ERR_NATIVE_TUNNEL_PROXY' });
    process.env.WARP_PROXY_URL = 'http://127.0.0.1:1234';
    await assert.rejects(create(), { code: 'ERR_NATIVE_TUNNEL_PROXY' });
    delete process.env.WARP_PROXY_URL; checks.push('proxy');
    let lookups = 0;
    const rebound = await create({ resolve: async () => [++lookups === 1 ? '93.184.216.34' : '127.0.0.1'], dial: () => { calls++; } });
    assert.match((await connect(rebound)).response, /403/); assert.equal(calls, 0);
    await rebound.close(); checks.push('rebinding');
    const restricted = await create({ dial: () => { calls++; } });
    assert.match((await connect(restricted, { auth: false })).response, /407/); checks.push('authorization');
    assert.match((await connect(restricted, { host: 'other.example.org:443' })).response, /403/);
    assert.equal(calls, 0); await restricted.close(); checks.push('origin');
    await assert.rejects(create({ timeoutMs: 40, resolve: () => new Promise(() => {}) }), { name: 'TimeoutError' });
    const canceled = new AbortController();
    const canceledReason = new DOMException('Before DNS', 'AbortError');
    canceled.abort(canceledReason);
    await assert.rejects(create({ signal: canceled.signal }), error => error === canceledReason);
    checks.push('deadline');
    const slots = await Promise.all(Array.from({ length: 8 }, () => create()));
    await assert.rejects(create(), { code: 'ERR_NATIVE_TUNNEL_CAPACITY' });
    await slots[0].close(); const replacement = await create(); await replacement.close();
    await Promise.all(slots.map(t => t.close())); checks.push('capacity');

    origin = net.createServer(socket => {
      track(socket); originSockets.add(socket);
      socket.once('close', () => originSockets.delete(socket));
      socket.on('data', data => { if (data.toString() === 'metadata') socket.write('fixture-ok'); });
    });
    await new Promise(r => origin.listen(0, '127.0.0.1', r));
    const deadlineTunnel = await create({ dial, timeoutMs: 250 });
    const stalled = await connect(deadlineTunnel);
    assert.match(stalled.response, /200/);
    await waitFor(() => originSockets.size === 1);
    await waitFor(() => deadlineTunnel.signal.aborted);
    assert.equal(deadlineTunnel.signal.reason.name, 'TimeoutError');
    await deadlineTunnel.close(); await waitFor(() => originSockets.size === 0);
    const caller = new AbortController();
    const first = await create({ dial, signal: caller.signal });
    const second = await create({ dial });
    const a = await connect(first), b = await connect(second);
    assert.match(a.response, /200/); assert.match(b.response, /200/);
    await waitFor(() => originSockets.size === 2);
    const reason = new DOMException('Fixture canceled', 'AbortError'); caller.abort(reason);
    await first.close(); await waitFor(() => originSockets.size === 1);
    assert.equal(first.signal.reason, reason);
    const reply = once(b.socket, 'data'); b.socket.write('metadata');
    assert.equal((await reply)[0].toString(), 'fixture-ok');
    await second.close(); await waitFor(() => originSockets.size === 0); checks.push('isolation');

    const nativeCaller = new AbortController();
    const nativeTunnel = await create({ dial, signal: nativeCaller.signal });
    const client = new Impit({ browser: 'chrome142', proxyUrl: nativeTunnel.proxyUrl,
      http3: false, followRedirects: false, ignoreTlsErrors: false, timeout: 3000 });
    const nativeReason = new DOMException('Native fixture canceled', 'AbortError');
    const request = client.fetch(target, { signal: nativeTunnel.signal, redirect: 'manual', timeout: 3000 }).catch(e => e);
    await waitFor(() => originSockets.size === 1);
    nativeCaller.abort(nativeReason);
    assert.equal(await request, nativeReason);
    await nativeTunnel.close(); await waitFor(() => originSockets.size === 0);
    const closedUrl = new URL(nativeTunnel.proxyUrl);
    const probe = track(net.connect({ host: closedUrl.hostname, port: Number(closedUrl.port) }));
    assert.equal((await once(probe, 'error'))[0].code, 'ECONNREFUSED');
    checks.push('native-abort');
    process.stdout.write(JSON.stringify({ checks, nativeConnectionsAfterAbort: originSockets.size }));
  } finally {
    await Promise.all([...tunnels].map(t => t.close()));
    for (const socket of sockets) socket.destroy();
    if (origin) await new Promise(r => origin.close(r));
  }
})().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
