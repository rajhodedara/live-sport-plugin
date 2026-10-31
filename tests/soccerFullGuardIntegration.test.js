'use strict';

// Drive the actual route and segment probe methods without listeners, workers,
// or network. ProviderOutbound remains real so its guardExternal option is checked.
jest.mock('express', () => ({ Router: jest.fn(() => ({ get: jest.fn() })) }));
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
jest.mock('../src/config', () => ({ getRequestBaseUrl: () => 'https://addon.example.test' }));
jest.mock('../src/services/SoccerFullHlsRewrite', () => ({
  rewriteSoccerFullPlaylist: jest.fn(body => body),
  prewarmPlaylist: jest.fn(async () => {})
}));

const { safeFetch } = require('../src/impitClient');
const router = require('../src/routes/soccerFullManifest');
const handler = router.get.mock.calls[0][1];
const { SoccerFullSegmentLength } = require('../src/services/SoccerFullSegmentLength');

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; }
  };
}

beforeEach(() => safeFetch.mockReset());

test.each([
  ['ERR_OUTBOUND_BLOCKED', 403],
  ['ERR_OUTBOUND_CAPACITY', 503]
])('the playlist route guards outbound requests and does not cache %s', async (code, status) => {
  const req = { query: { url: `https://soccerfull.net/hls/${code}.m3u8` } };
  safeFetch.mockRejectedValueOnce(Object.assign(new Error('fixture failure'), { code }));
  const first = response();
  await handler(req, first);
  expect(first.statusCode).toBe(status);
  expect(first.headers['Cache-Control']).toBe('no-store');
  expect(safeFetch.mock.calls[0][1]).toMatchObject({ guardExternal: true, attempts: 1, timeoutMs: 8000, maxBodyBytes: 8 * 1024 * 1024 });

  safeFetch.mockResolvedValueOnce({ status: 200, text: async () => '#EXTM3U\nsegment.ts' });
  const retry = response();
  await handler(req, retry);
  expect(retry.statusCode).toBe(200);
  expect(retry.headers['X-SoccerFull-Cache']).toBe('MISS');
  expect(safeFetch).toHaveBeenCalledTimes(2);
});

test('a truncated playlist cannot enter the rewritten playlist cache', async () => {
  const req = { query: { url: 'https://soccerfull.net/hls/truncated.m3u8' } };
  safeFetch.mockResolvedValueOnce({ status: 200, bodyTruncated: true, text: jest.fn() });
  const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const first = response(); await handler(req, first);
    expect(first.statusCode).toBe(502);
    expect(first.headers['Cache-Control']).toBe('no-store');
    safeFetch.mockResolvedValueOnce({ status: 200, text: async () => '#EXTM3U\nsegment.ts' });
    const retry = response(); await handler(req, retry);
    expect(retry.headers['X-SoccerFull-Cache']).toBe('MISS');
    expect(safeFetch).toHaveBeenCalledTimes(2);
  } finally { warn.mockRestore(); }
});

test('a blocked segment cannot populate length or prefix caches', async () => {
  const service = new SoccerFullSegmentLength();
  safeFetch.mockRejectedValue(Object.assign(new Error('blocked'), { code: 'ERR_OUTBOUND_BLOCKED' }));
  expect(await service.probePrefixBytes('https://cdn.example.test/blocked.image')).toBe(42);
  expect(await service.probeLength('https://cdn.example.test/blocked.image')).toBeNull();
  expect(service.prefixCache.size).toBe(0);
  expect(service.lengthCache.size).toBe(0);
  expect(service.activeProbes).toBe(0);
  expect(safeFetch.mock.calls).toHaveLength(2);
  for (const [, options] of safeFetch.mock.calls) expect(options).toMatchObject({ guardExternal: true, timeoutMs: 4000, attempts: 1 });
});
