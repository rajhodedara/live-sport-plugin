'use strict';

// Real config/mint state transitions with fake outbound I/O only. No provider,
// socket, worker, native transport or upstream account is exercised here.
const mockSafeFetch = jest.fn();
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: mockSafeFetch }));

const originalEnv = { ...process.env };
const initialTime = 1800000000000;
const signedUrl = 'https://papacito.cfd/m3u/fixture/live.m3u8?ft=fixture%2Fopaque&x=raw%2Bbytes';
const freshUrl = 'https://papacito.cfd/m3u/fixture/live.m3u8?ft=fresh';
const response = (urls = [signedUrl], extra = {}) => ({
  ok: true, status: 200, bodyTruncated: false,
  json: async () => ({ streams: urls.map(url => ({ url })) }), ...extra
});
const jwtUrl = exp => {
  const header = Buffer.from('{"alg":"none"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `https://papacito.cfd/m3u/fixture/live.m3u8?ft=${header}.${payload}.unverified`;
};

let leafMint, outcomes, now;
beforeEach(() => {
  jest.resetModules();
  process.env = { ...originalEnv };
  for (const name of Object.keys(process.env)) if (name.startsWith('LEAF_')) delete process.env[name];
  Object.assign(process.env, { LEAF_INSTALL_CONFIG: 'fixture-install', LEAF_MINT_TTL_MS: '60000',
    LEAF_MINT_BACKOFF_MS: '15000', LEAF_MINT_TIMEOUT_MS: '8000' });
  mockSafeFetch.mockReset();
  now = initialTime;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  leafMint = require('../src/services/LeafMint');
  outcomes = require('../src/services/StreamResolutionOutcome');
});
afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

test.each([
  ['guarded capacity', () => Object.assign(new Error('private account URL'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }), 'capacity'],
  ['native pool', () => Object.assign(new Error('private account URL'), { code: 'ERR_NATIVE_POOL_BUSY', isFatal: true }), 'capacity'],
  ['native slot', () => Object.assign(new Error('private account URL'), { code: 'ERR_NATIVE_SLOT_CAPACITY', isFatal: true }), 'capacity'],
  ['abort', () => new DOMException('private account URL', 'AbortError'), 'cancelled'],
  ['deadline', () => new DOMException('private account URL', 'TimeoutError'), 'timeout'],
  ['nested timeout', () => Object.assign(new Error('outer private account URL'), {
    cause: Object.assign(new Error('private token'), { code: 'UND_ERR_HEADERS_TIMEOUT' })
  }), 'timeout'],
])('%s stays deferred for two seconds, preserves its cause, and recovers', async (_label, makeError, reason) => {
  const cause = makeError();
  mockSafeFetch.mockRejectedValueOnce(cause).mockRejectedValueOnce(cause).mockResolvedValueOnce(response());
  const first = await leafMint.mintUrl('fixture', 'fixture').catch(error => error);
  expect(first).toMatchObject({ leafTransient: true, reason, retryAfterMs: 2000, cause });
  expect(first.message).toBe('Leaf mint request failed');
  expect(outcomes.isInconclusiveResolutionError(first)).toBe(true);
  const cooling = await leafMint.mintUrl('fixture', 'fixture').catch(error => error);
  expect(cooling).toMatchObject({ code: 'ERR_LEAF_MINT_COOLDOWN', leafTransient: true, reason, retryAfterMs: 2000 });
  expect(outcomes.isInconclusiveResolutionError(cooling)).toBe(true);
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  now += 2000;
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ leafTransient: true, retryAfterMs: 2000 });
  expect(leafMint.cooldownRemaining('fixture', 'fixture')).toBe(2000);
  now += 2000;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(signedUrl);
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(signedUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(3);
  expect(leafMint.stats()).toMatchObject({ cached: 1, coolingDown: 0 });
  expect(JSON.stringify(console.warn.mock.calls)).not.toMatch(/private|token|fixture-install/);
});

