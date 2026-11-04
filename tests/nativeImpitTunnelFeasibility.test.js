'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('native Impit retains HTTPS identity and certificate checks through a validated test tunnel', () => {
  // Native client in a fresh process, immune to Jest's Impit mocks. This is a
  // feasibility fixture, not a production proxy. Every dial is to loopback;
  // the public IP is a recorded validation result, never contacted.
  const result = JSON.parse(execFileSync(process.execPath, ['--eval', `
    const http = require('node:http'), tls = require('node:tls'), net = require('node:net');
    const fs = require('node:fs');
    const { Impit } = require('impit');
    const { assertOutboundUrl } = require('./src/services/GuardedOutbound');
    const key = fs.readFileSync('./tests/fixtures/guarded-tls/key.pem');
    const cert = fs.readFileSync('./tests/fixtures/guarded-tls/cert.pem');
    const context = tls.createSecureContext({ key, cert });
    const sockets = new Set(), names = [], connects = [], blocked = [], validated = [], plainRequests = [];
    let httpBytes = 0;
    const track = socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
      return socket;
    };
    const origin = tls.createServer({ key, cert, SNICallback(name, callback) { names.push(name); callback(null, context); } }, socket => {
      socket.on('data', data => { httpBytes += data.length; });
    });
    origin.on('connection', track); origin.on('tlsClientError', () => {});
    const proxy = http.createServer(async (req, res) => {
      plainRequests.push(req.url);
      try {
        await assertOutboundUrl(req.url, { resolve: async () => ['93.184.216.34'] });
        if (req.url !== 'http://metadata.example.org/redirect') throw Error('Non-fixture target forbidden');
        // Fixed metadata response only: no request is forwarded or downloaded.
        res.writeHead(302, { Location: 'https://127.0.0.1:' + origin.address().port + '/private' }); res.end();
      } catch (_) { res.writeHead(403); res.end(); }
    });
    proxy.on('connection', track);
    proxy.on('connect', async (request, socket, head) => {
      connects.push(request.url);
      try {
        const verdict = await assertOutboundUrl('https://' + request.url + '/', {
          resolve: async () => ['93.184.216.34']
        });
        // The only successful lab target is the reserved fixture identity.
        if (new URL('https://' + request.url).hostname !== 'cdn.example.org') throw Error('Non-fixture target forbidden');
        validated.push(verdict.addresses[0]);
        const upstream = track(net.connect({ host: '127.0.0.1', port: origin.address().port }, () => {
          socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
          if (head.length) upstream.write(head);
          socket.pipe(upstream); upstream.pipe(socket);
        }));
        socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
      } catch (error) {
        blocked.push(error.code || error.message);
        socket.end('HTTP/1.1 403 Forbidden\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n');
      }
    });
    const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    (async () => {
      let outcome;
      try {
        await listen(origin); await listen(proxy);
        const client = new Impit({ browser: 'chrome142', proxyUrl: 'http://127.0.0.1:' + proxy.address().port,
          http3: false, followRedirects: false, ignoreTlsErrors: false, timeout: 1500 });
        let certificateError, privateError;
        try { await client.fetch('https://cdn.example.org/metadata', { redirect: 'manual', timeout: 1500 }); }
        catch (error) { certificateError = { name: error.name, message: error.message }; }
        const beforePrivate = names.length;
        try { await client.fetch('https://127.0.0.1:' + origin.address().port + '/private', { redirect: 'manual', timeout: 1500 }); }
        catch (error) { privateError = { name: error.name }; }
        const manual = await client.fetch('http://metadata.example.org/redirect', { redirect: 'manual', timeout: 1500 });
        await manual.text();
        outcome = { names, connects, blocked, validated, certificateError, privateError, beforePrivate, httpBytes,
          manualStatus: manual.status, plainRequests };
      } finally {
        for (const socket of sockets) socket.destroy();
        await Promise.all([origin, proxy].map(server => new Promise(resolve => server.close(resolve))));
      }
      process.stdout.write(JSON.stringify(outcome));
    })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'pipe'] }));
  expect(result.names).toEqual(['cdn.example.org']);
  expect(result.validated).toEqual(['93.184.216.34']);
  expect(result.connects).toHaveLength(2);
  expect(result.blocked).toEqual(['ERR_OUTBOUND_BLOCKED']);
  expect(result.beforePrivate).toBe(1);
  expect(result.httpBytes).toBe(0);
  expect(result.certificateError.message).toMatch(/certificate|UnknownIssuer|invalid peer/i);
  expect(result.privateError).toBeDefined();
  expect(result.manualStatus).toBe(302);
  expect(result.plainRequests).toEqual(['http://metadata.example.org/redirect']);
});
