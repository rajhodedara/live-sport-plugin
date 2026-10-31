
// These tests explicitly exercise the unauthenticated TCP compatibility mode.
const legacyTrustBeforeTests = process.env.RESOLVER_TRUST_LEGACY_TCP;
beforeAll(() => { process.env.RESOLVER_TRUST_LEGACY_TCP = 'true'; });
afterAll(() => {
  if (legacyTrustBeforeTests === undefined) delete process.env.RESOLVER_TRUST_LEGACY_TCP;
  else process.env.RESOLVER_TRUST_LEGACY_TCP = legacyTrustBeforeTests;
});
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Real worker and resolver-cache modules, connected by a fully stubbed HTTP
// interface. The clock advances inside the mint; no network or waiting for TTLs.
function run(body, legacy = false, expireRetry = false) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { createRequire } from 'node:module';
    import { cacheClaim, cacheGet, cacheSet, cacheDelete, cacheStats } from './resolver/src/cache.js';
    process.env.RESOLVE_CACHE_SHARED = 'true';
    process.env.RESOLVER_TRUST_LEGACY_TCP = 'true';
    let now = 100000; Date.now = () => now;
    const calls = [], writes = [];
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url), key = decodeURIComponent(parsed.pathname.slice('/api/cache/'.length));
      calls.push({ method: options.method || 'GET', vacant: parsed.searchParams.get('vacant') === '1' });
      let result;
      if (parsed.searchParams.get('claim') === '1') {
        result = cacheClaim(key, undefined, true, parsed.searchParams.get('vacant') === '1');
        if (${legacy}) { delete result.supportsVacantClaim; delete result.vacantOnly; }
      } else if (options.method === 'POST') {
        const data = JSON.parse(options.body);
        if (${expireRetry} && writes.length === 1) now += 31000;
        result = cacheSet(key, data.streams, data.ttlMs, data.status, data.ownerToken);
        writes.push({ token: data.ownerToken, result });
      } else if (options.method === 'DELETE') result = cacheDelete(key, parsed.searchParams.get('ownerToken'));
      else result = cacheGet(key);
      return { ok: true, json: async () => result };
    };
    const require = createRequire(import.meta.url);
    const StreamResolveCache = require('./src/services/StreamResolveCache');
    const cache = new StreamResolveCache(), key = 'provider:slow:source';
    ${body}
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000 }));
}

describe('slow-mint shared publication recovery', () => {
  test.each(['ok', 'failed'])('a mint beyond the lease TTL can publish its %s result to L2', status => {
    const result = run(`
      const local = await cache.getOrCreate(key, async () => { now += 31000; return ${status === 'ok' ? "[{ url: 'slow' }]" : '[]'}; });
      let mintedAgain = false;
      const inherited = await new StreamResolveCache().getOrCreate(key, async () => { mintedAgain = true; return []; });
      console.log(JSON.stringify({ local, inherited, mintedAgain, current: cacheGet(key), calls, writes }));
    `);
    expect(result.current.status).toBe(status);
    expect(result.mintedAgain).toBe(false);
    expect(result.inherited).toEqual(result.local);
    expect(result.writes).toHaveLength(2);
    expect(result.writes[0].result.reason).toBe('stale-owner');
    expect(result.writes[1].result.ok).toBe(true);
    expect(result.writes[1].token).not.toBe(result.writes[0].token);
  });

  test('recovery cannot overwrite a result published by another worker', () => {
    const result = run(`
      await cache.getOrCreate(key, async () => {
        now += 31000;
        const next = cacheClaim(key, undefined, true);
        cacheSet(key, [{ url: 'newer' }], 60000, 'ok', next.ownerToken);
        return [{ url: 'late' }];
      });
      console.log(JSON.stringify({ current: cacheGet(key), calls, writes }));
    `);
    expect(result.current.streams).toEqual([{ url: 'newer' }]);
    expect(result.calls.some(call => call.vacant)).toBe(true);
    expect(result.writes).toHaveLength(1);
  });

  test('recovery cannot take a reservation held by another worker', () => {
    const result = run(`
      await cache.getOrCreate(key, async () => { now += 31000; cacheClaim(key, undefined, true); return [{ url: 'late' }]; });
      console.log(JSON.stringify({ current: cacheGet(key), calls, writes }));
    `);
    expect(result.current.status).toBe('minting');
    expect(result.writes).toHaveLength(1);
  });

  test('an older resolver without vacant-claim support is never used for recovery', () => {
    const result = run(`
      const local = await cache.getOrCreate(key, async () => { now += 31000; return [{ url: 'local' }]; });
      console.log(JSON.stringify({ local, calls, writes }));
    `, true);
    expect(result.local).toEqual([{ url: 'local' }]);
    expect(result.calls.some(call => call.vacant)).toBe(false);
    expect(result.writes).toHaveLength(1);
  });

  test('if the fresh lease also expires, publication does not loop', () => {
    const result = run(`
      const local = await cache.getOrCreate(key, async () => { now += 31000; return [{ url: 'local' }]; });
      console.log(JSON.stringify({ local, current: cacheGet(key), calls, writes }));
    `, false, true);
    expect(result.local).toEqual([{ url: 'local' }]);
    expect(result.current.status).toBe('miss');
    expect(result.calls.filter(call => call.vacant)).toHaveLength(1);
    expect(result.writes).toHaveLength(2);
    expect(result.writes[1].result.reason).toBe('stale-owner');
  });
});
