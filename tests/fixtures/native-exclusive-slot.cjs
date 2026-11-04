'use strict';
// Feasibility only: the private proxy serves fixed HTTP metadata, and its
// sole CONNECT target is a stalled loopback TLS fixture. No provider/media IO.
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { Impit } = require('impit');
const { createNativeExclusiveSlot } = require('../../src/services/NativeExclusiveSlot');
const sockets = new Set(), upstreamSockets = new Set();
let origin, proxy, constructs = 0, connects = 0, metadata = 0, bodyStarted = false;
const track = socket => {
  sockets.add(socket); socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket)); return socket;
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const waitFor = async predicate => {
  const end = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'Local slot fixture condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
(async () => {
  try {
    origin = net.createServer(socket => {
      track(socket); upstreamSockets.add(socket);
      socket.on('data', () => {});
      socket.once('close', () => upstreamSockets.delete(socket));
    });
    await listen(origin);
    proxy = http.createServer((request, response) => {
      if (request.url === 'http://metadata.example.org/stall-body') {
        response.writeHead(200, { 'Content-Length': 100, Connection: 'close' });
        response.write('prefix'); return;
      }
      if (request.url !== 'http://metadata.example.org/fixture') { response.writeHead(403); response.end(); return; }
      metadata++;
      response.writeHead(200, { 'Content-Length': 7, Connection: 'close' }); response.end('fixture');
    });
    proxy.on('connection', track);
    proxy.on('connect', (request, socket, head) => {
      if (request.url !== 'cdn.example.org:443') { socket.destroy(); return; }
      connects++;
      const upstream = track(net.connect({ host: '127.0.0.1', port: origin.address().port }, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      }));
      socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
    });
    await listen(proxy);
    constructs++;
    const client = new Impit({ browser: 'chrome142', proxyUrl: 'http://127.0.0.1:' + proxy.address().port,
      http3: false, followRedirects: false, ignoreTlsErrors: false, timeout: 1500 });
    const slot = createNativeExclusiveSlot(client, reason => {
      for (const socket of sockets) socket.destroy(reason instanceof Error ? reason : undefined);
    });

    // A controlled delayed settlement proves the slot cannot be reassigned
    // merely because the caller has already received its abort notification.
    let finish;
    const controller = new AbortController(), reason = new DOMException('Viewer stopped', 'AbortError');
    const controlled = slot.run(() => new Promise(resolve => { finish = resolve; }), { signal: controller.signal }).catch(e => e);
    await waitFor(() => finish);
    controller.abort(reason); assert.equal(await controlled, reason); assert.equal(slot.busy, true);
    await assert.rejects(slot.run(() => { throw Error('Must not start'); }), { code: 'ERR_NATIVE_SLOT_BUSY' });
    finish(); await waitFor(() => !slot.busy);

    // Now exercise the actual native client. Do not pass the caller signal to
    // Impit: slot release follows its real fetch/body settlement after TCP close.
    const nativeCaller = new AbortController();
    const pending = slot.run(async native => {
      const response = await native.fetch('https://cdn.example.org/fixture', { redirect: 'manual', timeout: 1500 });
      await response.arrayBuffer();
    }, { signal: nativeCaller.signal }).catch(e => e);
    await waitFor(() => upstreamSockets.size === 1);
    nativeCaller.abort(reason); assert.equal(await pending, reason);
    await waitFor(() => !slot.busy && upstreamSockets.size === 0);
    const bodyCaller = new AbortController();
    const bodyRead = slot.run(async native => {
      const response = await native.fetch('http://metadata.example.org/stall-body', { redirect: 'manual', timeout: 1500 });
      bodyStarted = true;
      return response.text();
    }, { signal: bodyCaller.signal }).catch(e => e);
    await waitFor(() => bodyStarted);
    bodyCaller.abort(reason); assert.equal(await bodyRead, reason);
    await waitFor(() => !slot.busy);
    for (let i = 0; i < 3; i++) {
      const value = await slot.run(async native => {
        const response = await native.fetch('http://metadata.example.org/fixture', { redirect: 'manual', timeout: 1500 });
        assert.equal(response.status, 200); return response.text();
      });
      assert.equal(value, 'fixture'); assert.equal(slot.busy, false);
    }
    assert.equal(constructs, 1); assert.equal(connects, 1); assert.equal(metadata, 3);
    process.stdout.write(JSON.stringify({ constructs, connects, metadata, retainedUntilSettlement: true,
      canceledDuringBody: bodyStarted, busyAfterCompletion: slot.busy, remainingOriginSockets: upstreamSockets.size }));
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([proxy, origin].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
  }
})().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
