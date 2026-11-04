'use strict';
const { createSharedOutboundFetch } = require('../src/services/SharedOutboundFetch');
const { providerRequestHeaders } = require('../src/services/ProviderRequestHeaders');
const result = status => ({ ok: status === 200, status, text: async () => 'fixture' });
const originalWarp = process.env.WARP_PROXY_URL;
afterEach(() => {
  if (originalWarp === undefined) delete process.env.WARP_PROXY_URL;
  else process.env.WARP_PROXY_URL = originalWarp;
});

test('keeps provider hints and the same headers for the alternate guarded fingerprint', async () => {
  const nativeFetch = jest.fn(async () => result(403)), fallbackFetch = jest.fn(async () => result(200));
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch });
  const response = await fetch('https://dembed.st/player', { headers: { Authorization: 'fixture' }, maxBodyBytes: 128 });
  expect(response.status).toBe(200);
  const opts = nativeFetch.mock.calls[0][1];
  expect(opts.headers).toMatchObject({ Authorization: 'fixture', Referer: 'https://dlive.sx/',
    'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site' });
  expect(fallbackFetch.mock.calls[0][1].headers).toEqual(opts.headers);
  expect(fallbackFetch.mock.calls[0][1].maxBodyBytes).toBe(128);
});

test('proxy 403 and proxy failures cannot escape via the direct fallback', async () => {
  process.env.WARP_PROXY_URL = 'socks5://127.0.0.1:40000';
  const nativeFetch = jest.fn(async () => result(403)), fallbackFetch = jest.fn();
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch });
  expect((await fetch('https://messi.damitv.st/live', { headers: { Referer: 'https://custom.example/' } })).status).toBe(403);
  expect(nativeFetch.mock.calls[0][1]).toMatchObject({ profile: 'vanilla', proxyUrl: process.env.WARP_PROXY_URL,
    headers: { Referer: 'https://custom.example/' } });
  nativeFetch.mockRejectedValueOnce(new Error('Proxy handshake failed'));
  await expect(fetch('https://messi.damitv.st/live', { attempts: 1 })).rejects.toThrow('Proxy handshake failed');
  expect(fallbackFetch).not.toHaveBeenCalled();
});

test.each(['ERR_OUTBOUND_BLOCKED', 'ERR_NATIVE_POOL_BUSY'])('does not retry or fall back on %s', async code => {
  const failure = Object.assign(new Error('Controlled denial'), { code });
  const nativeFetch = jest.fn(async () => { throw failure; }), fallbackFetch = jest.fn(), delay = jest.fn();
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch, delay });
  await expect(fetch('https://cdn.example.org/metadata')).rejects.toMatchObject({
    code: code === 'ERR_NATIVE_POOL_BUSY' ? 'ERR_OUTBOUND_CAPACITY' : code
  });
  expect(nativeFetch).toHaveBeenCalledTimes(1); expect(fallbackFetch).not.toHaveBeenCalled(); expect(delay).not.toHaveBeenCalled();
});

test('a fallback redirect guard rejection wins over the original native 403', async () => {
  const failure = Object.assign(new Error('Blocked redirect'), { code: 'ERR_OUTBOUND_BLOCKED' });
  const fetch = createSharedOutboundFetch({ nativeFetch: async () => result(403), fallbackFetch: async () => { throw failure; } });
  await expect(fetch('https://cdn.example.org/metadata')).rejects.toBe(failure);
});

test('transient attempts share the remaining deadline and preserve provider credentials', async () => {
  const nativeFetch = jest.fn().mockRejectedValueOnce(new Error('Connection reset')).mockResolvedValue(result(200));
  const delay = jest.fn(async () => new Promise(resolve => setTimeout(resolve, 20)));
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch: jest.fn(), delay });
  await fetch('https://cdn.example.org/metadata', { timeoutMs: 3000, headers: { Cookie: 'fixture' } });
  expect(nativeFetch).toHaveBeenCalledTimes(2);
  expect(nativeFetch.mock.calls[1][1].timeoutMs).toBeLessThan(nativeFetch.mock.calls[0][1].timeoutMs);
  expect(nativeFetch.mock.calls[1][1].headers.Cookie).toBe('fixture');
  expect(delay).toHaveBeenCalledTimes(1);
});

