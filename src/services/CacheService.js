const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_SCHEMA_VERSION = 4;

// Keep ambiguous legacy identities visible as null instead of allowing the
// last indexed match to silently take ownership of another fixture's link.
function indexIdentity(index, key, match) {
  if (!index.has(key)) index.set(key, match);
  else if (index.get(key) !== match) index.set(key, null);
}

function uniqueMatch(matches, predicate) {
  let found = null;
  for (const match of matches) {
    if (!match || !predicate(match)) continue;
    if (found && found !== match) return { ambiguous: true, match: null };
    found = match;
  }
  return { ambiguous: false, match: found };
}

function hasLegacySourceToken(sourceId, query) {
  const id = String(sourceId);
  if (query.length < 3 || /^https?:\/\//i.test(id)) return false;
  let at = id.indexOf(query);
  while (at !== -1) {
    const before = at === 0 || !/[a-z0-9]/i.test(id[at - 1]);
    const end = at + query.length;
    const after = end === id.length || !/[a-z0-9]/i.test(id[end]);
    if (before && after) return true;
    at = id.indexOf(query, at + 1);
  }
  return false;
}

// behaviorHints subtrees are plain JSON (provider literals or disk-cache
// parses) at most a few levels deep. V8's generic structuredClone serializer
// costs 5-15x a tight recursive copy on these shapes, and _cloneMatch runs it
// for every source of every match on each full-catalog clone.
function _cloneHints(v) {
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = _cloneHints(v[i]);
    return out;
  }
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k in v) out[k] = _cloneHints(v[k]);
    return out;
  }
  return v;
}

function diskSignature(stats) {
  // Atomic replacements can share a timestamp or move it backwards. Compare
  // file identity and metadata rather than requiring a newer wall-clock mtime.
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(':');
}

function resolveCacheFile() {
  // Jest runs test files in parallel worker processes that all share the repo's
  // matches_cache.json. Concurrent setMatches() calls overwrite each other and
  // the mtime poll then reloads foreign data mid-test (observed as replay
  // catalogs returning 0 metas in the full suite). Give each jest worker its
  // own temp file so parallel tests are isolated; production paths unchanged.
  if (process.env.JEST_WORKER_ID) {
    return path.join(os.tmpdir(), `nuvio-matches-cache-test-${process.pid}.json`);
  }
  // Operator override, read at runtime so it survives ncc. The bundler rewrites
  // path.join(process.cwd(), 'data') below and drops the "data" segment, so a
  // bundle always resolves its cache to <bundle dir>/matches_cache.json no
  // matter what this source says. That rewrite is why the live cache lands in
  // dist/ and why a rebuild cannot move it; an env var is the only external
  // control. Keep this check after the jest branch: test isolation must not
  // depend on the shell the suite happens to run in. Absolute paths only.
  if (process.env.MATCHES_CACHE_PATH) {
    return path.resolve(process.env.MATCHES_CACHE_PATH);
  }
  const rootDataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(rootDataDir)) {
    try { fs.mkdirSync(rootDataDir, { recursive: true }); } catch (_) {}
  }
  return path.join(rootDataDir, 'matches_cache.json');
}

class CacheService {
  constructor(customCachePath) {
    this.cachedMatches = [];
    this.lastFetchTime = 0;
    this.lastDiskMtime = 0;
    this.lastStatCheck = 0;
    this._hasDiskSnapshot = false;
    this._diskSignature = null;
    // Monotonic revision, bumped whenever the match set changes (in-memory
    // write or cross-worker disk reload). Downstream caches (catalog page
    // memo) key off this so a new sync invalidates everything at once.
    this.rev = 0;
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.cacheFilePath = (typeof customCachePath === 'string' && customCachePath)
      ? customCachePath
      : resolveCacheFile();
    // Boot-visible: the resolved path is build-dependent (see resolveCacheFile),
    // and a wrong one silently invalidates every backup, runbook and "clear the
    // cache" instruction. Two lines per start is not log noise.
    if (!process.env.JEST_WORKER_ID) {
      console.log(`[CacheService] matches cache: ${this.cacheFilePath}`);
    }
    this._byId = new Map();
    this._byAlias = new Map();
    this._bySourceId = new Map();
    this._indexedMatchesRef = null;
    this._loadDiskCache();
  }

