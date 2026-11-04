'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * LiveOverlayService
 *
 * A tiny, replaceable snapshot of the sources an *ephemeral* provider is
 * publishing right now, kept OUT of the catalog.
 *
 * Why this exists
 * ---------------
 * `matches_cache.json` holds ~16k matches and ~14 MB of JSON. Some providers
 * (currently Leaf / `sports.highfly.to`) only publish a fixture while it is
 * live — typically 1-5 at a time, posted an hour or two before kickoff and
 * removed when the whistle goes. Backfilling those sources by rewriting the
 * catalog (`CacheService.setMatches`) costs a full clone + index rebuild + a
 * 14 MB synchronous disk write per tick, races the 4-hour sync's own
 * read-modify-write of the same file, and resets `lastFetchTime`, which starves
 * the stale-while-revalidate path it was meant to help.
 *
 * So this service stores only `matchId -> sources[]` (a handful of entries),
 * persists it to a ~2 KB JSON file for cross-worker propagation, and is merged
 * at the single point where the answer is observable: stream resolution.
 *
 * Contract
 * --------
 * - The overlay is AUTHORITATIVE for its own source key (`leaf`). While a match
 *   is overlaid, every base source with that key is dropped and replaced. That
 *   is what prevents a dead Leaf entry (left behind by the last full sync) from
 *   sitting next to the live one as a second, broken button.
 * - `ownedIds` is the tombstone set: matches this service has overlaid at least
 *   once. When Leaf drops a fixture between catalog syncs, the entry disappears
 *   from `map` but the id stays owned, so the stale catalog copy is stripped on
 *   the way out too. Writers only add; readers only compare.
 * - Reads never throw and never block on a broken file: an unreadable overlay
 *   degrades to "no overlay", i.e. exactly the pre-feature behaviour.
 */
const OVERLAY_SOURCE = 'leaf';

// Leaf publishes 1-5 fixtures. 256 KB is ~50x headroom and still small enough
// that a corrupt or hostile file cannot be turned into a worker-sized parse.
const MAX_OVERLAY_BYTES = 256 * 1024;
// Tombstones are just strings; a match row leaves the catalog long before this
// many distinct live fixtures accumulate. Trim oldest-first if it ever grows.
const MAX_OWNED_IDS = 500;
// One stat() per second per worker for the cross-worker mtime poll — the same
// throttle CacheService uses for the catalog file itself.
const STAT_THROTTLE_MS = 1000;

function resolveOverlayFile() {
  // Operator override, read at runtime. Absolute paths only, mirroring
  // CacheService's MATCHES_CACHE_PATH so both files can be relocated together.
  if (process.env.LIVE_OVERLAY_FILE) return path.resolve(process.env.LIVE_OVERLAY_FILE);
  // Jest runs files in parallel workers that would otherwise share one overlay
  // file and cross-contaminate each other's revisions.
  if (process.env.JEST_WORKER_ID) {
    return path.join(os.tmpdir(), `nuvio-live-overlay-test-${process.pid}.json`);
  }
  // Deliberately the same expression CacheService uses: the bundler rewrites
  // path.join(process.cwd(), 'data'), so this lands beside matches_cache.json
  // wherever that resolves (dist/ in the shipped bundle), and a rebuild cannot
  // move one without the other.
  const dir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
  return path.join(dir, 'live_overlay.json');
}

function isLeafSource(src) {
  return Boolean(src) && String(src.source || '').toLowerCase() === OVERLAY_SOURCE;
}

function normalizeSources(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (!isLeafSource(raw)) continue;
    const id = raw.id == null ? '' : String(raw.id);
    if (!id) continue;
    if (out.some((s) => s.id === id)) continue;
    const src = { source: OVERLAY_SOURCE, id };
    if (raw.name) src.name = String(raw.name);
    out.push(src);
  }
  return out;
}

/** Accepts a Map, a plain object, or an array of [id, sources] pairs. */
function normalizeMap(input) {
  const out = new Map();
  if (!input) return out;
  const entries = (input instanceof Map)
    ? [...input.entries()]
    : (Array.isArray(input) ? input : Object.entries(input));
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const id = pair[0] == null ? '' : String(pair[0]);
    if (!id) continue;
    const sources = normalizeSources(pair[1]);
    if (sources.length === 0) continue;
    out.set(id, sources);
  }
  return out;
}

