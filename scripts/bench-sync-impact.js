#!/usr/bin/env node
/**
 * bench-sync-impact.js — before/after benchmark for the sync-path fixes.
 *
 * Modes:
 *   node scripts/bench-sync-impact.js sync
 *       Drives the REAL MatchAggregator.syncMatches() with stub providers at
 *       production catalog scale and measures event-loop stalls (a setImmediate
 *       chain is the stand-in for queued HTTP handlers) plus logo-enrichment
 *       concurrency. No network, no disk writes (cacheService is stubbed).
 *
 *   node scripts/bench-sync-impact.js breaker [--sync-opts]
 *       Fires breaker-wrapped failures at SYNC cadence (one per 10.5s).
 *       Without --sync-opts uses the old default options (pre-fix behaviour).
 *       With --sync-opts uses the cadence-aware options sync-path sites now
 *       pass (post-fix behaviour).
 *
 *   node scripts/bench-sync-impact.js fetch [--new]
 *       Spins up local slow-alive (16s) and hanging servers, then fetches them
 *       the way OLD proxyFetch did (safeFetch directly: no signal, timeoutMs
 *       15000, default attempts) vs, with --new, through the fixed proxyFetch
 *       with an 18s budget + attempts:1 (DaddyLive-style call).
 *
 * Run on the VPS for real-hardware numbers; laptop numbers are directional.
 */
'use strict';

const path = require('path');
const repoRoot = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Event-loop stall monitor ────────────────────────────────────────────────
// A tight setImmediate chain schedules the next tick as soon as the loop is
// free; the gap between consecutive ticks equals the longest synchronous block
// that ran in between. That gap is exactly what an queued HTTP request would
// wait behind.
function startLagMonitor() {
  const gaps = [];
  let prev = Date.now();
  let stopped = false;
  (function tick() {
    if (stopped) return;
    const now = Date.now();
    gaps.push(now - prev);
    prev = now;
    setImmediate(tick);
  })();
  return {
    stop() {
      stopped = true;
      const sorted = [...gaps].sort((a, b) => a - b);
      const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] || 0;
      return {
        samples: sorted.length,
        maxStallMs: sorted[sorted.length - 1] || 0,
        p99Ms: pct(99),
        p50Ms: pct(50),
        stallsOver50ms: gaps.filter((g) => g > 50).length,
        stallsOver100ms: gaps.filter((g) => g > 100).length,
      };
    },
  };
}

// ─── Synthetic catalog at production scale ───────────────────────────────────
const CATS = ['football', 'basketball', 'cricket', 'motorsport', 'hockey', 'baseball', 'mma', 'tennis', 'rugby', 'american_football'];
function mkMatch(i, salt) {
  const cat = CATS[i % CATS.length];
  const t1 = `Team${i}A${salt || ''}`;
  const t2 = `Club${i}B`;
  return {
    id: `prov_${salt || 0}_${i}`,
    title: `${t1} vs ${t2}`,
    category: cat,
    date: Date.now() + (i % 50) * 3600000,
    sources: Array.from({ length: 1 + (i % 3) }, (_, k) => ({
      source: `prov${salt || 0}`, id: `s${i}_${k}`, url: 'https://x/e' + i + '_' + k, name: `Feed ${k}`,
    })),
    poster: 'https://cdn.example.com/posters/' + i + '.jpg',
    league: `League ${i % 30}`,
    team1: { name: t1 }, team2: { name: t2 },
    popular: i % 10 === 0 ? '1' : '0',
  };
}

// ─── Mode: sync (merge + enrichment, real code path) ────────────────────────
async function benchSync() {
  const MatchAggregator = require(path.join(repoRoot, 'src/services/MatchAggregator'));

  const NAMES = ['timstreams', 'streamedpk', 'watchfooty', 'cdnlive', 'replayzone', 'livetv', 'daddylive', 'damitv', 'ppvst', 'prov10'];
  const providers = NAMES.map((name, idx) => ({
    name,
    sourceName: name,
    getMatches: async () => {
      if (idx < 6) return Array.from({ length: 170 }, (_, i) => mkMatch(idx * 5000 + i, idx));
      return Array.from({ length: 250 }, (_, i) => mkMatch((idx - 6) * 5000 + (i % 100), idx));
    },
  }));

  let captured = [];
  const cacheService = {
    lastFetchTime: Date.now(),
    getMatches: () => [],
    setMatches: (m) => { captured = m; },
  };

  let inFlight = 0;
  let maxInFlight = 0;
  const teamLogoService = {
    enrichMatch: async (m) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(25);
      inFlight--;
      return m;
    },
  };

  const agg = new MatchAggregator({
    timStreamsProvider: providers[0],
    streamedPkProvider: providers[1],
    watchFootyProvider: providers[2],
    cdnLiveProvider: providers[3],
    yamlProviders: [],
    replayzoneProvider: providers[4],
    liveTvProvider: providers[5],
    daddyLiveProvider: providers[6],
    damiTvProvider: providers[7],
    ppvStProvider: providers[8],
    streamSports99Provider: providers[9],
    cacheService,
    teamLogoService,
  });

  const monitor = startLagMonitor();
  const t0 = Date.now();
  const result = await agg.syncMatches();
  const wallMs = Date.now() - t0;
  // Wait for any trailing enrichment promises to settle.
  await sleep(1500);
  const lag = monitor.stop();

  console.log('── sync-path benchmark (real syncMatches, stub providers, no network) ──');
  console.log(`catalog: ${captured.length} events, ${captured.reduce((a, m) => a + (m.sources?.length || 0), 0)} sources (result=${Array.isArray(result) ? result.length : result})`);
  console.log(`sync wall time: ${wallMs} ms`);
  console.log(`event-loop stalls during sync: max=${lag.maxStallMs}ms  p99=${lag.p99Ms}ms  p50=${lag.p50Ms}ms  >50ms=${lag.stallsOver50ms}  >100ms=${lag.stallsOver100ms}  (samples=${lag.samples})`);
  console.log(`logo-enrichment max concurrent enrichMatch calls: ${maxInFlight}`);
}