test.each(['ERR_NATIVE_UNAVAILABLE', 'TLS'])('deterministic %s failure selects guarded fallback without backoff', async code => {
  const nativeFetch = jest.fn(async () => { throw Object.assign(new Error(code === 'TLS' ? 'UnknownIssuer certificate' : 'Unavailable'), { code }); });
  const fallbackFetch = jest.fn(async () => result(200)), delay = jest.fn();
  await createSharedOutboundFetch({ nativeFetch, fallbackFetch, delay })('https://cdn.example.org/metadata');
  expect(nativeFetch).toHaveBeenCalledTimes(1); expect(fallbackFetch).toHaveBeenCalledTimes(1); expect(delay).not.toHaveBeenCalled();
});

test('provider defaults do not modify the caller object or replace an accepted UA/Referer', () => {
  const headers = { 'User-Agent': 'Accepted UA', Referer: 'https://custom.example/', Authorization: 'fixture' };
  const copy = { ...headers };
  expect(providerRequestHeaders('https://messi.damitv.st/live', headers)).toEqual(headers);
  expect(headers).toEqual(copy);
});

test('default metadata truncation fails closed while explicit prefix sampling remains available', async () => {
  const nativeFetch = jest.fn(async () => ({ ...result(200), bodyTruncated: true }));
  const fallbackFetch = jest.fn();
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch });
  await expect(fetch('https://cdn.example.org/metadata')).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BODY_LIMIT' });
  expect(fallbackFetch).not.toHaveBeenCalled();
  expect((await fetch('https://cdn.example.org/sample', { maxBodyBytes: 64 })).bodyTruncated).toBe(true);
});

test('Undici-only metadata preserves its transport fingerprint and manual redirect choice', async () => {
  const nativeFetch = jest.fn(), fallbackFetch = jest.fn(async () => result(302));
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch });
  expect((await fetch('https://cdn.example.org/metadata', { transport: 'undici', redirect: 'manual' })).status).toBe(302);
  expect(nativeFetch).not.toHaveBeenCalled();
  expect(fallbackFetch.mock.calls[0][1].redirect).toBe('manual');
});

test('normalizes flat header lists for both guarded transports', async () => {
  const nativeFetch = jest.fn(async () => result(403));
  const fallbackFetch = jest.fn(async () => result(200));
  await createSharedOutboundFetch({ nativeFetch, fallbackFetch })('https://cdn.example.org/', { headers: ['Authorization', 'Bearer fixture', 'X-Test', 'ok'] });
  expect(new Headers(nativeFetch.mock.calls[0][1].headers).get('authorization')).toBe('Bearer fixture');
  expect(new Headers(fallbackFetch.mock.calls[0][1].headers).get('x-test')).toBe('ok');
});

test('DamiTV with WARP uses native vanilla profile and does not fall back to Undici', async () => {
  const previous = process.env.WARP_PROXY_URL;
  process.env.WARP_PROXY_URL = 'socks5://127.0.0.1:40000';
  const nativeFetch = jest.fn(async () => result(503));
  const fallbackFetch = jest.fn();
  try {
    const response = await createSharedOutboundFetch({ nativeFetch, fallbackFetch })('https://damitv.st/');
    expect(response.status).toBe(503);
    expect(nativeFetch.mock.calls[0][1]).toMatchObject({ profile: 'vanilla', proxyUrl: 'socks5://127.0.0.1:40000' });
    expect(fallbackFetch).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.WARP_PROXY_URL; else process.env.WARP_PROXY_URL = previous;
  }
});
