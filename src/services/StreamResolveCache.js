/**
 * StreamResolveCache - prewarm / verify-before-serve cache for resolved streams.
 *
 * Design: DELIVERY/nuvio-prewarm-cache-design.md
 *  - Single-flight mints: N concurrent requests for the same source -> ONE resolveStream call.
 *  - Per-source adaptive TTLs: healthy pre-flight doubles the TTL (cap 10 min),
 *    a failed pre-flight halves it (floor 60 s) and evicts the entry.
 *  - Negative cache (~30 s) for sources that resolve to nothing or fail, so dead
 *    sources are not re-scraped on every click. getOrCreate NEVER rejects.
 *  - Entries and nested behavior hints are cloned on read, so label/preflight mutations in
 *    streams.js never touch the cached originals.
 *  - LRU cap + pruneEnded() keep memory bounded and drop ended matches.
 */

const DEFAULT_TTL_MS = 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 200;
const CHANNEL_MATCH_ID = '__channel__'; // evergreen 24/7 keys survive pruneEnded

function cloneStream(stream) {
  const copy = { ...stream };
  // streams.js changes bingeGroup, notWebReady and proxyHeaders per request.
  // Copy the entire hints tree, including request/response headers, both when
  // storing provider results and when handing them to individual callers.
  if (stream && stream.behaviorHints && typeof stream.behaviorHints === 'object') {
    copy.behaviorHints = structuredClone(stream.behaviorHints);
  }
  return copy;
}

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
let _sharedFailStreak = 0;

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
  _sharedFailStreak = 0;
}

