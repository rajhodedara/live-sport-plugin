'use strict';

// Exercise the production breaker/provider/mint/cache wiring with transport
// adapters only. Never load an app entrypoint, listener or native provider.
jest.mock('../src/container', () => ({ resolve: jest.fn(), hasRegistration: () => false }));
jest.mock('../src/catalog', () => ({ isReplayMatch: () => false }));
jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(() => { throw Error('Unexpected provider I/O'); }),
  streamingFetch: jest.fn(() => { throw Error('Unexpected streaming I/O'); })
}));
jest.mock('../src/services/HlsRewriteService', () => ({
  rewriteHlsPlaylist: jest.fn(() => { throw Error('Unexpected rewrite'); }),
  resolveSegmentUrl: jest.fn(() => { throw Error('Unexpected segment probe'); })
}));
jest.mock('../src/services/TimingRuntime', () => ({ relations: null }));

const crypto = require('node:crypto');
const container = require('../src/container');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');
const ScoreZoneProvider = require('../src/providers/ScoreZoneProvider');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const { mintVerifiedSources } = require('../src/streams');
const { tokenCache } = require('../src/routes/scoreZoneStream');

const SECRET = 'offline-scorezone-production-wiring';
const capacity = () => Object.assign(new Error('Local transport busy'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true });
const timeout = () => Object.assign(new Error('Local transport deadline'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
const wrappedCapacity = () => new Error('Transport wrapper', { cause: { code: 'ERR_NATIVE_SLOT_CAPACITY', isFatal: true } });
const channel = { id: 'main', name: 'Main', country: 'US', url: 'https://media.fixture.test/main.m3u8' };

function sourceFor(route, suffix = 'one') {
  if (route === 'iptv') return { source: 'scorezone', id: 'sz_iptv_' + suffix };
  const meta = { e: 'event-' + suffix, h: 'Home', a: 'Away', s: 'football' };
  const body = Buffer.from(JSON.stringify(meta)).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(body).digest('hex').slice(0, 16);
  return { source: 'scorezone', id: body + '.' + signature };
}

function sharedAdapter() {
  const calls = [];
  return { calls, available: () => true, request: jest.fn(async (raw, options = {}) => {
    const url = new URL(raw);
    calls.push({ method: options.method || 'GET', claim: url.searchParams.get('claim'), body: options.body });
    const payload = options.method === 'DELETE' ? { ok: true }
      : url.searchParams.get('claim') === '1' ? { ok: true, ownerToken: 'owner-' + calls.length }
        : { status: 'miss' };
    return { ok: true, json: async () => payload };
  }) };
}

describe('ScoreZone production circuit-breaker deferral', () => {
  let breakerService, provider, cache, warn, previousShared;
  beforeEach(() => {
    previousShared = process.env.RESOLVE_CACHE_SHARED;
    process.env.RESOLVE_CACHE_SHARED = 'true';
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    breakerService = new CircuitBreakerService();
    provider = new ScoreZoneProvider({ circuitBreaker: breakerService });
    provider.secret = SECRET;
    cache = new StreamResolveCache({ sharedResolver: { available: () => false, request: () => { throw Error('Unexpected resolver I/O'); } } });
    container.resolve.mockImplementation(name => ({
      scorezoneProvider: provider, streamResolveCache: cache,
      streamScorer: { calculateScore: () => 1 }, m3u8Parser: null
    })[name]);
  });
  afterEach(() => {
    for (const breaker of breakerService.breakers.values()) breaker.shutdown();
    tokenCache.clear();
    warn.mockRestore();
    if (previousShared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
    else process.env.RESOLVE_CACHE_SHARED = previousShared;
    jest.clearAllMocks();
  });

  function mint(source, suffix = 'one') {
    const match = { id: 'fixture-' + suffix, title: 'Home vs Away', category: 'football', sources: [source] };
    const key = StreamResolveCache.resolveKey(source, match.id);
    return { key, run: () => cache.getOrCreate(key, () => mintVerifiedSources(source, match, null, key, { skipSpeedProbe: true })) };
  }

  test.each(['iptv', 'fixture'])('%s capacity reaches a two-second cooldown and recovers without a negative', async route => {
    const source = sourceFor(route);
    provider.proxyFetch = jest.fn().mockRejectedValueOnce(capacity()).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ channels: [{ ...channel, id: route === 'iptv' ? 'one' : 'main' }] })
    });
    const failed = jest.spyOn(cache, 'noteFailure');
    const query = mint(source);
    expect(await query.run()).toEqual([]);
    const deferred = cache.entries.get(query.key);
    expect(deferred).toMatchObject({ status: 'deferred', reason: 'capacity', streams: [] });
    expect(deferred.expiresAt - deferred.resolvedAt).toBe(2000);
    expect(await query.run()).toEqual([]);
    expect(provider.proxyFetch).toHaveBeenCalledTimes(1);
    expect(provider.fetchStreams.stats.failures).toBe(0);
    expect(provider.fetchStreams.stats.fallbacks).toBe(0);
    expect(provider.fetchStreams.opened).toBe(false);
    expect(failed).not.toHaveBeenCalled();
    deferred.expiresAt = Date.now() - 1;
    const recovered = await query.run();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].url).toBeTruthy();
    expect(cache.entries.get(query.key).status).toBe('ok');
    expect(provider.proxyFetch).toHaveBeenCalledTimes(2);
  });

  test.each([['iptv', timeout], ['fixture', timeout], ['iptv', wrappedCapacity], ['fixture', wrappedCapacity]])(
    '%s preserves typed temporary failures through the actual breaker', async (route, makeError) => {
      const error = makeError();
      provider.proxyFetch = jest.fn().mockRejectedValue(error);
      const query = mint(sourceFor(route));
      expect(await query.run()).toEqual([]);
      expect(cache.entries.get(query.key).status).toBe('deferred');
      expect(provider.fetchStreams.stats.failures).toBe(0);
      expect(provider.fetchStreams.stats.fallbacks).toBe(0);
    }
  );

  test.each([['capacity', capacity], ['timeout', timeout]])(
    'eight independent fixture %s failures neither open the breaker nor publish negative L2 entries', async (_kind, makeError) => {
    const adapter = sharedAdapter();
    cache.sharedResolver = adapter;
    provider.proxyFetch = jest.fn().mockRejectedValue(makeError());
    const failed = jest.spyOn(cache, 'noteFailure');
    const requests = Array.from({ length: 8 }, (_, index) => mint(sourceFor('fixture', String(index)), String(index)));
    expect(await Promise.all(requests.map(query => query.run()))).toEqual(Array.from({ length: 8 }, () => []));
    // The existing resolver retries timeouts twice; local capacity is never
    // retried immediately. Neither outcome is an upstream breaker failure.
    expect(provider.proxyFetch).toHaveBeenCalledTimes(_kind === 'capacity' ? 8 : 16);
    for (const query of requests) expect(cache.entries.get(query.key).status).toBe('deferred');
    expect(provider.fetchStreams.opened).toBe(false);
    expect(provider.fetchStreams.stats.failures).toBe(0);
    expect(provider.fetchStreams.stats.fallbacks).toBe(0);
    expect(failed).not.toHaveBeenCalled();
    expect(adapter.calls.filter(call => call.claim === '1')).toHaveLength(8);
    expect(adapter.calls.filter(call => call.method === 'DELETE')).toHaveLength(8);
    expect(adapter.calls.filter(call => call.method === 'POST')).toEqual([]);
    }
  );

  test.each(['iptv', 'fixture'])('%s hard guard refusal retains the ordinary negative cache', async route => {
    const refused = Object.assign(new Error('Guard refusal'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true, name: 'TimeoutError' });
    provider.proxyFetch = jest.fn().mockRejectedValue(refused);
    const query = mint(sourceFor(route));
    expect(await query.run()).toEqual([]);
    const entry = cache.entries.get(query.key);
    expect(entry.status).toBe('failed');
    expect(entry.expiresAt - entry.resolvedAt).toBe(30000);
    // The existing IPTV metadata helper turns hard refusals into [], while
    // fixture fetches reach the breaker's hard-error fallback. Neither case
    // is allowed to become a temporary deferral.
    expect(provider.fetchStreams.stats.failures).toBe(route === 'fixture' ? 1 : 0);
    expect(provider.fetchStreams.stats.fallbacks).toBe(route === 'fixture' ? 1 : 0);
  });

  test('real upstream failures can still open ScoreZone and retain its normal open fallback', async () => {
    provider.proxyFetch = jest.fn().mockRejectedValue(new Error('Malformed upstream response'));
    for (let index = 0; index < 5; index++) {
      await expect(provider.resolveStream(sourceFor('fixture', String(index)).id, 'football', 'Fixture')).resolves.toBeNull();
    }
    expect(provider.fetchStreams.opened).toBe(true);
    await expect(provider.resolveStream(sourceFor('fixture', 'after-open').id, 'football', 'Fixture')).resolves.toBeNull();
    expect(provider.proxyFetch).toHaveBeenCalledTimes(5);
  });

  test('unrelated breaker consumers retain the existing capacity fallback', async () => {
    const other = breakerService.wrap('Unchanged_provider', async () => { throw capacity(); });
    await expect(other.fire()).resolves.toBeNull();
    expect(other.stats.failures).toBe(1);
    expect(other.stats.fallbacks).toBe(1);
  });
});
