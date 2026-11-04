'use strict';

const { createSharedOutboundFetch } = require('../src/services/SharedOutboundFetch');
const { createNativeGuardedFetch } = require('../src/services/NativeGuardedFetch');
const { isLeafTarget, selectGuardedEgress } = require('../src/services/GuardedEgressPolicy');
const originalWarp = process.env.WARP_PROXY_URL;
const originalDami = process.env.DAMITV_PROXY_URL;
const originalLeaf = process.env.LEAF_PROXY_URL;
const proxy = 'socks5://127.0.0.1:40000';
const result = status => ({ ok: status >= 200 && status < 300, status, bodyTruncated: false, text: async () => 'fixture' });

beforeEach(() => {
  process.env.WARP_PROXY_URL = proxy;
  delete process.env.DAMITV_PROXY_URL;
  delete process.env.LEAF_PROXY_URL;
});
afterEach(() => {
  if (originalWarp === undefined) delete process.env.WARP_PROXY_URL;
  else process.env.WARP_PROXY_URL = originalWarp;
  if (originalDami === undefined) delete process.env.DAMITV_PROXY_URL;
  else process.env.DAMITV_PROXY_URL = originalDami;
  if (originalLeaf === undefined) delete process.env.LEAF_PROXY_URL;
  else process.env.LEAF_PROXY_URL = originalLeaf;
});

test.each([
  ['Leaf-specific', { LEAF_PROXY_URL: 'socks5://leaf.invalid:1', WARP_PROXY_URL: 'socks5://warp.invalid:2', DAMITV_PROXY_URL: 'socks5://dami.invalid:3' }, 'socks5://leaf.invalid:1'],
  ['WARP alias', { WARP_PROXY_URL: 'socks5://warp.invalid:2', DAMITV_PROXY_URL: 'socks5://dami.invalid:3' }, 'socks5://warp.invalid:2'],
  ['Dami compatibility alias', { DAMITV_PROXY_URL: 'socks5://dami.invalid:3' }, 'socks5://dami.invalid:3'],
  ['no configured proxy', {}, null],
])('%s precedence applies equally to Leaf mint and manifest hosts', (_label, environment, expected) => {
  for (const url of ['https://sports.highfly.to/install/stream/sport/fixture.json',
    'https://papacito.cfd/m3u/fixture/live.m3u8?ft=fixture']) {
    expect(selectGuardedEgress(url, {}, environment)).toEqual({ proxyUrl: expected, profile: 'chrome' });
    expect(selectGuardedEgress(url, { proxyUrl: null }, environment)).toEqual({ proxyUrl: null, profile: 'chrome' });
    expect(selectGuardedEgress(url, { proxyUrl: 'socks5://explicit.invalid:4' }, environment))
      .toEqual({ proxyUrl: 'socks5://explicit.invalid:4', profile: 'chrome' });
  }
});

test('Leaf-specific proxy configuration does not affect DamiTV or direct media', () => {
  const environment = { LEAF_PROXY_URL: 'socks5://leaf.invalid:1', WARP_PROXY_URL: proxy };
  expect(selectGuardedEgress('https://messi.damitv.st/metadata', {}, environment))
    .toEqual({ proxyUrl: proxy, profile: 'vanilla' });
  expect(selectGuardedEgress('https://w1.papacito.cfd/leaf/fixture/seg.ts?a=fixture', {}, environment))
    .toEqual({ proxyUrl: null, profile: 'chrome' });
});

test.each([
  ['https://sports.highfly.to/install/catalog/sport/live.json', true],
  ['https://SPORTS.HIGHFLY.TO./install/stream/sport/id.json', true],
  ['https://papacito.cfd/m3u/fixture/live.m3u8?note=w1.papacito.cfd', true],
  ['https://gateway.papacito.cfd/m3u/fixture/live.m3u8', true],
  ['https://w1.papacito.cfd/leaf/fixture/seg.ts?a=fixture', false],
  ['https://w1.papacito.cfd/leaf/fixture/seg.ts?source=sports.highfly.to', false],
  ['https://elsewhere.example/stream?sports.highfly.to', false],
  ['https://papacito.cfd.example/m3u/fixture/live.m3u8', false],
  ['https://sports.highfly.to@elsewhere.example/stream', false],
  [null, false]
])('Leaf egress classification uses the actual hostname: %s', (url, expected) => {
  expect(isLeafTarget(url)).toBe(expected);
});

test.each([
  'https://sports.highfly.to/install/catalog/sport/live.json',
  'https://papacito.cfd/m3u/fixture/live.m3u8?note=w1.papacito.cfd'
])('guarded shared Leaf metadata retains WARP and the Chrome slot: %s', async url => {
  const nativeFetch = jest.fn(async () => result(200)), fallbackFetch = jest.fn();
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch });
  expect((await fetch(url, { headers: { Authorization: 'fixture' } })).status).toBe(200);
  expect(nativeFetch.mock.calls[0][1]).toMatchObject({ proxyUrl: proxy, profile: 'chrome', headers: { Authorization: 'fixture' } });
  expect(fallbackFetch).not.toHaveBeenCalled();
});

test('a new CDN media request stays direct even when query text names a Leaf gateway', async () => {
  const nativeFetch = jest.fn(async () => result(200));
  await createSharedOutboundFetch({ nativeFetch, fallbackFetch: jest.fn() })(
    'https://w1.papacito.cfd/leaf/fixture/seg.ts?source=sports.highfly.to');
  expect(nativeFetch.mock.calls[0][1]).toMatchObject({ proxyUrl: null, profile: 'chrome' });
});

