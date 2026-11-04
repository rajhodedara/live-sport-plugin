'use strict';

// Pure transport-policy fixtures: no native client, child process, listener or
// network is created. The slot factory and all DNS answers are injected.
const { createNativeGuardedFetch } = require('../src/services/NativeGuardedFetch');
const { createSharedOutboundFetch } = require('../src/services/SharedOutboundFetch');

const originalWarp = process.env.WARP_PROXY_URL;
const originalDami = process.env.DAMITV_PROXY_URL;
const proxy = 'socks5://127.0.0.1:40000';
const mediaUrl = 'https://media.damitv.st/c/fixture.m3u8';

beforeEach(() => {
  process.env.WARP_PROXY_URL = proxy;
  delete process.env.DAMITV_PROXY_URL;
});

afterEach(() => {
  if (originalWarp === undefined) delete process.env.WARP_PROXY_URL;
  else process.env.WARP_PROXY_URL = originalWarp;
  if (originalDami === undefined) delete process.env.DAMITV_PROXY_URL;
  else process.env.DAMITV_PROXY_URL = originalDami;
});

function fixturePool({ respond = () => new Response('fixture'), resolve = async () => ['93.184.216.34'] } = {}) {
  const configurations = [], calls = [];
  const createSlot = jest.fn(async configuration => {
    configurations.push(configuration);
    const slot = {
      busy: false,
      close: jest.fn(async () => {}),
      whenIdle: () => Promise.resolve(),
      run: async (url, operation, runOptions) => {
        slot.busy = true;
        const operationSignal = new AbortController().signal;
        try {
          return await operation({ fetch: async (requested, options) => {
            const call = { url: requested, options, configuration, operationSignal, runOptions };
            calls.push(call);
            return await respond(call, calls.length - 1);
          } }, operationSignal);
        } finally { slot.busy = false; }
      }
    };
    return slot;
  });
  const pool = createNativeGuardedFetch({ createSlot, slotOptions: { resolve } });
  return { pool, configurations, calls, createSlot };
}

test.each([
  ['Dami root GET', 'https://damitv.st/c/fixture.m3u8', {}, true],
  ['Dami subdomain HEAD', mediaUrl, { method: 'HEAD' }, true],
  ['normalized Dami hostname', 'https://MEDIA.DAMITV.ST./c/fixture.m3u8', {}, true],
  ['Dami metadata', 'https://media.damitv.st/catalog.json', {}, false],
  ['Dami path without slash', 'https://media.damitv.st/c', {}, false],
  ['Dami nested path', 'https://media.damitv.st/catalog/c/fixture.m3u8', {}, false],
  ['Dami case-sensitive path', 'https://media.damitv.st/C/fixture.m3u8', {}, false],
  ['hostname suffix lookalike', 'https://damitv.st.other.example.org/c/fixture.m3u8', { proxyUrl: proxy }, false],
  ['hostname prefix lookalike', 'https://notdamitv.st/c/fixture.m3u8', { proxyUrl: proxy }, false],
  ['Dami only in query', 'https://other.example.org/c/fixture.m3u8?source=damitv.st', { proxyUrl: proxy }, false],
  ['ordinary provider', 'https://other.example.org/c/fixture.m3u8', {}, false],
  ['Leaf gateway', 'https://papacito.cfd/c/fixture.m3u8', {}, false],
  ['explicit direct Dami', mediaUrl, { proxyUrl: null }, false],
  ['Dami POST', mediaUrl, { method: 'POST', body: 'fixture' }, false],
  ['Dami GET with body', mediaUrl, { body: 'fixture' }, false]
])('%s selects the guarded curl shim only for proxied Dami media GET/HEAD', async (_name, url, options, curl) => {
  const { pool, configurations, calls } = fixturePool();
  try {
    await pool.fetch(url, { ...options, maxBodyBytes: 17 });
    expect(configurations).toHaveLength(1);
    expect(typeof configurations[0].nativeModule?.Impit).toBe(curl ? 'function' : 'undefined');
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ redirect: 'manual' });
    if (curl) {
      expect(configurations[0]).toMatchObject({ proxyUrl: proxy, profile: 'vanilla' });
      expect(calls[0].options.signal).toBe(calls[0].operationSignal);
      expect(calls[0].options.maxBodyBytes).toBe(17);
      expect(calls[0].options.signal).not.toBe(calls[0].runOptions.signal);
    } else {
      expect(calls[0].options).not.toHaveProperty('signal');
      expect(calls[0].options).not.toHaveProperty('maxBodyBytes');
    }
  } finally { await pool.close(); }
});

