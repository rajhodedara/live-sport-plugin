'use strict';

jest.mock('../src/container', () => ({ resolve: jest.fn(), hasRegistration: () => false }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
jest.mock('../src/services/StreamedWasmPool', () => ({ resolveWasmStream: () => { throw Error('Unexpected WASM'); } }));
jest.mock('../src/services/HlsRewriteService', () => ({}));
jest.mock('../src/services/TimingRuntime', () => ({ relations: null }));
jest.mock('../src/catalog', () => ({ isReplayMatch: () => false }));

const container = require('../src/container');
const { safeFetch } = require('../src/services/ProviderOutbound');
const { mintVerifiedSources, handleStream } = require('../src/streams');
const Cache = require('../src/services/StreamResolveCache');
const TimStreamsProvider = require('../src/providers/TimStreamsProvider');
const CronService = require('../src/services/CronService');
const { DIRECT_RETRY_HINT, markInconclusiveStreams, inconclusiveStreamsReason } = require('../src/services/StreamResolutionOutcome');
const PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n';
const direct = name => ({ title: name, url: `https://cdn.fixture.test/${name}.m3u8` });
const web = () => ({ title: 'Web Player', externalUrl: '/watch?url=https%3A%2F%2Fembed.fixture.test%2Flive' });
const busy = () => Object.assign(Error('synthetic capacity'), { code: 'ERR_NATIVE_POOL_BUSY' });
const ok = () => ({ status: 200, text: async () => PLAYLIST });
const source = { source: 'ppvst', id: 'channel', embedUrl: 'https://embed.fixture.test/live' };
const match = { id: 'partial', title: 'A vs B', category: 'football', sources: [source] };
const key = Cache.resolveKey(source, match.id);
let cache, services, oldEnv;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-06T03:00:00Z'));
  oldEnv = Object.fromEntries(['DONATION_URL', 'STREAM_SOFT_DEADLINE_MS', 'STREAM_HARD_DEADLINE_MS'].map(k => [k, process.env[k]]));
  process.env.DONATION_URL = 'disabled';
  process.env.STREAM_SOFT_DEADLINE_MS = '100';
  process.env.STREAM_HARD_DEADLINE_MS = '200';
  cache = new Cache({ sharedResolver: { available: () => false, request: () => { throw Error('Unexpected L2 I/O'); } } });
  services = { streamResolveCache: cache, streamScorer: { calculateScore: () => 1 }, m3u8Parser: null,
    cacheService: { findMatch: () => match }, ppvStProvider: { resolveStream: jest.fn(async () => [direct('ppv'), web()]) } };
  container.resolve.mockImplementation(name => services[name]);
  safeFetch.mockReset().mockResolvedValue(ok());
  for (const name of ['log', 'warn', 'error']) jest.spyOn(console, name).mockImplementation(() => {});
});
afterEach(() => {
  jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks();
  for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const mint = () => mintVerifiedSources(source, match, null, key, { skipSpeedProbe: true });

test('a surviving PPV web fallback cannot turn a capacity miss into a 30-second direct blackout', async () => {
  safeFetch.mockRejectedValueOnce(busy()).mockResolvedValue(ok());
  const first = await cache.getOrCreate(key, mint);
  expect(first).toHaveLength(1);
  expect(first[0].externalUrl).toBeDefined();
  expect(first[0][DIRECT_RETRY_HINT]).toBeUndefined();
  expect(cache.isDeferred(key)).toBe(true);
  expect(cache.getRemainingTtl(key)).toBe(2000);
  // A late verification report must not lengthen this direct-retry cooldown.
  cache.noteSuccess(key);
  expect(cache.getRemainingTtl(key)).toBe(2000);
  await cache.getOrCreate(key, mint);
  expect(services.ppvStProvider.resolveStream).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(2000);
  const recovered = await cache.getOrCreate(key, mint);
  expect(recovered.some(row => row.url)).toBe(true);
  expect(cache.isDeferred(key)).toBe(false);
  expect(cache.getRemainingTtl(key)).toBeGreaterThan(2000);
  expect(services.ppvStProvider.resolveStream).toHaveBeenCalledTimes(2);
});

test('a definite 404 retains the ordinary web fallback retry window', async () => {
  safeFetch.mockResolvedValue({ status: 404, text: async () => 'Not found' });
  const result = await cache.getOrCreate(key, mint);
  expect(result).toHaveLength(1);
  expect(result[0].externalUrl).toBeDefined();
  expect(cache.isDeferred(key)).toBe(false);
  expect(cache.getRemainingTtl(key)).toBe(30000);
});

test('a failed remint never restores an expired previous media URL', async () => {
  cache._set(key, 'ppvst', match.id, [direct('expired')], 'ok', -1);
  safeFetch.mockRejectedValue(busy());
  const result = await cache.getOrCreate(key, mint);
  expect(result.every(row => !row.url)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('expired');
  expect(cache.isDeferred(key)).toBe(true);
});

test('early success during a remint cannot revive the expired URL for another caller', async () => {
  cache._set(key, 'ppvst', match.id, [direct('expired')], 'ok', -1);
  let release;
  const first = cache.getOrCreate(key, async () => {
    cache.noteSuccess(key);
    await new Promise(resolve => { release = resolve; });
    return [direct('replacement')];
  });
  await jest.advanceTimersByTimeAsync(0);
  expect(cache.get(key)).toBeNull();
  let secondResult;
  const second = cache.getOrCreate(key, () => { throw Error('Duplicate mint'); }).then(rows => { secondResult = rows; });
  await jest.advanceTimersByTimeAsync(0);
  expect(secondResult).toBeUndefined();
  release();
  await first; await second;
  expect(secondResult).toEqual([direct('replacement')]);
});

test('provider JSON cannot forge the internal retry marker or expose it in the response', async () => {
  services.ppvStProvider.resolveStream.mockResolvedValue([{ ...web(), [DIRECT_RETRY_HINT]: 'capacity' }]);
  const result = await cache.getOrCreate(key, mint);
  expect(result[0][DIRECT_RETRY_HINT]).toBeUndefined();
  expect(cache.entries.get(key).streams[0][DIRECT_RETRY_HINT]).toBeUndefined();
  expect(cache.isDeferred(key)).toBe(false);
  expect(cache.getRemainingTtl(key)).toBe(30000);
  const annotated = markInconclusiveStreams([web()], 'capacity');
  expect(inconclusiveStreamsReason(annotated)).toBe('capacity');
  expect(inconclusiveStreamsReason(JSON.parse(JSON.stringify(annotated)))).toBeNull();
});

function groupedTimStreams() {
  const provider = new TimStreamsProvider({ circuitBreaker: {
    wrap: (_name, action) => ({ fire: action }), wrapSync: (_name, action) => ({ fire: action })
  } });
  provider.getMatches = jest.fn(async () => [{ id: 'ts_group', sources: [
    { id: 'busy', url: 'https://embed.fixture.test/busy' },
    { id: 'other', url: 'https://embed.fixture.test/other' }
  ] }]);
  provider.proxyFetch = jest.fn(async url => {
    if (url.endsWith('/busy')) throw busy();
    return { ok: true, text: async () => 'other' };
  });
  provider.decodeObfuscatedScript = jest.fn(() => 'var stream="https://cdn.fixture.test/other.m3u8";');
  services.timStreamsProvider = provider;
  const src = { source: 'timstreams', id: 'group' };
  const event = { ...match, sources: [src] };
  const cacheKey = Cache.resolveKey(src, event.id);
  return { provider, cacheKey, mint: () => mintVerifiedSources(src, event, null, cacheKey, { skipSpeedProbe: true }) };
}

test('mixed TimStreams extraction capacity and a later 404 retain the temporary evidence through verification', async () => {
  const grouped = groupedTimStreams();
  safeFetch.mockResolvedValue({ status: 404, text: async () => 'Not found' });
  const result = await cache.getOrCreate(grouped.cacheKey, grouped.mint);
  expect(result).toHaveLength(1);
  expect(result[0].externalUrl).toBeDefined();
  expect(cache.isDeferred(grouped.cacheKey)).toBe(true);
  expect(cache.getRemainingTtl(grouped.cacheKey)).toBe(2000);
  expect(grouped.provider.proxyFetch).toHaveBeenCalledTimes(2);
});

test('a verified healthy TimStreams feed survives another embed failure with a normal positive TTL', async () => {
  const grouped = groupedTimStreams();
  const result = await cache.getOrCreate(grouped.cacheKey, grouped.mint);
  expect(result.some(row => row.url)).toBe(true);
  expect(cache.isDeferred(grouped.cacheKey)).toBe(false);
  expect(cache.getRemainingTtl(grouped.cacheKey)).toBeGreaterThan(2000);
});

test('a partial positive response gets a short client cache, then a complete warm list recovers normal caching', async () => {
  let release;
  services.ppvStProvider.resolveStream.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  services.cdnLiveProvider = { resolveStream: jest.fn(async () => [{ title: 'Fast feed', url: 'https://cdn.fixture.test/fast.mp4' }]) };
  const event = { ...match, sources: [source, { source: 'cdnlive', id: 'fast' }] };
  services.cacheService.findMatch = () => event;
  let first;
  const request = handleStream('tv', 'nuvio_sport_partial', {}).then(value => { first = value; });
  await jest.advanceTimersByTimeAsync(100);
  expect(first.streams).toHaveLength(1);
  expect(first).toMatchObject({ cacheMaxAge: 2, staleRevalidate: 0, staleError: 0 });
  release([direct('ppv'), web()]);
  await jest.advanceTimersByTimeAsync(0);
  await request;
  const second = await handleStream('tv', 'nuvio_sport_partial', {});
  expect(second.streams).toHaveLength(2);
  expect(second).toMatchObject({ cacheMaxAge: 30, staleRevalidate: 30, staleError: 60 });
  expect(services.ppvStProvider.resolveStream).toHaveBeenCalledTimes(1);
});

test('a cached retryable web fallback hidden by another direct still shortens the client cache', async () => {
  safeFetch.mockRejectedValueOnce(busy());
  await cache.getOrCreate(key, mint);
  services.cdnLiveProvider = { resolveStream: jest.fn(async () => [{ title: 'Fast feed', url: 'https://cdn.fixture.test/fast.mp4' }]) };
  services.cacheService.findMatch = () => ({ ...match, sources: [source, { source: 'cdnlive', id: 'fast' }] });
  const response = await handleStream('tv', 'nuvio_sport_partial', {});
  expect(response.streams).toHaveLength(1);
  expect(response.streams[0]._source).toBe('cdnlive');
  expect(response).toMatchObject({ cacheMaxAge: 2, staleRevalidate: 0, staleError: 0 });
  expect(JSON.stringify(response)).not.toContain(DIRECT_RETRY_HINT);
});

function slowPublicationCache(options = {}) {
  const request = jest.fn(async (raw, opts = {}) => {
    const url = new URL(raw);
    let value = { status: 'miss' };
    if (url.pathname === '/api/cache/prune') value = { ok: true };
    else if (url.searchParams.get('claim') === '1') value = { ok: true, ownerToken: '11111111-1111-4111-8111-111111111111' };
    else if (opts.method === 'POST') return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
    else if (opts.method === 'DELETE') value = { ok: true };
    return { ok: true, json: async () => value };
  });
  cache = new Cache({ ...options, sharedResolver: { available: () => true, request } });
  services.streamResolveCache = cache;
  safeFetch.mockRejectedValueOnce(busy());
  return request;
}

test('a two-second L2 publication timeout does not erase the first usable web fallback', async () => {
  slowPublicationCache();
  const pending = cache.getOrCreate(key, mint);
  await jest.advanceTimersByTimeAsync(2000);
  const rows = await pending;
  expect(rows).toHaveLength(1);
  expect(rows[0].externalUrl).toBeDefined();
  expect(cache.isDeferred(key)).toBe(true);
  expect(cache.getRemainingTtl(key)).toBe(2000);
});

test('ordinary expiry cleanup during publication still allows that web fallback to be delivered', async () => {
  slowPublicationCache();
  setTimeout(() => { expect(cache.get(key)).toBeNull(); }, 2000);
  const pending = cache.getOrCreate(key, mint);
  await jest.advanceTimersByTimeAsync(2000);
  expect(await pending).toHaveLength(1);
  expect(cache.getRemainingTtl(key)).toBe(2000);
});

test('explicit failure after expiry cleanup fences a still-pending web publication', async () => {
  slowPublicationCache();
  setTimeout(() => { expect(cache.get(key)).toBeNull(); cache.noteFailure(key); }, 2000);
  const pending = cache.getOrCreate(key, mint);
  await jest.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual([]);
  expect(cache.entries.has(key)).toBe(false);
});

test('pruning during publication does not reinsert the temporary web result', async () => {
  slowPublicationCache();
  const pending = cache.getOrCreate(key, mint);
  await jest.advanceTimersByTimeAsync(0);
  cache.pruneEnded([]);
  await jest.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual([]);
  expect(cache.entries.size).toBe(0);
});

test('a newer local result wins over completion of an older web publication', async () => {
  slowPublicationCache();
  const pending = cache.getOrCreate(key, mint);
  await jest.advanceTimersByTimeAsync(0);
  const replacement = cache._set(key, 'ppvst', match.id, [direct('newer')], 'ok', 60000);
  await jest.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual([direct('newer')]);
  expect(cache.entries.get(key)).toBe(replacement);
  expect(cache.getRemainingTtl(key)).toBe(58000);
});

test('LRU eviction during publication does not displace the newer unrelated entry', async () => {
  slowPublicationCache({ maxEntries: 1 });
  const pending = cache.getOrCreate(key, mint);
  await jest.advanceTimersByTimeAsync(0);
  const otherKey = 'watchfooty:other:feed';
  cache._set(otherKey, 'watchfooty', 'other', [direct('other')], 'ok', 60000);
  await jest.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual([]);
  expect(cache.entries.has(otherKey)).toBe(true);
  expect(cache.entries.has(key)).toBe(false);
});

test('a Leaf overlay change fences a publication even after its local entry expired', async () => {
  slowPublicationCache();
  const leafKey = 'leaf:partial:old-feed';
  const cron = new CronService({ streamResolveCache: cache });
  setTimeout(() => { expect(cache.get(leafKey)).toBeNull(); cron._invalidateOverlayMatch(match.id); }, 2000);
  const pending = cache.getOrCreate(leafKey, async () => markInconclusiveStreams([web()], 'capacity'));
  await jest.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual([]);
  expect(cache.entries.has(leafKey)).toBe(false);
});