test.each([
  ['capacity around a blocked address', () => Object.assign(new Error('private address'), {
    code: 'ERR_OUTBOUND_CAPACITY', isFatal: true,
    cause: Object.assign(new Error('private guard detail'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true })
  })],
  ['abort around a fatal body limit', () => Object.assign(new Error('private body'), {
    name: 'AbortError', cause: Object.assign(new Error('private fatal detail'), { code: 'ERR_OUTBOUND_BODY_LIMIT', isFatal: true })
  })],
])('%s remains a hard failure through its cooldown', async (_label, makeError) => {
  const cause = makeError();
  mockSafeFetch.mockRejectedValue(cause);
  const error = await leafMint.mintUrl('fixture', 'fixture').catch(error => error);
  expect(error.cause).toBe(cause);
  expect(error.leafTransient).not.toBe(true);
  expect(outcomes.isInconclusiveResolutionError(error)).toBe(false);
  const cooling = await leafMint.mintUrl('fixture', 'fixture').catch(error => error);
  expect(cooling).toMatchObject({ code: 'ERR_LEAF_MINT_COOLDOWN', retryAfterMs: 15000 });
  expect(cooling.leafTransient).not.toBe(true);
  expect(outcomes.isInconclusiveResolutionError(cooling)).toBe(false);
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
});

test.each([
  ['delta seconds', { 'Retry-After': '7' }, 7000],
  ['HTTP date', { 'retry-after': new Date(initialTime + 11000).toUTCString() }, 11000],
  ['bounded maximum', { 'retry-after': '9999999' }, 600000],
  ['bounded minimum', { 'retry-after': '0' }, 1000],
  ['invalid header', { 'retry-after': 'private nonsense' }, 30000],
  ['negative header', { 'retry-after': '-1' }, 30000],
])('HTTP 429 honors %s as an upstream cooldown and recovers', async (_label, headers, delay) => {
  mockSafeFetch.mockResolvedValueOnce(response([], { ok: false, status: 429, headers })).mockResolvedValueOnce(response());
  const failure = await leafMint.mintUrl('fixture', 'fixture').catch(error => error);
  expect(failure).toMatchObject({ code: 'ERR_LEAF_MINT_STATUS', upstreamStatus: 429, retryAfterMs: delay });
  expect(outcomes.isInconclusiveResolutionError(failure)).toBe(false);
  expect(failure.leafTransient).not.toBe(true);
  now += delay - 1;
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429, retryAfterMs: 1
  });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  now += 1;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(signedUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  expect(mockSafeFetch.mock.calls.every(([url]) => !url.includes('?cb='))).toBe(true);
});

test.each([
  ['account denied', response([], { ok: false, status: 403 }), 'ERR_LEAF_MINT_ACCOUNT_DENIED'],
  ['no signed media', response(['https://papacito.cfd/m3u/fixture/live.m3u8']), 'ERR_LEAF_MINT_NO_MEDIA'],
  ['malformed shape', response([], { json: async () => ({ private: 'not stream metadata' }) }), 'ERR_LEAF_MINT_BODY'],
  ['invalid JSON', response([], { json: async () => { throw new SyntaxError('private upstream body'); } }), 'ERR_LEAF_MINT_BODY'],
  ['truncated metadata', response([], { bodyTruncated: true }), 'ERR_LEAF_MINT_BODY_LIMIT'],
])('%s stays distinct and does not produce cached media', async (_label, upstream, code) => {
  mockSafeFetch.mockResolvedValue(upstream);
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ code });
  expect(leafMint.stats().cached).toBe(0);
  expect(JSON.stringify(console.warn.mock.calls)).not.toContain('private');
});

test('body-read deadlines use the same short typed outcome', async () => {
  const cause = new DOMException('private body timeout', 'TimeoutError');
  mockSafeFetch.mockResolvedValue(response([], { json: async () => { throw cause; } }));
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ leafTransient: true, reason: 'timeout', retryAfterMs: 2000, cause });
});