// ─── Mode: breaker at sync cadence ───────────────────────────────────────────
async function benchBreaker(useSyncOpts) {
  const Svc = require(path.join(repoRoot, 'src/services/CircuitBreakerService'));
  const svc = new Svc();
  // The cadence-aware options the sync-path wrap sites pass (post-fix); kept
  // inline here so the same script measures pre-fix behaviour by omission.
  const SYNC_OPTS = {
    rollingCountTimeout: 45 * 60 * 1000,
    rollingCountBuckets: 45,
    volumeThreshold: 3,
    errorThresholdPercentage: 34,
    resetTimeout: 90 * 1000,
  };
  const b = svc.wrap('bench_sync_cadence', async () => { throw new Error('upstream down'); }, useSyncOpts ? SYNC_OPTS : {});
  let opened = false;
  let openedAfterCalls = -1;
  let calls = 0;
  b.on('open', () => { opened = true; openedAfterCalls = calls; });
  for (let i = 0; i < 6 && !opened; i++) {
    calls++;
    await b.fire().catch(() => {});
    await sleep(10500);
  }
  console.log('── breaker benchmark (1 failing call per 10.5s, sync cadence) ──');
  console.log(`options: ${useSyncOpts ? 'cadence-aware (post-fix)' : 'service defaults (pre-fix)'}`);
  console.log(`breaker opened: ${opened}${opened ? ` after ${openedAfterCalls} calls` : ' (never, despite 100% failure)'}`);
}

// ─── Mode: proxyFetch timeout honoring ───────────────────────────────────────
async function benchFetch(useNew) {
  const http = require('http');
  const { safeFetch } = require(path.join(repoRoot, 'src/impitClient'));

  const slowServer = http.createServer((req, res) => { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }, 16000); });
  const hangServer = http.createServer(() => { /* never responds */ });
  await new Promise((r) => slowServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => hangServer.listen(0, '127.0.0.1', r));
  const slowUrl = `http://127.0.0.1:${slowServer.address().port}/slow`;
  const hangUrl = `http://127.0.0.1:${hangServer.address().port}/hang`;

  // OLD behaviour, verbatim: what proxyFetch used to pass to safeFetch —
  // no signal, hard-coded 15s, default attempts (3).
  const oldFetch = (url) => safeFetch(url, { method: 'GET', headers: {}, timeoutMs: 15000 });

  // NEW behaviour: the real (fixed) proxyFetch with a DaddyLive-style budget.
  let proxyFetch;
  if (useNew) {
    const BaseProvider = require(path.join(repoRoot, 'src/providers/BaseProvider'));
    const p = new BaseProvider({ circuitBreaker: {} });
    proxyFetch = (url) => p.proxyFetch(url, {
      headers: {},
      signal: AbortSignal.timeout(18000),
      timeoutMs: 18000,
      attempts: 1,
    });
  }

  async function scenario(label, url, fn) {
    const t0 = Date.now();
    let outcome = 'ok';
    try { const r = await fn(url); outcome = r && r.ok ? `ok (status ${r.status})` : `http ${r && r.status}`; }
    catch (e) { outcome = `FAIL (${String(e.message).slice(0, 60)})`; }
    console.log(`${label}: ${outcome} — wall ${(Date.now() - t0) / 1000}s`);
  }

  console.log('── proxyFetch benchmark (local servers; budget 18s, mirror responds at 16s) ──');
  if (useNew) {
    await scenario('[new] slow-but-alive mirror', slowUrl, proxyFetch);
    await scenario('[new] hanging mirror       ', hangUrl, proxyFetch);
  } else {
    await scenario('[old] slow-but-alive mirror', slowUrl, oldFetch);
    await scenario('[old] hanging mirror       ', hangUrl, oldFetch);
  }
  slowServer.close();
  hangServer.close();
}

(async () => {
  const mode = process.argv[2] || 'sync';
  const flag = process.argv.includes('--sync-opts') || process.argv.includes('--new');
  if (mode === 'sync') await benchSync();
  else if (mode === 'breaker') await benchBreaker(flag);
  else if (mode === 'fetch') await benchFetch(flag);
  else { console.error('usage: bench-sync-impact.js [sync|breaker|fetch] [--sync-opts|--new]'); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
