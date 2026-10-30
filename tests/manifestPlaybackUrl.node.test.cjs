'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { manifestPlaybackUrl } = require('../src/services/ManifestPlaybackUrl');
const base = 'https://addon.example.invalid';
const root = path.join(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const target = 'https://cdn.example.invalid/live.m3u8?token=a%2Bb%3D&nested=x%26y';
const query = '?url=' + encodeURIComponent(target) + '&referer=https%3A%2F%2Fembed.st%2F&origin=https%3A%2F%2Fembed.st&rck=streamedpk%3Amatch%3Asource&extra=a+b#fragment';

test('changes only the local HLS path, preserving the raw nested URL, query and fragment', () => {
  const before = base + '/api/manifest' + query;
  const after = manifestPlaybackUrl(before, base);
  assert.equal(after, base + '/api/manifest.m3u8' + query);
  assert.equal(new URL(after).searchParams.get('url'), target);
  assert.equal(new URL(after).searchParams.get('rck'), 'streamedpk:match:source');
});

test('supports relative addon paths and configured base path prefixes', () => {
  assert.equal(manifestPlaybackUrl('/api/manifest' + query, base), '/api/manifest.m3u8' + query);
  assert.equal(manifestPlaybackUrl(base + '/sports/api/manifest' + query, base + '/sports/'), base + '/sports/api/manifest.m3u8' + query);
});

test('leaves third-party URLs, DASH, malformed inputs and already suffixed paths untouched', () => {
  for (const value of [
    'https://external.example.invalid/api/manifest' + query,
    base + '/api/manifest.m3u8' + query,
    base + '/api/manifest?url=' + encodeURIComponent('https://cdn.example.invalid/live.mpd?token=x'),
    base + '/api/manifest',
    'https://cdn.example.invalid/live.m3u8', undefined, null, ''
  ]) assert.equal(manifestPlaybackUrl(value, base), value);
  assert.equal(manifestPlaybackUrl(base + '/api/manifest' + query, 'invalid base'), base + '/api/manifest' + query);
});

test('actual publication block preserves recovery keys and normalizes the suffixed HLS URL', () => {
  const text = source('src/streams.js');
  const startKey = text.indexOf('function withResolveKey(');
  const endKey = text.indexOf('\n}', startKey) + 2;
  const withKey = vm.runInNewContext(text.slice(startKey, endKey) + '\nwithResolveKey');
  const start = text.indexOf('    // Change only the published path');
  const end = text.indexOf('\n  });', start);
  const publish = vm.runInNewContext('(function(s,providerName){' + text.slice(start, end) + '\nreturn s;})', { manifestPlaybackUrl, BASE_URL: base });
  const cached = { url: base + '/api/manifest?url=' + encodeURIComponent(target), behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: 'https://embed.st/' } } } };
  const playback = { ...cached, url: withKey(cached.url, 'ppvst:match:source'), behaviorHints: { ...cached.behaviorHints } };
  publish(playback, 'PpvSt');
  assert.equal(new URL(playback.url).pathname, '/api/manifest.m3u8');
  assert.equal(new URL(playback.url).searchParams.get('rck'), 'ppvst:match:source');
  assert.equal(playback.behaviorHints.notWebReady, false);
  assert.equal(playback.behaviorHints.proxyHeaders, undefined);
  assert.equal(new URL(cached.url).pathname, '/api/manifest');
  assert.ok(cached.behaviorHints.proxyHeaders);
});

test('publication keeps source headers on direct HLS but drops them on proxied HLS', () => {
  const text = source('src/streams.js');
  const start = text.indexOf('    // Change only the published path');
  const end = text.indexOf('\n  });', start);
  const publish = vm.runInNewContext('(function(s,providerName){' + text.slice(start, end) + '\nreturn s;})', { manifestPlaybackUrl, BASE_URL: base });
  const direct = { url: 'https://cdn.example.invalid/live.m3u8', behaviorHints: { proxyHeaders: { request: { 'User-Agent': 'FixtureClient/1.0' } } } };
  const proxied = { url: base + '/api/manifest?url=' + encodeURIComponent(direct.url) + '&hlsua=FixtureClient%2F1.0', behaviorHints: { proxyHeaders: { request: { 'User-Agent': 'FixtureClient/1.0' } } } };
  publish(direct, 'Ak47Live');
  publish(proxied, 'Ak47Live');
  assert.equal(direct.behaviorHints.notWebReady, false);
  assert.equal(direct.behaviorHints.proxyHeaders.request['User-Agent'], 'FixtureClient/1.0');
  assert.equal(proxied.behaviorHints.notWebReady, false);
  assert.equal(proxied.behaviorHints.proxyHeaders, undefined);
  assert.equal(new URL(proxied.url).searchParams.get('hlsua'), 'FixtureClient/1.0');
});