test('guarded requests receive the caller signal, one attempt, deadline and body cap', async () => {
  const controller = new AbortController();
  mockSafeFetch.mockResolvedValue(response());
  await leafMint.mintUrl('streamed:fixture', 'fixture', { signal: controller.signal });
  expect(mockSafeFetch).toHaveBeenCalledWith(expect.stringContaining('/stream/sport/streamed%3Afixture.json'),
    expect.objectContaining({ signal: controller.signal, attempts: 1, timeoutMs: 8000,
      maxBodyBytes: 256 * 1024, diagnosticOwner: 'provider' }));
});

test('an already cancelled caller cannot return a cached URL or start I/O', async () => {
  leafMint.seed('fixture', 'fixture', signedUrl);
  const controller = new AbortController();
  controller.abort();
  const error = await leafMint.mintUrl('fixture', 'fixture', { signal: controller.signal }).catch(error => error);
  expect(error).toMatchObject({ leafTransient: true, reason: 'cancelled', retryAfterMs: 2000 });
  expect(outcomes.isInconclusiveResolutionError(error)).toBe(true);
  expect(mockSafeFetch).not.toHaveBeenCalled();
});

test('positive caching retains signed bytes and expires at the ordinary TTL', async () => {
  mockSafeFetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(response([freshUrl]));
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(signedUrl);
  now += 59999;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(signedUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  now += 1;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
});

test('an unverified JWT exp only shortens positive cache lifetime', async () => {
  const shortLived = jwtUrl(initialTime / 1000 + 5);
  mockSafeFetch.mockResolvedValueOnce(response([shortLived])).mockResolvedValueOnce(response([freshUrl]));
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(shortLived);
  now += 4999;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(shortLived);
  now += 1;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
});

test('a far-future JWT cannot extend the normal positive cache lifetime', async () => {
  mockSafeFetch.mockResolvedValueOnce(response([jwtUrl(initialTime / 1000 + 3600)])).mockResolvedValueOnce(response([freshUrl]));
  await leafMint.mintUrl('fixture', 'fixture');
  now += 60000;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
});

test('expired JWT candidates and seeds cannot revive a failed mint', async () => {
  const expired = jwtUrl(initialTime / 1000);
  mockSafeFetch.mockResolvedValue(response([expired]));
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ code: 'ERR_LEAF_MINT_NO_MEDIA' });
  leafMint.seed('fixture', 'fixture', expired);
  expect(leafMint.stats()).toMatchObject({ cached: 0, coolingDown: 1 });
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ cooldown: true, retryAfterMs: 60000 });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
});

test('an expired seed does not become playable, and accepted seeds retain the exp ceiling', async () => {
  leafMint.seed('fixture', 'fixture', jwtUrl(initialTime / 1000 - 1));
  expect(leafMint.stats().cached).toBe(0);
  const shortLived = jwtUrl(initialTime / 1000 + 1);
  leafMint.seed('fixture', 'fixture', shortLived);
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(shortLived);
  now += 1000;
  mockSafeFetch.mockResolvedValue(response([freshUrl]));
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
});

test('captured account bases partition delayed seeds, invalidation and failures', async () => {
  const firstBase = leafMint.apiBase();
  process.env.LEAF_INSTALL_CONFIG = 'fixture-second';
  leafMint.seed('fixture', 'fixture', signedUrl, { base: firstBase });
  mockSafeFetch.mockResolvedValue(response([freshUrl]));
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
  leafMint.invalidate('fixture', 'fixture', { base: firstBase });
  leafMint.noteFailure('fixture', 'fixture', { base: firstBase, reason: 'ERR_LEAF_PLAYLIST' });
  expect(leafMint.cooldownRemaining('fixture', 'fixture')).toBe(0);
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
  process.env.LEAF_INSTALL_CONFIG = 'fixture-install';
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ cooldown: true, retryAfterMs: 10000 });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
});