test('explicit direct override is honored by the shared adapter', async () => {
  const nativeFetch = jest.fn(async () => result(200));
  await createSharedOutboundFetch({ nativeFetch, fallbackFetch: jest.fn() })(
    'https://sports.highfly.to/install/catalog.json', { proxyUrl: null });
  expect(nativeFetch.mock.calls[0][1]).toMatchObject({ proxyUrl: null, profile: 'chrome' });
});

test('explicit proxy and profile overrides remain available without affecting another provider', async () => {
  const nativeFetch = jest.fn(async () => result(200));
  await createSharedOutboundFetch({ nativeFetch, fallbackFetch: jest.fn() })(
    'https://other.example/metadata', { proxyUrl: 'socks5://127.0.0.1:40001', profile: 'chrome' });
  expect(nativeFetch.mock.calls[0][1]).toMatchObject({ proxyUrl: 'socks5://127.0.0.1:40001', profile: 'chrome' });
});

test('Leaf native-unavailable failure never selects a direct fallback', async () => {
  const failure = Object.assign(new Error('Native unavailable'), { code: 'ERR_NATIVE_UNAVAILABLE' });
  const nativeFetch = jest.fn(async () => { throw failure; }), fallbackFetch = jest.fn();
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch });
  await expect(fetch('https://sports.highfly.to/install/catalog.json')).rejects.toBe(failure);
  expect(nativeFetch).toHaveBeenCalledTimes(1);
  expect(fallbackFetch).not.toHaveBeenCalled();
});

test('Leaf authorization rejection remains 403 without changing transports', async () => {
  const nativeFetch = jest.fn(async () => result(403)), fallbackFetch = jest.fn();
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch });
  expect((await fetch('https://papacito.cfd/m3u/fixture/live.m3u8')).status).toBe(403);
  expect(nativeFetch).toHaveBeenCalledTimes(1);
  expect(fallbackFetch).not.toHaveBeenCalled();
});

test('an explicitly requested guarded Undici transport receives the same required proxy', async () => {
  const nativeFetch = jest.fn(), fallbackFetch = jest.fn(async () => result(200));
  await createSharedOutboundFetch({ nativeFetch, fallbackFetch })(
    'https://sports.highfly.to/install/catalog.json', { transport: 'undici' });
  expect(nativeFetch).not.toHaveBeenCalled();
  expect(fallbackFetch.mock.calls[0][1]).toMatchObject({ proxyUrl: proxy, profile: 'chrome' });
});

test('DamiTV keeps vanilla proxy routing and ordinary providers keep direct Chrome', async () => {
  const nativeFetch = jest.fn(async () => result(200));
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch: jest.fn() });
  await fetch('https://messi.damitv.st/metadata');
  await fetch('https://other.example/metadata');
  expect(nativeFetch.mock.calls[0][1]).toMatchObject({ proxyUrl: proxy, profile: 'vanilla' });
  expect(nativeFetch.mock.calls[1][1]).toMatchObject({ proxyUrl: null, profile: 'chrome' });
});

test('the compatibility proxy environment alias still routes Leaf', async () => {
  delete process.env.WARP_PROXY_URL;
  process.env.DAMITV_PROXY_URL = proxy;
  const nativeFetch = jest.fn(async () => result(200));
  await createSharedOutboundFetch({ nativeFetch, fallbackFetch: jest.fn() })(
    'https://sports.highfly.to/install/catalog.json');
  expect(nativeFetch.mock.calls[0][1]).toMatchObject({ proxyUrl: proxy, profile: 'chrome' });
});

function fixturePool(responses, configurations = [], calls = []) {
  return createNativeGuardedFetch({ maxSlots: 1,
    slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async config => {
      configurations.push(config);
      return { busy: false, close: async () => {}, run: (url, operation) => operation({ fetch: async () => {
        calls.push(url); return responses.shift();
      } }) };
    }
  });
}

test('direct native adapter selects the same Leaf proxy/profile and keeps them across a CDN redirect', async () => {
  const configurations = [], calls = [];
  const pool = fixturePool([
    new Response(null, { status: 302, headers: { Location: 'https://w1.papacito.cfd/leaf/fixture/master.m3u8' } }),
    new Response('fixture')
  ], configurations, calls);
  try {
    expect(await (await pool.fetch('https://papacito.cfd/m3u/fixture/live.m3u8')).text()).toBe('fixture');
    expect(configurations).toHaveLength(1);
    expect(configurations[0]).toMatchObject({ proxyUrl: proxy, profile: 'chrome' });
    expect(calls).toEqual(['https://papacito.cfd/m3u/fixture/live.m3u8', 'https://w1.papacito.cfd/leaf/fixture/master.m3u8']);
    expect(pool.stats.busy).toBe(0);
  } finally { await pool.close(); }
});

test('direct native adapter honors explicit direct override just like the shared adapter', async () => {
  const configurations = [];
  const pool = fixturePool([new Response('fixture')], configurations);
  try {
    await pool.fetch('https://sports.highfly.to/install/catalog.json', { proxyUrl: null });
    expect(configurations[0]).toMatchObject({ proxyUrl: null, profile: 'chrome' });
  } finally { await pool.close(); }
});

test('direct native adapter guards a Leaf DNS answer before any slot is allocated', async () => {
  const createSlot = jest.fn();
  const pool = createNativeGuardedFetch({ createSlot,
    slotOptions: { resolve: async () => ['127.0.0.1'] } });
  try {
    await expect(pool.fetch('https://papacito.cfd/m3u/fixture/live.m3u8')).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED' });
    expect(createSlot).not.toHaveBeenCalled();
  } finally { await pool.close(); }
});
