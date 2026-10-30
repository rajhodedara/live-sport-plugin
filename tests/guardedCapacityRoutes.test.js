'use strict';
jest.mock('../src/services/SharedOutboundFetch', () => ({ fetchSharedOutbound: jest.fn() }));
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
const http = require('node:http');
const express = require('express');
const { fetchSharedOutbound } = require('../src/services/SharedOutboundFetch');
const container = require('../src/container');
const proxy = require('../src/manifestProxy');

let server, base;
beforeAll(async () => {
  const app = express(); app.use(require('../src/routes/manifest')); app.use(require('../src/routes/embed'));
  server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  proxy.manifestCache.clear(); proxy.manifestInFlight.clear(); container.resolve.mockClear(); fetchSharedOutbound.mockReset();
  fetchSharedOutbound.mockRejectedValue(Object.assign(new Error('Local capacity'), { code: 'ERR_OUTBOUND_CAPACITY', statusCode: 503 }));
});

test.each(['/api/manifest', '/api/manifest.m3u8', '/api/manifest.mpd', '/api/proxy-embed'])('%s returns local overload without poisoning stream/cache state', async route => {
  const response = await fetch(base + route + '?url=' + encodeURIComponent('https://embed.st/metadata'));
  await response.text();
  expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(container.resolve).not.toHaveBeenCalled(); expect(proxy.manifestCache.size).toBe(0);
  expect(proxy.manifestInFlight.size).toBe(0);
});

test('capacity on the first attempt is not treated as an upstream 503 or retried', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const response = await fetch(base + '/api/manifest?url=' + encodeURIComponent('https://embed.st/metadata'));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Outbound capacity temporarily exhausted');
    expect(fetchSharedOutbound).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('Upstream 503'))).toBe(false);
    expect(proxy.manifestCache.size).toBe(0);
  } finally { warn.mockRestore(); }
});

test('upstream 503 followed by local capacity reports both without caching', async () => {
  fetchSharedOutbound.mockResolvedValueOnce({ ok: false, status: 503 });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const response = await fetch(base + '/api/manifest?url=' + encodeURIComponent('https://embed.st/metadata'));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Outbound capacity temporarily exhausted');
    expect(fetchSharedOutbound).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('previous upstream HTTP 503'))).toBe(true);
    expect(proxy.manifestCache.size).toBe(0);
  } finally { warn.mockRestore(); }
});
