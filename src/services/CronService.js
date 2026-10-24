const cron = require('node-cron');

// Catalog stale-while-revalidate window: once the cache is older than this,
// the next catalog/meta request triggers a background re-sync (see ensureFresh).
const REVALIDATE_AFTER_MS = parseInt(process.env.CATALOG_REVALIDATE_MS, 10) || 10 * 60 * 1000;

class CronService {
  constructor({ matchAggregator, streamResolveCache, cacheService, providerHealthService }) {
    this.matchAggregator = matchAggregator;
    this.streamResolveCache = streamResolveCache;
    this.cacheService = cacheService;
    this.providerHealthService = providerHealthService;
    this.syncing = false;
  }

  get isSyncing() { return this.syncing; }
  set isSyncing(v) { this.syncing = v; }

  async runSync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const activeMatches = await this.matchAggregator.syncMatches();
      if (activeMatches !== null) {
        this.pruneStreamCache(activeMatches);
        this.prewarmCatalogMemo();
      }
    } catch (error) {
      if (this.providerHealthService) {
        this.providerHealthService.finishSync({ matchCount: 0, succeeded: false });
      }
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  // Rebuild the hot catalog pages right after a sync, so no user ever pays the
  // post-sync rebuild. Every sync bumps CacheService.rev and wipes the page
  // memo; the first catalog request after that rebuilt from scratch (2-8s
  // baseline, 10-24s measured when it collided with peak-hour work). Building
  // the two hottest pages here — in a controlled background moment seconds
  // after the sync — means arriving users hit a warm memo (~11ms) instead of
  // becoming the rebuild trigger. Fire-and-forget with error swallowing: if
  // this fails, behavior is exactly the old first-request-rebuilds path.
  prewarmCatalogMemo() {
    if (String(process.env.CATALOG_MEMO_PREWARM ?? 'true') === 'false') return;
    if (this._memoPrewarmBusy) return;
    this._memoPrewarmBusy = true;
    setImmediate(async () => {
      try {
        const { handleCatalog } = require('../catalog');
        // Yield between pages so this never blocks request handling.
        await handleCatalog('tv', 'nuvio_sports_live', {}, {}).catch(() => {});
        await new Promise((r) => setImmediate(r));
        await handleCatalog('tv', 'nuvio_sports_catalog', {}, {}).catch(() => {});
      } catch (_) {
        // Never let memo hygiene disturb the sync cycle.
      } finally {
        this._memoPrewarmBusy = false;
      }
    });
  }

  // Catalog stale-while-revalidate: serve the cached list immediately and
  // refresh in the background once the cache passes REVALIDATE_AFTER_MS.
  // Traffic-driven, so idle instances stay quiet; the 4-hour cron is the floor.
  // PM2 runs N cluster workers sharing one socket; every worker used to run
  // every cron, so provider syncs and prewarm ticks executed 2x (N workers)
  // against the same upstreams. Background churn is owned by the primary
  // worker; secondary workers pick up results via the disk snapshot (matches)
  // and the shared resolver L2 (stream mints, write-through adopted on read).
  _isPrimaryWorker() {
    return (process.env.NODE_APP_INSTANCE === undefined || process.env.NODE_APP_INSTANCE === '0') &&
           (process.env.pm_id === undefined || process.env.pm_id === '0');
  }

  ensureFresh() {
    try {
      if (!this._isPrimaryWorker()) return;
      if (this.syncing) return;
      if (!this.cacheService || !this.cacheService.isStale(REVALIDATE_AFTER_MS)) return;
      console.log('[CronService] Catalog stale, triggering background re-sync (SWR)...');
      this.runSync().catch((err) => console.error('[CronService] SWR sync failed:', err.message));
    } catch (err) {
      console.error('[CronService] ensureFresh error:', err.message);
    }
  }

  start() {
    console.log('[CronService] Starting background jobs...');

    // Fetch and cache matches every 4 hours (primary only — see _isPrimaryWorker)
    cron.schedule('0 */4 * * *', async () => {
      if (!this._isPrimaryWorker()) return;
      console.log('[CronService] Running match sync job...');
      try {
        await this.runSync();
      } catch (err) {
        console.error('[CronService] Match sync failed:', err.message);
      }
    });

    // Prewarm LIVE matches only, so a click is near-instant.
    //
    // Deliberately narrow to protect the upstreams (this was previously disabled
    // for exactly that reason):
    //   - only matches that are genuinely LIVE right now (isMatchLive), which
    //     excludes replays, upcoming fixtures and 24/7 network channels;
    //   - capped at PREWARM_MAX matches per tick;
    //   - this tick also skips any match whose sources are already cached, so a
    //     warm instance does no work at all.
    cron.schedule(process.env.PREWARM_CRON_SCHEDULE || '*/3 * * * *', async () => {
      if (!this._isPrimaryWorker()) return;
      try {
        await this.prewarmPopular();
      } catch (err) {
        console.error('[CronService] Prewarm job failed:', err.message);
      }
    });

    // Run first sync in background on boot so the catalog and all providers (including replays) are fresh immediately.
    // Primary only: a secondary worker starting simultaneously would duplicate
    // the full provider scrape; it loads the primary's snapshot from disk instead.
    setImmediate(async () => {
      if (!this._isPrimaryWorker()) return;
      try {
        console.log('[CronService] Initiating startup match sync...');
        await this.runSync();
      } catch (err) {
        console.error('[CronService] Startup match sync failed:', err.message);
      }
    });

    const externalUrl = process.env.RENDER_EXTERNAL_URL;
    if (externalUrl) {
      console.log(`[CronService] Keep-alive enabled for ${externalUrl}`);
      cron.schedule('*/14 * * * *', async () => {
        try {
          console.log(`[CronService] Pinging external URL to prevent sleep...`);
          const { request } = require('undici');
          await request(`${externalUrl}/health`);
        } catch (err) {
          console.error('[CronService] Keep-alive ping failed:', err.message);
        }
      });
    }

    // Run first sync immediately on boot (primary only — see startup note above)
    setTimeout(async () => {
      if (!this._isPrimaryWorker()) return;
      try {
        console.log('[CronService] Running initial match sync...');
        await this.runSync();
      } catch(e) {
        console.error('[CronService] Match sync failed:', e.message);
      }
    }, 1000);
  }

  /** Drop stream-cache entries for matches that are no longer active. */
  pruneStreamCache(activeMatches) {
    try {
      if (!this.streamResolveCache) return;
      const ids = new Set((activeMatches || []).map(m => m && m.id).filter(Boolean));
      this.streamResolveCache.pruneEnded(ids);
    } catch (_) {}
  }

  /**
   * Prewarm LIVE matches so hot streams are already resolving when clicked.
   *
   * Scope is deliberately narrow:
   *   - LIVE only (isMatchLive) - no replays, no upcoming, no 24/7 networks;
   *   - hard cap per tick;
   *   - sources already in the resolve cache are skipped, so a warm instance
   *     performs no upstream requests at all.
   */
  async prewarmPopular() {
    try {
      const PREWARM_MAX = Number(process.env.PREWARM_MAX_MATCHES !== undefined ? process.env.PREWARM_MAX_MATCHES : 12);
      if (PREWARM_MAX <= 0) return;
      const { isMatchLive, isReplayMatch } = require('../catalog');
      const { prewarmMatch, prewarmSkipProvidersSet, resolveKey } = require('../streams');
      const resolveCache = this.streamResolveCache;
      const skip = prewarmSkipProvidersSet();
      const matches = this.cacheService ? this.cacheService.getMatches() : [];

      const live = matches.filter((m) => {
        if (!m || !m.sources || m.sources.length === 0) return false;
        if (m.category === 'networks') return false;      // 24/7 channels
        if (m.category === 'other') return false;         // other sports
        if (isReplayMatch(m)) return false;                // replays
        // Matches whose sources are ALL heavy embed-family providers never
        // prewarm (see PREWARM_SKIP_PROVIDERS) — excluding them here keeps the
        // tick log honest instead of announcing no-op mints.
        if (!m.sources.some((s) => s && !skip.has(String(s.source || '').toLowerCase()))) return false;
        return isMatchLive(m);                             // genuinely live
      });
      if (live.length === 0) return;

      // Only among LIVE matches: prefer popular, then most viewers/recent kickoff.
      live.sort((a, b) => {
        const ap = a.popular === '1' ? 1 : 0;
        const bp = b.popular === '1' ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (Number(b.date) || 0) - (Number(a.date) || 0);
      });

      // Skip matches whose sources are already cached (nothing to do).
      const todo = [];
      for (const m of live) {
        if (todo.length >= PREWARM_MAX) break;
        let warm = false;
        if (resolveCache) {
          const eligibleSources = m.sources.filter(s => s && !skip.has(String(s.source || '').toLowerCase()));
          const prioritySources = eligibleSources.filter(s => ['daddylive', 'ppvst', 'leaf'].includes(s.source));
          const isSourceWarm = (s) => {
            const key = resolveKey(s, m.id);
            if (typeof resolveCache.isResolved === 'function') {
              return resolveCache.isResolved(key);
            }
            if (typeof resolveCache.has === 'function') {
              return resolveCache.has(key);
            }
            return !!resolveCache.get(key);
          };
          if (prioritySources.length > 0) {
            warm = prioritySources.every(isSourceWarm);
          } else {
            warm = eligibleSources.some(isSourceWarm);
          }
        }
        if (!warm) todo.push(m);
      }
      if (todo.length === 0) return;

      console.log(`[CronService] Prewarming ${todo.length} live match(es) (of ${live.length} live)`);
      // Sequential: never bursts upstream. Low priority, so slow is fine.
      // (Heavy embed-family sources are excluded upstream via
      // PREWARM_SKIP_PROVIDERS in prewarmMatch — see streams.js.)
      for (const m of todo) {
        await prewarmMatch(m, null, Number.MAX_SAFE_INTEGER).catch(() => {});
      }
    } catch (err) {
      console.error('[CronService] Prewarm failed:', err.message);
    }
  }

}

module.exports = CronService;
