const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveCacheFile() {
  // Jest runs test files in parallel worker processes that all share the repo's
  // matches_cache.json. Concurrent setMatches() calls overwrite each other and
  // the mtime poll then reloads foreign data mid-test (observed as replay
  // catalogs returning 0 metas in the full suite). Give each jest worker its
  // own temp file so parallel tests are isolated; production paths unchanged.
  if (process.env.JEST_WORKER_ID) {
    return path.join(os.tmpdir(), `nuvio-matches-cache-test-${process.pid}.json`);
  }
  const srcDataDir = path.join(process.cwd(), 'src', 'data');
  if (fs.existsSync(srcDataDir)) {
    return path.join(srcDataDir, 'matches_cache.json');
  }
  const rootDataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(rootDataDir)) {
    try { fs.mkdirSync(rootDataDir, { recursive: true }); } catch (_) {}
  }
  return path.join(rootDataDir, 'matches_cache.json');
}

class CacheService {
  constructor() {
    this.cachedMatches = [];
    this.lastFetchTime = 0;
    this.lastDiskMtime = 0;
    this.lastStatCheck = 0;
    // Monotonic revision, bumped whenever the match set changes (in-memory
    // write or cross-worker disk reload). Downstream caches (catalog page
    // memo) key off this so a new sync invalidates everything at once.
    this.rev = 0;
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.cacheFilePath = resolveCacheFile();
    this._loadDiskCache();
  }

  // Deep-ish clone: handlers downstream mutate individual stream/source objects
  // (s.score, s._source, s.name, s.url, behaviorHints), so a shallow array copy
  // would leak state between requests. Structured clone is not available for
  // these plain JSON shapes on every runtime, so clone explicitly.
  _cloneMatch(m) {
    if (!m || typeof m !== 'object') return null;
    const c = { ...m };
    if (Array.isArray(m.sources)) {
      c.sources = m.sources.map((s) => (s && typeof s === 'object'
        ? { ...s, behaviorHints: s.behaviorHints ? { ...s.behaviorHints } : s.behaviorHints }
        : s));
    }
    if (m.team1 && typeof m.team1 === 'object') c.team1 = { ...m.team1 };
    if (m.team2 && typeof m.team2 === 'object') c.team2 = { ...m.team2 };
    return c;
  }

  _clone(matches) {
    return (matches || []).map((m) => this._cloneMatch(m)).filter(Boolean);
  }

  _ensureLoaded() {
    if (this.cachedMatches.length === 0) {
      this._loadDiskCache();
    } else {
      // Periodic or on-demand check if another worker wrote fresh data (throttled to at most once per second)
      const now = Date.now();
      if (this.lastStatCheck && (now - this.lastStatCheck < 1000)) return;
      this.lastStatCheck = now;
      try {
        if (fs.existsSync(this.cacheFilePath)) {
          const stats = fs.statSync(this.cacheFilePath);
          if (stats.mtimeMs > this.lastDiskMtime) {
            this._loadDiskCache();
          }
        }
      } catch (_) {}
    }
  }

  _loadDiskCache() {
    try {
      if (!fs.existsSync(this.cacheFilePath)) return false;
      const stats = fs.statSync(this.cacheFilePath);
      if (stats.mtimeMs <= this.lastDiskMtime && this.cachedMatches.length > 0) {
        return false;
      }
      const raw = fs.readFileSync(this.cacheFilePath, 'utf-8');
      if (!raw || raw.length < 2) return false;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.matches)) {
        this.cachedMatches = this._clone(parsed.matches);
        this.lastFetchTime = parsed.timestamp || stats.mtimeMs;
        this.lastDiskMtime = stats.mtimeMs;
        this.rev++;
        return true;
      }
    } catch (_) {}
    return false;
  }

  _saveDiskCache(matches) {
    let tempPath;
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      tempPath = `${this.cacheFilePath}.tmp.${process.pid}.${Date.now()}`;
      const payload = JSON.stringify({
        timestamp: this.lastFetchTime,
        matches: matches
      });
      fs.writeFileSync(tempPath, payload, 'utf-8');
      fs.renameSync(tempPath, this.cacheFilePath);
      const stats = fs.statSync(this.cacheFilePath);
      this.lastDiskMtime = stats.mtimeMs;
    } catch (err) {
      console.error('[CacheService] Failed to save disk cache:', err.message);
      try { if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    }
  }

  getMatches() {
    this._ensureLoaded();
    return this._clone(this.cachedMatches);
  }

  setMatches(matches) {
    this.cachedMatches = this._clone(matches);
    this.lastFetchTime = Date.now();
    this.rev++;
    this._saveDiskCache(matches);
  }

  // Explicit invalidation for downstream caches keyed on rev (catalog page
  // memo): called when async background work (logo enrichment) fills in data
  // that the match set alone doesn't capture, so memoized pages rebuild with
  // the artwork included.
  bumpRev() {
    this.rev++;
  }

  findMatch(matchId) {
    if (!matchId || typeof matchId !== 'string') {
      matchId = String(matchId || '');
      if (!matchId) return null;
    }
    this._ensureLoaded();
    const matches = this.cachedMatches;
    if (!Array.isArray(matches) || matches.length === 0) return null;

    // 1. Direct primary ID match
    let found = matches.find(m => m && m.id === matchId);
    if (found) return this._cloneMatch(found);

    // 2. Alias IDs (merged IDs from other providers during aggregator sync)
    found = matches.find(m => m && Array.isArray(m.aliasIds) && m.aliasIds.includes(matchId));
    if (found) return this._cloneMatch(found);

    // 3. Source ID match (any source within the match has this ID)
    found = matches.find(m => m && Array.isArray(m.sources) && m.sources.some(s => s && (s.id === matchId || s.id === `stream_${matchId}` || String(s.id).includes(matchId))));
    if (found) return this._cloneMatch(found);

    // 4. Normalized slug match (e.g. "cleveland-guardians" or team names in matchId)
    const cleanId = matchId.toLowerCase().replace(/^[a-z0-9]+_[0-9]+_/, '').replace(/[^a-z0-9]/g, '');
    if (cleanId.length > 6) {
      found = matches.find(m => {
        if (!m) return false;
        const mCleanId = (m.id || '').toLowerCase().replace(/^[a-z0-9]+_[0-9]+_/, '').replace(/[^a-z0-9]/g, '');
        if (mCleanId && (mCleanId.includes(cleanId) || cleanId.includes(mCleanId))) return true;
        if (m.title) {
          const cleanTitle = m.title.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (cleanTitle.includes(cleanId) || cleanId.includes(cleanTitle)) return true;
        }
        return false;
      });
    }

    return found ? this._cloneMatch(found) : null;
  }

  isStale(ttlMs = this.CACHE_TTL) {
    if (Date.now() - this.lastFetchTime > ttlMs) {
      this._ensureLoaded();
    }
    return (Date.now() - this.lastFetchTime) > ttlMs;
  }
}

module.exports = CacheService;
