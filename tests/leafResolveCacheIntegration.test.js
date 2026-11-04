'use strict';

// Pure cache integration: transport replies are in-memory fixtures, with no
// provider, application, resolver process, native transport or listener.
const StreamResolveCache = require('../src/services/StreamResolveCache');

const NOW = 1793793600000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const KEY = 'leaf:fixture-match:fixture-stream';
const REVISION = '12345678-1234-1234-1234-123456789abc';
// The cache must treat this synthetic state token as opaque; verification
// belongs to the Leaf route, not the resolve cache.
const STATE_URL = 'https://addon.example/api/leaf/m3u8/eyJtIjoiZml4dHVyZSJ9.fixture-signature/index.m3u8?hint=a%2fb%2Bc#preserve';
const response = data => ({ ok: true, json: async () => data });
const noConflict = { hasConflict: () => false, signal: () => null };

function localCache() {
  return new StreamResolveCache({
    sharedResolver: { available: () => false, request: jest.fn() },
    resolverConflictState: noConflict,
  });
}

function sharedFixture(initial = { status: 'miss' }) {
  let remote = initial;
  const request = jest.fn(async (raw, options = {}) => {
    const url = new URL(raw);
    if (options.method === 'PATCH') {
      const matches = url.searchParams.get('revision') === remote.revision;
      if (matches) remote = { status: 'miss' };
      return response({ ok: matches });
    }
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      remote = { status: body.status, streams: body.streams, expiresAt: Date.now() + body.ttlMs, revision: REVISION };
      return response({ ok: true, revision: REVISION });
    }
    if (url.searchParams.get('claim') === '1') return response({ ok: true, ownerToken: 'fixture-owner' });
    return response(remote);
  });
  return { request, cache: () => new StreamResolveCache({
    sharedResolver: { available: () => true, request },
    resolverConflictState: noConflict,
  }) };
}

let clock, oldShared;
beforeEach(() => {
  oldShared = process.env.RESOLVE_CACHE_SHARED;
  process.env.RESOLVE_CACHE_SHARED = 'true';
  clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('Unexpected real transport'); });
});
afterEach(() => {
  try {
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
    if (oldShared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
    else process.env.RESOLVE_CACHE_SHARED = oldShared;
  }
});

test('opaque Leaf state URLs retain their bytes and four-hour local lifetime', async () => {
  const cache = localCache();
  const mint = jest.fn(async () => [{ url: STATE_URL }]);
  expect(await cache.getOrCreate(KEY, mint)).toEqual([{ url: STATE_URL }]);
  expect(cache.getRemainingTtl(KEY)).toBe(FOUR_HOURS);
  clock.mockReturnValue(NOW + FOUR_HOURS - 1);
  expect(await cache.getOrCreate(KEY, mint)).toEqual([{ url: STATE_URL }]);
  expect(mint).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(NOW + FOUR_HOURS);
  expect(cache.get(KEY)).toBeNull();
});

test('mocked shared publication and adoption preserve opaque URLs and original expiry', async () => {
  const shared = sharedFixture();
  const first = shared.cache();
  await first.getOrCreate(KEY, async () => [{ url: STATE_URL }]);
  const publication = shared.request.mock.calls.find(([, options]) => options.method === 'POST');
  expect(JSON.parse(publication[1].body)).toMatchObject({ streams: [{ url: STATE_URL }], ttlMs: FOUR_HOURS });
  clock.mockReturnValue(NOW + 60 * 60 * 1000);
  const second = shared.cache();
  const mint = jest.fn(async () => []);
  const adopted = await second.getOrCreate(KEY, mint);
  expect(adopted).toEqual([{ url: STATE_URL }]);
  expect(second.getRemainingTtl(KEY)).toBe(3 * 60 * 60 * 1000);
  expect(mint).not.toHaveBeenCalled();
  adopted[0].url = 'changed-by-caller';
  expect(second.get(KEY)).toEqual([{ url: STATE_URL }]);
});

test.each(['direct', 'leaf proxy'])('future ft expiry caps the initial Leaf TTL (%s)', async wrapper => {
  const payload = Buffer.from(JSON.stringify({ exp: NOW / 1000 + 120 })).toString('base64url');
  const direct = `https://papacito.cfd/m3u/fixture/live.m3u8?ft=header.${payload}.signature`;
  const url = wrapper === 'direct' ? direct : `https://addon.example/api/leaf/manifest.m3u8?url=${encodeURIComponent(direct)}`;
  const cache = localCache();
  await cache.getOrCreate(KEY, async () => [{ url }]);
  expect(cache.getRemainingTtl(KEY)).toBe(75000);
  clock.mockReturnValue(NOW + 75000);
  expect(cache.get(KEY)).toBeNull();
});

test.each(['empty', 'throw'])('Leaf %s results use the negative lifetime and allow a retry after it', async outcome => {
  const cache = localCache();
  const mint = jest.fn().mockImplementationOnce(async () => {
    if (outcome === 'throw') throw new Error('fixture failure');
    return [];
  }).mockResolvedValue([{ url: STATE_URL }]);
  expect(await cache.getOrCreate(KEY, mint)).toEqual([]);
  expect(cache.getRemainingTtl(KEY)).toBe(30000);
  expect(cache.has(KEY)).toBe(false);
  clock.mockReturnValue(NOW + 29999);
  expect(await cache.getOrCreate(KEY, mint)).toEqual([]);
  expect(mint).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(NOW + 30000);
  expect(await cache.getOrCreate(KEY, mint)).toEqual([{ url: STATE_URL }]);
  expect(mint).toHaveBeenCalledTimes(2);
  expect(cache.getRemainingTtl(KEY)).toBe(FOUR_HOURS);
});

test.each([REVISION, undefined, 'invalid'])('adopted Leaf invalidation stays conditional (revision %s)', async revision => {
  const shared = sharedFixture({ status: 'ok', streams: [{ url: STATE_URL }], expiresAt: NOW + FOUR_HOURS, revision });
  const cache = shared.cache();
  const mint = jest.fn(async () => []);
  expect(await cache.getOrCreate(KEY, mint)).toEqual([{ url: STATE_URL }]);
  expect(mint).not.toHaveBeenCalled();
  const invalidate = jest.spyOn(cache, '_invalidateShared');
  cache.noteFailure(KEY);
  await invalidate.mock.results[0].value;
  expect(cache.get(KEY)).toBeNull();
  const mutations = shared.request.mock.calls.filter(([, options]) => options.method);
  if (revision === REVISION) {
    expect(mutations).toHaveLength(1);
    expect(mutations[0][1].method).toBe('PATCH');
    expect(new URL(mutations[0][0]).searchParams.get('revision')).toBe(REVISION);
  } else {
    expect(mutations).toEqual([]);
  }
});
