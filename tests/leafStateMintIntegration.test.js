'use strict';

// Pure integration boundary: real state/mint/cache/route code, fake outbound I/O
// and an in-memory Router. No listener, native module or worker is started.
const crypto = require('node:crypto');
const mockSafeFetch = jest.fn();
const mockGet = jest.fn();
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: mockSafeFetch }));
jest.mock('express', () => ({ Router: () => ({ get: mockGet }) }));

const originalEnv = { ...process.env };
const now = 1800000000000;
const signedUrl = 'https://papacito.cfd/m3u/fixture/live.m3u8?ft=one%2Ftwo&x=three%2Bfour';
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://w1.papacito.cfd/leaf/fixture/seg.ts?a=hash%2Fone\n';
const mintResponse = (urls = [signedUrl], overrides = {}) => ({
  ok: true, status: 200, bodyTruncated: false,
  json: jest.fn(async () => ({ streams: urls.map(url => ({ url })) })), ...overrides
});
const manifestResponse = (overrides = {}) => ({
  ok: true, status: 200, url: signedUrl, text: async () => playlist, ...overrides
});

let leafState, leafMint, warn;
beforeEach(() => {
  jest.resetModules();
  process.env = { ...originalEnv, APP_SECRET: 'fixture-private-leaf-state-key',
    LEAF_INSTALL_CONFIG: 'fixture-install', LEAF_MINT_TTL_MS: '60000',
    LEAF_MINT_TIMEOUT_MS: '8000', LEAF_MINT_BACKOFF_MS: '15000' };
  delete process.env.LEAF_STATE_SECRET;
  delete process.env.LEAF_API_URL;
  delete process.env.LEAF_API_ORIGIN;
  delete process.env.LEAF_FREE_USER_ID;
  mockSafeFetch.mockReset();
  mockGet.mockReset();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  leafState = require('../src/services/LeafState');
  leafMint = require('../src/services/LeafMint');
});
afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

function rawState(payload, key = process.env.APP_SECRET) {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url').slice(0, 24)}`;
}

function stateHandler() {
  require('../src/routes/leafManifest');
  return mockGet.mock.calls.find(([paths]) => paths.includes('/api/leaf/m3u8/:state/index.m3u8'))[1];
}