  // Deep-ish clone: handlers downstream mutate individual stream/source objects
  // (s.score, s._source, s.name, s.url, behaviorHints), so a shallow array copy
  // would leak state between requests. Structured clone is not available for
  // these plain JSON shapes on every runtime, so clone explicitly.
  _cloneMatch(m) {
    if (!m || typeof m !== 'object') return null;
    const c = { ...m };
    if (Array.isArray(m.aliasIds)) c.aliasIds = [...m.aliasIds];
    if (Array.isArray(m.sources)) {
      c.sources = m.sources.map((s) => (s && typeof s === 'object'
        ? { ...s, behaviorHints: s.behaviorHints ? _cloneHints(s.behaviorHints) : s.behaviorHints }
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
    // Empty, missing and malformed snapshots need the same polling throttle
    // as populated caches. Empty is a valid result, not a request to reread
    // and invalidate downstream catalog caches on every access.
    const now = Date.now();
    if (this.lastStatCheck && (now - this.lastStatCheck < 1000)) return;
    this.lastStatCheck = now;
    this._loadDiskCache();
  }

  _loadDiskCache() {
    let fd;
    try {
      if (!fs.existsSync(this.cacheFilePath)) return false;
      const pathStats = fs.statSync(this.cacheFilePath);
      if (this._hasDiskSnapshot && diskSignature(pathStats) === this._diskSignature) {
        return false;
      }
      // Open once: another worker can rename a replacement between path stat
      // and read. Derive both the bytes and stored signature from this handle.
      fd = fs.openSync(this.cacheFilePath, 'r');
      const stats = fs.fstatSync(fd);
      const signature = diskSignature(stats);
      if (this._hasDiskSnapshot && signature === this._diskSignature) return false;
      const raw = fs.readFileSync(fd, 'utf-8');
      if (!raw || raw.length < 2) return false;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.matches)) {
        // Cache Schema Versioning & Migration:
        // Caches without schemaVersion or with schemaVersion < CACHE_SCHEMA_VERSION contain
        // outdated country/league-split cards and must be invalidated and cleared from disk.
        const fileSchema = typeof parsed.schemaVersion === 'number'
          ? parsed.schemaVersion
          : (process.env.JEST_WORKER_ID ? CACHE_SCHEMA_VERSION : 1);

        if (fileSchema < CACHE_SCHEMA_VERSION) {
          try {
            fs.closeSync(fd);
            fd = undefined;
            if (fs.existsSync(this.cacheFilePath)) {
              fs.unlinkSync(this.cacheFilePath);
            }
          } catch (_) {}
          this.cachedMatches = [];
          this._hasDiskSnapshot = false;
          this._diskSignature = null;
          this._rebuildIndices();
          return false;
        }

        // The parsed tree is freshly allocated by JSON.parse above and no other
        // reference holds it, so adopting it (minus null rows, matching the old
        // _clone's .filter(Boolean)) is observationally identical and skips one
        // full-catalog clone per disk reload.
        this.cachedMatches = parsed.matches.filter(Boolean);
        this.lastFetchTime = parsed.timestamp || stats.mtimeMs;
        this.lastDiskMtime = stats.mtimeMs;
        this._hasDiskSnapshot = true;
        this._diskSignature = signature;
        this.rev++;
        this._rebuildIndices();
        return true;
      }
    } catch (_) {
      // Keep the previous snapshot if the new file is unavailable or invalid.
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (_) {}
      }
    }
    return false;
  }

  _rebuildIndices() {
    this._byId = new Map();
    this._byAlias = new Map();
    this._bySourceId = new Map();

    const matches = this.cachedMatches;
    if (Array.isArray(matches)) {
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        if (!m || typeof m !== 'object') continue;

        if (m.id && typeof m.id === 'string') {
          indexIdentity(this._byId, m.id, m);
        }

        if (Array.isArray(m.aliasIds)) {
          for (let j = 0; j < m.aliasIds.length; j++) {
            const aid = m.aliasIds[j];
            if (aid && typeof aid === 'string') {
              indexIdentity(this._byAlias, aid, m);
            }
          }
        }

        if (Array.isArray(m.sources)) {
          for (let j = 0; j < m.sources.length; j++) {
            const s = m.sources[j];
            if (s && s.id != null) {
              const sid = String(s.id);
              indexIdentity(this._bySourceId, sid, m);
              if (!sid.startsWith('stream_')) {
                indexIdentity(this._bySourceId, `stream_${sid}`, m);
              }
            }
          }
        }
      }
    }

