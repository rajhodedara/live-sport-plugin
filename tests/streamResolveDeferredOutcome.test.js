'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const { createDeferredResolution, isDeferredResolution, isInconclusiveResolutionError } = require('../src/services/StreamResolutionOutcome');
const key = 'timstreams:fixture:source';
const good = [{ url: 'https://cdn.example.test/live.m3u8' }];

function localCache(options = {}) {
  return new StreamResolveCache({ ...options, sharedResolver: { available: () => false, request: () => { throw new Error('Unexpected resolver I/O'); } } });
}

// Connect the actual CJS worker cache and actual pure ESM resolver cache using
// an in-memory request adapter. No HTTP server, provider, native code or socket.
function runShared(body, mode = 'normal') {
  const root = path.join(__dirname, '..');
  return JSON.parse(execFileSync(process.execPath, [
    '--require', path.join(root, 'tests/fixtures/pr59-offline-boundary.cjs'),
    '--input-type=module', '--eval', `
      import { createRequire } from 'node:module';
      import { cacheClaim, cacheGet, cacheSet, cacheDelete, cachePrune, cacheStats } from './resolver/src/cache.js';
      const require = createRequire(import.meta.url);
      const StreamResolveCache = require('./src/services/StreamResolveCache');
      const { createDeferredResolution } = require('./src/services/StreamResolutionOutcome');
      process.env.RESOLVE_CACHE_SHARED = 'true';
      process.env.RESOLVER_TRUST_LEGACY_TCP = 'true';
      let now = 100000; Date.now = () => now;
      const key = 'timstreams:fixture:source', calls = [];
      global.fetch = async (raw, options = {}) => {
        const url = new URL(raw), target = decodeURIComponent(url.pathname.slice('/api/cache/'.length));
        const call = { method: options.method || 'GET', token: url.searchParams.get('ownerToken') };
        calls.push(call);
        let result;
        if (url.pathname === '/api/cache/prune') {
          call.prune = true;
          result = cachePrune(JSON.parse(options.body).activeIds);
        } else if (url.searchParams.get('claim') === '1') {
          result = cacheClaim(target, undefined, true);
          if (${JSON.stringify(mode)} === 'legacy') delete result.ownerToken;
        } else if (options.method === 'POST') {
          const data = JSON.parse(options.body);
          result = cacheSet(target, data.streams, data.ttlMs, data.status, data.ownerToken);
        } else if (options.method === 'DELETE') {
          if (${JSON.stringify(mode)} === 'release-error') throw new Error('simulated resolver outage');
          result = cacheDelete(target, url.searchParams.get('ownerToken'));
          call.result = result;
        } else result = cacheGet(target);
        return { ok: true, json: async () => result };
      };
      const cache = new StreamResolveCache();
      ${body}
    `
  ], { cwd: root, encoding: 'utf8', timeout: 5000 }));
}