function sourceListKey(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => `${s && s.source}:${s && s.id}`)
    .sort()
    .join('|');
}

function sameSourceList(a, b) {
  return sourceListKey(a) === sourceListKey(b);
}

function trimSet(set, max) {
  if (set.size <= max) return;
  const drop = set.size - max;
  let n = 0;
  for (const value of set) {
    if (n++ >= drop) break;
    set.delete(value);
  }
}

class LiveOverlayService {
  constructor(opts = {}) {
    this.filePath = opts.file || resolveOverlayFile();
    this.map = new Map();          // canonical match id -> leaf sources[]
    this.ownedIds = new Set();     // ids this service has overlaid at least once
    this.revision = 0;
    this.updatedAt = 0;
    this._lastSignature = null;
    this._lastStatCheck = 0;
    this._writeErrors = 0;
    this._readErrors = 0;
    // Adopt the on-disk snapshot (and its revision) at boot, so a worker reload
    // continues the sequence instead of restarting it at 0 while the other
    // worker still compares against the higher number.
    this.syncFromDisk(true);
  }

  get size() {
    return this.map.size;
  }

  /**
   * Re-read the file when another worker has written it. Throttled: this sits
   * on the meta and stream request paths, so it must not become a per-request
   * syscall.
   *
   * @param {boolean} force bypass the throttle (boot, tests)
   * @returns {boolean} true when memory was replaced
   */
  syncFromDisk(force = false) {
    const now = Date.now();
    if (!force && now - this._lastStatCheck < STAT_THROTTLE_MS) return false;
    this._lastStatCheck = now;

    let stats;
    try {
      stats = fs.statSync(this.filePath);
    } catch (_) {
      return false; // no file yet: nothing to adopt
    }
    if (!stats || !stats.isFile() || stats.size === 0 || stats.size > MAX_OVERLAY_BYTES) return false;

    // Atomic rename means size+mtime is enough to tell snapshots apart without
    // hashing the payload on every poll.
    const signature = `${stats.size}:${stats.mtimeMs}`;
    if (signature === this._lastSignature) return false;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (_) {
      this._readErrors++;
      return false;
    }
    if (!parsed || typeof parsed !== 'object') return false;

    const nextMap = normalizeMap(parsed.overlay || parsed.matches || {});
    const nextOwned = new Set();
    if (Array.isArray(parsed.ownedIds)) {
      for (const id of parsed.ownedIds) {
        if (id != null && String(id)) nextOwned.add(String(id));
      }
    }
    for (const id of nextMap.keys()) nextOwned.add(id);

    this._lastSignature = signature;
    this.map = nextMap;
    this.ownedIds = nextOwned;
    const rev = Number(parsed.revision);
    this.revision = Number.isFinite(rev) && rev > 0 ? Math.floor(rev) : this.revision;
    const at = Number(parsed.updatedAt);
    this.updatedAt = Number.isFinite(at) && at > 0 ? at : this.updatedAt;
    return true;
  }

  /**
   * Replace the snapshot. Writer side only (the primary cluster worker).
   *
   * A no-op tick MUST be a real no-op: no revision bump, no disk write. The
   * revision feeds the catalog page/meta cache keys, so bumping it on an
   * unchanged snapshot would wipe the whole catalog memoization every tick
   * (30x/hour) to publish a diff of zero bytes.
   *
   * @returns {{changed: boolean, revision: number, addedIds: string[], removedIds: string[], touchedIds: string[]}}
   */
  setOverlay(nextMap) {
    const normalized = normalizeMap(nextMap);
    const prev = this.map;
    const prevIds = [...prev.keys()];
    const nextIds = [...normalized.keys()];

    const addedIds = nextIds.filter((id) => !prev.has(id));
    const removedIds = prevIds.filter((id) => !normalized.has(id));
    const updatedIds = nextIds.filter((id) => prev.has(id) && !sameSourceList(prev.get(id), normalized.get(id)));

    if (addedIds.length === 0 && removedIds.length === 0 && updatedIds.length === 0) {
      return { changed: false, revision: this.revision, addedIds: [], removedIds: [], touchedIds: [] };
    }

    this.map = normalized;
    // Removed ids stay owned on purpose: that tombstone is what strips the
    // stale catalog copy of a fixture Leaf has just ended.
    for (const id of nextIds) this.ownedIds.add(id);
    trimSet(this.ownedIds, MAX_OWNED_IDS);
    this.revision += 1;
    this.updatedAt = Date.now();
    this._write();

    return {
      changed: true,
      revision: this.revision,
      addedIds,
      removedIds,
      touchedIds: [...new Set([...addedIds, ...removedIds, ...updatedIds])]
    };
  }