test('an account change during a failed request cannot cool down the next account', async () => {
  let rejectFirst;
  mockSafeFetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; })).mockResolvedValueOnce(response([freshUrl]));
  const first = leafMint.mintUrl('fixture', 'fixture');
  await Promise.resolve();
  process.env.LEAF_INSTALL_CONFIG = 'fixture-second';
  rejectFirst(Object.assign(new Error('private'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }));
  await expect(first).rejects.toMatchObject({ leafTransient: true });
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
});

test('normal and explicit force callers share one in-flight mint', async () => {
  let finish;
  mockSafeFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = leafMint.mintUrl('fixture', 'fixture');
  const second = leafMint.mintUrl('fixture', 'fixture', { force: true });
  await Promise.resolve();
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  finish(response());
  await expect(Promise.all([first, second])).resolves.toEqual([signedUrl, signedUrl]);
});

test.each(['one key', 'all keys'])('%s invalidation fences late completion without deleting the new flight', async scope => {
  const finishes = [];
  mockSafeFetch.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  const first = leafMint.mintUrl('fixture', 'fixture');
  await Promise.resolve();
  if (scope === 'all keys') leafMint.invalidate(); else leafMint.invalidate('fixture', 'fixture');
  const second = leafMint.mintUrl('fixture', 'fixture');
  await Promise.resolve();
  finishes[0](response());
  await expect(first).rejects.toMatchObject({ code: 'ERR_LEAF_MINT_SUPERSEDED', leafTransient: true, retryAfterMs: 2000 });
  const third = leafMint.mintUrl('fixture', 'fixture');
  await Promise.resolve();
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  finishes[1](response([freshUrl]));
  await expect(Promise.all([second, third])).resolves.toEqual([freshUrl, freshUrl]);
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
});

test.each(['success', 'failure'])('a seed fences an older in-flight %s', async outcome => {
  let resolveOld, rejectOld;
  mockSafeFetch.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
  const pending = leafMint.mintUrl('fixture', 'fixture');
  await Promise.resolve();
  leafMint.seed('fixture', 'fixture', freshUrl);
  if (outcome === 'success') resolveOld(response());
  else rejectOld(Object.assign(new Error('private'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }));
  await expect(pending).rejects.toMatchObject({ code: 'ERR_LEAF_MINT_SUPERSEDED', retryAfterMs: 2000 });
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
  expect(leafMint.stats()).toMatchObject({ cached: 1, coolingDown: 0 });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
});

test('invalid premium config disables diagnostic readiness without throwing from stats', async () => {
  process.env.LEAF_PREMIUM_TOKEN = 'invalid-private-premium-token';
  expect(leafMint.isConfigured()).toBe(false);
  expect(leafMint.stats()).toMatchObject({ configured: false });
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ code: 'ERR_LEAF_CONFIG', message: 'Invalid Leaf configuration' });
  expect(mockSafeFetch).not.toHaveBeenCalled();
});

test('the stable four-hour default reuses a valid credential for hours and the maximum remains eight hours', async () => {
  delete process.env.LEAF_MINT_TTL_MS;
  jest.resetModules();
  leafMint = require('../src/services/LeafMint');
  expect(leafMint.MINT_TTL_MS).toBe(4 * 60 * 60 * 1000);
  leafMint.seed('fixture', 'fixture', signedUrl);
  now += 2 * 60 * 60 * 1000;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(signedUrl);
  expect(mockSafeFetch).not.toHaveBeenCalled();
  now += 2 * 60 * 60 * 1000;
  mockSafeFetch.mockResolvedValue(response([freshUrl]));
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
  process.env.LEAF_MINT_TTL_MS = String(12 * 60 * 60 * 1000);
  jest.resetModules();
  expect(require('../src/services/LeafMint').MINT_TTL_MS).toBe(8 * 60 * 60 * 1000);
});