describe('explicit local deferred resolution outcome', () => {
  test('sanitizes reasons and bounds cooldown without carrying source URLs', () => {
    expect(createDeferredResolution('secret https://token.example', -1)).toEqual({ status: 'deferred', reason: 'unavailable', retryAfterMs: 1000, streams: [] });
    expect(createDeferredResolution('capacity', 99999).retryAfterMs).toBe(3000);
    expect(createDeferredResolution('timeout', Infinity).retryAfterMs).toBe(2000);
    expect(isDeferredResolution(createDeferredResolution('cancelled'))).toBe(true);
  });

  test.each([
    null, [], {}, { status: 'deferred', reason: 'timeout', retryAfterMs: 999, streams: [] },
    { status: 'deferred', reason: 'other', retryAfterMs: 2000, streams: [] },
    { status: 'deferred', reason: 'timeout', retryAfterMs: 2000, streams: good },
    { status: 'deferred', reason: 'timeout', retryAfterMs: 2000, streams: [], extra: 'not-control-data' }
  ])('rejects malformed or positive control outcomes (%j)', value => {
    expect(isDeferredResolution(value)).toBe(false);
  });

  test('does not invoke provider getters or let proxies throw out of validation', () => {
    const getter = jest.fn(() => { throw new Error('must not execute'); });
    const value = { reason: 'timeout', retryAfterMs: 2000, streams: [] };
    Object.defineProperty(value, 'status', { enumerable: true, get: getter });
    expect(isDeferredResolution(value)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(isDeferredResolution(new Proxy({}, { ownKeys() { throw new Error('bad proxy'); } }))).toBe(false);
  });

  test.each([
    { name: 'AbortError' }, { name: 'TimeoutError' }, { code: 'ETIMEDOUT' },
    { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } },
    { code: 'WRAPPED', cause: { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true } },
    { code: 'WRAPPED', cause: { code: 'UND_ERR_BODY_TIMEOUT' } },
    { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true },
    { code: 'ERR_NATIVE_POOL_BUSY' }, { code: 'ERR_NATIVE_SLOT_CAPACITY' }
  ])('recognizes a typed inconclusive error (%j)', error => {
    expect(isInconclusiveResolutionError(error)).toBe(true);
  });

  test.each([
    { name: 'TimeoutError', code: 'ERR_OUTBOUND_BLOCKED', isFatal: true },
    { name: 'TimeoutError', code: 'ETIMEDOUT', cause: { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true } },
    { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true, cause: { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true } },
    { name: 'TimeoutError', code: 'WRAPPED', cause: { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true } },
    { code: 'ERR_NATIVE_POOL_CLOSED', isFatal: true },
    { name: 'Error', deadlineExceeded: true }, { code: 'ECONNRESET' }, { statusCode: 404 }, null
  ])('preserves hard outcomes and does not trust public flags (%j)', error => {
    expect(isInconclusiveResolutionError(error)).toBe(false);
  });
});

