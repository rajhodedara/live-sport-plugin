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
        } else if (options.method === 'PATCH') result = cacheDelete(target, undefined, url.searchParams.get('revision') || '');
        else if (options.method === 'DELETE') result = cacheDelete(target, url.searchParams.get('ownerToken'));
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

test('cold worker B inherits verified event candidate from worker A via shared L2, leaves no negative L2 entry on temporary miss, misses changed kickoff, and invalidates expired token', () => {
  const result = sharedScenario(`
    const emitJson = console.log.bind(console);
    console.log = () => {};
    console.warn = () => {};
    console.info = () => {};
    const outboundId = require.resolve('./src/services/ProviderOutbound');
    const wasmId = require.resolve('./src/services/StreamedWasmPool');
    const timingId = require.resolve('./src/services/TimingRuntime');
    const catalogId = require.resolve('./src/catalog');

    const PLAYLIST = '#EXTM3U\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:12\\n#EXTINF:4,\\nsegment.ts\\n';
    let releaseNhl11;
    let nhl11Resolves = 0;
    let deadResolves = 0;
    let tmpResolves = 0;
    let currentToken = 'tok-v1';

    require.cache[outboundId] = {
      id: outboundId,
      filename: outboundId,
      loaded: true,
      exports: {
        safeFetch: async (url) => {
          const target = String(url);
          if (target.includes('/stream/tv/')) {
            const id = decodeURIComponent(target.split('/stream/tv/')[1].replace(/\\.json$/, ''));
            if (id === 'trex:836411') {
              nhl11Resolves += 1;
              if (nhl11Resolves === 1 && releaseNhl11 === undefined) {
                await new Promise((r) => { releaseNhl11 = r; });
              }
              return { ok: true, status: 200, json: async () => ({ streams: [{ name: '▶ Watch Live', title: id, url: 'https://cdn.fixture.test/nhl11-' + currentToken + '.m3u8' }] }) };
            }
            if (id === 'trex:tmp') {
              tmpResolves += 1;
              const err = new Error('upstream timed out');
              err.name = 'TimeoutError';
              err.code = 'ETIMEDOUT';
              throw err;
            }
            if (id === 'trex:dead') {
              deadResolves += 1;
              return { ok: false, status: 404, statusText: 'Not Found' };
            }
            return { ok: true, status: 200, json: async () => ({ streams: [{ name: '▶ Watch Live', title: id, url: 'https://cdn.fixture.test/' + encodeURIComponent(id) + '.m3u8' }] }) };
          }
          return { status: 200, text: async () => PLAYLIST };
        },
        streamingFetch: async () => ({
          ok: true,
          status: 206,
          headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'video/mp2t' : '1024') },
          body: {
            getReader: () => {
              let done = false;
              return {
                read: async () => (done ? { done: true } : (done = true, { done: false, value: new Uint8Array(64) })),
                cancel: async () => {},
                releaseLock: () => {}
              };
            }
          }
        })
      }
    };
    require.cache[wasmId] = { id: wasmId, filename: wasmId, loaded: true, exports: { resolveWasmStream: () => { throw new Error('Unexpected WASM'); } } };
    require.cache[timingId] = { id: timingId, filename: timingId, loaded: true, exports: { relations: null } };
    require.cache[catalogId] = { id: catalogId, filename: catalogId, loaded: true, exports: { isReplayMatch: () => false } };

    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    process.env.KAFKA_ENABLED = 'true';
    process.env.KAFKA_MANIFEST_URL = 'https://trex.invalid/manifest.json';
    process.env.KAFKA_EVENT_SEARCH_ENABLED = 'true';
    process.env.KAFKA_EVENT_PROBE_CONCURRENCY = '4';
    process.env.KAFKA_EVENT_JOB_TIMEOUT_MS = '5000';
    process.env.DONATION_URL = 'disabled';
    process.env.STREAM_SOFT_DEADLINE_MS = '40';
    process.env.STREAM_HARD_DEADLINE_MS = '80';

    const container = require('./src/container');
    const KafkaProvider = require('./src/providers/KafkaProvider');
    const M3U8ParserService = require('./src/services/M3U8ParserService');
    const StreamScoringService = require('./src/services/StreamScoringService');
    const { handleStream } = require('./src/streams');

    const kickoff = Date.UTC(2026, 10, 26, 1, 0);
    let matchDate = String(kickoff);
    const makeMatch = () => ({
      id: 'shared-ev-1',
      title: 'Utah Mammoth vs Minnesota Wild',
      category: 'hockey',
      league: 'NHL',
      status: 'live',
      date: matchDate,
      team1: { name: 'Utah Mammoth' },
      team2: { name: 'Minnesota Wild' },
      sources: [{ source: 'kafka', id: 'trex:label', channelName: 'NHL Network', country: 'USA', matchMode: 'label' }]
    });
    const candidates = [
      { id: 'trex:836411', name: 'Live | Utah Mammoth vs Minnesota Wild | US: NHL 11', score: 9500 },
      { id: 'trex:tmp', name: 'Live | Utah Mammoth vs Minnesota Wild | US: TMP', score: 9000 },
      { id: 'trex:dead', name: 'Live | Utah Mammoth vs Minnesota Wild | US: DEAD', score: 8500 }
    ];
    const makeProvider = () => new KafkaProvider({
      catalogStore: { isReady: () => true, findEvents: () => candidates, findChannel: () => [], findTeam: () => [] },
      eventSearch: { cachedFor: () => [], findForFixture: async () => [], isInWindow: () => true }
    });

    // Real Date.now inside streams/timers while tracking elapsed cleanly
    Date.now = Date.__origNow || (() => globalThis.performance.timeOrigin + globalThis.performance.now());

    const cacheA = new Cache({ sharedResolver });
    const cacheB = new Cache({ sharedResolver });
    const providerA = makeProvider();
    const providerB = makeProvider();
    let probeSlotsUsedB = 0;
    const origWithB = providerB.withEventProbe.bind(providerB);
    providerB.withEventProbe = (fn, sig) => origWithB(async () => { probeSlotsUsedB += 1; return fn(); }, sig);

    const servicesA = { cacheService: { findMatch: makeMatch }, kafkaProvider: providerA, streamResolveCache: cacheA, m3u8Parser: new M3U8ParserService(), streamScorer: new StreamScoringService() };
    const servicesB = { cacheService: { findMatch: makeMatch }, kafkaProvider: providerB, streamResolveCache: cacheB, m3u8Parser: new M3U8ParserService(), streamScorer: new StreamScoringService() };

    container.resolve = (name) => servicesA[name];
    const reqA = handleStream('tv', 'nuvio_sport_shared-ev-1', {});
    await new Promise((r) => setTimeout(r, 120));
    const firstA = await reqA;

    releaseNhl11();
    const waitStart = Date.now();
    while (Date.now() - waitStart < 2500) {
      await new Promise((r) => setTimeout(r, 50));
      if (cacheGet('kafka:shared-ev-1:trex:836411:event-v4:' + kickoff).status === 'ok' &&
          cacheGet('kafka:shared-ev-1:trex:tmp:event-v4:' + kickoff).status === 'miss' &&
          cacheGet('kafka:shared-ev-1:trex:dead:event-v4:' + kickoff).status === 'failed') {
        break;
      }
    }

    const nhl11Key = 'kafka:shared-ev-1:trex:836411:event-v4:' + kickoff;
    const tmpKey = 'kafka:shared-ev-1:trex:tmp:event-v4:' + kickoff;
    const deadKey = 'kafka:shared-ev-1:trex:dead:event-v4:' + kickoff;
    const nhl11RemoteBeforeB = cacheGet(nhl11Key);
    const tmpRemoteBeforeB = cacheGet(tmpKey);
    const deadRemoteBeforeB = cacheGet(deadKey);

    // Cold worker B reads verified NHL 11 via L2 without another upstream mint.
    // Note: tmp still failed on A (no L2 negative entry), so B retries tmp cleanly.
    const nhl11ResolvesBeforeB = nhl11Resolves;
    const deadResolvesBeforeB = deadResolves;
    container.resolve = (name) => servicesB[name];
    process.env.STREAM_SOFT_DEADLINE_MS = '250';
    process.env.STREAM_HARD_DEADLINE_MS = '400';
    const coldB = await handleStream('tv', 'nuvio_sport_shared-ev-1', {});
    await new Promise((r) => setTimeout(r, 100));
    const nhl11ResolvesAfterB = nhl11Resolves;
    const deadResolvesAfterB = deadResolves;

    // Expire token on A -> invalidates both A's coordinator snapshot and L2!
    cacheA.noteFailure(nhl11Key);
    await new Promise((r) => setTimeout(r, 20));
    currentToken = 'tok-v2';
    const remoteAfterInvalidate = cacheGet(nhl11Key);
    container.resolve = (name) => servicesA[name];
    process.env.STREAM_SOFT_DEADLINE_MS = '250';
    process.env.STREAM_HARD_DEADLINE_MS = '400';
    const refreshedA = await handleStream('tv', 'nuvio_sport_shared-ev-1', {});

    // Changed fixture date misses candidate key!
    matchDate = String(kickoff + 3600000);
    currentToken = 'tok-v3';
    container.resolve = (name) => servicesB[name];
    const nextDateB = await handleStream('tv', 'nuvio_sport_shared-ev-1', {});

    emitJson(JSON.stringify({
      firstAHasNhl11: firstA.streams.some((s) => s.url && s.url.includes('nhl11-tok-v1')),
      firstACacheMaxAge: firstA.cacheMaxAge,
      nhl11RemoteOk: nhl11RemoteBeforeB && nhl11RemoteBeforeB.status === 'ok',
      tmpRemoteMiss: tmpRemoteBeforeB && tmpRemoteBeforeB.status === 'miss',
      deadRemoteFailed: deadRemoteBeforeB && deadRemoteBeforeB.status === 'failed',
      coldBHasNhl11: coldB.streams.some((s) => s.url && s.url.includes('nhl11-tok-v1')),
      nhl11ResolvesBeforeB,
      nhl11ResolvesAfterB,
      deadResolvesBeforeB,
      deadResolvesAfterB,
      probeSlotsUsedB,
      remoteAfterInvalidateStatus: remoteAfterInvalidate ? remoteAfterInvalidate.status : 'miss',
      refreshedAHasV1: refreshedA.streams.some((s) => s.url && s.url.includes('nhl11-tok-v1')),
      refreshedAHasV2: refreshedA.streams.some((s) => s.url && s.url.includes('nhl11-tok-v2')),
      refreshedAUrls: refreshedA.streams.map((s) => s.url),
      nhl11ResolvesAfterA: nhl11Resolves,
      nextDateBHasV3: nextDateB.streams.some((s) => s.url && s.url.includes('nhl11-tok-v3'))
    }));
    process.exit(0);
  `);
  expect(result).toMatchObject({
    firstAHasNhl11: false,
    firstACacheMaxAge: 2,
    nhl11RemoteOk: true,
    tmpRemoteMiss: true,
    deadRemoteFailed: true,
    coldBHasNhl11: true,
    nhl11ResolvesBeforeB: 1,
    nhl11ResolvesAfterB: 1,
    refreshedAHasV1: false,
    refreshedAHasV2: true,
    nextDateBHasV3: true
  });
  expect(result.deadResolvesAfterB).toBe(result.deadResolvesBeforeB);
  expect(result.remoteAfterInvalidateStatus).not.toBe('ok');
});

