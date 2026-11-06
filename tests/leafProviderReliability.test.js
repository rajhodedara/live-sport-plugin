'use strict';

// Provider control flow and real breaker policy with fake metadata/probe I/O.
// No native client, worker, socket, upstream account or media bytes are used.
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
jest.mock('../src/services/LeafStreamProbe', () => ({ checkLeafStream: jest.fn() }));

const LeafProvider = require('../src/providers/LeafProvider');
const outbound = require('../src/services/ProviderOutbound');
const probe = require('../src/services/LeafStreamProbe');
const leafMint = require('../src/services/LeafMint');
const leafState = require('../src/services/LeafState');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');
const { inconclusiveStreamsReason } = require('../src/services/StreamResolutionOutcome');
const { recordAccountRateLimit, accountCooldownRemaining, resetAccountRateLimits } = require('../src/services/LeafRateLimitState');

const TOKEN = '00000000-0000-4000-8000-000000000001';
const OTHER_TOKEN = '00000000-0000-4000-8000-000000000002';
const NOW = Date.parse('2026-11-06T18:00:00Z');
const originalEnv = process.env;
const directUrl = (slug = 'fixture', token = 'fixture') => `https://papacito.cfd/m3u/${slug}/live.m3u8?ft=${token}`;
const metadata = (urls = [directUrl()], extra = {}) => ({
  ok: true, status: 200, bodyTruncated: false,
  json: async () => ({ streams: urls.map(url => ({ name: 'Leaf 720p', title: '1280x720 ~3 Mbps', url })) }),
  ...extra,
});
const catalog = (body, extra = {}) => ({ ok: true, status: 200, bodyTruncated: false, json: async () => body, ...extra });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const stateOf = stream => leafState.verify(stream.url.split('/api/leaf/m3u8/')[1].replace('/index.m3u8', ''));
const jwt = exp => [Buffer.from('{"alg":"none"}').toString('base64url'), Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'unverified'].join('.');
async function until(predicate) {
  for (let count = 0; count < 40 && !predicate(); count++) await Promise.resolve();
  expect(predicate()).toBe(true);
}

let now, breakers;
beforeEach(() => {
  process.env = { ...originalEnv };
  for (const name of Object.keys(process.env)) if (name.startsWith('LEAF_')) delete process.env[name];
  Object.assign(process.env, { LEAF_INSTALL_CONFIG: TOKEN, LEAF_STREAM_CACHE_TTL_MS: '30000', APP_SECRET: 'fixture-private-provider-state-key' });
  now = NOW;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  outbound.safeFetch.mockReset();
  probe.checkLeafStream.mockReset().mockResolvedValue({ status: 'ok' });
  leafMint.invalidate();
  resetAccountRateLimits();
  breakers = [];
});

afterEach(() => {
  for (const service of breakers) for (const breaker of service.breakers.values()) breaker.shutdown();
  leafMint.invalidate();
  resetAccountRateLimits();
  jest.restoreAllMocks();
  process.env = originalEnv;
});

function withBreaker() {
  const service = new CircuitBreakerService();
  breakers.push(service);
  return { provider: new LeafProvider({ circuitBreaker: service }), service };
}

test.each([
  ['capacity', () => Object.assign(new Error('fixture local queue'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true })],
  ['timeout', () => new DOMException('fixture deadline', 'TimeoutError')],
  ['cancelled', () => new DOMException('fixture cancelled', 'AbortError')],
])('real breaker preserves typed %s without charging upstream failures', async (reason, makeError) => {
  const { provider, service } = withBreaker();
  outbound.safeFetch.mockRejectedValueOnce(makeError()).mockResolvedValueOnce(metadata());
  const result = await provider.resolveStream('fixture');
  expect(result).toEqual([]);
  expect(inconclusiveStreamsReason(result)).toBe(reason);
  expect(service.getStatus().Leaf_fetchStreams).toMatchObject({ failures: 0, fallbacks: 0, state: 'closed' });
  expect(provider._streamCache.size).toBe(0);
  expect(probe.checkLeafStream).not.toHaveBeenCalled();
  now += 2001;
  expect(await provider.resolveStream('fixture')).toHaveLength(1);
});

