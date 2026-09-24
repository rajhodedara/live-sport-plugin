const cron = require('node-cron');

// Catalog stale-while-revalidate window: once the cache is older than this,
// the next catalog/meta request triggers a background re-sync (see ensureFresh).
const REVALIDATE_AFTER_MS = parseInt(process.env.CATALOG_REVALIDATE_MS, 10) || 10 * 60 * 1000;

class CronService {
  constructor({ matchAggregator, streamResolveCache, cacheService }) {
    this.matchAggregator = matchAggregator;
    this.streamResolveCache = streamResolveCache;
    this.cacheService = cacheService;
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
      }
    } finally {
      this.syncing = false;
    }
  }

  // Catalog stale-while-revalidate: serve the cached list immediately and
  // refresh in the background once the cache passes REVALIDATE_AFTER_MS.
  // Traffic-driven, so idle instances stay quiet; the 4-hour cron is the floor.
  ensureFresh() {
    try {
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
    
    // Fetch and cache matches every 4 hours
    cron.schedule('0 */4 * * *', async () => {
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
    cron.schedule(process.env.PREWARM_CRON_SCHEDULE || '*/10 * * * *', async () => {
      try {
        await this.prewarmPopular();
      } catch (err) {
        console.error('[CronService] Prewarm job failed:', err.message);
      }
    });

    // Run first sync immediately on boot
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

    // Run first sync immediately on boot
    setTimeout(async () => {
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
      const PREWARM_MAX = Number(process.env.PREWARM_MAX_MATCHES || 6);
      const { isMatchLive, isReplayMatch } = require('../catalog');
      const { prewarmMatch } = require('../streams');
      const resolveCache = this.streamResolveCache;
      const matches = this.cacheService ? this.cacheService.getMatches() : [];

      const live = matches.filter((m) => {
        if (!m || !m.sources || m.sources.length === 0) return false;
        if (m.category === 'networks') return false;      // 24/7 channels
        if (isReplayMatch(m)) return false;                // replays
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
          warm = m.sources.some((s) => resolveCache.get(`${s.source}:${m.id}:${s.id}`));
        }
        if (!warm) todo.push(m);
      }
      if (todo.length === 0) return;

      console.log(`[CronService] Prewarming ${todo.length} live match(es) (of ${live.length} live)`);
      // Sequential: never bursts upstream. Low priority, so slow is fine.
      for (const m of todo) {
        await prewarmMatch(m, null, Number.MAX_SAFE_INTEGER, { skipSpeedProbe: true }).catch(() => {});
      }
    } catch (err) {
      console.error('[CronService] Prewarm failed:', err.message);
    }
  }

}

module.exports = CronService;