function reply() {
  return { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
}

describe('Leaf signed application state', () => {
  test('uses the existing shared key and drops fields outside the state contract', () => {
    const token = leafState.sign({ m: 'streamed:fixture', s: 'fixture', credential: 'not-public' });
    expect(leafState.verify(token)).toEqual({ m: 'streamed:fixture', s: 'fixture', t: now });
    expect(Buffer.from(token.split('.')[0], 'base64url').toString()).not.toContain('not-public');
    process.env.LEAF_STATE_SECRET = 'fixture-specific-leaf-state-key';
    expect(leafState.verify(token)).toBeNull();
    expect(leafState.verify(leafState.sign({ m: 'fixture' }))).toMatchObject({ m: 'fixture' });
  });

  test.each([
    ['missing issued time', { m: 'fixture' }],
    ['zero issued time', { m: 'fixture', t: 0 }],
    ['string issued time', { m: 'fixture', t: String(now) }],
    ['future issued time', { m: 'fixture', t: now + 1 }],
    ['expired issued time', { m: 'fixture', t: now - 24 * 60 * 60 * 1000 - 1 }],
    ['missing match', { t: now }],
    ['non-string match', { m: 42, t: now }],
    ['empty match', { m: ' ', t: now }],
    ['control character', { m: 'fixture\n', t: now }],
    ['invalid slug', { m: 'fixture', s: '../other', t: now }],
    ['array', ['fixture']],
    ['invalid JSON', '{not-json'],
  ])('rejects correctly authenticated state with %s', (_label, payload) => {
    expect(leafState.verify(rawState(payload))).toBeNull();
  });

  test('rejects malformed, oversized and Unicode signatures without throwing', () => {
    const token = leafState.sign({ m: 'fixture', s: 'fixture' });
    for (const value of [null, [], 'bad', 'x'.repeat(4097), token + 'x', token.replace(/.$/, '!'),
      `${token.split('.')[0]}.${'é'.repeat(24)}`]) {
      expect(() => leafState.verify(value)).not.toThrow();
      expect(leafState.verify(value)).toBeNull();
    }
  });

  test('missing shared key disables signed state and public emission', async () => {
    delete process.env.APP_SECRET;
    expect(() => leafState.sign({ m: 'fixture' })).toThrow('not configured');
    expect(() => leafState.verify(rawState({ m: 'fixture', t: now }, 'fixture-old-key')))
      .toThrow('not configured');
    const res = reply();
    await stateHandler()({ params: { state: 'invalid' } }, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).toHaveBeenCalledWith('Failed to resolve Leaf playlist');
    expect(mockSafeFetch).not.toHaveBeenCalled();
    mockSafeFetch.mockResolvedValue(mintResponse());
    const LeafProvider = require('../src/providers/LeafProvider');
    await expect(new LeafProvider().resolveStream('fixture')).resolves.toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-old-key');
  });
});

describe('Leaf guarded mint/cache', () => {
  test.each([
    ['full official install URL', 'https://sports.highfly.to/fixture-user.long-token/manifest.json', { freeUserId: 'fixture-user.long-token' }],
    ['bare install token', 'fixture-user.long-token', { freeUserId: 'fixture-user.long-token' }],
    ['JSON install config', '{"freeUserId":"fixture-user.long-token"}', { freeUserId: 'fixture-user.long-token' }],
  ])('preserves stable normalization for %s', (_label, input, expected) => {
    expect(JSON.parse(Buffer.from(leafMint.normalizeConfigBlob(input), 'base64url').toString())).toEqual(expected);
  });

  test('keeps pre-encoded config and whole-base kill-switch semantics', () => {
    const encoded = Buffer.from(JSON.stringify({ userId: 'fixture-user' })).toString('base64url');
    expect(leafMint.normalizeConfigBlob(encoded)).toBe(encoded);
    process.env.LEAF_API_URL = 'http://127.0.0.1:9/leaf-disabled/manifest.json';
    expect(leafMint.apiBase()).toBe('http://127.0.0.1:9/leaf-disabled');
  });

  test('uses guarded metadata I/O, coalesces concurrency and preserves signed bytes', async () => {
    let finish;
    mockSafeFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = leafMint.mintUrl('streamed:fixture', 'fixture');
    const second = leafMint.mintUrl('streamed:fixture', 'fixture');
    await Promise.resolve();
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockSafeFetch).toHaveBeenCalledWith(expect.stringContaining('/stream/sport/streamed%3Afixture.json'),
      expect.objectContaining({ timeoutMs: 8000, maxBodyBytes: 256 * 1024, diagnosticOwner: 'provider' }));
    finish(mintResponse());
    await expect(Promise.all([first, second])).resolves.toEqual([signedUrl, signedUrl]);
    await expect(leafMint.mintUrl('streamed:fixture', 'fixture')).resolves.toBe(signedUrl);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    'https://papacito.cfd.example.test/m3u/fixture/live.m3u8?ft=secret',
    'https://example.test/?url=https://papacito.cfd/m3u/fixture/live.m3u8?ft=secret',
    'https://user:secret@papacito.cfd/m3u/fixture/live.m3u8?ft=secret',
    'https://papacito.cfd:8443/m3u/fixture/live.m3u8?ft=secret',
    'http://papacito.cfd/m3u/fixture/live.m3u8?ft=secret',
    'https://papacito.cfd/m3u/fixture/live.m3u8#fragment?ft=secret',
  ])('a spoofed or unsigned mint candidate is not cached: %s', async url => {
    mockSafeFetch.mockResolvedValue(mintResponse([url]));
    await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ code: 'ERR_LEAF_MINT_NO_MEDIA' });
    expect(leafMint.stats()).toMatchObject({ cached: 0, coolingDown: 1 });
    await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ cooldown: true });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  test('a guarded denial is private, backed off and never cached as success', async () => {
    mockSafeFetch.mockRejectedValue(Object.assign(new Error('https://secret-install.test/?ft=secret-token'), { code: 'ERR_OUTBOUND_BLOCKED' }));
    await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED', message: 'Leaf mint request failed' });
    await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ cooldown: true, retryAfterMs: 15000 });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(leafMint.stats().cached).toBe(0);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-install|secret-token|fixture-install/);
  });

  test('a missing requested slug never substitutes another channel or a query-path match', async () => {
    mockSafeFetch.mockResolvedValue(mintResponse([
      'https://papacito.cfd/m3u/different/live.m3u8?ft=other',
      'https://papacito.cfd/m3u/different/live.m3u8?ft=other&path=/m3u/fixture/live.m3u8'
    ]));
    await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ code: 'ERR_LEAF_MINT_NO_MEDIA' });
    expect(leafMint.stats().cached).toBe(0);
  });

  test.each([
    ['rate limit', mintResponse([], { ok: false, status: 429 }), 'ERR_LEAF_MINT_STATUS', 30000],
    ['truncation', mintResponse([], { bodyTruncated: true }), 'ERR_LEAF_MINT_BODY_LIMIT', 15000],
    ['invalid JSON', mintResponse([], { json: async () => { throw new Error('secret upstream body'); } }), 'ERR_LEAF_MINT_BODY', 15000],
  ])('%s becomes a bounded cooldown without caching invalid metadata', async (_label, response, code, retryAfterMs) => {
    mockSafeFetch.mockResolvedValue(response);
    await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ code });
    expect(leafMint.cooldownRemaining('fixture', 'fixture')).toBe(retryAfterMs);
    expect(leafMint.stats().cached).toBe(0);
  });

  test('install changes and the kill switch cannot reuse a previous cached credential', async () => {
    mockSafeFetch.mockResolvedValue(mintResponse());
    await leafMint.mintUrl('fixture', 'fixture');
    process.env.LEAF_INSTALL_CONFIG = 'different-install';
    await leafMint.mintUrl('fixture', 'fixture');
    process.env.LEAF_API_URL = 'http://127.0.0.1:9/leaf-disabled';
    mockSafeFetch.mockRejectedValue(Object.assign(new Error('blocked'), { code: 'ERR_OUTBOUND_BLOCKED' }));
    await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED' });
    expect(mockSafeFetch).toHaveBeenCalledTimes(3);
    expect(mockSafeFetch.mock.calls[2][0]).toBe('http://127.0.0.1:9/leaf-disabled/stream/sport/fixture.json');
  });
});

