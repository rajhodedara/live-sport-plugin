const cron = require('node-cron');
const StreamResolveCache = require('../services/StreamResolveCache');

// Catalog stale-while-revalidate window: once the cache is older than this,
// the next catalog/meta request triggers a background re-sync (see ensureFresh).
const REVALIDATE_AFTER_MS = parseInt(process.env.CATALOG_REVALIDATE_MS, 10) || 10 * 60 * 1000;

// Leaf-only live overlay cadence (ms). 0 disables the pass entirely. The
// overlay no-ops when its snapshot is unchanged, so a short cadence costs one
// small upstream GET per tick and nothing else.
const LIVE_OVERLAY_REFRESH_MS = (() => {
  const raw = process.env.LIVE_OVERLAY_REFRESH_MS;
  if (raw === undefined || raw === '') return 2 * 60 * 1000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2 * 60 * 1000;
})();

class CronService {
  constructor({ matchAggregator, streamResolveCache, cacheService, providerHealthService, liveOverlayService }) {
    this.matchAggregator = matchAggregator;
    this.streamResolveCache = streamResolveCache;
    this.cacheService = cacheService;
    this.providerHealthService = providerHealthService;
    this.liveOverlayService = liveOverlayService;
    this.syncing = false;
    this._overlayBusy = false;
    this._overlayFailStreak = 0;
    // Consecutive failed fetches before the last-known-good overlay is cleared.
    // Below this, a failed tick keeps serving the previous snapshot: Leaf
    // answers [] both when nothing is live and when upstream throws, so a
    // single timeout must never blank every Leaf source for a full cadence.
    this._overlayFailStreakMax = Math.max(1, parseInt(process.env.LIVE_OVERLAY_MAX_CONSECUTIVE_FAILURES, 10) || 3);
    this._lastIdentityWarnAt = 0;
  }