describe('local deferred cache behavior', () => {
  let now, clock;
  beforeEach(() => { now = 100000; clock = jest.spyOn(Date, 'now').mockImplementation(() => now); });
  afterEach(() => clock.mockRestore());

  test('keeps a short distinct cooldown, then retries successfully without lowering adaptive TTL', async () => {
    const cache = localCache();
    cache.ttl.set('timstreams', 120000);
    const mint = jest.fn().mockResolvedValueOnce(createDeferredResolution('timeout')).mockResolvedValueOnce(good);
    expect(await cache.getOrCreate(key, mint)).toEqual([]);
    expect(cache.entries.get(key)).toMatchObject({ status: 'deferred', reason: 'timeout', expiresAt: now + 2000 });
    expect(cache.get(key)).toBeNull();
    expect(cache.has(key)).toBe(false);
    expect(cache.isResolved(key)).toBe(true);
    now += 1999;
    expect(await cache.getOrCreate(key, mint)).toEqual([]);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ negativeHits: 0, deferredHits: 1, deferrals: 1, learnedTtls: { timstreams: 120000 } });
    now++;
    expect(cache.isResolved(key)).toBe(false);
    expect(await cache.getOrCreate(key, mint)).toEqual(good);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(cache.entries.get(key).status).toBe('ok');
    expect(cache.ttl.get('timstreams')).toBe(120000);
  });

  test('isDeferred distinguishes local cooldowns and expires at the exact boundary', async () => {
    const cache = localCache();
    expect(cache.isDeferred(key)).toBe(false);
    await cache.getOrCreate(key, async () => createDeferredResolution('timeout'));
    cache._set('provider:fixture:positive', 'provider', 'fixture', good, 'ok', 60000);
    cache._set('provider:fixture:failed', 'provider', 'fixture', [], 'failed', 30000);
    expect(cache.isDeferred(key)).toBe(true);
    expect(cache.isDeferred('provider:fixture:positive')).toBe(false);
    expect(cache.isDeferred('provider:fixture:failed')).toBe(false);
    expect(cache.stats().deferredHits).toBe(0);
    now += 1999;
    expect(cache.isDeferred(key)).toBe(true);
    now++;
    expect(cache.isDeferred(key)).toBe(false);
    expect(cache.entries.has(key)).toBe(false);
  });

  test.each([
    ['timeout', () => Object.assign(new Error('local timer'), { name: 'TimeoutError', code: 'ETIMEDOUT' })],
    ['cancelled', () => new DOMException('caller stopped', 'AbortError')],
    ['capacity', () => Object.assign(new Error('busy'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true })],
    ['capacity', () => Object.assign(new Error('wrapped busy'), { code: 'WRAPPER', cause: { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true } })],
    ['timeout', () => Object.assign(new Error('wrapped timer'), { code: 'WRAPPER', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })]
  ])('a thrown %s receives the same short cooldown', async (reason, makeError) => {
    const cache = localCache();
    await cache.getOrCreate(key, async () => { throw makeError(); });
    expect(cache.entries.get(key)).toMatchObject({ status: 'deferred', reason, expiresAt: now + 2000 });
    expect(cache.ttl.size).toBe(0);
  });

  test('a thrown legitimate control outcome does not become a 30-second failure', async () => {
    const cache = localCache();
    await cache.getOrCreate(key, async () => { throw createDeferredResolution('capacity', 1000); });
    expect(cache.entries.get(key)).toMatchObject({ status: 'deferred', reason: 'capacity', expiresAt: now + 1000 });
  });

  test('final empty/404 and fatal guard failures keep normal negative caching', async () => {
    const cache = localCache();
    const mint = jest.fn(async () => []);
    await cache.getOrCreate(key, mint);
    await cache.getOrCreate(key, mint);
    expect(cache.entries.get(key)).toMatchObject({ status: 'failed', expiresAt: now + 30000 });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(cache.stats().negativeHits).toBe(1);
    await cache.getOrCreate('provider:fixture:blocked', async () => { throw Object.assign(new Error('blocked'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true }); });
    expect(cache.entries.get('provider:fixture:blocked').status).toBe('failed');
    await cache.getOrCreate('provider:fixture:wrapped-guard', async () => { throw Object.assign(new Error('wrapper'), { name: 'TimeoutError', code: 'ETIMEDOUT', cause: { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true } }); });
    expect(cache.entries.get('provider:fixture:wrapped-guard').status).toBe('failed');
  });

  test('followers share one inconclusive mint and cannot serve an expired prior URL', async () => {
    const cache = localCache();
    cache._set(key, 'timstreams', 'fixture', good, 'ok', -1);
    let release;
    const mint = jest.fn(() => new Promise(resolve => { release = resolve; }));
    const a = cache.getOrCreate(key, mint), b = cache.getOrCreate(key, mint);
    while (!release) await Promise.resolve();
    release(createDeferredResolution('capacity'));
    expect(await Promise.all([a, b])).toEqual([[], []]);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(cache.get(key)).toBeNull();
    expect(cache.entries.get(key).status).toBe('deferred');
    expect(cache.inFlight.size).toBe(0);
    expect(cache.pendingOperations.size).toBe(0);
  });

  test('deferred entries obey LRU capacity and pruning while live positives stay normal', async () => {
    const cache = localCache({ maxEntries: 2 });
    await cache.getOrCreate('provider:ended:a', async () => createDeferredResolution('timeout'));
    await cache.getOrCreate('provider:active:b', async () => createDeferredResolution('capacity'));
    await cache.getOrCreate('provider:active:c', async () => good);
    expect(cache.entries.size).toBe(2);
    expect(cache.stats().evictions).toBe(1);
    cache.pruneEnded([]);
    expect(cache.entries.size).toBe(0);
    expect(cache.inFlight.size).toBe(0);
  });
});