test('hard guard hidden under a capacity wrapper stays unmarked and propagates past the real breaker fallback', async () => {
  const { provider, service } = withBreaker();
  outbound.safeFetch.mockResolvedValueOnce(metadata());
  expect(await provider.resolveStream('fixture')).toHaveLength(1);
  now += 30001;
  const cause = Object.assign(new Error('fixture guarded address'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true });
  const wrapper = Object.assign(new Error('fixture capacity wrapper', { cause }), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true });
  outbound.safeFetch.mockRejectedValueOnce(wrapper);
  const seed = jest.spyOn(leafMint, 'seed');
  const result = await provider.resolveStream('fixture');
  expect(result).toEqual([]);
  expect(inconclusiveStreamsReason(result)).toBeNull();
  expect(service.getStatus().Leaf_fetchStreams).toMatchObject({ failures: 0, fallbacks: 0 });
  expect(seed).not.toHaveBeenCalled();
});

test('actual upstream failures remain visible to the real circuit breaker', async () => {
  const { provider, service } = withBreaker();
  outbound.safeFetch.mockResolvedValueOnce({ ok: false, status: 502 });
  expect(await provider.resolveStream('fixture')).toEqual([]);
  expect(service.getStatus().Leaf_fetchStreams.failures).toBe(1);
});

test('catalog local contention is unhealthy without charging a real upstream breaker failure', async () => {
  const { provider, service } = withBreaker();
  outbound.safeFetch.mockRejectedValueOnce(Object.assign(new Error('fixture capacity'), { code: 'ERR_NATIVE_POOL_BUSY', isFatal: true }));
  expect(await provider.getMatches()).toEqual([]);
  expect(provider.lastCatalogOk).toBe(false);
  expect(service.getStatus().Leaf_fetchMatches).toMatchObject({ failures: 0, fallbacks: 0 });
});

test.each([
  ['null body', catalog(null)],
  ['missing metas', catalog({ private: 'fixture malformed body' })],
  ['object metas', catalog({ metas: {} })],
  ['array body', catalog([])],
  ['truncated body', catalog({ metas: [] }, { bodyTruncated: true })],
  ['invalid JSON', catalog(null, { json: async () => { throw new SyntaxError('fixture invalid metadata'); } })],
])('invalid catalog %s cannot become a healthy empty schedule', async (_label, response) => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(response);
  expect(await provider.getMatches()).toEqual([]);
  expect(provider.lastCatalogOk).toBe(false);
});

test('a legitimate empty catalog remains healthy and bounded even during a stream quota cooldown', async () => {
  const provider = new LeafProvider();
  recordAccountRateLimit(provider.apiUrl, 45000);
  outbound.safeFetch.mockResolvedValueOnce(catalog({ metas: [] }));
  expect(await provider.getMatches()).toEqual([]);
  expect(provider.lastCatalogOk).toBe(true);
  expect(outbound.safeFetch).toHaveBeenCalledWith(`${provider.apiUrl}/catalog/sport/sports_live.json`,
    expect.objectContaining({ attempts: 1, timeoutMs: 8000, maxBodyBytes: 256 * 1024 }));
});

test.each([
  ['HTTP Retry-After', metadata([], { ok: false, status: 429, headers: { 'Retry-After': '75' } }), 75000],
  ['bounded JSON countdown', metadata([], { json: async () => ({ streams: [{ name: 'Rate limit', title: 'Please wait 90 seconds' }] }) }), 90000],
])('%s quota applies across IDs, instances, regions, profiles and the mint endpoint', async (_label, response, delay) => {
  const provider = new LeafProvider();
  const base = provider.apiUrl;
  outbound.safeFetch.mockResolvedValueOnce(response);
  expect(inconclusiveStreamsReason(await provider.resolveStream('match-one'))).toBe('unavailable');
  expect(accountCooldownRemaining(base)).toBe(delay);
  process.env.LEAF_INSTALL_CONFIG = `https://premium-eu1.highfly.dev/${TOKEN}/pabc123/manifest.json`;
  const regional = new LeafProvider();
  expect(inconclusiveStreamsReason(await regional.resolveStream('match-two'))).toBe('unavailable');
  await expect(leafMint.mintUrl('match-three', 'fixture', { force: true })).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429, retryAfterMs: delay,
  });
  expect(outbound.safeFetch).toHaveBeenCalledTimes(1);
  process.env.LEAF_INSTALL_CONFIG = OTHER_TOKEN;
  outbound.safeFetch.mockResolvedValueOnce(metadata());
  expect(await regional.resolveStream('match-two')).toHaveLength(1);
  expect(outbound.safeFetch).toHaveBeenCalledTimes(2);
});

