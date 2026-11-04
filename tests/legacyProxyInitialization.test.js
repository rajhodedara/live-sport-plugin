'use strict';

jest.mock('undici', () => ({ request: jest.fn(), Agent: jest.fn() }));
jest.mock('impit', () => ({ Impit: jest.fn() }));

const previousEnv = { ...process.env };
beforeEach(() => {
  jest.resetModules();
  process.env = { ...previousEnv };
  delete process.env.DAMITV_PROXY_URL;
  process.env.WARP_PROXY_URL = 'socks5://127.0.0.1:40000';
});
afterEach(() => { process.env = { ...previousEnv }; });

function setup({ constructionFails = false, status = 200, requestFails = false } = {}) {
  const { Impit } = require('impit');
  const { request } = require('undici');
  const fetch = jest.fn(async url => {
    if (requestFails) throw new Error('mock proxy request failure');
    return { status, url, headers: {}, arrayBuffer: async () => Buffer.from('{}') };
  });
  Impit.mockImplementation(() => {
    if (constructionFails) throw new Error('mock native initialization failure');
    return { fetch };
  });
  request.mockResolvedValue({ statusCode: 200, headers: {}, body: { arrayBuffer: async () => Buffer.from('{}') } });
  return { client: require('../src/impitClient'), Impit, request, fetch };
}

test('required Leaf proxy initialization failure rejects before any direct request', async () => {
  const t = setup({ constructionFails: true });
  await expect(t.client.safeFetch('https://sports.highfly.to/fixture/catalog.json', { attempts: 1 }))
    .rejects.toMatchObject({ code: 'EPROXYUNAVAILABLE' });
  expect(t.request).not.toHaveBeenCalled();
});

test('explicit proxy initialization failure on another host rejects before any direct request', async () => {
  delete process.env.WARP_PROXY_URL;
  const t = setup({ constructionFails: true });
  await expect(t.client.safeFetch('https://media.example.org/fixture.m3u8', { proxyUrl: 'socks5://127.0.0.1:40001', attempts: 1 }))
    .rejects.toMatchObject({ code: 'EPROXYUNAVAILABLE' });
  expect(t.request).not.toHaveBeenCalled();
});

test('successful Leaf proxy still uses the stable Chrome142 profile', async () => {
  const t = setup();
  expect((await t.client.safeFetch('https://sports.highfly.to/fixture/catalog.json', { attempts: 1 })).status).toBe(200);
  expect(t.Impit).toHaveBeenCalledWith({ browser: 'chrome142', proxyUrl: 'socks5://127.0.0.1:40000' });
  expect(t.fetch).toHaveBeenCalledTimes(1);
  expect(t.request).not.toHaveBeenCalled();
});

test('initialized proxy HTTP403 remains visible without a direct retry', async () => {
  const t = setup({ status: 403 });
  expect((await t.client.safeFetch('https://sports.highfly.to/fixture/stream.json', { attempts: 1 })).status).toBe(403);
  expect(t.request).not.toHaveBeenCalled();
});

test('initialized proxy fetch failure rejects without a direct retry', async () => {
  const t = setup({ requestFails: true });
  await expect(t.client.safeFetch('https://sports.highfly.to/fixture/catalog.json', { attempts: 1 })).rejects.toThrow('mock proxy request failure');
  expect(t.request).not.toHaveBeenCalled();
});

test('ordinary non-proxied native failure retains its direct fallback', async () => {
  delete process.env.WARP_PROXY_URL;
  const t = setup({ constructionFails: true });
  expect((await t.client.safeFetch('https://ordinary.example.org/fixture.json', { attempts: 1 })).status).toBe(200);
  expect(t.request).toHaveBeenCalledTimes(1);
});
