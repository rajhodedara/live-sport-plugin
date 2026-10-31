'use strict';
// Run with node --test. The installed middleware is ESM and the repository's
// Jest configuration does not load it directly. No listening socket is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const express = require('express');
const { Duplex, PassThrough, Writable } = require('node:stream');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createPinnedResolverClients } = require('../src/services/ResolverPinnedClients');
const { createResolverProxyEvents } = require('../src/services/ResolverProxyEvents');

const dir = path.join(__dirname, 'fixtures/guarded-tls');
const cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');

async function exercise(pin, waitForResponse = false, redirect = false) {
  const oldConnect = tls.connect, oldNetConnect = net.connect;
  const streams = [];
  let requests = 0, tlsOptions, reportTlsError;
  net.connect = () => { throw new Error('unexpected network access'); };
  tls.connect = options => {
    tlsOptions = options;
    const a = new PassThrough(), b = new PassThrough();
    const client = Duplex.from({ readable: b, writable: a });
    const peer = Duplex.from({ readable: a, writable: b });
    for (const stream of [a, b, client, peer]) stream.on('error', () => {});
    const server = new tls.TLSSocket(peer, { isServer: true, secureContext: tls.createSecureContext({ key, cert }) });
    server.on('error', () => {});
    server.on('data', () => {
      requests++;
      server.end(redirect
        ? 'HTTP/1.1 302 Found\r\nLocation: https://foreign.invalid/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
        : 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
    streams.push(server, client, peer, a, b);
    const socket = oldConnect({ ...options, socket: client, ca: cert });
    socket.on('error', error => reportTlsError?.(error));
    return socket;
  };
  const clients = createPinnedResolverClients({ certificatePem: pin, expectedHost: 'cdn.example.org', port: 7004 });
  try {
    const req = new PassThrough();
    Object.assign(req, { method: 'GET', url: '/stream', headers: { host: 'localhost' },
      httpVersion: '1.1', httpVersionMajor: 1, socket: { writable: true } });
    let body = '', proxyFailure;
    const res = new Writable({ write(chunk, encoding, callback) { body += chunk.toString(); callback(); } });
    res.setHeader = () => {};
    res.status = code => { res.statusCode = code; return res; };
    res.send = text => { res.end(text); return res; };
    const events = createResolverProxyEvents({ signal: () => new AbortController().signal });
    const middleware = createProxyMiddleware({ ...clients.proxyOptions, logger: { info() {}, warn() {}, error() {} },
      on: { proxyReq: events.proxyReq, error(error, request, response) { proxyFailure = error; events.error(error, request, response); } } });
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ failure: new Error('test timeout') }), 3000);
      if (!waitForResponse) reportTlsError = failure => { clearTimeout(timer); resolve({ failure }); };
      res.once('finish', () => { clearTimeout(timer); resolve({ body, status: res.statusCode }); });
      res.once('error', failure => { clearTimeout(timer); resolve({ failure }); });
      res.once('close', () => { if (!res.writableFinished) { clearTimeout(timer); resolve({ failure: proxyFailure || new Error('proxy closed') }); } });
      middleware(req, res, failure => { if (failure) { clearTimeout(timer); resolve({ failure }); } });
      req.end();
    });
    return { ...outcome, requests, tlsOptions };
  } finally {
    await clients.close();
    for (const stream of streams) stream.destroy();
    tls.connect = oldConnect; net.connect = oldNetConnect;
  }
}

test('middleware uses the pinned HTTPS agent', async () => {
  const result = await exercise(cert);
  assert.equal(result.failure, undefined);
  assert.equal(result.body, 'ok');
  assert.equal(result.requests, 1);
  assert.equal(result.tlsOptions.rejectUnauthorized, true);
  assert.equal(result.tlsOptions.servername, 'cdn.example.org');
});

test('middleware rejects a wrong pin before upstream HTTP', async () => {
  const result = await exercise(tls.rootCertificates[0]);
  assert.ok(result.failure);
  assert.notEqual(result.failure.message, 'test timeout');
  assert.equal(result.requests, 0);
});

test('middleware returns a generic error response for a rejected TLS identity', async () => {
  const result = await exercise(tls.rootCertificates[0], true);
  assert.equal(result.failure, undefined);
  assert.equal(result.status, 502);
  assert.equal(result.body, 'Bad Gateway: Internal stream resolver is not responding.');
  assert.equal(result.requests, 0);
});

test('middleware does not follow a resolver redirect to a different endpoint', async () => {
  const result = await exercise(cert, true, true);
  assert.equal(result.failure, undefined);
  assert.equal(result.status, 302);
  assert.equal(result.requests, 1);
});

test('an HTTP client receives the generic 502 when the resolver pin is wrong', async () => {
  const oldConnect = tls.connect, oldNetConnect = net.connect;
  const streams = [];
  let upstreamRequests = 0;
  net.connect = () => { throw new Error('unexpected network access'); };
  tls.connect = options => {
    const a = new PassThrough(), b = new PassThrough();
    const client = Duplex.from({ readable: b, writable: a });
    const peer = Duplex.from({ readable: a, writable: b });
    for (const stream of [a, b, client, peer]) stream.on('error', () => {});
    const server = new tls.TLSSocket(peer, { isServer: true, secureContext: tls.createSecureContext({ key, cert }) });
    server.on('error', () => {});
    server.on('data', () => { upstreamRequests++; });
    streams.push(server, client, peer, a, b);
    return oldConnect({ ...options, socket: client, ca: cert });
  };
  const clients = createPinnedResolverClients({ certificatePem: tls.rootCertificates[0], expectedHost: 'cdn.example.org', port: 7004 });
  const app = express();
  const events = createResolverProxyEvents({ signal: () => new AbortController().signal });
  app.use(createProxyMiddleware({ ...clients.proxyOptions, logger: { info() {}, warn() {}, error() {} }, on: events }));
  const server = http.createServer(app);
  const inbound = new PassThrough(), outbound = new PassThrough();
  const socket = Duplex.from({ readable: inbound, writable: outbound });
  for (const stream of [inbound, outbound, socket]) { stream.on('error', () => {}); streams.push(stream); }
  try {
    const response = await new Promise((resolve, reject) => {
      let data = '';
      const timer = setTimeout(() => reject(new Error('test timeout')), 3000);
      outbound.on('data', chunk => { data += chunk.toString(); });
      outbound.on('end', () => { clearTimeout(timer); resolve(data); });
      server.emit('connection', socket);
      inbound.write('GET /stream?token=secret HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    });
    assert.match(response, /^HTTP\/1\.1 502 /);
    assert.match(response, /Bad Gateway: Internal stream resolver is not responding\./);
    assert.doesNotMatch(response, /secret|token/);
    assert.equal(upstreamRequests, 0);
  } finally {
    await clients.close();
    for (const stream of streams) stream.destroy();
    server.close();
    tls.connect = oldConnect; net.connect = oldNetConnect;
  }
});