test('curl and required proxy persist across a CDN redirect and use a separate pool key from native', async () => {
  const cdnUrl = 'https://cdn.example.org/master.m3u8';
  const responses = [
    new Response(null, { status: 302, headers: { Location: cdnUrl } }),
    new Response('redirected fixture'),
    new Response('ordinary fixture')
  ];
  const { pool, configurations, calls } = fixturePool({ respond: () => responses.shift() });
  try {
    expect(await (await pool.fetch(mediaUrl)).text()).toBe('redirected fixture');
    expect(configurations).toHaveLength(1);
    expect(calls.map(call => call.url)).toEqual([mediaUrl, cdnUrl]);
    expect(calls[1].configuration).toBe(calls[0].configuration);
    expect(calls[1].configuration).toMatchObject({ proxyUrl: proxy, profile: 'vanilla' });
    expect(calls[1].options.signal).toBe(calls[1].operationSignal);

    // Match every other key component so only the engine distinguishes slots.
    await pool.fetch(cdnUrl, { proxyUrl: proxy, profile: 'vanilla' });
    expect(configurations).toHaveLength(2);
    expect(configurations[0].nativeModule).toBeDefined();
    expect(configurations[1]).not.toHaveProperty('nativeModule');
    expect(calls[2].configuration).toBe(configurations[1]);
    expect(calls[2].options).not.toHaveProperty('signal');
    expect(calls[2].options).not.toHaveProperty('maxBodyBytes');
  } finally { await pool.close(); }
});

test('private initial DNS is rejected before any mocked slot is allocated', async () => {
  const resolve = jest.fn(async () => ['127.0.0.1']);
  const { pool, createSlot, calls } = fixturePool({ resolve });
  try {
    await expect(pool.fetch(mediaUrl)).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED' });
    expect(resolve).toHaveBeenCalled();
    expect(createSlot).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  } finally { await pool.close(); }
});

test('private redirect DNS is rejected before another slot operation can request that destination', async () => {
  const privateUrl = 'https://private.example.org/master.m3u8';
  const resolve = jest.fn(async hostname => hostname === 'private.example.org' ? ['10.0.0.1'] : ['93.184.216.34']);
  const { pool, createSlot, calls } = fixturePool({ resolve,
    respond: () => new Response(null, { status: 302, headers: { Location: privateUrl } }) });
  try {
    await expect(pool.fetch(mediaUrl)).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED' });
    expect(resolve).toHaveBeenCalledWith('private.example.org');
    expect(createSlot).toHaveBeenCalledTimes(1);
    expect(calls.map(call => call.url)).toEqual([mediaUrl]);
  } finally { await pool.close(); }
});

test('curl redirects strip sensitive and custom headers while keeping permitted negotiation headers', async () => {
  const { pool, calls } = fixturePool({ respond: (_call, index) => index === 0
    ? new Response(null, { status: 302, headers: { Location: 'https://cdn.example.org/master.m3u8' } })
    : new Response('fixture') });
  try {
    await pool.fetch(mediaUrl, { headers: {
      Authorization: 'Bearer fixture', Cookie: 'session=fixture', Referer: 'https://damitv.st/',
      Origin: 'https://damitv.st', 'X-Provider-Token': 'fixture',
      Accept: 'application/vnd.apple.mpegurl', 'User-Agent': 'Fixture/1', Range: 'bytes=0-99'
    } });
    expect(calls[0].options.headers).toMatchObject({ authorization: 'Bearer fixture', cookie: 'session=fixture' });
    expect(calls[1].options.headers).toEqual({
      accept: 'application/vnd.apple.mpegurl', 'user-agent': 'Fixture/1', range: 'bytes=0-99'
    });
    expect(calls[1].configuration.nativeModule).toBe(calls[0].configuration.nativeModule);
  } finally { await pool.close(); }
});

test.each(['ERR_NATIVE_UNAVAILABLE', 'ERR_GUARDED_CURL_UNAVAILABLE'])('%s on proxied Dami never invokes shared direct fallback', async code => {
  const failure = Object.assign(new Error('Fixture transport unavailable'), { code, isFatal: true });
  const { pool, configurations } = fixturePool({ respond: () => { throw failure; } });
  const nativeFetch = jest.fn((url, options) => pool.fetch(url, options));
  const fallbackFetch = jest.fn(async () => ({ status: 200 }));
  const delay = jest.fn();
  try {
    await expect(createSharedOutboundFetch({ nativeFetch, fallbackFetch, delay })(mediaUrl)).rejects.toBe(failure);
    expect(configurations[0].nativeModule).toBeDefined();
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(fallbackFetch).not.toHaveBeenCalled();
  } finally { await pool.close(); }
});

test('a proxied Dami curl 403 remains 403 without shared fallback or retry', async () => {
  const { pool, configurations } = fixturePool({ respond: () => new Response('fixture denied', { status: 403 }) });
  const nativeFetch = jest.fn((url, options) => pool.fetch(url, options));
  const fallbackFetch = jest.fn();
  const delay = jest.fn();
  try {
    const response = await createSharedOutboundFetch({ nativeFetch, fallbackFetch, delay })(mediaUrl);
    expect(response.status).toBe(403);
    expect(configurations[0].nativeModule).toBeDefined();
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(fallbackFetch).not.toHaveBeenCalled();
  } finally { await pool.close(); }
});