test('a pending 429 is recorded against the immutable account that requested it', async () => {
  const pendingMetadata = deferred();
  outbound.safeFetch.mockReturnValueOnce(pendingMetadata.promise);
  const provider = new LeafProvider();
  const base = provider.apiUrl;
  const pending = provider.resolveStream('fixture');
  await until(() => outbound.safeFetch.mock.calls.length === 1);
  process.env.LEAF_INSTALL_CONFIG = OTHER_TOKEN;
  pendingMetadata.resolve(metadata([], { ok: false, status: 429, headers: { 'retry-after': '45' } }));
  expect(inconclusiveStreamsReason(await pending)).toBe('unavailable');
  expect(accountCooldownRemaining(base)).toBe(45000);
  expect(accountCooldownRemaining(provider.apiUrl)).toBe(0);
});

test('valid state and cached mint remain reusable during quota without renewing metadata or credential lifetime', async () => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(metadata());
  const streams = await provider.resolveStream('fixture');
  const entry = [...provider._streamCache.values()][0];
  const originalAt = entry.at;
  recordAccountRateLimit(provider.apiUrl, 120000);
  now += 30001;
  expect(await provider.resolveStream('fixture')).toEqual(streams);
  now += 30000;
  expect(await provider.resolveStream('fixture', null, null, {}, { forceRefresh: true })).toEqual(streams);
  expect([...provider._streamCache.values()][0]).toBe(entry);
  expect(entry.at).toBe(originalAt);
  expect(outbound.safeFetch).toHaveBeenCalledTimes(1);
  leafMint.invalidate('fixture', 'fixture', { base: provider.apiUrl });
  const expired = await provider.resolveStream('fixture');
  expect(expired).toEqual([]);
  expect(inconclusiveStreamsReason(expired)).toBe('unavailable');
  expect(outbound.safeFetch).toHaveBeenCalledTimes(1);
});

test('known mint expiry prevents a fresh metadata tile from reviving an expired credential', async () => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(metadata([directUrl('fixture', jwt(NOW / 1000 + 5))]));
  expect(await provider.resolveStream('fixture')).toHaveLength(1);
  recordAccountRateLimit(provider.apiUrl, 60000);
  now += 5000;
  const result = await provider.resolveStream('fixture');
  expect(result).toEqual([]);
  expect(inconclusiveStreamsReason(result)).toBe('unavailable');
  expect(leafMint.peekCachedUrl('fixture', 'fixture', { base: provider.apiUrl })).toBeUndefined();
  expect(outbound.safeFetch).toHaveBeenCalledTimes(1);
});

test('state signed with a previous application secret cannot survive in cached metadata', async () => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(metadata());
  expect(await provider.resolveStream('fixture')).toHaveLength(1);
  recordAccountRateLimit(provider.apiUrl, 60000);
  process.env.APP_SECRET = 'fixture-rotated-provider-state-key';
  const result = await provider.resolveStream('fixture');
  expect(result).toEqual([]);
  expect(inconclusiveStreamsReason(result)).toBe('unavailable');
  expect(outbound.safeFetch).toHaveBeenCalledTimes(1);
});

test('an already aborted fifth-argument signal prevents cached return and I/O', async () => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(metadata());
  expect(await provider.resolveStream('fixture')).toHaveLength(1);
  const controller = new AbortController();
  controller.abort();
  const result = await provider.resolveStream('fixture', null, null, {}, { signal: controller.signal });
  expect(result).toEqual([]);
  expect(inconclusiveStreamsReason(result)).toBe('cancelled');
  expect(outbound.safeFetch).toHaveBeenCalledTimes(1);
});

test('active caller cancellation reaches metadata I/O and remains a typed local outcome', async () => {
  outbound.safeFetch.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const provider = new LeafProvider();
  const controller = new AbortController();
  const pending = provider.resolveStream('fixture', null, null, {}, { signal: controller.signal });
  await until(() => outbound.safeFetch.mock.calls.length === 1);
  controller.abort();
  expect(inconclusiveStreamsReason(await pending)).toBe('cancelled');
  expect(provider._inFlight.size).toBe(0);
});

