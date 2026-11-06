'use strict';

jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));

const LeafRecapProvider = require('../src/providers/LeafRecapProvider');
const providerOutbound = require('../src/services/ProviderOutbound');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');
const { accountCooldownRemaining, recordAccountRateLimit, resetAccountRateLimits } = require('../src/services/LeafRateLimitState');
const { inconclusiveStreamsReason } = require('../src/services/StreamResolutionOutcome');

const TOKEN = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
const OTHER_TOKEN = 'b1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
const NOW = Date.parse('2026-11-06T15:00:00Z');
const response = streams => ({ ok: true, status: 200, json: async () => ({ streams }) });
const media = (suffix = '') => response([{ name: 'Leaf 720p', title: '1280x720 ~3 Mbps', url: `https://recaps.highfly.to/vod/game/playlist.m3u8${suffix}` }]);

describe('LeafRecap account throttle and bounded metadata reuse', () => {
  const originalEnv = process.env;
  let warn;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of ['LEAF_API_URL', 'LEAF_API_ORIGIN', 'LEAF_FREE_USER_ID', 'LEAF_PREMIUM_TOKEN', 'LEAF_PREMIUM_PROFILE']) delete process.env[name];
    process.env.LEAF_INSTALL_CONFIG = TOKEN;
    process.env.LEAF_STREAM_CACHE_TTL_MS = '30000';
    providerOutbound.safeFetch.mockReset();
    resetAccountRateLimits();
    jest.useFakeTimers().setSystemTime(NOW);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    jest.useRealTimers();
    resetAccountRateLimits();
    process.env = originalEnv;
  });

  test('explicit premium token/profile config reaches the recap API without dropping its profile', async () => {
    delete process.env.LEAF_INSTALL_CONFIG;
    process.env.LEAF_PREMIUM_TOKEN = TOKEN;
    process.env.LEAF_PREMIUM_PROFILE = 'p123abc';
    process.env.LEAF_API_ORIGIN = 'https://premium-us2.highfly.dev';
    providerOutbound.safeFetch.mockResolvedValue(media());
    const provider = new LeafRecapProvider();

    expect(provider.configured).toBe(true);
    expect(provider.apiUrl).toBe(`https://premium-us2.highfly.dev/${TOKEN}/p123abc`);
    expect(await provider.resolveStream('recap:game')).toHaveLength(1);
    expect(providerOutbound.safeFetch.mock.calls[0][0]).toBe(`${provider.apiUrl}/stream/sport/recap%3Agame.json`);
  });

  test('HTTP 429 shares its Retry-After across recap IDs, instances, regions and profiles while catalog remains callable', async () => {
    const provider = new LeafRecapProvider();
    providerOutbound.safeFetch.mockResolvedValueOnce({ ok: false, status: 429, headers: { 'Retry-After': '45' } });
    expect(inconclusiveStreamsReason(await provider.resolveStream('game-a'))).toBe('unavailable');
    expect(accountCooldownRemaining(provider.apiUrl)).toBe(45000);

    process.env.LEAF_INSTALL_CONFIG = `https://premium-eu1.highfly.dev/${TOKEN}/p123abc/manifest.json`;
    const regional = new LeafRecapProvider();
    expect(inconclusiveStreamsReason(await regional.resolveStream('game-b'))).toBe('unavailable');
    expect(providerOutbound.safeFetch).toHaveBeenCalledTimes(1);

    providerOutbound.safeFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ metas: [] }) });
    expect(await regional.getMatches()).toEqual([]);
    expect(regional.lastCatalogOk).toBe(true);
    expect(providerOutbound.safeFetch.mock.calls[1][0]).toContain('/catalog/sport/sports_recaps.json');

    process.env.LEAF_INSTALL_CONFIG = OTHER_TOKEN;
    providerOutbound.safeFetch.mockResolvedValueOnce(media());
    expect(await regional.resolveStream('game-b')).toHaveLength(1);

    jest.setSystemTime(NOW + 45001);
    process.env.LEAF_INSTALL_CONFIG = TOKEN;
    providerOutbound.safeFetch.mockResolvedValueOnce(media());
    expect(await provider.resolveStream('game-a')).toHaveLength(1);
    expect(providerOutbound.safeFetch).toHaveBeenCalledTimes(4);
  });

  test('JSON throttle countdown is recorded and never cached as a permanently empty recap', async () => {
    const provider = new LeafRecapProvider();
    providerOutbound.safeFetch.mockResolvedValueOnce(response([{ name: 'Rate limit', title: 'Too many stream requests, wait 90 seconds' }]));
    expect(inconclusiveStreamsReason(await provider.resolveStream('game'))).toBe('unavailable');
    expect(accountCooldownRemaining(provider.apiUrl)).toBe(90000);
    expect(provider._streamCache.size).toBe(0);
    expect(inconclusiveStreamsReason(await provider.resolveStream('other-game'))).toBe('unavailable');
    expect(providerOutbound.safeFetch).toHaveBeenCalledTimes(1);
    jest.setSystemTime(NOW + 90001);
    providerOutbound.safeFetch.mockResolvedValueOnce(media());
    expect(await provider.resolveStream('game')).toHaveLength(1);
  });

  test('HTTP 429 can supply its retry countdown in the bounded JSON body', async () => {
    const provider = new LeafRecapProvider();
    providerOutbound.safeFetch.mockResolvedValueOnce({ ...response([{ title: 'Please wait 75 seconds' }]), ok: false, status: 429 });
    expect(inconclusiveStreamsReason(await provider.resolveStream('game'))).toBe('unavailable');
    expect(accountCooldownRemaining(provider.apiUrl)).toBe(75000);
  });

  test('fresh cached metadata is reusable while an account quota is active', async () => {
    const provider = new LeafRecapProvider();
    providerOutbound.safeFetch.mockResolvedValueOnce(media());
    const streams = await provider.resolveStream('game');
    recordAccountRateLimit(provider.apiUrl, 45000);
    expect(await provider.resolveStream('recap:game')).toBe(streams);
    expect(providerOutbound.safeFetch).toHaveBeenCalledTimes(1);
  });

  test.each(['quota', 'exception'])('repeated %s fallback never renews the original stale deadline', async failure => {
    const provider = new LeafRecapProvider();
    providerOutbound.safeFetch.mockResolvedValueOnce(media());
    const streams = await provider.resolveStream('game');
    const entry = [...provider._streamCache.values()][0];
    expect(entry.expiresAt).toBe(NOW + 30000);
    expect(entry.staleUntil).toBe(NOW + 90000);
    jest.setSystemTime(NOW + 30001);
    if (failure === 'quota') {
      providerOutbound.safeFetch.mockResolvedValueOnce({ ok: false, status: 429, headers: { 'retry-after': '120' } });
    } else {
      providerOutbound.safeFetch.mockRejectedValue(new Error('fixture transport failure'));
    }
    expect(await provider.resolveStream('game')).toBe(streams);
    jest.setSystemTime(NOW + 89000);
    expect(await provider.resolveStream('game')).toBe(streams);
    expect([...provider._streamCache.values()][0]).toBe(entry);
    jest.setSystemTime(NOW + 90001);
    expect(await provider.resolveStream('game')).toHaveLength(0);
    expect(provider._streamCache.size).toBe(0);
    expect(entry.expiresAt).toBe(NOW + 30000);
  });

  test.each(['jwt', 'query'])('known %s media expiry limits fresh reuse and stale fallback without changing issued player URLs', async type => {
    const expirySeconds = Math.floor(NOW / 1000) + 20;
    const jwt = `header.${Buffer.from(JSON.stringify({ exp: expirySeconds })).toString('base64url')}.signature`;
    const suffix = type === 'jwt' ? `?ft=${jwt}` : `?expires=${expirySeconds}`;
    const provider = new LeafRecapProvider();
    providerOutbound.safeFetch.mockResolvedValueOnce(media(suffix));
    const streams = await provider.resolveStream('game');
    const playerUrl = streams[0].url;
    const entry = [...provider._streamCache.values()][0];
    expect(entry.expiresAt).toBe(NOW + 20000);
    expect(entry.staleUntil).toBe(NOW + 20000);
    recordAccountRateLimit(provider.apiUrl, 60000);
    jest.setSystemTime(NOW + 20001);
    expect(inconclusiveStreamsReason(await provider.resolveStream('game'))).toBe('unavailable');
    expect(streams[0].url).toBe(playerUrl);
    expect(providerOutbound.safeFetch).toHaveBeenCalledTimes(1);
  });

  test('known expired upstream media is not issued as a new tile', async () => {
    providerOutbound.safeFetch.mockResolvedValueOnce(media(`?exp=${Math.floor(NOW / 1000) - 1}`));
    const provider = new LeafRecapProvider();
    expect(await provider.resolveStream('game')).toEqual([]);
    expect(provider._streamCache.size).toBe(0);
  });

  test('ID aliases share in-flight work while a different account gets its own metadata', async () => {
    let finish;
    providerOutbound.safeFetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const provider = new LeafRecapProvider();
    const first = provider.resolveStream('leaf_recap_game');
    const alias = provider.resolveStream('recap:game');
    expect(providerOutbound.safeFetch).toHaveBeenCalledTimes(1);
    process.env.LEAF_INSTALL_CONFIG = OTHER_TOKEN;
    providerOutbound.safeFetch.mockResolvedValueOnce(media('?variant=second-account'));
    const secondAccount = await provider.resolveStream('game');
    finish(media());
    const firstAccount = await first;
    expect(await alias).toBe(firstAccount);
    expect(secondAccount[0].url).not.toBe(firstAccount[0].url);
    process.env.LEAF_INSTALL_CONFIG = TOKEN;
    expect(await provider.resolveStream('game')).toBe(firstAccount);
    expect(providerOutbound.safeFetch).toHaveBeenCalledTimes(2);
  });

  test('a pending throttle response remains scoped to the account that requested it', async () => {
    let finish;
    providerOutbound.safeFetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const provider = new LeafRecapProvider();
    const initialBase = provider.apiUrl;
    const pending = provider.resolveStream('game');
    process.env.LEAF_INSTALL_CONFIG = OTHER_TOKEN;
    finish({ ok: false, status: 429, headers: { 'retry-after': '45' } });
    expect(inconclusiveStreamsReason(await pending)).toBe('unavailable');
    expect(accountCooldownRemaining(initialBase)).toBe(45000);
    expect(accountCooldownRemaining(provider.apiUrl)).toBe(0);
  });

  test('malformed configuration returns safely without an outbound request', async () => {
    delete process.env.LEAF_INSTALL_CONFIG;
    process.env.LEAF_PREMIUM_TOKEN = 'not-a-premium-uuid';
    const provider = new LeafRecapProvider();
    expect(await provider.resolveStream('game')).toEqual([]);
    expect(providerOutbound.safeFetch).not.toHaveBeenCalled();
  });

  test.each([
    ['capacity', { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }],
    ['timeout', { name: 'TimeoutError' }],
    ['cancelled', { name: 'AbortError' }]
  ])('typed %s preserves its reason through the production breaker and retries after two seconds', async (reason, fields) => {
    const breakers = new CircuitBreakerService();
    const provider = new LeafRecapProvider({ circuitBreaker: breakers });
    providerOutbound.safeFetch.mockRejectedValueOnce(Object.assign(new Error('fixture local outcome'), fields));
    expect(inconclusiveStreamsReason(await provider.resolveStream('game'))).toBe(reason);
    expect(inconclusiveStreamsReason(await provider.resolveStream('game'))).toBe(reason);
    expect(providerOutbound.safeFetch).toHaveBeenCalledTimes(1);
    expect(breakers.getStatus().LeafRecap_fetchStreams.failures).toBe(0);
    jest.setSystemTime(NOW + 2001);
    providerOutbound.safeFetch.mockResolvedValueOnce(media());
    expect(await provider.resolveStream('game')).toHaveLength(1);
    for (const breaker of breakers.breakers.values()) breaker.shutdown();
  });

  test('a hard cause reaches the public resolver without a local retry outcome or breaker fallback', async () => {
    const breakers = new CircuitBreakerService();
    const provider = new LeafRecapProvider({ circuitBreaker: breakers });
    const cause = Object.assign(new Error('fixture denied'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true });
    const wrapper = Object.assign(new Error('fixture wrapper', { cause }), { code: 'ERR_OUTBOUND_CAPACITY' });
    expect(provider.fetchStreams.options.errorFilter(wrapper)).toBe(true);
    providerOutbound.safeFetch.mockRejectedValueOnce(wrapper);
    const result = await provider.resolveStream('game');
    expect(inconclusiveStreamsReason(result)).toBe(null);
    expect(breakers.getStatus().LeafRecap_fetchStreams.failures).toBe(0);
    expect(breakers.getStatus().LeafRecap_fetchStreams.fallbacks).toBe(0);
    for (const breaker of breakers.breakers.values()) breaker.shutdown();
  });

  test.each(['guard', 401, 403, 404, 410])('definitive %s refusal clears stale VOD metadata without fallback or a deferred result', async refusal => {
    const breakers = new CircuitBreakerService();
    const provider = new LeafRecapProvider({ circuitBreaker: breakers });
    providerOutbound.safeFetch.mockResolvedValueOnce(media());
    const streams = await provider.resolveStream('game');
    expect(streams).toHaveLength(1);
    jest.setSystemTime(NOW + 30001);
    if (refusal === 'guard') {
      const cause = Object.assign(new Error('fixture denied'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true });
      providerOutbound.safeFetch.mockRejectedValueOnce(Object.assign(new Error('fixture capacity wrapper', { cause }), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }));
    } else {
      providerOutbound.safeFetch.mockResolvedValueOnce({ ok: false, status: refusal });
    }
    const result = await provider.resolveStream('game');
    expect(result).toEqual([]);
    expect(inconclusiveStreamsReason(result)).toBe(null);
    expect(provider._streamCache.size).toBe(0);
    expect(provider._retryControls.size).toBe(0);
    expect(breakers.getStatus().LeafRecap_fetchStreams.fallbacks).toBe(0);
    for (const breaker of breakers.breakers.values()) breaker.shutdown();
  });

  test('retryable HTTP 503 keeps only the original bounded stale fallback', async () => {
    const breakers = new CircuitBreakerService();
    const provider = new LeafRecapProvider({ circuitBreaker: breakers });
    providerOutbound.safeFetch.mockResolvedValueOnce(media());
    const streams = await provider.resolveStream('game');
    const entry = [...provider._streamCache.values()][0];
    jest.setSystemTime(NOW + 30001);
    providerOutbound.safeFetch.mockResolvedValue({ ok: false, status: 503 });
    expect(await provider.resolveStream('game')).toBe(streams);
    expect([...provider._streamCache.values()][0]).toBe(entry);
    expect(breakers.getStatus().LeafRecap_fetchStreams.failures).toBe(1);
    jest.setSystemTime(NOW + 90001);
    expect(await provider.resolveStream('game')).toHaveLength(0);
    expect(provider._streamCache.size).toBe(0);
    for (const breaker of breakers.breakers.values()) breaker.shutdown();
  });

  test('in-flight and successful cache cardinalities stay bounded', async () => {
    const provider = new LeafRecapProvider();
    const finishers = [];
    providerOutbound.safeFetch.mockImplementation(() => new Promise(resolve => { finishers.push(resolve); }));
    const pending = Array.from({ length: 32 }, (_, index) => provider.resolveStream(`game-${index}`));
    expect(inconclusiveStreamsReason(await provider.resolveStream('overflow'))).toBe('capacity');
    expect(providerOutbound.safeFetch).toHaveBeenCalledTimes(32);
    for (const finish of finishers) finish(media());
    await Promise.all(pending);
    expect(provider._inFlight.size).toBe(0);
    providerOutbound.safeFetch.mockResolvedValue(media());
    for (let index = 32; index < 205; index++) await provider.resolveStream(`game-${index}`);
    expect(provider._streamCache.size).toBe(200);
  });
});