test.each([
  ['eight-minute stub', 'Too many stream requests. Please wait 8 min.', undefined, 480000],
  ['compact countdown', 'Too many stream requests. Please wait8min.', undefined, 480000],
  ['header and countdown', 'Too many stream requests. Please wait 8 min.', '120', 480000],
  ['longer header', 'Too many stream requests. Please wait 2 seconds.', '7', 7000],
  ['bounded countdown', 'Too many stream requests. Please wait 25 minutes.', undefined, 600000],
])('%s records the reported cooldown and does not poll through it', async (_label, title, retryAfter, delay) => {
  mockSafeFetch.mockResolvedValueOnce(response([], {
    headers: retryAfter ? { 'retry-after': retryAfter } : {},
    json: async () => ({ streams: [{ name: 'Rate limit exceeded', title }] })
  })).mockResolvedValueOnce(response([freshUrl]));
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_RATE_LIMIT', rateLimit: true, upstreamStatus: 429, retryAfterMs: delay
  });
  await expect(leafMint.mintUrl('fixture', 'fixture', { force: true })).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429, retryAfterMs: delay
  });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  now += delay;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
});

test('rate-limit fallback preserves an absolute JWT expiry across normal and forced callers', async () => {
  delete process.env.LEAF_MINT_TTL_MS;
  jest.resetModules();
  leafMint = require('../src/services/LeafMint');
  const expiring = jwtUrl(initialTime / 1000 + 120);
  leafMint.seed('fixture', 'fixture', expiring);
  now += 30000;
  mockSafeFetch.mockResolvedValueOnce(response([], { ok: false, status: 429, headers: { 'retry-after': '480' } }))
    .mockResolvedValueOnce(response([freshUrl]));
  await expect(leafMint.mintUrl('fixture', 'fixture', { force: true })).resolves.toBe(expiring);
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(expiring);
  await expect(leafMint.mintUrl('fixture', 'fixture', { force: true })).resolves.toBe(expiring);
  expect(leafMint.peekCachedUrl('fixture', 'fixture')).toBe(expiring);
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  now = initialTime + 120000;
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429, retryAfterMs: 390000
  });
  await expect(leafMint.mintUrl('fixture', 'fixture', { force: true })).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429
  });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  now = initialTime + 510000;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(freshUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
});

test('a rate-limit stub never renews the fixed TTL of a token with no readable expiry', async () => {
  leafMint.seed('fixture', 'fixture', signedUrl);
  now += 30000;
  mockSafeFetch.mockResolvedValueOnce(response([], {
    json: async () => ({ streams: [{ name: 'Rate limit exceeded', title: 'Please wait 8 min.' }] })
  }));
  await expect(leafMint.mintUrl('fixture', 'fixture', { force: true })).resolves.toBe(signedUrl);
  now = initialTime + 59999;
  await expect(leafMint.mintUrl('fixture', 'fixture')).resolves.toBe(signedUrl);
  now += 1;
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429, retryAfterMs: 450000
  });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  expect(leafMint.stats().cached).toBe(0);
});

test('a token that expires during a forced request cannot be returned by the HTTP 429 fallback', async () => {
  const expiring = jwtUrl(initialTime / 1000 + 1);
  leafMint.seed('fixture', 'fixture', expiring);
  let finish;
  mockSafeFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = leafMint.mintUrl('fixture', 'fixture', { force: true });
  await Promise.resolve();
  now += 1000;
  finish(response([], { ok: false, status: 429, headers: { 'retry-after': '480' } }));
  await expect(pending).rejects.toMatchObject({ code: 'ERR_LEAF_MINT_STATUS', upstreamStatus: 429, retryAfterMs: 480000 });
  await expect(leafMint.mintUrl('fixture', 'fixture')).rejects.toMatchObject({ code: 'ERR_LEAF_MINT_COOLDOWN' });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
});