    this._indexedMatchesRef = this.cachedMatches;
  }

  _saveDiskCache(matches) {
    let tempPath;
    let fd;
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      tempPath = `${this.cacheFilePath}.tmp.${process.pid}.${Date.now()}`;
      const payload = JSON.stringify({
        schemaVersion: CACHE_SCHEMA_VERSION,
        timestamp: this.lastFetchTime,
        matches: matches
      });
      fs.writeFileSync(tempPath, payload, 'utf-8');
      fd = fs.openSync(tempPath, 'r');
      fs.renameSync(tempPath, this.cacheFilePath);
      tempPath = null;
      // A different worker may already have replaced the destination path.
      // Remember our own written snapshot, not that worker's file metadata.
      const stats = fs.fstatSync(fd);
      this.lastDiskMtime = stats.mtimeMs;
      this._hasDiskSnapshot = true;
      this._diskSignature = diskSignature(stats);
    } catch (err) {
      console.error('[CacheService] Failed to save disk cache:', err.message);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (_) {}
      }
      try { if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    }
  }

  getMatches() {
    this._ensureLoaded();
    return this._clone(this.cachedMatches);
  }

  /**
   * Returns a direct reference to the internal cached matches array in O(1) time
   * without deep-cloning all match entities.
   *
   * CONTRACT / INVARIANTS:
   * - Callers MUST treat the returned array and its elements as strictly read-only.
   * - Do not push, pop, splice, or sort this array directly.
   * - Do not mutate match.id, match.sources, or match.category.
   * - Downstream catalog meta projection may idempotently attach team logos.
   * - For mutable per-request match processing, use findMatch() or getMatches().
   *
   * @returns {Array<Object>} The internal cached matches array.
   */
  getMatchesReadOnly() {
    this._ensureLoaded();
    return this.cachedMatches || [];
  }

  setMatches(matches) {
    this.cachedMatches = this._clone(matches);
    this.lastFetchTime = Date.now();
    this.rev++;
    this._rebuildIndices();
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

    // Self-healing: if indices were not built or cachedMatches was updated/reassigned directly
    if (!this._byId || this._indexedMatchesRef !== matches) {
      this._rebuildIndices();
    }

    // Fast O(1) Indexed Lookups
    for (const index of [this._byId, this._byAlias, this._bySourceId]) {
      if (index.has(matchId)) {
        const found = index.get(matchId);
        return found ? this._cloneMatch(found) : null;
      }
    }

    // Legacy partial source IDs must be whole tokens and identify one event.
    const sourceMatch = uniqueMatch(matches, m => Array.isArray(m.sources) &&
      m.sources.some(s => s && s.id != null && hasLegacySourceToken(s.id, matchId)));
    if (sourceMatch.ambiguous) return null;
    if (sourceMatch.match) return this._cloneMatch(sourceMatch.match);

    // Fallback: Normalized slug match (e.g. "cleveland-guardians" or team names in matchId)
    const cleanId = matchId.toLowerCase().replace(/^[a-z0-9]+_[0-9]+_/, '').replace(/[^a-z0-9]/g, '');
    if (cleanId.length > 6) {
      const slugMatch = uniqueMatch(matches, m => {
        const mCleanId = (m.id || '').toLowerCase().replace(/^[a-z0-9]+_[0-9]+_/, '').replace(/[^a-z0-9]/g, '');
        if (mCleanId.length > 6 && (mCleanId.includes(cleanId) || cleanId.includes(mCleanId))) return true;
        if (m.title) {
          const cleanTitle = m.title.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (cleanTitle.length > 6 && (cleanTitle.includes(cleanId) || cleanId.includes(cleanTitle))) return true;
        }
        return false;
      });
      return slugMatch.match ? this._cloneMatch(slugMatch.match) : null;
    }

    return null;
  }

  isStale(ttlMs = this.CACHE_TTL) {
    if (Date.now() - this.lastFetchTime > ttlMs) {
      this._ensureLoaded();
    }
    return (Date.now() - this.lastFetchTime) > ttlMs;
  }

  clear() {
    this.cachedMatches = [];
    this.lastFetchTime = 0;
    this.lastDiskMtime = 0;
    this.lastStatCheck = 0;
    this._hasDiskSnapshot = false;
    this._diskSignature = null;
    this.rev++;
    this._byId.clear();
    this._byAlias.clear();
    this._bySourceId.clear();
    this._indexedMatchesRef = null;
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        fs.unlinkSync(this.cacheFilePath);
      }
    } catch (_) {}
  }
}

CacheService.CACHE_SCHEMA_VERSION = CACHE_SCHEMA_VERSION;

module.exports = CacheService;