  _write() {
    const payload = {
      revision: this.revision,
      updatedAt: this.updatedAt,
      overlay: Object.fromEntries(this.map),
      ownedIds: [...this.ownedIds]
    };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Temp + rename: a reader must never observe a half-written overlay.
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.filePath);
      try {
        const st = fs.statSync(this.filePath);
        this._lastSignature = `${st.size}:${st.mtimeMs}`;
      } catch (_) {}
    } catch (err) {
      this._writeErrors++;
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      console.warn(`[LiveOverlay] write failed: ${err.message}`);
    }
  }

  /** Look up an entry by canonical id, then by any alias. */
  _lookup(matchId, aliasIds) {
    const id = matchId == null ? '' : String(matchId);
    if (id && this.map.has(id)) return this.map.get(id);
    if (Array.isArray(aliasIds)) {
      for (const alias of aliasIds) {
        if (alias == null || alias === '') continue;
        const key = String(alias);
        if (this.map.has(key)) return this.map.get(key);
      }
    }
    return null;
  }

  _isOwned(matchId, aliasIds) {
    const id = matchId == null ? '' : String(matchId);
    if (id && this.ownedIds.has(id)) return true;
    if (Array.isArray(aliasIds)) {
      for (const alias of aliasIds) {
        if (alias == null || alias === '') continue;
        if (this.ownedIds.has(String(alias))) return true;
      }
    }
    return false;
  }

  /**
   * Merge overlay sources onto a match's base sources.
   *
   * - Overlaid match: base `leaf` entries are dropped, overlay entries appended.
   * - Previously overlaid but no longer live: base `leaf` entries are dropped
   *   (they are stale copies of a fixture Leaf has ended).
   * - Never overlaid: base returned untouched, so a leaf source the full sync
   *   legitimately just added survives the window before the next tick.
   *
   * @returns {Array} a NEW array; the caller's base is never mutated.
   */
  mergeSources(matchId, baseSources = [], aliasIds = []) {
    this.syncFromDisk();
    const base = Array.isArray(baseSources) ? baseSources : [];
    const entry = this._lookup(matchId, aliasIds);
    if (!entry && !this._isOwned(matchId, aliasIds)) return base;

    const kept = base.filter((src) => !isLeafSource(src));
    if (!entry || entry.length === 0) return kept;

    const out = kept.slice();
    for (const src of entry) {
      const dup = out.some((s) => isLeafSource(s) && String(s.id == null ? '' : s.id) === src.id);
      // Copy: downstream resolve paths are allowed to annotate source objects,
      // and they must not be able to mutate the shared overlay snapshot.
      if (!dup) out.push({ ...src });
    }
    return out;
  }

  hasOverlay(matchId, aliasIds) {
    this.syncFromDisk();
    return this._lookup(matchId, aliasIds) !== null;
  }

  /** Boot/DI path: current revision, after polling for another worker's write. */
  getRevision() {
    this.syncFromDisk();
    return this.revision;
  }

  /** Diagnostics: never returns source objects, just counts and ids. */
  snapshot() {
    this.syncFromDisk();
    return {
      revision: this.revision,
      updatedAt: this.updatedAt,
      file: this.filePath,
      size: this.map.size,
      matchIds: [...this.map.keys()],
      ownedIds: [...this.ownedIds],
      writeErrors: this._writeErrors,
      readErrors: this._readErrors
    };
  }

  /** Test/reset helper: drop memory and the on-disk snapshot. */
  clear() {
    this.map = new Map();
    this.ownedIds = new Set();
    this.revision = 0;
    this.updatedAt = 0;
    this._lastSignature = null;
    this._lastStatCheck = 0;
    try { if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath); } catch (_) {}
  }
}

module.exports = LiveOverlayService;
module.exports.OVERLAY_SOURCE = OVERLAY_SOURCE;
module.exports.resolveOverlayFile = resolveOverlayFile;
