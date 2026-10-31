'use strict';
// Exercise the guarded fallback route without loading native transport inside
// Jest's VM or contacting any fake-public destination. Native fixtures run in
// separate processes with their own strictly loopback dial injection.
jest.mock('impit', () => ({ Impit: class {
  constructor() { throw Object.assign(new Error('Native unavailable in boundary fixture'), { code: 'ERR_NATIVE_UNAVAILABLE' }); }
} }));
jest.mock('undici', () => ({ ...jest.requireActual('undici'), request: jest.fn(() => { throw Error('Unexpected outbound request'); }) }));
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
const express = require('express');
const http = require('node:http');
const dns = require('node:dns');
const { request } = require('undici');

describe('public proxy URL boundaries', () => {
  let server, origin;
  beforeAll(async () => {
    const app = express();
    app.use(require('../src/routes/manifest'));
    app.use(require('../src/routes/embed'));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(async () => {
    await require('../src/services/GuardedOutbound').closeGuardedDispatcher();
    await new Promise(resolve => server.close(resolve));
  });
  beforeEach(() => request.mockClear());

  function get(path, target) {
    return new Promise((resolve, reject) => {
      http.get(origin + path + '?url=' + encodeURIComponent(target), response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
  }

  test.each(['/api/manifest', '/api/manifest.m3u8', '/api/manifest.mpd'])('%s rejects loopback through the real route', async path => {
    const response = await get(path, 'http://127.0.0.1:7003/private');
    expect(response.status).toBe(403);
    expect(response.body.reason).toBe('blocked_address');
    expect(request).not.toHaveBeenCalled();
  });

  test('embed hostname allowlist does not authorize private DNS answers', async () => {
    const lookup = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    try {
      const response = await get('/api/proxy-embed', 'https://embed.st/private');
      expect(response.status).toBe(403);
      expect(response.body.reason).toBe('blocked_address');
      expect(request).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); }
  });

  test('image cache and image-size probes reject private URLs before transport', async () => {
    const images = require('../src/services/ImageService');
    expect(await images.getImage('http://127.0.0.1:7003/private-image.png')).toBeNull();
    expect(await images.fetchImage('http://169.254.169.254/private-image.png')).toEqual({ ok: false, bytes: 0 });
    expect(request).not.toHaveBeenCalled();
  });

  test.each([
    ['/api/manifest', 'https://cdn.example.org/redirect.m3u8'],
    ['/api/manifest.m3u8', 'https://cdn.example.org/redirect-alias.m3u8'],
    ['/api/manifest.mpd', 'https://cdn.example.org/redirect.mpd'],
    ['/api/proxy-embed', 'https://embed.st/redirect']
  ])('%s blocks a public-to-private redirect without treating it as token expiry', async (path, target) => {
    const lookup = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const responseBody = { on: jest.fn(), destroy: jest.fn() };
    request.mockResolvedValueOnce({ statusCode: 302, headers: { location: 'http://169.254.169.254/private' }, body: responseBody });
    try {
      const result = await get(path, target);
      expect(result.status).toBe(403);
      expect(result.body.reason).toBe('blocked_address');
      expect(request).toHaveBeenCalledTimes(1);
      expect(responseBody.destroy).toHaveBeenCalledTimes(1);
    } finally { lookup.mockRestore(); }
  });

  test('a blocked image redirect is not retried or stored as a positive result', async () => {
    const lookup = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const responseBody = { on: jest.fn(), destroy: jest.fn() };
    request.mockResolvedValueOnce({ statusCode: 302, headers: { location: 'http://127.0.0.1/private' }, body: responseBody });
    try {
      const images = require('../src/services/ImageService');
      const url = 'https://cdn.example.org/redirect-image.png';
      expect(await images.getImage(url)).toBeNull();
      expect(await images.getImage(url)).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    } finally { lookup.mockRestore(); }
  });
});
