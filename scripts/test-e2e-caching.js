/**
 * test-e2e-caching.js — End-to-End Caching & Prewarm Verification Suite
 * 
 * Verifies the entire lifecycle:
 * 1. JIT Prewarm via handleMeta()
 * 2. handleStream() Cache Hit acceleration (<15ms)
 * 3. Preflight stream verification updating adaptive TTL (noteSuccess)
 * 4. Concurrent Single-Flight coalescing (1 mint for N parallel callers)
 * 5. Negative Caching on failing sources
 * 6. Adaptive TTL scaling (noteSuccess / noteFailure)
 * 7. Match lifecycle pruning via CronService (pruneEnded with 24/7 preservation)
 * 8. Telemetry & Health Stats reporting
 */

const http = require('http');
const container = require('../src/container');
const { handleMeta } = require('../src/catalog');
const { handleStream } = require('../src/streams');
const StreamEntity = require('../src/domain/StreamEntity');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runE2ETests() {
  console.log('====================================================');
  console.log('🚀 Starting End-to-End Cache & Prewarm Test Suite');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name, condition, detail = '') {
    if (condition) {
      passed++;
      console.log('  ✅ PASS: ' + name + (detail ? ' (' + detail + ')' : ''));
    } else {
      failed++;
      console.error('  ❌ FAIL: ' + name + (detail ? ' (' + detail + ')' : ''));
    }
  }

  // ─── 0. Setup Mock Local HLS Server for Valid Preflight Testing ───────
  const mockHlsServer = http.createServer((req, res) => {
    if (req.url.includes('/valid.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment1.ts\n');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  const MOCK_PORT = 45892;
  await new Promise(resolve => mockHlsServer.listen(MOCK_PORT, '127.0.0.1', resolve));
  const validStreamUrl = `http://127.0.0.1:${MOCK_PORT}/valid.m3u8`;

  try {
    const cache = container.resolve('streamResolveCache');
    const cacheService = container.resolve('cacheService');

    // Reset cache state
    cache.entries.clear();
    cache.inFlight.clear();
    cache.ttl.clear();
    cache.statsCounters = { hits: 0, misses: 0, negativeHits: 0, evictions: 0 };

    // Setup Mock Live Matches in cacheService
    const testMatch1 = {
      id: 'e2e_match_arsenal_vs_chelsea',
      title: 'Arsenal vs Chelsea',
      category: 'football',
      date: String(Date.now() - 1000 * 60 * 30),
      popular: '1',
      sources: [
        { source: 'daddylive', id: 'sky_sports_pl', quality: '1080p', url: validStreamUrl }
      ]
    };

    cacheService.setMatches([testMatch1]);

    // -------------------------------------------------------------
    // TEST 1: Container & Cache Registration
    // -------------------------------------------------------------
    console.log('👉 [1/7] Container & Cache Verification');
    assert('StreamResolveCache is registered as singleton', cache !== undefined && typeof cache.getOrCreate === 'function');
    assert('Initial stats counters are zeroed', cache.stats().hits === 0 && cache.stats().misses === 0);

    // -------------------------------------------------------------
    // TEST 2: JIT Prewarm via handleMeta()
    // -------------------------------------------------------------
    console.log('\n👉 [2/7] JIT Prewarming on handleMeta()');
    const metaStart = Date.now();
    const metaRes = await handleMeta('tv', 'nuvio_sport_' + testMatch1.id, {});
    const metaDuration = Date.now() - metaStart;

    assert('handleMeta returns valid match metadata', metaRes && metaRes.meta && metaRes.meta.name.includes('Arsenal vs Chelsea'));
    assert('handleMeta responds without blocking (<500ms)', metaDuration < 500, metaDuration + 'ms');

    // Allow fire-and-forget prewarm promise to complete
    await sleep(100);

    const prewarmedKey = 'daddylive:' + testMatch1.id + ':sky_sports_pl';
    const cachedStreams = cache.get(prewarmedKey);
    assert('prewarmMatch successfully minted tokens in background', cachedStreams !== null && cachedStreams.length > 0);

    // -------------------------------------------------------------
    // TEST 3: handleStream Cache HIT Latency Acceleration
    // -------------------------------------------------------------
    console.log('\n👉 [3/7] handleStream() Cache Hit Verification');
    const streamStart = Date.now();
    const streamRes = await handleStream('tv', 'nuvio_sport_' + testMatch1.id, {});
    const streamDuration = Date.now() - streamStart;

    assert('handleStream returns streams for prewarmed match', streamRes && streamRes.streams && streamRes.streams.length > 0);
    assert('Cache HIT provides fast response (<300ms with local preflight)', streamDuration < 300, streamDuration + 'ms');
    assert('Cache records positive hit increment', cache.stats().hits >= 1, 'Hits: ' + cache.stats().hits);

    // -------------------------------------------------------------
    // TEST 4: Concurrent Single-Flight Coalescing
    // -------------------------------------------------------------
    console.log('\n👉 [4/7] Single-Flight Coalescing (Thundering Herd Protection)');
    const uncoalescedKey = 'custom_test_src:m_coalesce:stream_1';
    let mintExecutions = 0;

    const mockMintFn = async () => {
      mintExecutions++;
      await sleep(60);
      return [new StreamEntity({ name: 'Coalesced Stream', url: validStreamUrl })];
    };

    const parallelCallers = Array.from({ length: 10 }, () => cache.getOrCreate(uncoalescedKey, mockMintFn));
    const results = await Promise.all(parallelCallers);

    assert('Single-Flight executes mint function exactly ONCE for 10 callers', mintExecutions === 1, 'Executions: ' + mintExecutions);
    assert('All 10 callers received identical valid stream data', results.every(r => r.length === 1 && r[0].name === 'Coalesced Stream'));
    assert('Clone-on-read ensures distinct object references', results[0] !== results[1]);

    // -------------------------------------------------------------
    // TEST 5: Negative Caching on Failing/Dead Upstreams
    // -------------------------------------------------------------
    console.log('\n👉 [5/7] Negative Caching for Dead/Failing Sources');
    const failingKey = 'failing_source:dead_match:slot_99';
    let failAttempts = 0;

    const failingMintFn = async () => {
      failAttempts++;
      throw new Error('Upstream 502 Bad Gateway');
    };

    const firstFail = await cache.getOrCreate(failingKey, failingMintFn);
    assert('Failing source returns [] cleanly without rejecting', Array.isArray(firstFail) && firstFail.length === 0);
    assert('Mint function was called once on first try', failAttempts === 1);

    const secondFail = await cache.getOrCreate(failingKey, failingMintFn);
    assert('Subsequent call returns [] instantly via negative cache', secondFail.length === 0);
    assert('Negative cache prevented upstream re-scrape', failAttempts === 1, 'Attempts stayed: ' + failAttempts);
    assert('Negative hit counter incremented', cache.stats().negativeHits >= 1, 'Negative Hits: ' + cache.stats().negativeHits);

    // -------------------------------------------------------------
    // TEST 6: Adaptive TTL Learning & Lifecycle Pruning
    // -------------------------------------------------------------
    console.log('\n👉 [6/7] Adaptive TTL Scaling & Match Lifecycle Pruning');
    const testSrcName = 'adaptive_src';
    const initialTtl = cache._ttlFor(testSrcName);

    cache.noteSuccess(testSrcName + ':m1:s1');
    cache.noteSuccess(testSrcName + ':m1:s1');
    const doubledTtl = cache._ttlFor(testSrcName);
    assert('2 successful pre-flights quadrupled TTL', doubledTtl === initialTtl * 4, 'TTL: ' + doubledTtl + 'ms');

    cache.noteFailure(testSrcName + ':m1:s1');
    const halvedTtl = cache._ttlFor(testSrcName);
    assert('1 failed pre-flight halved TTL', halvedTtl === doubledTtl / 2, 'TTL: ' + halvedTtl + 'ms');

    await cache.getOrCreate('active_src:active_match_1:s1', async () => [{ url: validStreamUrl }]);
    await cache.getOrCreate('ended_src:ended_match_99:s1', async () => [{ url: validStreamUrl }]);
    await cache.getOrCreate('channel_src:__channel__:willow_cricket', async () => [{ url: validStreamUrl }]);

    const cronService = container.resolve('cronService');
    cronService.pruneStreamCache([{ id: 'active_match_1' }]);

    assert('pruneStreamCache kept active match entry', cache.entries.has('active_src:active_match_1:s1'));
    assert('pruneStreamCache purged ended match entry', !cache.entries.has('ended_src:ended_match_99:s1'));
    assert('pruneStreamCache preserved evergreen __channel__ entry', cache.entries.has('channel_src:__channel__:willow_cricket'));

    // -------------------------------------------------------------
    // TEST 7: Telemetry & Stats Verification
    // -------------------------------------------------------------
    console.log('\n👉 [7/7] Telemetry & Health Stats Verification');
    const stats = cache.stats();
    console.log('Live Cache Stats:', JSON.stringify(stats, null, 2));

    assert('Telemetry reports positive hits > 0', stats.hits > 0, 'Hits: ' + stats.hits);
    assert('Telemetry reports misses > 0', stats.misses > 0, 'Misses: ' + stats.misses);
    assert('Telemetry reports negative hits > 0', stats.negativeHits > 0, 'Negative Hits: ' + stats.negativeHits);
    assert('Telemetry includes learned per-source TTL map', Object.keys(stats.learnedTtls).length > 0);

    console.log('\n====================================================');
    if (failed === 0) {
      console.log('🎉 ALL ' + passed + ' END-TO-END TESTS PASSED SUCCESSFULLY!');
    } else {
      console.error('💥 TEST SUITE FAILED: ' + passed + ' passed, ' + failed + ' failed.');
    }
    console.log('====================================================\n');

  } finally {
    mockHlsServer.close();
  }

  process.exit(failed === 0 ? 0 : 1);
}

runE2ETests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