describe('deferred outcome with actual fenced resolver-cache semantics', () => {
  test('releases only its owned claim, publishes no failed status, and permits another worker to recover', () => {
    const result = runShared(`
      const a = await cache.getOrCreate(key, async () => createDeferredResolution('capacity'));
      const before = cacheGet(key);
      const firstCalls = calls.slice();
      const b = await new StreamResolveCache().getOrCreate(key, async () => [{url:'https://cdn.example.test/recovered.m3u8'}]);
      console.log(JSON.stringify({a,b,before,firstCalls,local:cache.entries.get(key),current:cacheGet(key)}));
    `);
    expect(result.a).toEqual([]);
    expect(result.local.status).toBe('deferred');
    expect(result.before.status).toBe('miss');
    expect(result.firstCalls.filter(call => call.method === 'POST')).toEqual([]);
    expect(result.firstCalls.filter(call => call.method === 'DELETE')).toEqual([expect.objectContaining({ token: expect.any(String), result: { ok: true } })]);
    expect(result.b).toEqual([{ url: 'https://cdn.example.test/recovered.m3u8' }]);
    expect(result.current.status).toBe('ok');
  });

  test.each(['claim', 'published'])('a delayed deferral cannot remove a newer %s', state => {
    const result = runShared(`
      await cache.getOrCreate(key, async () => {
        now += 31000;
        const newer=cacheClaim(key,undefined,true);
        if (${JSON.stringify(state)} === 'published') cacheSet(key,[{url:'newer'}],60000,'ok',newer.ownerToken);
        return createDeferredResolution('timeout');
      });
      console.log(JSON.stringify({local:cache.entries.get(key),current:cacheGet(key),calls}));
    `);
    expect(result.local.status).toBe('deferred');
    expect(result.current.status).toBe(state === 'claim' ? 'minting' : 'ok');
    if (state === 'published') expect(result.current.streams).toEqual([{ url: 'newer' }]);
    expect(result.calls.filter(call => call.method === 'DELETE')).toEqual([expect.objectContaining({ token: expect.any(String), result: { ok: false, reason: 'stale-owner' } })]);
    expect(result.calls.some(call => call.method === 'POST')).toBe(false);
  });

  test('a failed release never converts the local cooldown into a permanent dead verdict', () => {
    const result = runShared(`
      await cache.getOrCreate(key,async()=>createDeferredResolution('timeout'));
      console.log(JSON.stringify({entry:cache.entries.get(key),calls,stats:cache.stats()}));
    `, 'release-error');
    expect(result.entry).toMatchObject({ status: 'deferred', expiresAt: 102000 });
    expect(result.stats.deferrals).toBe(1);
    expect(result.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    expect(result.calls.some(call => call.method === 'POST')).toBe(false);
  });

  test('an older unfenced resolver never receives an unsafe release', () => {
    const result = runShared(`
      await cache.getOrCreate(key,async()=>createDeferredResolution('capacity'));
      console.log(JSON.stringify({entry:cache.entries.get(key),calls}));
    `, 'legacy');
    expect(result.entry.status).toBe('deferred');
    expect(result.calls.some(call => ['DELETE','POST'].includes(call.method))).toBe(false);
  });

  test('pruning an in-flight deferral cannot repopulate either cache', () => {
    const result = runShared(`
      await cache.getOrCreate(key,async()=>{
        cache.pruneEnded([]);
        return createDeferredResolution('cancelled');
      });
      console.log(JSON.stringify({local:cache.entries.size,current:cacheGet(key),calls}));
    `);
    expect(result.local).toBe(0);
    expect(result.current.status).toBe('miss');
    expect(result.calls.filter(call => call.method === 'POST')).toEqual([expect.objectContaining({ prune: true })]);
    expect(result.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });

  test('an inconclusive throw after pruning also releases only its owned claim', () => {
    const result = runShared(`
      await cache.getOrCreate(key,async()=>{
        cache.pruneEnded([]);
        throw Object.assign(new Error('local timeout'),{name:'TimeoutError',code:'ETIMEDOUT'});
      });
      console.log(JSON.stringify({local:cache.entries.size,current:cacheGet(key),calls}));
    `);
    expect(result.local).toBe(0);
    expect(result.current.status).toBe('miss');
    expect(result.calls.filter(call => call.method === 'DELETE')).toEqual([expect.objectContaining({ token: expect.any(String) })]);
    expect(result.calls.filter(call => call.method === 'POST')).toEqual([expect.objectContaining({ prune: true })]);
  });
});
