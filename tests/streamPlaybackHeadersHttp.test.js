const http = require('node:http');
const net = require('node:net');
const express = require('express');
jest.mock('../src/container', () => {
  const Registry = jest.requireActual('../src/services/IframeDomainRegistry');
  const registry = new Registry();
  return { resolve: name => name === 'iframeDomainRegistry' ? registry : undefined };
});
jest.mock('impit', () => { throw new Error('fixture: native impit disabled'); }, { virtual: true });
jest.mock('undici', () => {
  const actual = jest.requireActual('undici'), agents = [];
  return { ...actual, _testAgents: agents, Agent: class extends actual.Agent {
    constructor(...args) { super(...args); agents.push(this); }
  } };
});
// This fixture exercises local HTTP header handling; guard behavior is covered separately.
jest.mock('../src/services/SharedOutboundFetch', () => ({
  fetchSharedOutbound: (url, options) => require('../src/impitClient').safeFetch(url, { ...options, guardExternal: false }),
  closeSharedOutbound: async () => {}
}));
const { safeFetch } = require('../src/impitClient');
const { verifyStreams } = require('../src/streams');
const Parser = require('../src/services/M3U8ParserService');
const registry = require('../src/container').resolve('iframeDomainRegistry');
const manifest = require('../src/manifestProxy');
const body = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5,\nsegment.ts\n';
const right = 'https://fixture.example/embed/player', wrong = 'https://wrong.example/';
const originalConnect = net.Socket.prototype.connect;
let upstream, addon, base, addonBase;
const seen = [];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const url = new URL(req.url, 'http://fixture');
    const accepted = url.pathname === '/auth'
      ? req.headers.authorization === 'Bearer FAKE' && req.headers.cookie === 'session=FAKE'
        && req.headers.origin === 'https://explicit.example' && req.headers['user-agent'] === 'Provider-UA'
        && req.headers['x-fixture'] === 'preserved'
      : req.headers.referer === (url.pathname === '/root' ? 'https://fixture.example/' : right)
        && req.headers.origin === 'https://fixture.example';
    res.writeHead(accepted ? 200 : 403);
    res.end(accepted ? (url.pathname === '/invalid' ? 'not a playlist' : body) : 'denied');
  });
  const app = express(); app.use(require('../src/routes/manifest')); addon = http.createServer(app);
  await listen(upstream); await listen(addon);
  base = 'http://127.0.0.1:' + upstream.address().port;
  addonBase = 'http://127.0.0.1:' + addon.address().port;
  registry.terminalHosts.set('127.0.0.1', { referer: right });
  const ports = new Set([upstream.address().port, addon.address().port]);
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof options !== 'object' || options.host !== '127.0.0.1' || !ports.has(Number(options.port))) throw new Error('TEST_NETWORK_BLOCKED');
    return originalConnect.apply(this, args);
  };
});
beforeEach(() => { seen.length = 0; manifest.manifestCache.clear(); manifest.manifestInFlight.clear(); });
afterAll(async () => {
  registry.terminalHosts.delete('127.0.0.1');
  try {
    await Promise.all(require('undici')._testAgents.map(agent => agent.destroy()));
    await Promise.all([upstream, addon].map(server => new Promise(resolve => {
      server.closeAllConnections(); server.close(resolve);
    })));
    expect(upstream.listening || addon.listening).toBe(false);
  } finally { net.Socket.prototype.connect = originalConnect; }
});
const cache = () => ({ noteSuccess: jest.fn(), noteFailure: jest.fn() });
const run = stream => verifyStreams([stream], '', new Parser(), cache(), { skipSpeedProbe: true });
function proxy(path, relative = false, referer = wrong) {
  const target = base + path + '?token=a%2Bb%26c';
  return { url: (relative ? '' : addonBase) + '/api/manifest?' + new URLSearchParams({
    url: target, referer, origin: referer === right ? 'https://fixture.example' : 'https://wrong.example', other: 'keep',
  }), behaviorHints: { proxyHeaders: { request: { Referer: wrong } } } };
}
test.each([false, true])('repair persists into %s-relative proxy URL and real route serves MISS then HIT', async relative => {
  const stream = proxy('/playlist', relative), before = new URL(stream.url, addonBase);
  const [result] = await run(stream); expect(result).toBe(stream);
  const after = new URL(result.url, addonBase);
  expect(after.searchParams.get('url')).toBe(before.searchParams.get('url'));
  expect(after.searchParams.get('other')).toBe('keep');
  expect(after.searchParams.get('referer')).toBe(right);
  expect(after.searchParams.get('origin')).toBe('https://fixture.example');
  const first = await safeFetch(after.href); expect(first.status).toBe(200);
  expect(first.headers['x-manifest-cache']).toBe('MISS'); expect(await first.text()).toContain('#EXTM3U');
  const second = await safeFetch(after.href); expect(second.headers['x-manifest-cache']).toBe('HIT');
  expect(seen).toHaveLength(3);
});
test('direct playback can reuse accepted repaired hints without changing token URL', async () => {
  const stream = { url: base + '/direct?token=a%2Bb%26c', behaviorHints: { proxyHeaders: { request: { Referer: wrong } } } };
  const before = stream.url; const [result] = await run(stream); expect(result.url).toBe(before);
  const response = await safeFetch(result.url, { headers: result.behaviorHints.proxyHeaders.request });
  expect(response.status).toBe(200); expect(await response.text()).toBe(body);
});
test('root Referer repair succeeds but must also update the returned proxy URL', async () => {
  const root = 'https://fixture.example/'; registry.terminalHosts.set('127.0.0.1', { referer: root });
  try {
    const stream = proxy('/root'); const [result] = await run(stream);
    expect(result).toBe(stream); expect(seen).toHaveLength(2);
    expect(seen[1].headers.referer).toBe(root);
    expect(new URL(result.url).searchParams.get('referer')).toBe(root);
    expect((await safeFetch(result.url)).status).toBe(200);
  } finally { registry.terminalHosts.set('127.0.0.1', { referer: right }); }
});
test('provider credentials UA Origin and custom headers allow direct verification', async () => {
  const headers = { Authorization: 'Bearer FAKE', Cookie: 'session=FAKE', 'User-Agent': 'Provider-UA', Origin: 'https://explicit.example', Referer: right, 'X-Fixture': 'preserved' };
  const stream = { url: base + '/auth', behaviorHints: { proxyHeaders: { request: headers } } };
  expect(await run(stream)).toEqual([stream]); expect(seen).toHaveLength(1);
  expect(seen[0].headers.authorization).toBe('Bearer FAKE');
});
test('real verification generates the correct Host and omits provider framing and nominated hop headers', async () => {
  const headers = Object.freeze({ Authorization: 'Bearer FAKE', Cookie: 'session=FAKE',
    'User-Agent': 'Provider-UA', Origin: 'https://explicit.example', Referer: right, 'X-Fixture': 'preserved',
    hOsT: 'spoofed.invalid', Connection: 'X-Private-Hop', 'X-Private-Hop': 'transport-only',
    'Content-Length': '999', 'Transfer-Encoding': 'chunked' });
  const stream = { url: base + '/auth', behaviorHints: { proxyHeaders: { request: headers } } };
  expect(await run(stream)).toEqual([stream]); expect(seen).toHaveLength(1);
  expect(seen[0].headers.host).toBe(new URL(base).host);
  for (const name of ['x-private-hop', 'content-length', 'transfer-encoding']) expect(seen[0].headers[name]).toBeUndefined();
  expect(headers.hOsT).toBe('spoofed.invalid');
});
test('nonempty proxy query overrides contradictory hint without needing repair', async () => {
  const stream = proxy('/query', false, right);
  expect(await run(stream)).toEqual([stream]); expect(seen).toHaveLength(1);
  expect(seen[0].headers.referer).toBe(right);
});
test('invalid 200 repair body never publishes guessed playback headers', async () => {
  const stream = proxy('/invalid'), before = JSON.stringify(stream);
  expect(await run(stream)).toEqual([]); expect(JSON.stringify(stream)).toBe(before); expect(seen).toHaveLength(2);
});
test('boundary: direct authorization verification does not add secret headers to manifest proxy', async () => {
  const headers = { Authorization: 'Bearer FAKE', Cookie: 'session=FAKE', 'User-Agent': 'Provider-UA', Origin: 'https://explicit.example', Referer: right, 'X-Fixture': 'preserved' };
  const stream = { url: base + '/auth', behaviorHints: { proxyHeaders: { request: headers } } };
  expect(await run(stream)).toEqual([stream]);
  const query = new URLSearchParams({ url: stream.url, referer: right, origin: 'https://explicit.example' });
  const response = await safeFetch(addonBase + '/api/manifest?' + query);
  expect(response.status).toBe(404); expect(seen.at(-1).headers.authorization).toBeUndefined();
});
