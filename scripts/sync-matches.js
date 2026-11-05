#!/usr/bin/env node
/**
 * sync-matches.js - force a full provider sync and write the match cache.
 *
 * WHY THIS EXISTS
 * ---------------
 * The add-on syncs matches on a schedule (4 hours) plus a traffic-driven
 * stale-while-revalidate pass (CronService.ensureFresh). Both are traffic-gated,
 * and under PM2 cluster each worker keeps its OWN in-memory copy of the match
 * list (CacheService), refreshed from the shared disk file only when that file's
 * mtime is newer.
 *
 * That combination can leave a worker serving a stale in-memory list — the
 * catalog then appears to be missing whole providers even though `/api/matches`
 * on a freshly-synced worker shows them. This script forces ONE full sync in a
 * throwaway process, which writes the disk cache; the running workers pick it up
 * on their next mtime check.
 *
 * It runs the SAME code path as the app's scheduled sync
 * (MatchAggregator.syncMatches), so provider behaviour is identical.
 *
 * USAGE
 *   node scripts/sync-matches.js            # sync, print a short summary
 *   node scripts/sync-matches.js --json     # machine-readable summary only
 *   node scripts/sync-matches.js --quiet    # no per-provider logs
 *
 * EXIT CODES
 *   0  sync completed (even if some individual providers failed - that is normal)
 *   1  sync returned null (every provider failed) or threw
 *
 * NOTE: this performs real outbound requests to every provider, so it is also
 * load. Run it on demand after a deploy or a suspected stale catalog, not in a
 * tight loop.
 */

'use strict';

require('dotenv').config();

const JSON_OUT = process.argv.includes('--json');
const QUIET = process.argv.includes('--quiet') || JSON_OUT;

function main() {
  // Silence the app's very chatty logs only when asked. Provider errors are
  // deliberately still surfaced by syncMatches itself.
  if (QUIET) {
    const origLog = console.log;
    console.log = (...args) => {
      const s = args.join(' ');
      if (/\[MatchAggregator\]|Merged|Derived/i.test(s)) origLog(...args);
    };
  }

  const container = require('../src/container');
  const aggregator = container.resolve('matchAggregator');

  return (async () => {
    const started = Date.now();
    let matches;
    try {
      matches = await aggregator.syncMatches();
    } catch (err) {
      console.error('[sync-matches] Sync threw:', err && err.message ? err.message : err);
      process.exit(1);
    }

    if (!matches || !Array.isArray(matches)) {
      console.error('[sync-matches] Sync returned no matches (every provider failed). Cache left untouched.');
      process.exit(1);
    }

    const bySource = {};
    let withDaddy = 0;
    for (const m of matches) {
      const srcs = Array.isArray(m.sources) ? m.sources : [];
      for (const s of srcs) {
        const key = s && s.source ? s.source : 'unknown';
        bySource[key] = (bySource[key] || 0) + 1;
      }
      if (srcs.some((s) => s && s.source === 'daddylive')) withDaddy++;
    }

    const summary = {
      totalMatches: matches.length,
      withDaddyLiveSource: withDaddy,
      bySource,
      ms: Date.now() - started,
      cacheFile: container.resolve('cacheService').cacheFilePath,
    };

    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(summary) + '\n');
    } else {
      console.log('');
      console.log('[sync-matches] ────────────────────────────────────────────');
      console.log(`[sync-matches] total matches        : ${summary.totalMatches}`);
      console.log(`[sync-matches] with daddylive source: ${summary.withDaddyLiveSource}`);
      console.log(`[sync-matches] cache file           : ${summary.cacheFile}`);
      console.log(`[sync-matches] took                 : ${(summary.ms / 1000).toFixed(1)}s`);
      console.log('[sync-matches] sources:');
      for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
        console.log(`[sync-matches]    ${String(k).padEnd(16)} ${v}`);
      }
      console.log('[sync-matches] ────────────────────────────────────────────');
      if (summary.withDaddyLiveSource === 0) {
        console.log('[sync-matches] WARNING: no match carries a daddylive source.');
        console.log('[sync-matches]          The DaddyLive schedule fetch likely failed - check the logs above.');
      }
    }

    process.exit(0);
  })();
}

main();
