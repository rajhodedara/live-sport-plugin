'use strict';

// Real Leaf provider -> stream mint -> resolve cache, with all I/O replaced.
jest.mock('../src/container', () => ({ resolve: jest.fn(), hasRegistration: () => false }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn(), getImpit: () => null, isImpitAvailable: () => false }));
jest.mock('../src/catalog', () => ({ isReplayMatch: () => false }));
jest.mock('../src/services/LeafStreamProbe', () => ({ checkLeafStream: jest.fn() }));
const container = require('../src/container');
const { safeFetch } = require('../src/services/ProviderOutbound');
const { checkLeafStream } = require('../src/services/LeafStreamProbe');
const LeafProvider = require('../src/providers/LeafProvider');
const leafMint = require('../src/services/LeafMint');
const { resetAccountRateLimits } = require('../src/services/LeafRateLimitState');
const { mintVerifiedSources } = require('../src/streams');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const source = { source: 'leaf', id: 'streamed:fixture' };
const match = { id: 'canonical-fixture', title: 'Home vs Away', category: 'football', sources: [source] };
const key = 'leaf:canonical-fixture:streamed:fixture';
let cache, provider, now;
const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.LEAF_INSTALL_CONFIG = 'fixture-install';
  process.env.APP_SECRET = 'fixture-leaf-private-state';
  for (const name of ['LEAF_API_URL', 'LEAF_PREMIUM_TOKEN', 'LEAF_PREMIUM_PROFILE', 'LEAF_API_ORIGIN']) delete process.env[name];
  now = Date.parse('2026-11-06T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  leafMint.invalidate(); resetAccountRateLimits(); safeFetch.mockReset(); checkLeafStream.mockReset();
  checkLeafStream.mockResolvedValue({ status: 'ok' });
  cache = new StreamResolveCache({ sharedResolver: { available: () => false } });
  provider = new LeafProvider();
  container.resolve.mockImplementation(name => {
    if (name === 'leafProvider') return provider;
    if (name === 'streamResolveCache') return cache;
    if (name === 'streamScorer') return { calculateScore: () => 0 };
    if (name === 'm3u8Parser') return null;
    throw new Error('Unexpected mocked service');
  });
});
afterEach(() => { leafMint.invalidate(); resetAccountRateLimits(); jest.restoreAllMocks(); process.env = { ...originalEnv }; });
const mint = options => mintVerifiedSources(source, match, null, key, options);

test.each([
  ['capacity', { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }],
  ['timeout', { name: 'TimeoutError', code: 'ETIMEDOUT' }],
  ['cancelled', { name: 'AbortError' }]
])('Leaf %s keeps a two-second local defer and recovers without a dead verdict', async (reason, attributes) => {
  safeFetch.mockRejectedValueOnce(Object.assign(new Error('fixture local control'), attributes))
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({ streams: [
      { name: 'Leaf · Fixture', url: 'https://papacito.cfd/m3u/fixture/live.m3u8?ft=fixture' }
    ] }) });
  const failure = jest.spyOn(cache, 'noteFailure');
  const calls = jest.fn(() => mint());
  expect(await cache.getOrCreate(key, calls)).toEqual([]);
  expect(cache.entries.get(key)).toMatchObject({ status: 'deferred', reason, expiresAt: now + 2000 });
  expect(cache.stats().negativeHits).toBe(0);
  expect(failure).not.toHaveBeenCalled();
  now += 2000;
  expect(await cache.getOrCreate(key, calls)).toHaveLength(1);
  expect(cache.entries.get(key).status).toBe('ok');
  expect(failure).not.toHaveBeenCalled();
});

test('quota does not publish a failed shared-cache entry and suppresses repeated account I/O', async () => {
  const requests = [];
  process.env.RESOLVE_CACHE_SHARED = 'true';
  const request = jest.fn(async (url, options = {}) => {
    requests.push(options.method || 'GET');
    return { ok: true, json: async () => url.includes('claim=1') ? { ok: true, ownerToken: 'fixture-owner' } : { status: 'miss' } };
  });
  cache = new StreamResolveCache({ sharedResolver: { available: () => true, request },
    resolverConflictState: { hasConflict: () => false, signal: () => null } });
  safeFetch.mockResolvedValue({ ok: false, status: 429, headers: { get: () => '10' } });
  expect(await cache.getOrCreate(key, () => mint())).toEqual([]);
  expect(cache.entries.get(key).status).toBe('deferred');
  now += 2000;
  expect(await cache.getOrCreate(key, () => mint())).toEqual([]);
  expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(requests).toContain('DELETE');
  expect(requests).not.toContain('POST');
});

test('core dispatch forwards caller cancellation and canonical match association to Live Leaf', async () => {
  const controller = new AbortController();
  const resolve = jest.spyOn(provider, 'resolveStream').mockResolvedValue([]);
  await mint({ signal: controller.signal, forceRefresh: true });
  expect(resolve).toHaveBeenCalledWith(source.id, match.category, match.title, source,
    expect.objectContaining({ signal: controller.signal, forceRefresh: true, matchId: match.id }));
});
