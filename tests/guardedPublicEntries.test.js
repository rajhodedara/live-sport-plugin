'use strict';
// Invoke the registered route handlers with in-memory request/response objects.
// Keep native preflight and guarded fallback policy real, but stop allocation
// before NativeGuardedSlot can open its listener or load the native module.
jest.mock('../src/services/NativeGuardedSlot', () => ({
  createNativeGuardedSlot: jest.fn(async () => {
    throw Object.assign(new Error('Native unavailable in boundary fixture'), { code: 'ERR_NATIVE_UNAVAILABLE' });
  })
}));
jest.mock('undici', () => ({ ...jest.requireActual('undici'), request: jest.fn(() => { throw Error('Unexpected outbound request'); }) }));
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
const dns = require('node:dns');
const { request } = require('undici');
const { createNativeGuardedSlot } = require('../src/services/NativeGuardedSlot');

describe('public proxy URL boundaries', () => {
  let routers;
  beforeAll(() => {
    routers = [require('../src/routes/manifest'), require('../src/routes/embed')];
  });
  afterAll(async () => {
    await require('../src/services/SharedOutboundFetch').closeSharedOutbound();
    await require('../src/services/GuardedOutbound').closeGuardedDispatcher();
  });
  beforeEach(() => {
    request.mockReset().mockImplementation(() => { throw Error('Unexpected outbound request'); });
    createNativeGuardedSlot.mockClear();
  });

  async function get(path, target) {
    const registered = routers.flatMap(router => router.stack).find(layer => {
      const route = layer.route;
      return route && route.methods.get && (Array.isArray(route.path) ? route.path.includes(path) : route.path === path);
    });
    if (!registered) throw new Error('Missing registered GET route: ' + path);
    const url = path + '?url=' + encodeURIComponent(target);
    const req = { method: 'GET', query: { url: target }, headers: { host: 'proxy.fixture.example.org' },
      protocol: 'http', url, originalUrl: url };
    const result = { status: 200, body: undefined };
    const res = {
      setHeader() {},
      status(status) { result.status = status; return this; },
      json(body) { result.body = body; return this; },
      send(body) { result.body = body; return this; }
    };
    await registered.route.stack.find(layer => layer.method === 'get').handle(req, res);
    return result;
  }

  test.each(['/api/manifest', '/api/manifest.m3u8', '/api/manifest.mpd'])('%s rejects loopback through the real route', async path => {
    const response = await get(path, 'http://127.0.0.1:7003/private');
    expect(response.status).toBe(403);
    expect(response.body.reason).toBe('blocked_address');
    expect(request).not.toHaveBeenCalled();
    expect(createNativeGuardedSlot).not.toHaveBeenCalled();
  });

  test('embed hostname allowlist does not authorize private DNS answers', async () => {
    const lookup = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    try {
      const response = await get('/api/proxy-embed', 'https://embed.st/private');
      expect(response.status).toBe(403);
      expect(response.body.reason).toBe('blocked_address');
      expect(request).not.toHaveBeenCalled();
      expect(createNativeGuardedSlot).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); }
  });

  test('image cache and image-size probes reject private URLs before transport', async () => {
    const images = require('../src/services/ImageService');
    expect(await images.getImage('http://127.0.0.1:7003/private-image.png')).toBeNull();
    expect(await images.fetchImage('http://169.254.169.254/private-image.png')).toEqual({ ok: false, bytes: 0 });
    expect(request).not.toHaveBeenCalled();
    expect(createNativeGuardedSlot).not.toHaveBeenCalled();
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