async function _sharedJson(path, opts = {}, timeoutMs = 1500) {
  const base = _sharedBase();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, { signal: ctrl.signal, ...opts });
    if (!res.ok) return null;
    const out = await res.json();
    _sharedFailStreak = 0;
    return out;
  } catch (err) {
    // A single timeout (resolver event-loop stall under load) shouldn't
    // disable the L2 tier for every worker — require consecutive failures
    // first. A real outage (connection refused) fails fast repeatedly and
    // trips the backoff on the second miss.
    _sharedFailStreak++;
    if (_sharedFailStreak >= 2) _sharedDown();
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
    this.pendingOperations = new Map(); // key -> locally prunable operation
    this.ttl = new Map();       // sourceName -> learned TTL ms
    this.statsCounters = { hits: 0, misses: 0, negativeHits: 0, evictions: 0 };
  }

  _extractTokenRemainingMs(url) {
    if (!url || typeof url !== 'string') return 0;
    try {
      let target = url;
      if (target.includes('/api/manifest?')) {
        const u = new URL(target, 'http://localhost');
        target = u.searchParams.get('url') || target;
      }
      const u = new URL(target, 'http://localhost');
      const e = u.searchParams.get('e') || u.searchParams.get('exp') || u.searchParams.get('expires');
      if (e && /^\d+$/.test(e)) {
        const exp = parseInt(e, 10);
        const expMs = exp < 1e11 ? exp * 1000 : exp;
        return expMs - Date.now();
      }
      const token = u.searchParams.get('token');
      if (token) {
        const b64 = token.split('.')[0];
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const parts = decoded.split('|');
        if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1])) {
          const exp = parseInt(parts[parts.length - 1], 10);
          const expMs = exp < 1e11 ? exp * 1000 : exp;
          return expMs - Date.now();
        }
      }
    } catch (_) {}
    return 0;
  }

  _ttlFor(sourceName) {
    const val = this.ttl.get(sourceName) || this.defaultTtlMs;
    if (sourceName === 'daddylive') {
      return Math.min(val, 150 * 1000);
    }
    return val;
  }

  /**
   * Canonical cache key constructor shared by streams.js, CronService, and resolvers.
   * Format: `${src.source}:${matchId}:${src.id}${subKey}`
   * where subKey is `:${src.streamSource}${src.streamId ? ':' + src.streamId : ''}`.
   */
  static resolveKey(src, matchId) {
    if (!src) return '';
    const mId = (matchId && typeof matchId === 'object') ? matchId.id : (matchId || src.matchId || '');
    const subKey = src.streamSource ? `:${src.streamSource}${src.streamId ? ':' + src.streamId : ''}` : '';
    return `${src.source}:${mId}:${src.id}${subKey}`;
  }

  resolveKey(src, matchId) {
    return StreamResolveCache.resolveKey(src, matchId);
  }

  /**
   * O(1) check if a key has a fresh, positive (status === 'ok') entry.
   * Avoids cloning stream arrays or mutating LRU access order.
   */
  has(key, minRemainingMs = 0) {
    const e = this.entries.get(key);
    if (!e) return false;
    const now = Date.now();
    if (now + minRemainingMs >= e.expiresAt) {
      if (now >= e.expiresAt) this.entries.delete(key);
      return false;
    }
    return e.status === 'ok';
  }

  /**
   * O(1) check if a key is currently resolved (either positive 'ok' or negative 'failed')
   * and unexpired, preventing duplicate prewarm re-minting of already processed sources.
   */
  isResolved(key, minRemainingMs = 0) {
    const e = this.entries.get(key);
    if (!e) return false;
    const now = Date.now();
    if (now + minRemainingMs >= e.expiresAt) {
      if (now >= e.expiresAt) this.entries.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Remaining TTL in milliseconds for an entry, or 0 if missing/expired.
   */
  getRemainingTtl(key) {
    const e = this.entries.get(key);
    if (!e) return 0;
    return Math.max(0, e.expiresAt - Date.now());
  }

  /** Fresh positive entry? Returns streams with isolated behavior hints, else null. */
  get(key) {
    const e = this.entries.get(key);
    if (!e) return null;
    const now = Date.now();
    if (now >= e.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    e.lastAccess = now;
    this.entries.delete(key);
    this.entries.set(key, e);
    if (e.status !== 'ok') return null;
    return e.streams.map(cloneStream);
  }

  /**
   * Returns cached streams if fresh; otherwise mints via mintFn exactly once
   * (single-flight). Never rejects: failures/empty results are negative-cached
   * and resolve to [] until the negative window passes.
   */
  // Adopt a shared-cache payload into the local Map (L2 → L1).
  _adoptRemote(key, remote) {
    // The payload can expire between the resolver's lookup and receipt here.
    // Missing/invalid expiry must not manufacture a new lifetime for old URLs.
    const expiresAt = Number(remote.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
    const matchId = key.split(':')[1] || '';
    const streams = Array.isArray(remote.streams) ? remote.streams : [];
    this.entries.delete(key);
    this.entries.set(key, {
      streams: streams.map(cloneStream),
      matchId,
      status: remote.status === 'ok' ? 'ok' : 'failed',
      expiresAt,
      lastAccess: Date.now(),
    });
    this._evictIfNeeded();
    return true;
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
      this.entries.delete(key);
      this.entries.set(key, existing);
      if (existing.status !== 'ok') {
        this.statsCounters.negativeHits++;
        return [];
      }
      this.statsCounters.hits++;
      return existing.streams.map(cloneStream);
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      await pending.catch(() => {});
      return this.get(key) || [];
    }

    this.statsCounters.misses++;
    const operation = { matchId: key.split(':')[1] || '', pruned: false };
    this.pendingOperations.set(key, operation);

    // Reserve this key before any shared-cache I/O. Otherwise concurrent
    // callers can all pass the pending check while the first awaits L2.
    // Defer the work so even a synchronous mint failure cleans up only after
    // the promise has been registered.
    const p = Promise.resolve()
      .then(() => this._resolveAndStore(key, mintFn, operation))
      .finally(() => {
        this.inFlight.delete(key);
        this.pendingOperations.delete(key);
      });
    this.inFlight.set(key, p);
    await p.catch(() => {});
    return this.get(key) || [];
  }

  async _resolveAndStore(key, mintFn, operation) {

    // ── Shared L2: another worker may have minted (or be minting) this key ──
    let claimed = false;
    let ownerToken;
    if (_sharedAvailable()) {
      const enc = _sharedKey(key);
      let remote = await _sharedJson(enc);
      if (operation.pruned) return;
      if (remote && remote.status === 'minting') remote = await this._sharedWaitMinting(key);
      if (operation.pruned) return;
      if (remote && (remote.status === 'ok' || remote.status === 'failed')) {
        if (this._adoptRemote(key, remote)) {
          if (remote.status === 'ok') {
            this.statsCounters.hits++;
            return;
          }
          this.statsCounters.negativeHits++;
          return;
        }
        remote = null; // expired in transit: claim and mint instead
      }
      if (_sharedAvailable() && (!remote || remote.status === 'miss')) {
        const claim = await _sharedJson(`${enc}?claim=1&fenced=1`);
        if (operation.pruned) return;
        if (claim && claim.ok === false) {
          // Another worker holds the claim — wait for its result.
          remote = await this._sharedWaitMinting(key);
          if (operation.pruned) return;
          if (remote && (remote.status === 'ok' || remote.status === 'failed')) {
            if (this._adoptRemote(key, remote)) {
              if (remote.status === 'ok') {
                this.statsCounters.hits++;
                return;
              }
              this.statsCounters.negativeHits++;
              return;
            }
          }
        } else if (claim && claim.ok && typeof claim.ownerToken === 'string' && claim.ownerToken) {
          ownerToken = claim.ownerToken;
          claimed = true;
        }
        // Older resolvers may grant a claim without an ownership token.
        // Resolve locally, but do not issue an unsafe shared write/release.
      }
    }

    const parts = key.split(':');
    const sourceName = parts[0];
    const matchId = parts[1];
    const p = (async () => {
      try {
        const streams = await mintFn();
        // Pruning can run while the provider is resolving. Discard both
        // positive and negative late answers before touching either cache.
        if (operation.pruned) return;
        let status = 'failed';
        let ttl = this.negativeTtlMs;
        if (Array.isArray(streams) && streams.length > 0) {
          status = 'ok';
          ttl = this._ttlFor(sourceName);
          for (const s of streams) {
            if (s && s.url) {
              const rem = this._extractTokenRemainingMs(s.url);
              if (rem > 0) {
                ttl = Math.min(ttl, Math.max(30000, rem - 45000));
              }
            }
          }
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
              body: JSON.stringify({ streams: status === 'ok' ? streams : [], ttlMs: ttl, status, ownerToken }),
            },
            2000
          );
        }
      } catch (_) {
        if (operation.pruned) return;
        this._set(key, sourceName, matchId, [], 'failed', this.negativeTtlMs);
        // Release the shared mint claim so other workers don't stall up to
        // SHARED_POLL_MAX_MS waiting for a result we failed to produce.
        // (Claims self-expire at 30s, but an immediate release lets the next
        // worker retry right away.) Releasing also restores retry diversity:
        // the other worker's attempt may succeed where ours failed.
        if (claimed && _sharedAvailable()) {
          _sharedJson(`${_sharedKey(key)}?ownerToken=${encodeURIComponent(ownerToken)}`, { method: 'DELETE' }, 1000).catch(() => {});
        }
      }
    })();

    await p.catch(() => {});
  }

  _set(key, sourceName, matchId, streams, status, ttlMs) {
    const now = Date.now();
    this.entries.delete(key);
    this.entries.set(key, {
      streams: streams.map(cloneStream), // store our own copy
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
    const maxTtl = sourceName === 'daddylive' ? 150 * 1000 : this.maxTtlMs;
    const next = Math.min(this._ttlFor(sourceName) * 2, maxTtl);
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
    for (const operation of this.pendingOperations.values()) {
      if (operation.matchId && operation.matchId !== CHANNEL_MATCH_ID && !ids.has(operation.matchId)) {
        operation.pruned = true;
      }
    }
    for (const [key, e] of this.entries) {
      if (e.matchId === CHANNEL_MATCH_ID) continue;
      if (e.matchId && !ids.has(e.matchId)) this.entries.delete(key);
    }
    // Mirror the prune into the shared cache so ended matches don't linger
    // for the other worker either.
    if (_sharedAvailable()) {
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
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
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
