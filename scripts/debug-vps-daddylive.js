#!/usr/bin/env node
/**
 * VPS Debug Script — DaddyLive Stream Pipeline
 * Run on VPS: node scripts/debug-vps-daddylive.js
 * Shows exactly where streams are being dropped.
 */

const container = require('../src/container');

(async () => {
  console.log('\n========================================');
  console.log('  DADDYLIVE STREAM DEBUG — VPS');
  console.log('========================================\n');

  // ── 1. Provider health ──────────────────────────────────────────────────────
  const provider = container.resolve('daddyLiveProvider');
  console.log('[1] Fetching DaddyLive schedule...');
  let dlMatches = [];
  try {
    dlMatches = await provider.getMatches();
    console.log(`    ✅ Got ${dlMatches.length} matches from provider`);
  } catch (e) {
    console.log(`    ❌ getMatches() threw: ${e.message}`);
    process.exit(1);
  }

  if (dlMatches.length === 0) {
    console.log('    ❌ No DaddyLive matches returned — schedule fetch failing');
    process.exit(1);
  }

  // Show top 3 matches
  console.log('    Sample matches:');
  dlMatches.slice(0, 3).forEach(m => {
    console.log(`      • [${m.id}] ${m.title}`);
    console.log(`        sources: ${JSON.stringify(m.sources)}`);
  });

  // ── 2. Pick a test match ────────────────────────────────────────────────────
  // Prefer a live or upcoming one
  const now = Date.now();
  const testMatch = dlMatches.find(m => {
    if (!m.date) return true;
    const d = Number(m.date) || new Date(m.date).getTime();
    return d > now - 3 * 3600 * 1000;
  }) || dlMatches[0];

  const testSrc = testMatch.sources[0];
  console.log(`\n[2] Testing resolveStream for: ${testMatch.title}`);
  console.log(`    Source ID: ${testSrc.id}  channel: ${testSrc.channelName}`);

  // ── 3. Raw resolveStream (no verifyStreams) ─────────────────────────────────
  console.log('\n[3] Calling provider.resolveStream() directly (bypasses verifyStreams)...');
  let rawStreams = [];
  try {
    rawStreams = await provider.resolveStream(testSrc.id, testMatch.category, testMatch.title, testSrc);
    console.log(`    Raw streams returned: ${rawStreams.length}`);
    rawStreams.forEach((s, i) => {
      const urlPart = (s.url || s.externalUrl || '').slice(0, 90);
      console.log(`    [${i}] ${s.name || s.title} → ${urlPart}`);
    });
  } catch (e) {
    console.log(`    ❌ resolveStream threw: ${e.message}`);
    console.error(e.stack);
  }

  if (rawStreams.length === 0) {
    console.log('\n    ⚠️  PROBLEM IS IN resolveStream() — provider failed to decode any m3u8');
    console.log('    The DaddyLive site structure may have changed, or dlive.sx is blocking VPS IP.\n');
    
    // Try to fetch dlive.sx directly
    console.log('[4] Testing raw dlive.sx fetch from VPS...');
    try {
      const { safeFetch } = require('../src/impitClient');
      const testUrl = `https://dlive.sx/stream/stream-${testSrc.id}.php`;
      console.log(`    GET ${testUrl}`);
      const r = await safeFetch(testUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Referer': 'https://dlive.sx/'
        },
        timeoutMs: 8000,
        attempts: 1,
      });
      const body = await r.text();
      console.log(`    HTTP ${r.status} | body length: ${body.length}`);
      console.log(`    Has iframe: ${body.includes('<iframe')}`);
      console.log(`    Has m3u8: ${body.includes('.m3u8')}`);
      if (r.status !== 200) {
        console.log(`    ❌ dlive.sx returning ${r.status} — VPS IP is BLOCKED by DaddyLive`);
      } else {
        console.log(`    ✅ dlive.sx reachable — problem is deeper in extraction`);
        const iframeMatch = body.match(/<iframe[^>]+src=["']?([^"'\s>]+)/i);
        if (iframeMatch) console.log(`    Iframe src: ${iframeMatch[1]}`);
      }
    } catch (e) {
      console.log(`    ❌ fetch failed: ${e.message}`);
    }
    process.exit(0);
  }

  // ── 4. Run verifyStreams and watch what gets dropped ────────────────────────
  console.log('\n[4] Running verifyStreams on raw streams...');
  // Set _source exactly as resolveSource does in production — verifyStreams reads this to skip preflight
  rawStreams.forEach(s => { s._source = 'daddylive'; });
  const { verifyStreams } = require('../src/streams');
  const m3u8Parser = container.resolve('m3u8Parser');
  const resolveCache = container.resolve('streamResolveCache');

  // Monkey-patch console.log temporarily to capture filter messages
  const filterLogs = [];
  const origLog = console.log;
  const patchLog = (...args) => {
    const msg = args.join(' ');
    if (msg.includes('[Filter]')) filterLogs.push(msg);
    origLog(...args);
  };
  console.log = patchLog;

  let verified = [];
  try {
    verified = await verifyStreams(rawStreams, null, m3u8Parser, resolveCache, {});
  } finally {
    console.log = origLog;
  }

  console.log(`\n    Raw: ${rawStreams.length} → Verified: ${verified.length}`);
  if (filterLogs.length > 0) {
    console.log('\n    ⚠️  Filter log (what got dropped and why):');
    filterLogs.forEach(l => console.log('   ', l));
  }

  if (verified.length === 0) {
    console.log('\n    ❌ PROBLEM IS IN verifyStreams() — streams are being dropped during preflight');
    if (filterLogs.some(l => l.includes('403'))) {
      console.log('    ➜  Cause: 403 from CDN during preflight ping');
      console.log('    ➜  Fix: exempt daddylive source from verifyStreams the same way cdnlive is');
    }
    if (filterLogs.some(l => l.includes('404'))) {
      console.log('    ➜  Cause: 404 — stream token expired before verify ran');
    }
  } else {
    console.log('\n    ✅ Streams survive verifyStreams — problem is elsewhere (catalog/cache)');
    verified.forEach((s, i) => {
      const urlPart = (s.url || s.externalUrl || '').slice(0, 80);
      console.log(`    [${i}] ${s.name}: ${urlPart}`);
    });
  }

  // ── 5. Full handleStream round-trip ────────────────────────────────────────
  console.log('\n[5] Full handleStream() round-trip...');
  const cache = container.resolve('cacheService');
  cache.setMatches(dlMatches);
  const { handleStream } = require('../src/streams');
  const fullId = 'nuvio_sport_' + testMatch.id;
  try {
    const result = await handleStream('tv', fullId, {});
    console.log(`    handleStream returned ${result.streams.length} streams for: ${fullId}`);
    if (result.streams.length === 0) {
      console.log('    ❌ ZERO streams after full pipeline');
    } else {
      result.streams.forEach((s, i) => {
        const urlPart = (s.url || s.externalUrl || '').slice(0, 80);
        console.log(`    [${i}] ${s.name}: ${urlPart}`);
      });
    }
  } catch (e) {
    console.log(`    ❌ handleStream threw: ${e.message}`);
  }

  // ── 6. Environment check ────────────────────────────────────────────────────
  console.log('\n[6] Environment:');
  console.log(`    NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`    BASE_URL: ${process.env.BASE_URL}`);
  console.log(`    LOW_MEMORY_MODE: ${process.env.LOW_MEMORY_MODE}`);
  console.log(`    VERIFY_TIMEOUT_MS: ${process.env.VERIFY_TIMEOUT_MS || '5000 (default)'}`);
  console.log(`    ENABLE_SPEED_PROBE: ${process.env.ENABLE_SPEED_PROBE || 'true (default)'}`);

  const health = container.resolve('streamResolveCache');
  const stats = health._stats ? health._stats() : { note: 'no stats method' };
  console.log(`    StreamResolveCache: ${JSON.stringify(stats)}`);

  console.log('\n========================================\n');
  process.exit(0);
})().catch(e => {
  console.error('\n[FATAL]', e.stack || e.message);
  process.exit(1);
});
