'use strict';

const http = require('node:http');
const express = require('express');

jest.mock('../src/container', () => ({ resolve: () => ({ noteFailure: jest.fn() }) }));
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));

const { safeFetch } = require('../src/impitClient');
const manifestProxy = require('../src/manifestProxy');
const manifestRouter = require('../src/routes/manifest');

describe('/api/manifest cache identity includes the rewritten request base URL', () => {
  let server;
  let addon;
  const body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nchild.m3u8\n';

  beforeAll(async () => {
    const app = express();
    app.use(manifestRouter);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    addon = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => {
    manifestProxy.manifestCache.clear();
    manifestProxy.manifestInFlight.clear();
    safeFetch.mockReset();
    safeFetch.mockResolvedValue({ ok: true, status: 200, text: async () => body });
  });

  afterAll(async () => {
    await new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    });
  });

  async function requestWithHost(host, rck, overrides = {}, pathname = '/api/manifest') {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname + '?' + new URLSearchParams({
        url: 'https://cdn.example/live/master.m3u8',
        ...(rck !== undefined ? { rck } : {}),
        ...overrides,
      }), addon);
      const req = http.get(url, { headers: { Host: host } }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('manifest request timed out')));
    });
  }

  test('separates cached manifests by user agent and preserves it in the child URL', async () => {
    const first = await requestWithHost('same.example', undefined, { hlsua: 'Fixture-A/1.0' });
    const second = await requestWithHost('same.example', undefined, { hlsua: 'Fixture-B/1.0' });
    const again = await requestWithHost('same.example', undefined, { hlsua: 'Fixture-A/1.0' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(again.headers['x-manifest-cache']).toBe('HIT');
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls.map(call => call[1].headers['User-Agent'])).toEqual(['Fixture-A/1.0', 'Fixture-B/1.0']);
    const child = first.body.split('\n').find(line => line.includes('/api/manifest?'));
    expect(new URL(child).searchParams.get('hlsua')).toBe('Fixture-A/1.0');
    const childQuery = Object.fromEntries(new URL(child).searchParams);
    const childResponse = await requestWithHost('same.example', undefined, childQuery);
    expect(childResponse.status).toBe(200);
    expect(safeFetch.mock.calls[2][0]).toBe('https://cdn.example/live/child.m3u8');
    expect(safeFetch.mock.calls[2][1].headers['User-Agent']).toBe('Fixture-A/1.0');
  });

  test('invalid user agent does not reach the upstream request', async () => {
    const result = await requestWithHost('same.example', undefined, { hlsua: 'bad\r\nInjected: value' });
    expect(result.status).toBe(200);
    expect(safeFetch.mock.calls[0][1].headers['User-Agent']).not.toContain('\r');
    expect(result.body).not.toContain('hlsua=');
  });

  test('legacy HLS ua parameter keeps the existing default user agent', async () => {
    const result = await requestWithHost('same.example', undefined, { ua: 'LegacyClient/131.0' });
    expect(result.status).toBe(200);
    expect(safeFetch.mock.calls[0][1].headers['User-Agent']).toContain('Chrome/127.0.0.0');
    expect(result.body).not.toContain('hlsua=');
  });

  test('Vavoo keeps its historical default when no HLS user agent is supplied', async () => {
    const result = await requestWithHost('same.example', undefined, { referer: 'https://vavoo.to/' });
    expect(result.status).toBe(200);
    expect(safeFetch.mock.calls[0][1].headers['User-Agent']).toBe('MediaHubMX/2');
  });

  test('a rejected user agent does not negatively cache a different user agent', async () => {
    safeFetch.mockImplementation(async (_url, opts) => opts.headers['User-Agent'] === 'BadClient/1.0'
      ? { ok: false, status: 403 }
      : { ok: true, status: 200, text: async () => body });
    const bad = await requestWithHost('same.example', undefined, { hlsua: 'BadClient/1.0' });
    const good = await requestWithHost('same.example', undefined, { hlsua: 'GoodClient/1.0' });
    expect(bad.status).toBe(404); // Existing proxy behavior maps upstream 403 to failover 404.
    expect(good.status).toBe(200);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  test('the published m3u8 alias preserves cache identity with the original route', async () => {
    const first = await requestWithHost('same.example', 'source-A');
    const alias = await requestWithHost('same.example', 'source-A', {}, '/api/manifest.m3u8');
    expect(first.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(alias.body).toBe(first.body);
    expect(alias.headers['x-manifest-cache']).toBe('HIT');
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  test('does not reuse a rewritten playlist across distinct request hosts', async () => {
    const first = await requestWithHost('first.example');
    const second = await requestWithHost('second.example');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toContain('http://first.example/api/manifest?');
    expect(second.body).toContain('http://second.example/api/manifest?');
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  test('does not reuse a rewritten playlist across distinct recovery keys', async () => {
    const first = await requestWithHost('same.example', 'provider:match:source-one');
    const second = await requestWithHost('same.example', 'provider:match:source-two');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toContain('rck=provider%3Amatch%3Asource-one');
    expect(second.body).toContain('rck=provider%3Amatch%3Asource-two');
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  test('reuses a positive entry only for the same host and recovery identity', async () => {
    const first = await requestWithHost('first.example', 'source-A');
    const second = await requestWithHost('first.example', 'source-A');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers['x-manifest-cache']).toBe('MISS');
    expect(second.headers['x-manifest-cache']).toBe('HIT');
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  test('treats a missing recovery key and an empty recovery key as equivalent', async () => {
    const first = await requestWithHost('first.example');
    const second = await requestWithHost('first.example', '');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['x-manifest-cache']).toBe('HIT');
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  test('isolates negative cache failures across hosts', async () => {
    safeFetch.mockReset();
    safeFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    safeFetch.mockResolvedValue({ ok: true, status: 200, text: async () => body });

    const badHost = await requestWithHost('first.example');
    const otherHost = await requestWithHost('second.example');
    expect(badHost.status).toBe(404);
    expect(otherHost.status).toBe(200);
    expect(otherHost.headers['x-manifest-cache']).toBe('MISS');
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  test('uses structured tuple boundaries for values containing separators', async () => {
    const first = await requestWithHost('first.example', 'rck', {
      referer: 'https://a.example/path|https://b.example',
      origin: 'https://c.example',
    });
    const second = await requestWithHost('first.example', 'rck', {
      referer: 'https://a.example/path',
      origin: 'https://b.example|https://c.example',
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['x-manifest-cache']).toBe('MISS');
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

});
