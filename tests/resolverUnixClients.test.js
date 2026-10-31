'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { createResolverUnixClients, createPinnedResolverUnixClients } = require('../src/services/ResolverUnixClients');

test('experimental socket adapter confines cache requests and does not follow redirects', async () => {
  const dispatcher = { close: jest.fn(async () => {}) };
  const Dispatcher = jest.fn(function () { return dispatcher; });
  const fetch = jest.fn(async () => ({ ok: true }));
  const clients = createResolverUnixClients({ socketPath: '/run/nuvio-test/resolver.sock', legacyPort: 7004 }, { Dispatcher, fetch });
  try {
    expect(Dispatcher).toHaveBeenCalledWith({ connect: { socketPath: '/run/nuvio-test/resolver.sock' } });
    expect(clients.proxyOptions).toEqual({ target: { protocol: 'http:', socketPath: '/run/nuvio-test/resolver.sock', pathname: '/api' }, agent: false, followRedirects: false });
    await clients.request('http://127.0.0.1:7004/api/cache/key', { redirect: 'follow', dispatcher: {} });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:7004/api/cache/key', expect.objectContaining({ dispatcher, redirect: 'error' }));
    await expect(clients.request('http://foreign.example:7004/api/cache/key')).rejects.toThrow('Invalid resolver request');
    await expect(clients.request('http://127.0.0.1:7004/api/stream')).rejects.toThrow('Invalid resolver request');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { await clients.close(); }
  expect(dispatcher.close).toHaveBeenCalledTimes(1);
  expect(clients.available()).toBe(false);
});

test('rejects relative, traversing and malformed socket configurations', () => {
  for (const socketPath of ['relative.sock', '/run/test/../resolver.sock', '/run/a\0b', '/' + 'x'.repeat(101)]) {
    expect(() => createResolverUnixClients({ socketPath, legacyPort: 7004 })).toThrow('Invalid resolver socket configuration');
  }
});

test('pinned Unix clients require TLS for both cache and proxy paths', async () => {
  const certificatePem = fs.readFileSync(path.join(__dirname, 'fixtures/guarded-tls/cert.pem'), 'utf8');
  const dispatcher = { close: jest.fn(async () => {}) }, agent = { destroy: jest.fn() };
  let connectOptions, agentOptions;
  const Dispatcher = jest.fn(function (opts) { connectOptions = opts.connect; return dispatcher; });
  const createProxyAgent = jest.fn(opts => { agentOptions = opts; return agent; });
  const fetch = jest.fn(async () => ({ ok: true }));
  const config = { socketPath: '/run/nuvio-test/resolver.sock', legacyPort: 7004,
    tlsIdentity: { certificatePem, expectedHost: 'cdn.example.org' } };
  const clients = createPinnedResolverUnixClients(config, { Dispatcher, createProxyAgent, fetch });
  try {
    expect(connectOptions).toMatchObject({ socketPath: config.socketPath, ca: certificatePem, servername: 'cdn.example.org', rejectUnauthorized: true });
    expect(agentOptions).toMatchObject({ ca: certificatePem, servername: 'cdn.example.org', rejectUnauthorized: true });
    const peer = new X509Certificate(certificatePem).toLegacyObject();
    expect(connectOptions.checkServerIdentity('cdn.example.org', peer)).toBeUndefined();
    expect(agentOptions.checkServerIdentity('wrong.example.org', peer)).toBeInstanceOf(Error);
    expect(clients.proxyOptions).toMatchObject({ target: { protocol: 'https:', socketPath: config.socketPath }, agent, secure: true, followRedirects: false });
    await clients.request('http://127.0.0.1:7004/api/cache/key');
    expect(fetch).toHaveBeenCalledWith('https://127.0.0.1:7004/api/cache/key', expect.objectContaining({ dispatcher, redirect: 'error' }));
  } finally { await clients.close(); }
  expect(agent.destroy).toHaveBeenCalledTimes(1);
  expect(dispatcher.close).toHaveBeenCalledTimes(1);
  expect(() => createPinnedResolverUnixClients({ socketPath: config.socketPath, legacyPort: 7004 })).toThrow('Resolver TLS identity required');
});