test('rate-limit and normalization compatibility exports remain available to Recap', () => {
  expect(leafMint.UUID_REGEX.test('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d')).toBe(true);
  expect(leafMint.extractOrigin('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d')).toBe('https://premium.highfly.to');
  expect(leafMint.normalizeConfigBlob('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d')).toBe('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');
  expect(leafMint.isRateLimit([{ name: 'Rate limit exceeded', title: 'Please wait 8 min.' }])).toBe(true);
});

test('internal cache eligibility stays scoped to the captured account and stops at JWT expiry', () => {
  const firstBase = leafMint.apiBase();
  const expiring = jwtUrl(initialTime / 1000 + 2);
  leafMint.seed('fixture', 'fixture', expiring, { base: firstBase });
  process.env.LEAF_INSTALL_CONFIG = 'fixture-second';
  expect(leafMint.peekCachedUrl('fixture', 'fixture')).toBeUndefined();
  expect(leafMint.peekCachedUrl('fixture', 'different', { base: firstBase })).toBeUndefined();
  expect(leafMint.peekCachedUrl('fixture', 'fixture', { base: firstBase })).toBe(expiring);
  now += 1999;
  expect(leafMint.peekCachedUrl('fixture', 'fixture', { base: firstBase })).toBe(expiring);
  now += 1;
  expect(leafMint.peekCachedUrl('fixture', 'fixture', { base: firstBase })).toBeUndefined();
  expect(leafMint.stats().cached).toBe(0);
  expect(mockSafeFetch).not.toHaveBeenCalled();
});

test('internal cache eligibility cannot renew the TTL of an opaque token', () => {
  leafMint.seed('fixture', 'fixture', signedUrl);
  now += 59000;
  expect(leafMint.peekCachedUrl('fixture', 'fixture')).toBe(signedUrl);
  now += 999;
  expect(leafMint.peekCachedUrl('fixture', 'fixture')).toBe(signedUrl);
  now += 1;
  expect(leafMint.peekCachedUrl('fixture', 'fixture')).toBeUndefined();
  expect(mockSafeFetch).not.toHaveBeenCalled();
});

test.each(['HTTP429', 'JSON stub'])('%s blocks other matches, profiles and regional development hosts for the same account', async kind => {
  const uid = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
  const initialBase = `https://premium.highfly.to/${uid}/pabc123`;
  process.env.LEAF_API_URL = initialBase;
  const limited = kind === 'HTTP429'
    ? response([], { ok: false, status: 429, headers: { 'retry-after': '480' } })
    : response([], { json: async () => ({ streams: [{ name: 'Rate limit exceeded', title: 'Please wait 8 min.' }] }) });
  mockSafeFetch.mockResolvedValueOnce(limited).mockResolvedValueOnce(response([freshUrl])).mockResolvedValueOnce(response());
  await expect(leafMint.mintUrl('first-match', 'fixture')).rejects.toMatchObject({ upstreamStatus: 429, retryAfterMs: 480000 });
  process.env.LEAF_API_URL = `https://premium-eu1.highfly.dev/${uid}/pdef456`;
  await expect(leafMint.mintUrl('different-match', 'fixture')).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_COOLDOWN', rateLimit: true, cooldown: true, upstreamStatus: 429, retryAfterMs: 480000
  });
  await expect(leafMint.mintUrl('another-match', 'fixture', { force: true })).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429, retryAfterMs: 480000
  });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  process.env.LEAF_API_URL = 'https://premium-eu1.highfly.dev/11111111-2222-3333-4444-555555555555/pdef456';
  await expect(leafMint.mintUrl('another-account', 'fixture')).resolves.toBe(freshUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  process.env.LEAF_API_URL = initialBase;
  now += 480000;
  await expect(leafMint.mintUrl('different-match', 'fixture')).resolves.toBe(signedUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(3);
});