describe('Leaf state route denial handling', () => {
  test('invalid signed state is rejected before outbound I/O', async () => {
    const res = reply();
    await stateHandler()({ params: { state: 'invalid' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  test('mint -> manifest retains raw query and direct authenticated segment bytes', async () => {
    mockSafeFetch.mockResolvedValueOnce(mintResponse()).mockResolvedValueOnce(manifestResponse());
    const res = reply();
    await stateHandler()({ params: { state: leafState.sign({ m: 'fixture', s: 'fixture' }) } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(playlist);
    expect(mockSafeFetch.mock.calls[1][0]).toBe(signedUrl);
    expect(mockSafeFetch.mock.calls[1][1]).toMatchObject({ timeoutMs: 6000, maxBodyBytes: 256 * 1024 });
  });

  test('real mint/manifest code selects the same Leaf-specific guarded proxy and profile', async () => {
    process.env.LEAF_PROXY_URL = 'socks5://leaf.invalid:1';
    process.env.WARP_PROXY_URL = 'socks5://warp.invalid:2';
    process.env.DAMITV_PROXY_URL = 'socks5://dami.invalid:3';
    const { createSharedOutboundFetch } = require('../src/services/SharedOutboundFetch');
    const nativeFetch = jest.fn(async url => url === signedUrl ? manifestResponse() : mintResponse());
    const fallbackFetch = jest.fn();
    mockSafeFetch.mockImplementation(createSharedOutboundFetch({ nativeFetch, fallbackFetch }));
    const res = reply();
    await stateHandler()({ params: { state: leafState.sign({ m: 'fixture', s: 'fixture' }) } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
    for (const [, options] of nativeFetch.mock.calls) {
      expect(options).toMatchObject({ proxyUrl: 'socks5://leaf.invalid:1', profile: 'chrome' });
    }
    expect(fallbackFetch).not.toHaveBeenCalled();
  });

  test.each([
    ['denied media', manifestResponse({ text: async () => '#EXTM3U\nhttps://w1.papacito.cfd/leaf/stream_notice/seg.ts\n' })],
    ['authorization failure', manifestResponse({ ok: false, status: 403 })],
  ])('%s invalidates the mint and backs off without a forced retry', async (_label, upstream) => {
    const handler = stateHandler();
    const state = leafState.sign({ m: 'fixture', s: 'fixture' });
    mockSafeFetch.mockResolvedValueOnce(mintResponse()).mockResolvedValueOnce(upstream);
    const first = reply();
    await handler({ params: { state } }, first);
    expect(first.status).toHaveBeenCalledWith(502);
    expect(first.send).toHaveBeenCalledWith('Failed to resolve Leaf playlist');
    expect(leafMint.stats()).toMatchObject({ cached: 0, coolingDown: 1 });
    const second = reply();
    await handler({ params: { state } }, second);
    expect(second.status).toHaveBeenCalledWith(502);
    expect(second.setHeader).toHaveBeenCalledWith('Retry-After', '10');
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    expect(mockSafeFetch.mock.calls.some(([url]) => url.includes('?cb='))).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(signedUrl);
  });

  test('legacy validated URL route still works without a state signing key', async () => {
    delete process.env.APP_SECRET;
    require('../src/routes/leafManifest');
    const legacy = mockGet.mock.calls[0][1];
    mockSafeFetch.mockResolvedValue(manifestResponse());
    const res = reply();
    await legacy({ query: { url: signedUrl }, url: '/api/leaf/manifest.m3u8?url=' + encodeURIComponent(signedUrl) }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(playlist);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });
});
