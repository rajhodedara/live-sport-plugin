/**
 * StreamResolveCache - prewarm / verify-before-serve cache for resolved streams.
 *
 * Design: DELIVERY/nuvio-prewarm-cache-design.md
 *  - Single-flight mints: N concurrent requests for the same source -> ONE resolveStream call.
 *  - Per-source adaptive TTLs: healthy pre-flight doubles the TTL (cap 10 min),
 *    a failed pre-flight halves it (floor 60 s) and evicts the entry.
 *  - Negative cache (~30 s) for sources that resolve to nothing or fail, so dead
 *    sources are not re-scraped on every click. getOrCreate NEVER rejects.
 *  - Entries are shallow-cloned on read, so label/preflight mutations in
 *    streams.js never touch the cached originals.
 *  - LRU cap + pruneEnded() keep memory bounded and drop ended matches.
 */

const DEFAULT_TTL_MS = 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 200;
const CHANNEL_MATCH_ID = '__channel__'; // evergreen 24/7 keys survive pruneEnded

// ─── Shared L2 (resolver-hosted) ─────────────────────────────────────────────
// Both cluster workers point at the same resolver child (127.0.0.1:7003), so a
// stream minted by one worker is a cache hit for the other. Read as L2 after
// the local Map misses; every local mint is written through. If the resolver
// is unreachable, remote mode backs off for 30s and behavior degrades to
// exactly the pre-shared local-only cache.
const SHARED_POLL_INTERVAL_MS = 400;
const SHARED_POLL_MAX_MS = 8000;
const REMOTE_DOWN_BACKOFF_MS = 30000;
let _remoteDownUntil = 0;

function _sharedBase() {
  if (String(process.env.RESOLVE_CACHE_SHARED ?? 'true') === 'false') return null;
  const port = process.env.RESOLVER_PORT || '7003';
  return `http://127.0.0.1:${port}`;
}

function _sharedAvailable() {
  return !!_sharedBase() && Date.now() > _remoteDownUntil;
}

function _sharedDown() {
  _remoteDownUntil = Date.now() + REMOTE_DOWN_BACKOFF_MS;
}

async function _sharedJson(path, opts = {}, timeoutMs = 1500) {
  const base = _sharedBase();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, { signal: ctrl.signal, ...opts });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    _sharedDown();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function _sharedKey(key) {
  return `/api/cache/${encodeURIComponent(key)}`;
}

class StreamResolveCache {
  constructor(opts = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.minTtlMs = opts.minTtlMs ?? MIN_TTL_MS;
    this.maxTtlMs = opts.maxTtlMs ?? MAX_TTL_MS;
    this.negativeTtlMs = opts.negativeTtlMs ?? NEGATIVE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;

    this.entries = new Map();   // key -> { streams, matchId, status, resolvedAt, expiresAt, lastAccess }
    this.inFlight = new Map();  // key -> Promise (mint in progress)
    this.ttl = new Map();       // sourceName -> learned TTL ms
    this.statsCounters = { hits: 0, misses: 0, negativeHits: 0, evictions: 0 };
  }

  _ttlFor(sourceName) {
    return this.ttl.get(sourceName) || this.defaultTtlMs;
  }