function fixture(body) {
  const handlers = new Map(), entries = new Map(), upstream = [];
  const router = { use() {}, all() {}, options() {}, get: (paths, handler) => { for (const value of Array.isArray(paths) ? paths : [paths]) handlers.set(value, handler); } };
  const context = { URL, Buffer, process: { env: {} }, Date: { now: () => 1800000000000 }, console: { log() {}, warn() {}, error() {} } };
  const hm = { exports: {} };
  vm.runInNewContext(source('src/services/HlsRewriteService.js'), { ...context, module: hm, require: name => {
    if (name === './WorkerBudget') return { createWorkerPool: () => ({}) };
    if (name === './ByteRangeSigner') return { encodeSegmentToken: data => ({ token: Buffer.from(data.url).toString('base64url'), psig: 'fixture' }) };
    if (name === './SegmentLengthService') return { getSegmentLength: () => 564, hasValidLength: () => true };
    throw Error('Unexpected dependency: ' + name);
  } });
  const proxy = {
    MANIFEST_TTL_MS: 60000,
    playlistHasContent: text => text.split('\n').some(line => line && !line.startsWith('#')),
    manifestCacheGet: key => entries.get(key),
    manifestCacheSet: (key, value) => entries.set(key, { body: value }),
    manifestCacheSetNegative: () => { throw Error('Unexpected negative result'); },
    notifyResolveCacheOfDeadStream: () => { throw Error('Unexpected dead stream'); },
    fetchUpstreamManifest: async (...args) => {
      upstream.push(args);
      return args[3]?.withResponseUrl ? { body, url: args[0] } : body;
    },
    manifestInFlight: new Map()
  };
  const rm = { exports: {} };
  vm.runInNewContext(source('src/routes/manifest.js'), { ...context, module: rm, require: name => {
    if (name === 'express') return { Router: () => router, json: () => () => {}, urlencoded: () => () => {} };
    if (name === '../manifestProxy') return proxy;
    if (name === '../remint') return { readRck: req => req.query.rck, getRemintCacheKey: () => null, remintCache: new Map(), isExpiryStatus: () => false };
    if (name === '../services/HlsRewriteService') return hm.exports;
    if (name === '../config') return { getRequestBaseUrl: () => base };
    if (name === '../services/ManifestUserAgent') return require('../src/services/ManifestUserAgent');
    if (name === '../impitClient') return { safeFetch: () => { throw Error('Unexpected fetch'); } };
    throw Error('Parser unavailable in isolated fixture');
  } });
  return { handlers, upstream, entries };
}

test('both paths register the same handler', () => {
  const f = fixture('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
  assert.equal(f.handlers.get('/api/manifest'), f.handlers.get('/api/manifest.m3u8'));
});

test('real HTTP: old and new paths serve identical rewritten HLS, without a redirect or extra upstream fetch', async () => {
  const f = fixture('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://cdn.example.invalid/segment.image\n');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const handler = f.handlers.get(url.pathname);
    if (!handler) { res.writeHead(404); res.end(); return; }
    const response = { setHeader: (k, v) => res.setHeader(k, v), status(code) { res.statusCode = code; return this; }, send: body => res.end(body) };
    Promise.resolve(handler({ query: Object.fromEntries(url.searchParams), headers: req.headers, originalUrl: req.url, url: req.url }, response)).catch(error => { res.statusCode = 500; res.end(error.message); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const local = 'http://127.0.0.1:' + server.address().port;
    const suffix = query.split('#')[0];
    const a = await fetch(local + '/api/manifest' + suffix, { redirect: 'error' });
    const oldBody = await a.text();
    const b = await fetch(local + '/api/manifest.m3u8' + suffix, { redirect: 'error' });
    const newBody = await b.text();
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    assert.equal(b.headers.get('content-type'), a.headers.get('content-type'));
    assert.equal(a.headers.get('x-manifest-cache'), 'MISS');
    assert.equal(b.headers.get('x-manifest-cache'), 'HIT');
    assert.equal(oldBody, newBody);
    assert.ok(newBody.includes('#EXT-X-VERSION:4'));
    assert.ok(newBody.includes('#EXT-X-BYTERANGE:564@42'));
    // Segment addressing is mode-dependent (see segmentAddressMode); this fixture
    // runs with an empty env, i.e. the default direct-CDN mode. What must hold is
    // that the declared byte range sits on the upstream object itself.
    assert.ok(newBody.includes('https://cdn.example.invalid/segment.image'));
    assert.equal(f.upstream.length, 1);
    assert.equal(f.upstream[0][0], target);
    assert.equal(f.upstream[0][1], 'https://embed.st/');
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('master playlist retains child queries and recovery key', async () => {
  const f = fixture('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nchild.m3u8\n');
  const result = { headers: {} };
  await f.handlers.get('/api/manifest.m3u8')({ query: { url: target, referer: 'https://embed.st/', origin: 'https://embed.st', rck: 'streamedpk:match:source' } }, {
    setHeader: (k, v) => { result.headers[k] = v; }, send: body => { result.body = body; }, status() { throw Error('Unexpected status'); }
  });
  const child = new URL(result.body.split('\n').find(line => line.startsWith('https://')));
  assert.equal(child.searchParams.get('rck'), 'streamedpk:match:source');
  assert.equal(new URL(child.searchParams.get('url')).pathname, '/child.m3u8');
  assert.equal(child.searchParams.get('referer'), 'https://embed.st/');
});