test('a valid cached credential on another slug plays during the account advisory without forced I/O or lifetime renewal', async () => {
  const otherUrl = 'https://papacito.cfd/m3u/other/live.m3u8?ft=opaque-other';
  leafMint.seed('cached-match', 'other', otherUrl);
  mockSafeFetch.mockResolvedValueOnce(response([], { ok: false, status: 429, headers: { 'retry-after': '480' } }));
  await expect(leafMint.mintUrl('new-match', 'fixture')).rejects.toMatchObject({ upstreamStatus: 429 });
  await expect(leafMint.mintUrl('cached-match', 'other')).resolves.toBe(otherUrl);
  await expect(leafMint.mintUrl('cached-match', 'other', { force: true })).resolves.toBe(otherUrl);
  expect(leafMint.peekCachedUrl('cached-match', 'other')).toBe(otherUrl);
  now += 60000;
  await expect(leafMint.mintUrl('cached-match', 'other')).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429, retryAfterMs: 420000
  });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
});

test('late successful mints, targeted invalidation and seeding cannot erase an account advisory', async () => {
  let finishSuccess;
  mockSafeFetch.mockImplementationOnce(() => new Promise(resolve => { finishSuccess = resolve; }))
    .mockResolvedValueOnce(response([], { ok: false, status: 429, headers: { 'retry-after': '480' } }));
  const success = leafMint.mintUrl('already-running', 'fixture');
  await Promise.resolve();
  await expect(leafMint.mintUrl('limited-match', 'fixture')).rejects.toMatchObject({ upstreamStatus: 429 });
  finishSuccess(response());
  await expect(success).resolves.toBe(signedUrl);
  leafMint.invalidate('limited-match', 'fixture');
  leafMint.seed('seeded-match', 'fixture', freshUrl);
  expect(leafMint.cooldownRemaining('unseen-match', 'fixture')).toBe(480000);
  await expect(leafMint.mintUrl('seeded-match', 'fixture')).resolves.toBe(freshUrl);
  await expect(leafMint.mintUrl('unseen-match', 'fixture', { force: true })).rejects.toMatchObject({
    code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429, retryAfterMs: 480000
  });
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
});

test('a shared account advisory installed before queued mint I/O blocks that request', async () => {
  const limits = require('../src/services/LeafRateLimitState');
  const pending = leafMint.mintUrl('queued-match', 'fixture');
  limits.recordAccountRateLimit(leafMint.apiBase(), 480000);
  await expect(pending).rejects.toMatchObject({ code: 'ERR_LEAF_MINT_COOLDOWN', upstreamStatus: 429, retryAfterMs: 480000 });
  expect(mockSafeFetch).not.toHaveBeenCalled();
});

test('only an explicit full invalidation resets shared account rate limits', async () => {
  mockSafeFetch.mockResolvedValueOnce(response([], { ok: false, status: 429, headers: { 'retry-after': '480' } }))
    .mockResolvedValueOnce(response());
  await expect(leafMint.mintUrl('limited-match', 'fixture')).rejects.toMatchObject({ upstreamStatus: 429 });
  leafMint.invalidate();
  expect(leafMint.cooldownRemaining('fresh-match', 'fixture')).toBe(0);
  await expect(leafMint.mintUrl('fresh-match', 'fixture')).resolves.toBe(signedUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
});

test('local capacity cannot install a cross-target account cooldown', async () => {
  mockSafeFetch.mockRejectedValueOnce(Object.assign(new Error('private capacity detail'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }))
    .mockResolvedValueOnce(response());
  await expect(leafMint.mintUrl('busy-match', 'fixture')).rejects.toMatchObject({ leafTransient: true, retryAfterMs: 2000 });
  expect(leafMint.cooldownRemaining('other-match', 'fixture')).toBe(0);
  await expect(leafMint.mintUrl('other-match', 'fixture')).resolves.toBe(signedUrl);
  expect(mockSafeFetch).toHaveBeenCalledTimes(2);
});