  /** Fresh positive entry? Returns a shallow clone of the streams, else null. */
  get(key) {
    const e = this.entries.get(key);
    if (!e) return null;
    const now = Date.now();
    if (now > e.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    e.lastAccess = now;
    if (e.status !== 'ok') return null;
    return e.streams.map((s) => ({ ...s }));
  }

  /**
   * Returns cached streams if fresh; otherwise mints via mintFn exactly once
   * (single-flight). Never rejects: failures/empty results are negative-cached
   * and resolve to [] until the negative window passes.
   */
  // Adopt a shared-cache payload into the local Map (L2 → L1).
  _adoptRemote(key, remote) {
    const matchId = key.split(':')[1] || '';
    const streams = Array.isArray(remote.streams) ? remote.streams : [];
    this.entries.set(key, {
      streams: streams.map((s) => ({ ...s })),
      matchId,
      status: remote.status === 'ok' ? 'ok' : 'failed',
      expiresAt: Number(remote.expiresAt) || Date.now() + this.defaultTtlMs,
      lastAccess: Date.now(),
    });
    this._evictIfNeeded();
  }

  // Poll the shared cache while another worker holds the mint claim.
  async _sharedWaitMinting(key) {
    const deadline = Date.now() + SHARED_POLL_MAX_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SHARED_POLL_INTERVAL_MS));
      if (!_sharedAvailable()) return null;
      const r = await _sharedJson(_sharedKey(key));
      if (!r || r.status === 'miss') return null;
      if (r.status === 'ok' || r.status === 'failed') return r;
    }
    return null;
  }

  async getOrCreate(key, mintFn) {
    const now = Date.now();
    const existing = this.entries.get(key);

    if (existing && existing.expiresAt > now) {
      existing.lastAccess = now;
      if (existing.status !== 'ok') {
        this.statsCounters.negativeHits++;
        return [];
      }
      this.statsCounters.hits++;
      return existing.streams.map((s) => ({ ...s }));
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      await pending.catch(() => {});
      return this.get(key) || [];
    }

    this.statsCounters.misses++;

    // ── Shared L2: another worker may have minted (or be minting) this key ──
    let claimed = false;
    if (_sharedAvailable()) {
      const enc = _sharedKey(key);
      let remote = await _sharedJson(enc);
      if (remote && remote.status === 'minting') remote = await this._sharedWaitMinting(key);
      if (remote && (remote.status === 'ok' || remote.status === 'failed')) {
        this._adoptRemote(key, remote);
        if (remote.status === 'ok') {
          this.statsCounters.hits++;
          return this.get(key) || [];
        }
        this.statsCounters.negativeHits++;
        return [];
      }
      if (_sharedAvailable() && (!remote || remote.status === 'miss')) {
        const claim = await _sharedJson(`${enc}?claim=1`);
        if (claim && claim.ok === false) {
          // Another worker holds the claim — wait for its result.
          remote = await this._sharedWaitMinting(key);
          if (remote && (remote.status === 'ok' || remote.status === 'failed')) {
            this._adoptRemote(key, remote);
            if (remote.status === 'ok') {
              this.statsCounters.hits++;
              return this.get(key) || [];
            }
            this.statsCounters.negativeHits++;
            return [];
          }
        } else if (claim && claim.ok) {
          claimed = true; // we own the mint; write the result back below
        }
      }
    }

    const parts = key.split(':');
    const sourceName = parts[0];
    const matchId = parts[1];
    const p = (async () => {
      try {
        const streams = await mintFn();
        let status = 'failed';
        let ttl = this.negativeTtlMs;
        if (Array.isArray(streams) && streams.length > 0) {
          status = 'ok';
          ttl = this._ttlFor(sourceName);
          this._set(key, sourceName, matchId, streams, 'ok', ttl);
        } else {
          this._set(key, sourceName, matchId, [], 'failed', ttl);
        }
        // Write-through so the other worker inherits the mint instantly.
        if (claimed && _sharedAvailable()) {
          await _sharedJson(
            _sharedKey(key),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ streams: status === 'ok' ? streams : [], ttlMs: ttl, status }),
            },
            2000
          );
        }
      } catch (_) {
        this._set(key, sourceName, matchId, [], 'failed', this.negativeTtlMs);
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, p);
    await p.catch(() => {});
    return this.get(key) || [];
  }

  _set(key, sourceName, matchId, streams, status, ttlMs) {
    const now = Date.now();
    this.entries.set(key, {
      streams: streams.map((s) => ({ ...s })), // store our own copy
      matchId, status,
      resolvedAt: now,
      expiresAt: now + ttlMs,
      lastAccess: now
    });
    this._evictIfNeeded();
  }

  /** Pre-flight passed: double the source TTL (capped) and extend the entry. */
  noteSuccess(key) {
    if (!key) return;
    const sourceName = key.split(':')[0];
    const next = Math.min(this._ttlFor(sourceName) * 2, this.maxTtlMs);
    this.ttl.set(sourceName, next);
    const e = this.entries.get(key);
    if (e && e.status === 'ok') {
      e.expiresAt = Math.max(e.expiresAt, Date.now() + next);
    }
  }

  /** Pre-flight failed: halve the source TTL (floored) and evict the entry. */
  noteFailure(key) {
    if (!key) return;
    const sourceName = key.split(':')[0];
    const next = Math.max(Math.floor(this._ttlFor(sourceName) / 2), this.minTtlMs);
    this.ttl.set(sourceName, next);
    this.entries.delete(key);
    if (_sharedAvailable()) {
      _sharedJson(_sharedKey(key), { method: 'DELETE' }, 1000).catch(() => {});
    }
  }

  /** Drop entries whose match is no longer in the active match set. */
  pruneEnded(activeMatchIds) {
    const ids = activeMatchIds instanceof Set ? activeMatchIds : new Set(activeMatchIds || []);
    for (const [key, e] of this.entries) {
      if (e.matchId === CHANNEL_MATCH_ID) continue;
      if (e.matchId && !ids.has(e.matchId)) this.entries.delete(key);
    }
    // Mirror the prune into the shared cache so ended matches don't linger
    // for the other worker either.
    if (_sharedAvailable() && ids.size) {
      _sharedJson(
        '/api/cache/prune',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activeIds: [...ids] }),
        },
        2000
      ).catch(() => {});
    }
  }

  _evictIfNeeded() {
    if (this.entries.size <= this.maxEntries) return;
    const byAccess = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const excess = this.entries.size - this.maxEntries;
    for (let i = 0; i < excess; i++) {
      this.entries.delete(byAccess[i][0]);
      this.statsCounters.evictions++;
    }
  }

  stats() {
    return {
      entries: this.entries.size,
      inFlight: this.inFlight.size,
      hits: this.statsCounters.hits,
      misses: this.statsCounters.misses,
      negativeHits: this.statsCounters.negativeHits,
      evictions: this.statsCounters.evictions,
      learnedTtls: Object.fromEntries(this.ttl)
    };
  }
}

module.exports = StreamResolveCache;