test('shared L2 minting wait neither extends HTTP deadline nor acquires semaphore/mint after job deadline', () => {
  const result = sharedScenario(`
    const emitJson = console.log.bind(console);
    console.log = () => {};
    console.warn = () => {};
    console.info = () => {};
    const outboundId = require.resolve('./src/services/ProviderOutbound');
    const wasmId = require.resolve('./src/services/StreamedWasmPool');
    const timingId = require.resolve('./src/services/TimingRuntime');
    const catalogId = require.resolve('./src/catalog');

    let upstreamMintCalls = 0;
    const PLAYLIST = '#EXTM3U\\n#EXT-X-TARGETDURATION:4\\n#EXTINF:4,\\nsegment.ts\\n';
    require.cache[outboundId] = {
      id: outboundId,
      filename: outboundId,
      loaded: true,
      exports: {
        safeFetch: async (url) => {
          const target = String(url);
          if (target.includes('/stream/tv/')) {
            const id = decodeURIComponent(target.split('/stream/tv/')[1].replace(/\\.json$/, ''));
            if (id === 'trex:slow-l2') upstreamMintCalls += 1;
            return { ok: true, status: 200, json: async () => ({ streams: [{ name: '▶ Watch Live', url: 'https://cdn.fixture.test/' + encodeURIComponent(id) + '.m3u8' }] }) };
          }
          return { status: 200, text: async () => PLAYLIST };
        },
        streamingFetch: async () => ({
          ok: true,
          status: 206,
          headers: { get: () => '1024' },
          body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : (done = true, { done: false, value: new Uint8Array(64) })), cancel: async () => {}, releaseLock: () => {} }; } }
        })
      }
    };
    require.cache[wasmId] = { id: wasmId, filename: wasmId, loaded: true, exports: { resolveWasmStream: () => { throw new Error('Unexpected WASM'); } } };
    require.cache[timingId] = { id: timingId, filename: timingId, loaded: true, exports: { relations: null } };
    require.cache[catalogId] = { id: catalogId, filename: catalogId, loaded: true, exports: { isReplayMatch: () => false } };

    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    process.env.KAFKA_ENABLED = 'true';
    process.env.KAFKA_MANIFEST_URL = 'https://trex.invalid/manifest.json';
    process.env.KAFKA_EVENT_SEARCH_ENABLED = 'true';
    process.env.KAFKA_EVENT_PROBE_CONCURRENCY = '4';
    process.env.KAFKA_EVENT_JOB_TIMEOUT_MS = '180';
    process.env.DONATION_URL = 'disabled';
    process.env.STREAM_SOFT_DEADLINE_MS = '60';
    process.env.STREAM_HARD_DEADLINE_MS = '120';

    const container = require('./src/container');
    const KafkaProvider = require('./src/providers/KafkaProvider');
    const M3U8ParserService = require('./src/services/M3U8ParserService');
    const StreamScoringService = require('./src/services/StreamScoringService');
    const { handleStream } = require('./src/streams');

    Date.now = () => Math.floor(globalThis.performance.timeOrigin + globalThis.performance.now());
    const kickoff = Date.UTC(2026, 10, 26, 2, 0);
    const match = {
      id: 'wait-deadline-fx',
      title: 'Boston Celtics vs Miami Heat',
      category: 'basketball',
      league: 'NBA',
      status: 'live',
      date: String(kickoff),
      team1: { name: 'Boston Celtics' },
      team2: { name: 'Miami Heat' },
      sources: [{ source: 'kafka', id: 'trex:label', channelName: 'NBA TV', country: 'USA', matchMode: 'label' }]
    };

    cacheClaim('kafka:wait-deadline-fx:trex:slow-l2:event-v4:' + kickoff, undefined, true, false);

    const providerB = new KafkaProvider({
      catalogStore: { isReady: () => true, findEvents: () => [{ id: 'trex:slow-l2', name: 'Live | Boston Celtics vs Miami Heat | PPV 1', score: 9000 }], findChannel: () => [], findTeam: () => [] },
      eventSearch: { cachedFor: () => [], findForFixture: async () => [], isInWindow: () => true }
    });
    let slotsAcquired = 0;
    const origWith = providerB.withEventProbe.bind(providerB);
    providerB.withEventProbe = (fn, sig) => origWith(async () => { slotsAcquired += 1; return fn(); }, sig);

    const cacheB = new Cache({ sharedResolver });
    container.resolve = (name) => ({
      cacheService: { findMatch: () => match },
      kafkaProvider: providerB,
      streamResolveCache: cacheB,
      m3u8Parser: new M3U8ParserService(),
      streamScorer: new StreamScoringService()
    })[name];

    const startedAt = Date.now();
    const res = await handleStream('tv', 'nuvio_sport_wait-deadline-fx', {});
    const elapsedMs = Date.now() - startedAt;

    await new Promise((r) => setTimeout(r, 500));

    emitJson(JSON.stringify({
      elapsedMs,
      hasLabel: res.streams.some((s) => s._kafkaMatchMode === 'label'),
      cacheMaxAge: res.cacheMaxAge,
      slotsAcquired,
      upstreamMintCalls
    }));
    process.exit(0);
  `);
  expect(result.hasLabel).toBe(true);
  expect(result.cacheMaxAge).toBe(2);
  expect(result.elapsedMs).toBeLessThan(1500);
  expect(result.slotsAcquired).toBe(0);
  expect(result.upstreamMintCalls).toBe(0);
});