test('cancelling the first caller cannot cancel an independent follower for the same target', async () => {
  const requests = [];
  outbound.safeFetch.mockImplementation((_url, options) => new Promise((resolve, reject) => {
    requests.push(resolve);
    options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const provider = new LeafProvider();
  const controller = new AbortController();
  let firstSettled = false;
  const first = provider.resolveStream('fixture', null, null, {}, { signal: controller.signal });
  first.then(() => { firstSettled = true; });
  await until(() => requests.length > 0);
  const follower = provider.resolveStream('fixture');
  await Promise.resolve();
  controller.abort();
  try {
    await until(() => firstSettled);
    expect(inconclusiveStreamsReason(await first)).toBe('cancelled');
  } finally {
    for (const finish of requests) finish(metadata());
  }
  expect(await follower).toHaveLength(1);
});

test('a follower can cancel promptly without ending the owner metadata request', async () => {
  const requests = [];
  outbound.safeFetch.mockImplementation((_url, options) => new Promise((resolve, reject) => {
    requests.push(resolve);
    options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const provider = new LeafProvider();
  let ownerSettled = false, followerSettled = false;
  const owner = provider.resolveStream('fixture');
  owner.then(() => { ownerSettled = true; });
  await until(() => requests.length > 0);
  const controller = new AbortController();
  const follower = provider.resolveStream('fixture', null, null, {}, { signal: controller.signal });
  follower.then(() => { followerSettled = true; });
  controller.abort();
  try {
    await until(() => followerSettled);
    expect(inconclusiveStreamsReason(await follower)).toBe('cancelled');
    expect(ownerSettled).toBe(false);
  } finally {
    for (const finish of requests) finish(metadata());
  }
  expect(await owner).toHaveLength(1);
});

test.each([
  ['401', () => metadata([], { ok: false, status: 401 })],
  ['403', () => metadata([], { ok: false, status: 403 })],
  ['guard refusal', () => Object.assign(new Error('fixture guard'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true })],
])('a forced %s clears old metadata before a later timeout can revive it', async (_label, denial) => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(metadata());
  expect(await provider.resolveStream('fixture')).toHaveLength(1);
  const failure = denial();
  if (failure instanceof Error) outbound.safeFetch.mockRejectedValueOnce(failure);
  else outbound.safeFetch.mockResolvedValueOnce(failure);
  expect(await provider.resolveStream('fixture', null, null, {}, { forceRefresh: true })).toEqual([]);
  expect(provider._streamCache.size).toBe(0);
  outbound.safeFetch.mockRejectedValueOnce(new DOMException('fixture later timeout', 'TimeoutError'));
  const retry = await provider.resolveStream('fixture');
  expect(retry).toEqual([]);
  expect(inconclusiveStreamsReason(retry)).toBe('timeout');
  expect(outbound.safeFetch).toHaveBeenCalledTimes(3);
});

test('normal resolution after a forced 403 fetches a new feed instead of reviving the old tile', async () => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(metadata([directUrl('old')]))
    .mockResolvedValueOnce(metadata([], { ok: false, status: 403 }))
    .mockResolvedValueOnce(metadata([directUrl('fresh')]));
  expect(stateOf((await provider.resolveStream('fixture'))[0]).s).toBe('old');
  expect(await provider.resolveStream('fixture', null, null, {}, { forceRefresh: true })).toEqual([]);
  expect(stateOf((await provider.resolveStream('fixture'))[0]).s).toBe('fresh');
  expect(outbound.safeFetch).toHaveBeenCalledTimes(3);
});

test('probe acceptance is required before seeding the mint and selected origin is forwarded', async () => {
  process.env.LEAF_API_ORIGIN = 'https://premium-us2.highfly.dev';
  const provider = new LeafProvider();
  const validation = deferred();
  probe.checkLeafStream.mockReturnValueOnce(validation.promise);
  outbound.safeFetch.mockResolvedValueOnce(metadata());
  const seed = jest.spyOn(leafMint, 'seed');
  const pending = provider.resolveStream('fixture');
  await until(() => probe.checkLeafStream.mock.calls.length === 1);
  expect(seed).not.toHaveBeenCalled();
  expect(probe.checkLeafStream).toHaveBeenCalledWith(directUrl(), expect.objectContaining({
    origin: 'https://premium-us2.highfly.dev', referer: 'https://premium-us2.highfly.dev/',
  }));
  validation.resolve({ status: 'ok' });
  const streams = await pending;
  expect(streams).toHaveLength(1);
  expect(streams[0].behaviorHints.proxyHeaders.request).toMatchObject({
    Referer: 'https://premium-us2.highfly.dev/', Origin: 'https://premium-us2.highfly.dev',
  });
  expect(seed).toHaveBeenCalledWith('fixture', 'fixture', directUrl(), { base: provider.apiUrl });
});

test('all inconclusive candidate checks return a marked empty without seeding or positive cache', async () => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(metadata([directUrl('one'), directUrl('two')]));
  probe.checkLeafStream.mockResolvedValue({ status: 'inconclusive', reason: 'capacity' });
  const seed = jest.spyOn(leafMint, 'seed');
  const result = await provider.resolveStream('fixture');
  expect(result).toEqual([]);
  expect(inconclusiveStreamsReason(result)).toBe('capacity');
  expect(seed).not.toHaveBeenCalled();
  expect(provider._streamCache.size).toBe(0);
});

test('an accepted candidate remains an unmarked positive cache hit when another probe has local capacity pressure', async () => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(metadata([directUrl('accepted'), directUrl('busy')]));
  probe.checkLeafStream.mockResolvedValueOnce({ status: 'ok' }).mockResolvedValueOnce({ status: 'inconclusive', reason: 'capacity' });
  const seed = jest.spyOn(leafMint, 'seed');
  const result = await provider.resolveStream('fixture');
  expect(result).toHaveLength(1);
  expect(stateOf(result[0]).s).toBe('accepted');
  expect(inconclusiveStreamsReason(result)).toBeNull();
  expect(seed).toHaveBeenCalledTimes(1);
  expect(leafMint.peekCachedUrl('fixture', 'busy', { base: provider.apiUrl })).toBeUndefined();
  expect(await provider.resolveStream('fixture')).toEqual(result);
  expect(provider._streamCache.size).toBe(1);
  expect(outbound.safeFetch).toHaveBeenCalledTimes(1);
  expect(probe.checkLeafStream).toHaveBeenCalledTimes(2);
});

test('a rejected probe never seeds a credential and a metadata response samples at most eight candidates', async () => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(metadata(Array.from({ length: 20 }, (_, index) => directUrl(`feed-${index}`))));
  probe.checkLeafStream.mockResolvedValue({ status: 'rejected' });
  const seed = jest.spyOn(leafMint, 'seed');
  expect(await provider.resolveStream('fixture')).toEqual([]);
  expect(probe.checkLeafStream).toHaveBeenCalledTimes(8);
  expect(seed).not.toHaveBeenCalled();
});

test('one provider isolates positive tiles, mint seeds and probe origin across selected account configs', async () => {
  const provider = new LeafProvider();
  const firstBase = provider.apiUrl;
  outbound.safeFetch.mockResolvedValueOnce(metadata([directUrl('first')]));
  const first = await provider.resolveStream('fixture');
  process.env.LEAF_INSTALL_CONFIG = OTHER_TOKEN;
  process.env.LEAF_API_ORIGIN = 'https://premium-eu1.highfly.dev';
  const secondBase = provider.apiUrl;
  outbound.safeFetch.mockResolvedValueOnce(metadata([directUrl('second')]));
  const second = await provider.resolveStream('fixture');
  expect(stateOf(first[0]).s).toBe('first');
  expect(stateOf(second[0]).s).toBe('second');
  expect(leafMint.peekCachedUrl('fixture', 'first', { base: firstBase })).toBe(directUrl('first'));
  expect(leafMint.peekCachedUrl('fixture', 'first', { base: secondBase })).toBeUndefined();
  expect(probe.checkLeafStream.mock.calls[1][1].origin).toBe('https://premium-eu1.highfly.dev');
  process.env.LEAF_INSTALL_CONFIG = TOKEN;
  delete process.env.LEAF_API_ORIGIN;
  expect(await provider.resolveStream('fixture')).toEqual(first);
  expect(outbound.safeFetch).toHaveBeenCalledTimes(2);
});

test('malformed premium configuration isolates the provider without an outbound call', async () => {
  process.env.LEAF_PREMIUM_TOKEN = 'invalid-private-fixture-token';
  const provider = new LeafProvider();
  expect(provider.configured).toBe(false);
  expect(await provider.getMatches()).toEqual([]);
  expect(await provider.resolveStream('fixture')).toEqual([]);
  expect(outbound.safeFetch).not.toHaveBeenCalled();
  expect(JSON.stringify(console.warn.mock.calls)).not.toContain('invalid-private-fixture-token');
});

test('forceRefresh fences a superseded pending resolution without deleting its replacement flight', async () => {
  const old = deferred(), fresh = deferred();
  outbound.safeFetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const provider = new LeafProvider();
  const seed = jest.spyOn(leafMint, 'seed');
  const first = provider.resolveStream('fixture');
  await until(() => outbound.safeFetch.mock.calls.length === 1);
  const replacement = provider.resolveStream('fixture', null, null, {}, { forceRefresh: true });
  await until(() => outbound.safeFetch.mock.calls.length === 2);
  old.resolve(metadata([directUrl('old')]));
  expect(await first).toEqual([]);
  expect(seed).not.toHaveBeenCalled();
  expect(provider._inFlight.size).toBe(1);
  fresh.resolve(metadata([directUrl('fresh')]));
  const result = await replacement;
  expect(stateOf(result[0]).s).toBe('fresh');
  expect(await provider.resolveStream('fixture')).toEqual(result);
  expect(outbound.safeFetch).toHaveBeenCalledTimes(2);
});

test.each(['forceRefresh', 'skipCache'])('legacy source %s hint refreshes metadata without requiring fifth-argument flags', async flag => {
  const provider = new LeafProvider();
  outbound.safeFetch.mockResolvedValueOnce(metadata([directUrl('old')])).mockResolvedValueOnce(metadata([directUrl('fresh')]));
  expect(stateOf((await provider.resolveStream('fixture'))[0]).s).toBe('old');
  expect(stateOf((await provider.resolveStream('fixture', null, null, { [flag]: true }))[0]).s).toBe('fresh');
  const cached = await provider.resolveStream('fixture');
  expect(stateOf(cached[0]).s).toBe(flag === 'skipCache' ? 'old' : 'fresh');
  expect(outbound.safeFetch).toHaveBeenCalledTimes(2);
});

test('clearCacheForMatch uses exact associations and fences pending completion after invalidation', async () => {
  const old = deferred(), fresh = deferred();
  outbound.safeFetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const provider = new LeafProvider();
  const first = provider.resolveStream('upstream-target', null, null, {}, { matchId: 'catalog-match' });
  await until(() => outbound.safeFetch.mock.calls.length === 1);
  provider.clearCacheForMatch('catalog');
  expect(provider._inFlight.size).toBe(1);
  provider.clearCacheForMatch('catalog-match');
  const replacement = provider.resolveStream('upstream-target', null, null, {}, { matchId: 'catalog-match' });
  await until(() => outbound.safeFetch.mock.calls.length === 2);
  old.resolve(metadata([directUrl('old')]));
  expect(await first).toEqual([]);
  expect(provider._inFlight.size).toBe(1);
  fresh.resolve(metadata([directUrl('fresh')]));
  const result = await replacement;
  expect(stateOf(result[0]).s).toBe('fresh');
  provider.clearCacheForMatch('catalog');
  expect(await provider.resolveStream('upstream-target', null, null, {}, { matchId: 'catalog-match' })).toEqual(result);
  provider.clearCacheForMatch('catalog-match');
  outbound.safeFetch.mockResolvedValueOnce(metadata([directUrl('newest')]));
  expect(stateOf((await provider.resolveStream('upstream-target'))[0]).s).toBe('newest');
  expect(outbound.safeFetch).toHaveBeenCalledTimes(3);
});

test.each(['ordinary', 'cancellable'])('%s callers cannot exceed 32 concurrent metadata flights and capacity produces a marked empty', async kind => {
  const finishers = [];
  outbound.safeFetch.mockImplementation(() => new Promise(resolve => { finishers.push(resolve); }));
  const provider = new LeafProvider();
  const options = () => kind === 'cancellable' ? { signal: new AbortController().signal } : {};
  const pending = Array.from({ length: 32 }, (_, index) => provider.resolveStream(`fixture-${index}`, null, null, {}, options()));
  await until(() => finishers.length === 32);
  let overflow;
  try {
    overflow = await provider.resolveStream('overflow', null, null, {}, options());
    expect(overflow).toEqual([]);
    expect(inconclusiveStreamsReason(overflow)).toBe('capacity');
    expect(outbound.safeFetch).toHaveBeenCalledTimes(32);
  } finally {
    for (const finish of finishers) finish(metadata());
  }
  await Promise.all(pending);
  expect(provider._inFlight.size).toBe(0);
});

test('successful metadata storage remains bounded at 200 entries and evicted IDs fetch again', async () => {
  outbound.safeFetch.mockResolvedValue(metadata());
  const provider = new LeafProvider();
  for (let index = 0; index < 205; index++) expect(await provider.resolveStream(`fixture-${index}`)).toHaveLength(1);
  expect(provider._streamCache.size).toBe(200);
  expect(await provider.resolveStream('fixture-0')).toHaveLength(1);
  expect(outbound.safeFetch).toHaveBeenCalledTimes(206);
});
