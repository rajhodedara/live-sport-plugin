'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { createPinnedResolverClients } = require('../src/services/ResolverPinnedClients');
const StreamResolveCache = require('../src/services/StreamResolveCache');

const certificatePem = fs.readFileSync(path.join(__dirname, 'fixtures/guarded-tls/cert.pem'), 'utf8');

function fixture(port = 7004) {
  let options, proxyOptions;
  const dispatcher = { close: jest.fn(async () => {}), destroy: jest.fn() };
  const proxyAgent = { destroy: jest.fn() };
  const Dispatcher = jest.fn(function (opts) { options = opts; return dispatcher; });
  const createProxyAgent = jest.fn(opts => { proxyOptions = opts; return proxyAgent; });
  const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: 'miss' }) }));
  const clients = createPinnedResolverClients({ certificatePem, expectedHost: 'cdn.example.org', port }, { Dispatcher, createProxyAgent, fetch });
  return { clients, options, proxyOptions, dispatcher, proxyAgent, fetch };
}

test('adapter availability does not claim the resolver has been authenticated', async () => {
  const f = fixture();
  try {
    expect(f.clients.available()).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
    // No request or TLS handshake has occurred: this flag cannot be used as
    // a readiness signal or evidence that a listener belongs to this instance.
  } finally { await f.clients.close(); }
});

test('both clients require CA verification, hostname validation and the same certificate pin', async () => {
  const f = fixture();
  const peer = new X509Certificate(certificatePem).toLegacyObject();
  expect(f.options.connect).toMatchObject({ ca: certificatePem, servername: 'cdn.example.org', rejectUnauthorized: true });
  expect(f.proxyOptions).toMatchObject({ ca: certificatePem, servername: 'cdn.example.org', rejectUnauthorized: true });
  expect(f.options.connect.checkServerIdentity('cdn.example.org', peer)).toBeUndefined();
  expect(f.proxyOptions.checkServerIdentity('wrong.example.org', peer)).toBeInstanceOf(Error);
  const badRaw = Buffer.from(peer.raw); badRaw[badRaw.length - 1] ^= 1;
  expect(f.options.connect.checkServerIdentity('cdn.example.org', { ...peer, raw: badRaw })).toBeInstanceOf(Error);
  expect(f.clients.proxyOptions).toMatchObject({ target: 'https://127.0.0.1:7004/api', secure: true, followRedirects: false });
  await f.clients.close();
  expect(f.dispatcher.close).toHaveBeenCalledTimes(1); expect(f.proxyAgent.destroy).toHaveBeenCalledTimes(1);
});

test('closing still releases the dispatcher if the proxy agent fails to close', async () => {
  const f = fixture();
  f.proxyAgent.destroy.mockImplementation(() => { throw new Error('fixture failure'); });
  const closing = f.clients.close();
  await expect(closing).rejects.toThrow('fixture failure');
  expect(f.dispatcher.close).toHaveBeenCalledTimes(1);
  expect(f.clients.available()).toBe(false);
  expect(f.clients.close()).toBe(closing);
});

test('cache requests use only the pinned HTTPS dispatcher and reject redirects and foreign origins', async () => {
  const f = fixture();
  try {
    await f.clients.request('http://127.0.0.1:7004/api/cache/fixture?claim=1', { redirect: 'follow', dispatcher: {} });
    expect(f.fetch).toHaveBeenCalledWith('https://127.0.0.1:7004/api/cache/fixture?claim=1',
      expect.objectContaining({ dispatcher: f.dispatcher, redirect: 'error' }));
    await expect(f.clients.request('http://example.test:7004/api/cache/secret')).rejects.toThrow('Invalid resolver request');
    await expect(f.clients.request('http://127.0.0.1:7004/api/stream?secret=x')).rejects.toThrow('Invalid resolver request');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  } finally { await f.clients.close(); }
  expect(f.clients.available()).toBe(false);
  await expect(f.clients.request('http://127.0.0.1:7004/api/cache/x')).rejects.toThrow('Resolver transport unavailable');
});

test('cache adapter uses the pinned client rather than raw fetch', async () => {
  const originalFetch = global.fetch, oldShared = process.env.RESOLVE_CACHE_SHARED, oldPort = process.env.RESOLVER_PORT;
  const f = fixture();
  global.fetch = jest.fn(() => { throw new Error('raw fetch'); });
  process.env.RESOLVE_CACHE_SHARED = 'true'; process.env.RESOLVER_PORT = '7004';
  try {
    const cache = new StreamResolveCache({ sharedResolver: f.clients });
    await cache.getOrCreate('damitv:fixture:s', async () => []);
    expect(f.fetch).toHaveBeenCalled();
    expect(f.fetch.mock.calls.every(([url]) => url.startsWith('https://127.0.0.1:7004/api/cache/'))).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    await f.clients.close(); global.fetch = originalFetch;
    if (oldShared === undefined) delete process.env.RESOLVE_CACHE_SHARED; else process.env.RESOLVE_CACHE_SHARED = oldShared;
    if (oldPort === undefined) delete process.env.RESOLVER_PORT; else process.env.RESOLVER_PORT = oldPort;
  }
});
