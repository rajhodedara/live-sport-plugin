const fs = require('fs');
const path = require('path');

function resolveCacheFile() {
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
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.cacheFilePath = resolveCacheFile();
    this._loadDiskCache();
  }

  // Deep-ish clone: handlers downstream mutate individual stream/source objects
  // (s.score, s._source, s.name, s.url, behaviorHints), so a shallow array copy
  // would leak state between requests. Structured clone is not available for
  // these plain JSON shapes on every runtime, so clone explicitly.
  _clone(matches) {
    return (matches || []).map((m) => {
      const c = { ...m };
      if (Array.isArray(m.sources)) {
        c.sources = m.sources.map((s) => (s && typeof s === 'object'
          ? { ...s, behaviorHints: s.behaviorHints ? { ...s.behaviorHints } : s.behaviorHints }
          : s));
      }
      if (m.team1 && typeof m.team1 === 'object') c.team1 = { ...m.team1 };
      if (m.team2 && typeof m.team2 === 'object') c.team2 = { ...m.team2 };
      return c;
    });
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
        return true;
      }
    } catch (_) {}
    return false;
  }

  _saveDiskCache(matches) {
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tempPath = `${this.cacheFilePath}.tmp.${process.pid}.${Date.now()}`;
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
    }
  }

  getMatches() {
    if (this.cachedMatches.length === 0) {
      this._loadDiskCache();
    } else {
      // Periodic or on-demand check if another worker wrote fresh data
      try {
        if (fs.existsSync(this.cacheFilePath)) {
          const stats = fs.statSync(this.cacheFilePath);
          if (stats.mtimeMs > this.lastDiskMtime) {
            this._loadDiskCache();
          }
        }
      } catch (_) {}
    }
    return this._clone(this.cachedMatches);
  }

  setMatches(matches) {
    this.cachedMatches = this._clone(matches);
    this.lastFetchTime = Date.now();
    this._saveDiskCache(matches);
  }

  isStale(ttlMs = this.CACHE_TTL) {
    if (Date.now() - this.lastFetchTime > ttlMs) {
      this._loadDiskCache();
    }
    return (Date.now() - this.lastFetchTime) > ttlMs;
  }
}

module.exports = CacheService;
