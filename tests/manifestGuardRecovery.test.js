'use strict';

// Actual manifest route, guard, manifest fetch and remint lookup. The upstream
// transport and provider are simulated; the route is called without a listener.
jest.mock('express', () => ({
  Router: () => ({ get: jest.fn(), use: jest.fn(), options: jest.fn(), all: jest.fn() }),
  json: () => () => {}, urlencoded: () => () => {}
}));
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/streams', () => ({ resolveSource: jest.fn() }));
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
const container = require('../src/container');
const { resolveSource } = require('../src/streams');
const { safeFetch } = require('../src/impitClient');
const { assertOutboundUrl } = require('../src/services/GuardedOutbound');
const proxy = require('../src/manifestProxy');
const remint = require('../src/remint');
const router = require('../src/routes/manifest');

const held = 'https://cdn.example.test/old/index.m3u8';
const fresh = 'https://cdn.example.test/fresh/index.m3u8';
const rck = 'embedst:canonical-match:source-1';
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://cdn.example.test/segment.ts\n';
const response = () => ({ ok: true, status: 200, text: async () => media });
let warn, log, noteFailure;

beforeEach(() => {
  jest.useFakeTimers();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  proxy.manifestCache.clear();
  proxy.manifestInFlight.clear();
  remint.remintCache.clear();
  noteFailure = jest.fn();
  const match = { id: 'canonical-match', sources: [{ id: 'source-1', source: 'embedst' }] };
  container.resolve.mockImplementation(name => {
    if (name === 'cacheService') return { getMatchesReadOnly: () => [match] };
    if (name === 'streamResolveCache') return { noteFailure };
    throw new Error('Unexpected service: ' + name);
  });
  resolveSource.mockReset();
  resolveSource.mockResolvedValue([{ url: fresh }]);
  safeFetch.mockReset();
});

afterEach(() => {
  expect(proxy.manifestInFlight.size).toBe(0);
  jest.clearAllTimers();
  jest.useRealTimers();
  warn.mockRestore();
  log.mockRestore();
});

async function request(target) {
  const url = new URL('https://addon.example.test/api/manifest.m3u8');
  url.search = new URLSearchParams({ url: target, rck }).toString();
  const result = { status: 200, headers: {} };
  const res = {
    setHeader(name, value) { result.headers[name.toLowerCase()] = value; },
    status(code) { result.status = code; return this; },
    send(body) { result.body = body; return this; },
    json(body) { result.body = body; return this; }
  };
  await router.get.mock.calls[0][1]({
    query: Object.fromEntries(url.searchParams), headers: { host: url.host },
    protocol: 'https', url: url.pathname + url.search, originalUrl: url.pathname + url.search
  }, res);
  return result;
}

test('a real guard rejection with a valid recovery key returns 403 without invoking the provider', async () => {
  const blocked = 'http://127.0.0.1/private.m3u8';
  safeFetch.mockImplementation(async (url, options) => {
    expect(options.guardExternal).toBe(true);
    if (url === blocked) await assertOutboundUrl(url);
    return response();
  });

  const result = await request(blocked);
  expect(result.status).toBe(403);
  expect(result.body).toMatchObject({ error: 'Blocked outbound URL' });
  expect(resolveSource).not.toHaveBeenCalled();
  expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(remint.remintCache.size).toBe(0);
  expect(proxy.manifestCache.size).toBe(0);
  expect(noteFailure).not.toHaveBeenCalled();
});

test('local capacity with prior upstream provenance stays 503 without remint or negative caching', async () => {
  safeFetch.mockRejectedValue(Object.assign(new Error('Local capacity exhausted'), {
    code: 'ERR_OUTBOUND_CAPACITY', statusCode: 503, previousUpstreamStatus: 403, isFatal: true
  }));
  const result = await request(held);
  expect(result.status).toBe(503);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(resolveSource).not.toHaveBeenCalled();
  expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(proxy.manifestCache.size).toBe(0);
  expect(noteFailure).not.toHaveBeenCalled();
});

test('a real upstream 403 still remints the selected source and returns a valid manifest', async () => {
  safeFetch.mockResolvedValueOnce({ ok: false, status: 403 }).mockResolvedValueOnce(response());
  const result = await request(held);
  expect(result.status).toBe(200);
  expect(result.body).toContain('#EXTM3U');
  expect(resolveSource).toHaveBeenCalledTimes(1);
  expect(resolveSource).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'source-1', forceRefresh: true, skipCache: true }),
    expect.objectContaining({ id: 'canonical-match' }), null
  );
  expect(safeFetch.mock.calls.map(([url]) => url)).toEqual([held, fresh]);
  expect(safeFetch.mock.calls.every(([, options]) => options.guardExternal === true)).toBe(true);
});

test.each(['ERR_OUTBOUND_BLOCKED', 'ERR_OUTBOUND_CAPACITY', 'ERR_NATIVE_POOL_BUSY', 'ERR_NATIVE_SLOT_CAPACITY'])(
  '%s cannot be interpreted as upstream expiry even with stale status fields', code => {
    expect(remint.isExpiryStatus({ code, statusCode: 403, upstreamStatus: 403 })).toBe(false);
  }
);

test('a fatal local transport error is not an upstream token expiry', () => {
  expect(remint.isExpiryStatus({ isFatal: true, statusCode: 403 })).toBe(false);
});
