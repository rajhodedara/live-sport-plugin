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
// Dead-source negative cache. 30s re-scraped dead mirrors on nearly every
// prewarm cycle (Vavoo/sunshine 403-502s dominate the verify logs); 5 minutes
// matches how long an upstream outage actually lasts without letting a
// transient blip hide a source for too long.
const NEGATIVE_TTL_MS = Number(process.env.STREAM_NEGATIVE_TTL_MS || 5 * 60 * 1000);
// One prewarm tick (12 matches x ~20 aggregated sources) is ~240 keys — the
// old 200 cap made each tick LRU-evict the previous tick's entries, so the
// warm-check always missed and everything re-minted every 3 minutes.
const MAX_ENTRIES = Number(process.env.STREAM_CACHE_MAX_ENTRIES || 600);
// DaddyLive entry ceiling. Must EXCEED the prewarm tick period (180s): a
// ceiling shorter than the tick expires every entry right before each tick's
// warm-check, forcing a full re-mint of every priority-1 match on every tick —
// measured on the live VPS as ~2MB/s of resolveStream .text() allocations in
// each worker. Bluetier-token URLs are still clamped tighter by their actual
// embedded expiry (see _extractTokenRemainingMs), so this is a ceiling, not a
// lifetime.
const DADDYLIVE_MAX_TTL_MS = Math.max(
  240 * 1000,
  Number(process.env.DADDYLIVE_MAX_TTL_MS || 5 * 60 * 1000)
);
// Global cap on concurrent mint executions (the mintFn inside getOrCreate).
// Measured on the live VPS: 250+ simultaneous mints — each holding scraper-page
// strings plus a 15-25 socket fan-out — saturated the box, and V8 heap tracked
// in-flight mints 1:1. On-demand callers WAIT up to MINT_QUEUE_WAIT_MS for a
// slot (their request's own soft deadline returns whatever arrived; late mints
// land in the cache for the next request); prewarm callers (opts.skipIfBusy)
// are shed instantly with NO entry written — not even negative — so the next
// view retries naturally.
const MINT_MAX_CONCURRENT = Number(process.env.MINT_MAX_CONCURRENT || 64);
const MINT_QUEUE_WAIT_MS = Number(process.env.MINT_QUEUE_WAIT_MS || 8000);
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
    this.mintMaxConcurrent = opts.mintMaxConcurrent ?? MINT_MAX_CONCURRENT;
    this.mintQueueWaitMs = opts.mintQueueWaitMs ?? MINT_QUEUE_WAIT_MS;

    this.entries = new Map();   // key -> { streams, matchId, status, resolvedAt, expiresAt, lastAccess }
    this.inFlight = new Map();  // key -> Promise (mint in progress)
    this.pendingOperations = new Map(); // key -> locally prunable operation
    this.ttl = new Map();       // sourceName -> learned TTL ms
    this._mintActive = 0;       // mintFn executions holding a slot right now
    this._mintWaiters = [];     // on-demand callers parked for a slot
    this.statsCounters = { hits: 0, misses: 0, negativeHits: 0, evictions: 0, shedMints: 0 };
  }

  /** True when mint slots are mostly consumed — callers shed cheap work. */
  isMintPressureHigh() {
    return this._mintActive >= Math.ceil(this.mintMaxConcurrent * 0.75);
  }

  /**
   * Run `fn` while holding one of mintMaxConcurrent slots.
   *  - opts.skipIfBusy → return null immediately when full (prewarm sheds).
   *  - otherwise wait up to mintQueueWaitMs for a slot; still full → null.
   * A null result means "shed": callers must not cache anything.
   * On release, a waiting caller is handed the slot directly (no gap, no
   * over-cap race); a timed-out waiter removes itself from the queue.
   */
  async _withMintSlot(fn, opts = {}) {
    if (this._mintActive >= this.mintMaxConcurrent) {
      if (opts.skipIfBusy) {
        this.statsCounters.shedMints++;
        return null;
      }
      const granted = await new Promise((resolve) => {
        const entry = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => {
          const i = this._mintWaiters.indexOf(entry);
          if (i !== -1) this._mintWaiters.splice(i, 1);
          resolve(false);
        }, this.mintQueueWaitMs);
        this._mintWaiters.push(entry);
      });
      if (!granted) {
        this.statsCounters.shedMints++;
        return null;
      }
      // Slot ownership was transferred by the releaser.
    } else {
      this._mintActive++;
    }
    try {
      return await fn();
    } finally {
      const wake = this._mintWaiters.shift();
      if (wake) wake(); // hand the slot straight to the next waiter
      else this._mintActive--;
    }
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
      return Math.min(val, DADDYLIVE_MAX_TTL_MS);
    }
    return val;
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

  async getOrCreate(key, mintFn, opts = {}) {
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
      .then(() => this._resolveAndStore(key, mintFn, operation, opts))
      .finally(() => {
        this.inFlight.delete(key);
        this.pendingOperations.delete(key);
      });
    this.inFlight.set(key, p);
    await p.catch(() => {});
    return this.get(key) || [];
  }

  async _resolveAndStore(key, mintFn, operation, opts = {}) {

    // ── Shared L2: another worker may have minted (or be minting) this key ──
    let claimed = false;
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
        const claim = await _sharedJson(`${enc}?claim=1`);
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
        // The mint itself runs under the global concurrency cap. A null
        // result means the caller was shed (cap full) — nothing may be
        // cached (not even negative), and any shared L2 claim is released
        // so other workers retry instead of polling to their 30s expiry.
        const streams = await this._withMintSlot(mintFn, opts);
        if (streams === null) {
          if (claimed && _sharedAvailable()) {
            _sharedJson(_sharedKey(key), { method: 'DELETE' }, 1000).catch(() => {});
          }
          return;
        }
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
              body: JSON.stringify({ streams: status === 'ok' ? streams : [], ttlMs: ttl, status }),
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
          _sharedJson(_sharedKey(key), { method: 'DELETE' }, 1000).catch(() => {});
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
    const maxTtl = sourceName === 'daddylive' ? DADDYLIVE_MAX_TTL_MS : this.maxTtlMs;
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
      mintActive: this._mintActive,
      mintCap: this.mintMaxConcurrent,
      hits: this.statsCounters.hits,
      misses: this.statsCounters.misses,
      negativeHits: this.statsCounters.negativeHits,
      shedMints: this.statsCounters.shedMints,
      evictions: this.statsCounters.evictions,
      learnedTtls: Object.fromEntries(this.ttl)
    };
  }
}

module.exports = StreamResolveCache;
