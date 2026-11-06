'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Actual worker caches and actual resolver table, joined by an in-memory
// adapter. The subprocess only loads these pure modules; it starts no server.
function sharedScenario(body) {
  const root = path.join(__dirname, '..');
  return JSON.parse(execFileSync(process.execPath, [
    '--require', path.join(root, 'tests/fixtures/pr59-offline-boundary.cjs'),
    '--input-type=module', '--eval', `
      import { createRequire } from 'node:module';
      import { cacheGet, cacheClaim, cacheSet, cacheDelete } from './resolver/src/cache.js';
      const require = createRequire(import.meta.url);
      const Cache = require('./src/services/StreamResolveCache');
      const { markInconclusiveStreams, DIRECT_RETRY_HINT } = require('./src/services/StreamResolutionOutcome');
      process.env.RESOLVE_CACHE_SHARED = 'true';
      let now = 100000; Date.now = () => now;
      const key = 'ppvst:fixture:channel', calls = [];
      global.fetch = () => { throw Error('Unexpected network'); };
      const sharedResolver = { available: () => true, request: async (raw, options = {}) => {
        const url = new URL(raw), target = decodeURIComponent(url.pathname.slice('/api/cache/'.length));
        const call = { method: options.method || 'GET' }; calls.push(call);
        let result;
        if (url.searchParams.get('claim') === '1') result = cacheClaim(target, undefined, true, url.searchParams.get('vacant') === '1');
        else if (options.method === 'POST') {
          const data = JSON.parse(options.body);
          call.status = data.status; call.ttlMs = data.ttlMs;
          call.hasRetryHint = data.streams.some(row => Object.hasOwn(row, DIRECT_RETRY_HINT));
          result = cacheSet(target, data.streams, data.ttlMs, data.status, data.ownerToken);
        } else if (options.method === 'DELETE') result = cacheDelete(target, url.searchParams.get('ownerToken'));
        else result = cacheGet(target);
        return { ok: true, json: async () => result };
      } };
      ${body}
    `
  ], { cwd: root, encoding: 'utf8', timeout: 5000 }));
}

test('a second worker inherits short direct retry without leaking the cache hint or publishing a failure', () => {
  const result = sharedScenario(`
    const a = new Cache({sharedResolver});
    const first = await a.getOrCreate(key, async () => markInconclusiveStreams([{externalUrl:'/watch?url=fixture'}], 'capacity'));
    const remoteFirst = cacheGet(key);
    const b = new Cache({sharedResolver});
    let mints = 0;
    const inherited = await b.getOrCreate(key, async () => { mints++; return []; });
    const inheritedDeferred = b.isDeferred(key), inheritedTtl = b.getRemainingTtl(key);
    now += 2000;
    const recovered = await b.getOrCreate(key, async () => { mints++; return [{url:'https://cdn.fixture.test/recovered.m3u8'}]; });
    console.log(JSON.stringify({first,inherited,inheritedDeferred,inheritedTtl,mints,recovered,
      remoteStatus:remoteFirst.status,remoteTtl:remoteFirst.expiresAt-100000,
      finalDeferred:b.isDeferred(key),finalStatus:cacheGet(key).status,calls}));
  `);
  expect(result.first).toEqual([{ externalUrl: '/watch?url=fixture' }]);
  expect(result.inherited).toEqual(result.first);
  expect(result.inheritedDeferred).toBe(true);
  expect(result.inheritedTtl).toBe(2000);
  expect(result.remoteStatus).toBe('ok');
  expect(result.remoteTtl).toBe(2000);
  expect(result.mints).toBe(1); // only the recovery mint; the first read was L2
  expect(result.recovered[0].url).toContain('recovered');
  expect(result.finalDeferred).toBe(false);
  expect(result.finalStatus).toBe('ok');
  const posts = result.calls.filter(call => call.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatchObject({ status: 'ok', ttlMs: 2000, hasRetryHint: true });
  expect(posts[1]).toMatchObject({ status: 'ok', hasRetryHint: false });
  expect(posts.every(call => call.status !== 'failed')).toBe(true);
});

test('a complete web-only answer remains an ordinary positive result across workers', () => {
  const result = sharedScenario(`
    const a = new Cache({sharedResolver});
    await a.getOrCreate(key, async () => [{externalUrl:'/watch?url=fixture'}]);
    const b = new Cache({sharedResolver});
    let mints = 0;
    const rows = await b.getOrCreate(key, async () => {mints++;return [];});
    console.log(JSON.stringify({rows,mints,deferred:b.isDeferred(key),ttl:b.getRemainingTtl(key),calls}));
  `);
  expect(result.mints).toBe(0);
  expect(result.deferred).toBe(false);
  expect(result.ttl).toBe(30000);
  expect(result.calls.filter(call => call.method === 'POST')[0].hasRetryHint).toBe(false);
});

test('retry-shaped fields on a media payload cannot turn it into a pending web result', () => {
  const result = sharedScenario(`
    cacheSet(key, [{url:'https://cdn.fixture.test/live.m3u8',[DIRECT_RETRY_HINT]:'capacity'}], 60000, 'ok');
    const cache = new Cache({sharedResolver});
    const rows = await cache.getOrCreate(key, async () => {throw Error('Unexpected mint');});
    console.log(JSON.stringify({rows,deferred:cache.isDeferred(key),ttl:cache.getRemainingTtl(key)}));
  `);
  expect(result.deferred).toBe(false);
  expect(result.ttl).toBe(60000);
  expect(result.rows).toEqual([{ url: 'https://cdn.fixture.test/live.m3u8' }]);
});