  /**
   * The invariant cluster leader.
   *
   * NODE_APP_INSTANCE is the per-worker index PM2 keeps stable across
   * zero-downtime reloads; when the process does not run under PM2 it is
   * undefined and the instance is trivially primary. The previous check also
   * required pm_id === '0', but PM2 assigns a fresh, ever-increasing pm_id to
   * every worker a reload spawns, so after the first reload NO worker passed
   * that test and the SWR re-sync below silently never ran again.
   */
  _isPrimaryWorker() {
    const instance = process.env.NODE_APP_INSTANCE;
    return instance === undefined || instance === '0';
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
  ensureFresh() {
    try {
      const isPrimary = this._isPrimaryWorker();
      // (pm_id === '0' used to be required here; it is reassigned on every reload.)
      if (!isPrimary) return;
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
    cron.schedule(process.env.PREWARM_CRON_SCHEDULE || '*/3 * * * *', async () => {
      try {
        await this.prewarmPopular();
      } catch (err) {
        console.error('[CronService] Prewarm job failed:', err.message);
      }
    });

    // Leaf-only live overlay: 1-5 ephemeral fixtures, refreshed on a short
    // cadence without ever touching matches_cache.json.
    //
    // setInterval, not cron.schedule: node-cron has no leader election, so a
    // cron job here would fire in BOTH cluster workers. This pass is owned by
    // the primary worker; every other worker reads its snapshot off disk.
    if (LIVE_OVERLAY_REFRESH_MS > 0) {
      console.log(`[CronService] Live overlay refresh every ${Math.round(LIVE_OVERLAY_REFRESH_MS / 1000)}s (primary worker only)`);
      this._overlayTimer = setInterval(() => {
        this.refreshLiveOverlay().catch((err) => console.error('[CronService] Leaf overlay tick failed:', err.message));
      }, LIVE_OVERLAY_REFRESH_MS);
      // Never hold the process open just for this timer.
      if (this._overlayTimer && typeof this._overlayTimer.unref === 'function') this._overlayTimer.unref();
      // One pass at boot, not one cadence later: a deploy replaces dist/ and
      // takes the overlay file with it, so waiting would cost minutes of
      // missing Leaf sources on every release.
      setImmediate(() => {
        this.refreshLiveOverlay().catch(() => {});
      });
    }

    // Run first sync in background on boot so the catalog and all providers (including replays) are fresh immediately
    setImmediate(async () => {
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
          const { request } = require('./ProviderOutbound');
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

  /**
   * Leaf-only freshness pass.
   *
   * Rebuilds the overlay from upstream, replaces the snapshot wholesale, and
   * drops Leaf resolved-stream entries for the fixtures that entered, left or
   * changed. It never writes the catalog - see LiveOverlayService for why that
   * matters (14 MB rewrite, read-modify-write race with the 4h sync, and a
   * lastFetchTime reset that would starve the SWR path).
   */
  async refreshLiveOverlay() {
    if (!this._isPrimaryWorker()) return { skipped: 'secondary-worker' };
    if (this._overlayBusy) return { skipped: 'busy' };
    const overlay = this.liveOverlayService;
    const aggregator = this.matchAggregator;
    if (!overlay || !aggregator || typeof aggregator.buildLiveOverlay !== 'function') {
      return { skipped: 'unavailable' };
    }
    this._overlayBusy = true;
    try {
      const result = await aggregator.buildLiveOverlay();
      const fetched = result && Number.isFinite(result.fetched) ? result.fetched : 0;
      const matched = result && Number.isFinite(result.matched) ? result.matched : 0;
      let nextMap = result && result.map instanceof Map ? result.map : null;

      if (!result || !result.ok) {
        this._overlayFailStreak += 1;
        if (this._overlayFailStreak < this._overlayFailStreakMax) {
          console.warn(`[CronService] Leaf overlay fetch failed (${(result && result.reason) || 'unknown'}); keeping previous snapshot (${this._overlayFailStreak}/${this._overlayFailStreakMax})`);
          return { ok: false, kept: true, fetched, matched };
        }
        console.warn(`[CronService] Leaf overlay failed ${this._overlayFailStreak}x (${(result && result.reason) || 'unknown'}); clearing overlay`);
        nextMap = new Map();
      } else {
        this._overlayFailStreak = 0;
        // "Live upstream but matched nothing" is the identity-regression
        // canary: the match guard or the kickoff window stopped agreeing with
        // the catalog. Rate-limited - a genuinely card-less fixture would
        // otherwise warn every tick.
        if (fetched > 0 && matched === 0 && Date.now() - this._lastIdentityWarnAt > 30 * 60 * 1000) {
          this._lastIdentityWarnAt = Date.now();
          console.warn(`[CronService] Leaf overlay: ${fetched} live fixture(s) matched 0 catalog cards - identity regression?`);
        }
      }
      if (!nextMap) return { ok: false, skipped: 'no-snapshot' };

      const applied = overlay.setOverlay(nextMap);
      if (!applied.changed) {
        return { ok: Boolean(result && result.ok), changed: false, revision: applied.revision };
      }

      for (const matchId of applied.touchedIds) this._invalidateOverlayMatch(matchId);

      console.log(`[CronService] Leaf overlay r${applied.revision}: +${applied.addedIds.length} -${applied.removedIds.length} (fetched ${fetched}, matched ${matched})`);
      return {
        ok: true,
        changed: true,
        revision: applied.revision,
        fetched,
        matched,
        added: applied.addedIds.length,
        removed: applied.removedIds.length
      };
    } catch (err) {
      console.error('[CronService] Leaf overlay refresh failed:', err.message);
      return { ok: false, error: err.message };
    } finally {
      this._overlayBusy = false;
    }
  }

  /**
   * Drop Leaf resolved-stream entries for one match whose overlay just changed.
   *
   * The overlay is authoritative only for Leaf. Other providers' positive,
   * negative and deferred entries remain valid when a Leaf source changes;
   * evicting them forced unrelated PPV/TimStreams work to be repeated. Ended
   * fixtures still use pruneStreamCache(), which removes every source.
   */
  _invalidateOverlayMatch(matchId) {
    const target = String(matchId);
    // Provider entries use upstream IDs, so let Leaf clear only entries that
    // it associated with this canonical fixture and fence their pending work.
    try {
      const leaf = (this.matchAggregator?.providers || []).find((provider) =>
        provider && provider.sourceName === 'leaf');
      if (typeof leaf?.clearCacheForMatch === 'function') leaf.clearCacheForMatch(target);
    } catch (_) { /* private-cache hygiene must not prevent outer eviction */ }

    try {
      const cache = this.streamResolveCache;
      if (!cache || !cache.entries || typeof cache.entries.delete !== 'function') return 0;
      let dropped = 0;
      for (const [key, entry] of cache.entries) {
        if (typeof key === 'string' && key.startsWith('leaf:') &&
            entry && String(entry.matchId) === target) {
          entry.invalidated = true;
          cache.entries.delete(key);
          dropped += 1;
        }
      }
      // An expiry reader may have removed a Leaf entry while its publication
      // is still pending. Fence that same result without touching other sources.
      for (const [key, operation] of cache.pendingOperations || []) {
        if (typeof key === 'string' && key.startsWith('leaf:') && operation &&
            String(operation.matchId) === target && operation.publicationEntry) {
          operation.publicationEntry.invalidated = true;
        }
      }
      if (dropped > 0 && cache.statsCounters) cache.statsCounters.evictions += dropped;
      return dropped;
    } catch (_) {
      return 0;
    }
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
      const PREWARM_MAX = Number(process.env.PREWARM_MAX_MATCHES || 12);
      if (PREWARM_MAX <= 0) return; // master switch: 0 disables every prewarm path
      const { isMatchLive, isReplayMatch } = require('../catalog');
      const { prewarmMatch, prewarmSkipProvidersSet } = require('../streams');
      const resolveCache = this.streamResolveCache;
      const skip = prewarmSkipProvidersSet();
      // Filtering/sorting below only reads, so the defensive deep clone of
      // getMatches() is pure GC churn on this 3-minute tick. Use the internal
      // read-only array and slice() so the in-place sort reorders our copy,
      // not the master catalog. Only the matches actually prewarmed get
      // cloned (in the loop below) since resolve paths may mutate them.
      const roMatches = this.cacheService
        ? (this.cacheService.getMatchesReadOnly ? this.cacheService.getMatchesReadOnly() : this.cacheService.getMatches())
        : [];
      const matches = Array.isArray(roMatches) ? roMatches.slice() : roMatches;

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
          const prioritySources = m.sources.filter(s => ['daddylive', 'ppvst'].includes(s.source) && !skip.has(String(s.source || '').toLowerCase()));
          if (prioritySources.length > 0) {
            warm = prioritySources.every(s => resolveCache.isResolved(StreamResolveCache.resolveKey(s, m.id)));
          } else {
            warm = m.sources.some((s) => !skip.has(String(s.source || '').toLowerCase()) && resolveCache.isResolved(StreamResolveCache.resolveKey(s, m.id)));
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
        // Deep-clone only the handful of selected matches (plain JSON shapes;
        // see CacheService._cloneMatch) — resolve paths may mutate sources.
        const clone = JSON.parse(JSON.stringify(m));
        await prewarmMatch(clone, null, Number.MAX_SAFE_INTEGER).catch(() => {});
      }
    } catch (err) {
      console.error('[CronService] Prewarm failed:', err.message);
    }
  }

}

module.exports = CronService;
