'use strict';
// Real safeFetch entry point and native client. DNS and numeric dial seams map
// only to this loopback origin; every other attempted JS dial is rejected.
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const Module = require('node:module');
const native = require('impit');
const originalLoad = Module._load, originalConnect = net.connect, originalLookup = dns.promises.lookup;
const sockets = new Set(), profiles = [];
let origin, closeDispatcher, seen = 0, pinned = 0, outcome;
(async () => {
  delete process.env.WARP_PROXY_URL; delete process.env.DAMITV_PROXY_URL;
  try {
    origin = http.createServer((req, res) => {
      seen++;
      if (req.url === '/private') { res.writeHead(302, { Location: 'http://127.0.0.1/private' }); res.end(); return; }
      if (req.url === '/large') { res.end('x'.repeat(4096)); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers));
    });
    origin.on('connection', socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    net.connect = function(options, ...args) {
      if (options?.host === '93.184.216.34') {
        assert.equal(Number(options.port), 80); pinned++;
        return originalConnect.call(this, { ...options, host: '127.0.0.1', port: origin.address().port }, ...args);
      }
      if (options?.host === '127.0.0.1') return originalConnect.call(this, options, ...args);
      throw Error('Non-fixture socket forbidden');
    };
    Module._load = function(name, ...args) {
      if (name === 'impit') return { ...native, Impit: class extends native.Impit {
        constructor(options) { super(options); profiles.push(options.browser || 'vanilla'); }
      } };
      return originalLoad.call(this, name, ...args);
    };
    const { safeFetch } = require('../../src/impitClient');
    closeDispatcher = require('../../src/services/GuardedOutbound').closeGuardedDispatcher;
    const request = (url, options = {}) => safeFetch(url, { guardExternal: true, attempts: 1, ...options });
    const damitv = await (await request('http://messi.damitv.st/headers', { headers: {
      'User-Agent': 'Mozilla/Chrome/127', Authorization: 'fixture'
    } })).json();
    assert.match(damitv['user-agent'], /Chrome\/131/);
    assert.equal(damitv.referer, 'https://damitv.st/'); assert.equal(damitv.authorization, 'fixture');
    assert.equal(damitv.host, 'messi.damitv.st'); assert.equal(damitv['proxy-authorization'], undefined);
    const embed = await (await request('http://dembed.st/headers', { headers: { 'User-Agent': 'Accepted UA' } })).json();
    assert.equal(embed['user-agent'], 'Accepted UA'); assert.equal(embed.referer, 'https://dlive.sx/');
    assert.equal(embed['sec-fetch-dest'], 'iframe');
    assert.equal(embed['sec-fetch-mode'], 'navigate'); assert.equal(embed['sec-fetch-site'], 'cross-site');
    const prefix = await request('http://dembed.st/large', { maxBodyBytes: 64 });
    assert.equal(prefix.bodyTruncated, true); assert.equal((await prefix.arrayBuffer()).byteLength, 64);
    const before = seen;
    await assert.rejects(request('http://dembed.st/private'), { code: 'ERR_OUTBOUND_BLOCKED' });
    assert.equal(seen, before + 1);
    await assert.rejects(request('http://127.0.0.1/private'), { code: 'ERR_OUTBOUND_BLOCKED' });
    assert.equal(seen, before + 1);
    assert.deepEqual(profiles, ['vanilla', 'chrome142']); assert.equal(pinned, seen);
    outcome = { actualSafeFetch: true, guardedNative: true, providerDefaults: true,
      boundedBody: true, privateRedirectBlocked: true, profiles, pinned };
  } finally {
    if (closeDispatcher) await closeDispatcher();
    for (const socket of sockets) socket.destroy();
    if (origin) await new Promise(resolve => origin.close(resolve));
    Module._load = originalLoad; net.connect = originalConnect; dns.promises.lookup = originalLookup;
  }
  process.stdout.write(JSON.stringify(outcome));
})().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
