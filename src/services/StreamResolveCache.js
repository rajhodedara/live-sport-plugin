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
const sharedRevision = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value) ? value : null;
const { withTimingWork } = require('./TimingContext');
const resolverConflictState = require('./ResolverConflictState');
const { allowsLegacyResolverTcp } = require('./ResolverTrustPolicy');
const { createDeferredResolution, isDeferredResolution, isInconclusiveResolutionError,
  inconclusiveStreamsReason, DIRECT_RETRY_HINT } = require('./StreamResolutionOutcome');

// behaviorHints are small plain-JSON trees; a tight recursive copy beats V8's
// generic structuredClone serializer by 5-15x on these shapes, and cloneStream
// runs per stream on every cache read.
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

function cloneStream(stream) {
  const copy = { ...stream };
  // streams.js changes bingeGroup, notWebReady and proxyHeaders per request.
  // Copy the entire hints tree, including request/response headers, both when
  // storing provider results and when handing them to individual callers.
  if (stream && stream.behaviorHints && typeof stream.behaviorHints === 'object') {
    copy.behaviorHints = _cloneHints(stream.behaviorHints);
  }
  return copy;
}

function clonePublicStream(stream) {
  const copy = cloneStream(stream);
  delete copy[DIRECT_RETRY_HINT];
  return copy;
}

// A short positive web fallback can cross the unchanged L2 ok/failed protocol.
// Accept its internal hint only on a web-only payload; never alter direct media
// or treat an arbitrary provider control field as evidence of a failure.
function webRetryReason(streams) {
  if (!Array.isArray(streams) || !streams.length || !streams.every(s => s && !s.url && typeof s.externalUrl === 'string')) return null;
  const descriptor = Object.getOwnPropertyDescriptor(streams[0], DIRECT_RETRY_HINT);
  const reason = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  return ['timeout', 'capacity', 'cancelled', 'unavailable'].includes(reason) ? reason : null;
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

async function _sharedJson(path, opts = {}, timeoutMs = 1500, requester = fetch, conflictSignal = null) {
  const base = _sharedBase();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const signals = [ctrl.signal, ...(conflictSignal ? [conflictSignal] : []), ...(opts.signal ? [opts.signal] : [])];
    // Do not invoke an adapter at all when cancellation already happened; it
    // may not honor a pre-aborted signal and could otherwise send a request.
    if (signals.some(signal => signal.aborted)) return null;
    const res = await requester(base + path, { ...opts, signal: AbortSignal.any(signals) });
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
    // Experimental opt-in observer; absent in normal operation. An operation
    // may end in an L2 hit, so it is not proof that a provider was invoked.
    this.timingRelations = opts.timingRelations ?? null;
    // Optional prototype seam only. A real adapter must bind each request to
    // a verified resolver connection. Merely returning true is not proof.
    this.sharedResolver = opts.sharedResolver ?? null;
    this.resolverConflictState = opts.resolverConflictState ?? resolverConflictState;

    this.entries = new Map();   // key -> { streams, matchId, status, resolvedAt, expiresAt, lastAccess }
    this.inFlight = new Map();  // key -> Promise (mint in progress)
    this.pendingOperations = new Map(); // key -> locally prunable operation
    this.ttl = new Map();       // sourceName -> learned TTL ms
    this.statsCounters = { hits: 0, misses: 0, negativeHits: 0, deferredHits: 0, deferrals: 0, evictions: 0 };
  }

  _extractTokenRemainingMs(url) {
    if (!url || typeof url !== 'string') return 0;
    try {
      let target = url;
      if (target.includes('/api/manifest?') || target.includes('/api/manifest.m3u8?')) {
        const u = new URL(target, 'http://localhost');
        target = u.searchParams.get('url') || target;
      }
      if (target.includes('/api/leaf/manifest.m3u8?') || target.includes('/api/leaf/live.m3u8?')) {
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
      const ft = u.searchParams.get('ft');
      if (ft && ft.includes('.')) {
        const parts = ft.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          if (payload && typeof payload.exp === 'number') {
            const expMs = payload.exp < 1e11 ? payload.exp * 1000 : payload.exp;
            return expMs - Date.now();
          }
        }
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
    if (sourceName === 'daddylive') {
      const val = this.ttl.get(sourceName) || this.defaultTtlMs;
      return Math.min(val, 150 * 1000);
    }
    if (sourceName === 'leaf') {
      const val = this.ttl.get(sourceName);
      return Math.min(val || (4 * 3600 * 1000), 4 * 3600 * 1000);
    }
    return this.ttl.get(sourceName) || this.defaultTtlMs;
  }

  /**
   * Canonical cache key constructor shared by streams.js, CronService, and resolvers.
   * Format: key = source:matchId:srcId (+ :streamSource[:streamId] when present).
   */
  static resolveKey(src, matchId) {
    if (!src) return '';
    const mId = (matchId && typeof matchId === 'object') ? matchId.id : (matchId || src.matchId || '');
    const subKey = src.streamSource ? ':' + src.streamSource + (src.streamId ? ':' + src.streamId : '') : '';
    return src.source + ':' + mId + ':' + src.id + subKey;
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

  /** Local inconclusive cooldown only; never treats a negative result as one. */
  isDeferred(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return entry.status === 'deferred' || (entry.status === 'ok' && Boolean(entry.retryReason));
  }

  /**
   * O(1) check if a key has an unexpired positive, negative or short local
   * deferred result — prevents duplicate prewarm work during its cooldown.
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
    return e.streams.map(clonePublicStream);
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
    const retryReason = remote.status === 'ok' ? webRetryReason(streams) : null;
    this.entries.delete(key);
    this.entries.set(key, {
      streams: streams.map(cloneStream),
      matchId,
      status: remote.status === 'ok' ? 'ok' : 'failed',
      expiresAt: retryReason ? Math.min(expiresAt, Date.now() + 2000) : expiresAt,
      lastAccess: Date.now(),
      sharedRevision: sharedRevision(remote.revision),
      ...(retryReason ? { retryReason } : {}),
    });
    this._evictIfNeeded();
    return true;
  }

  _sharedAvailable() {
    try { if (this.resolverConflictState.hasConflict() !== false) return false; }
    catch (_) { return false; }
    if (!_sharedAvailable()) return false;
    if (this.sharedResolver === null) return allowsLegacyResolverTcp();
    try {
      return typeof this.sharedResolver.available === 'function' &&
        typeof this.sharedResolver.request === 'function' && this.sharedResolver.available() === true;
    } catch (_) { return false; }
  }

  async _sharedJson(path, opts = {}, timeoutMs = 1500) {
    if (!this._sharedAvailable()) return null;
    const requester = this.sharedResolver === null ? fetch : this.sharedResolver.request.bind(this.sharedResolver);
    let conflictSignal = null;
    try { conflictSignal = this.resolverConflictState.signal?.() || null; } catch (_) { return null; }
    const result = await _sharedJson(path, opts, timeoutMs, requester, conflictSignal);
    // An adapter might ignore AbortSignal or finish concurrently with the
    // conflict. Never accept its late response after this worker has revoked
    // access. Cancellation cannot retract data already sent to the endpoint.
    try { if (this.resolverConflictState.hasConflict() !== false || conflictSignal?.aborted) return null; }
    catch (_) { return null; }
    return result;
  }

  // Poll the shared cache while another worker holds the mint claim.
  async _sharedWaitMinting(key) {
    const deadline = Date.now() + SHARED_POLL_MAX_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SHARED_POLL_INTERVAL_MS));
      if (!this._sharedAvailable()) return null;
      const r = await this._sharedJson(_sharedKey(key));
      if (!r || r.status === 'miss') return null;
      if (r.status === 'ok' || r.status === 'failed') return r;
    }
    return null;
  }

  async getOrCreate(key, mintFn, timingStream = null) {
    const now = Date.now();
    const existing = this.entries.get(key);

    if (existing && existing.expiresAt > now) {
      existing.lastAccess = now;
      this.entries.delete(key);
      this.entries.set(key, existing);
      if (existing.status !== 'ok') {
        if (existing.status === 'deferred') this.statsCounters.deferredHits++;
        else this.statsCounters.negativeHits++;
        return [];
      }
      this.statsCounters.hits++;
      return existing.streams.map(clonePublicStream);
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this._linkTiming(timingStream, this.pendingOperations.get(key)?.timingWork);
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
        if (operation.timingWork) {
          try { this.timingRelations?.endWork(operation.timingWork); } catch (_) { /* diagnostic only */ }
        }
      });
    this.inFlight.set(key, p);
    // Reserve before invoking any diagnostic callback: a synchronous sink can
    // itself call getOrCreate and must observe this same in-flight operation.
    if (this.timingRelations) {
      try { operation.timingWork = this.timingRelations.work(key.split(':', 1)[0]); } catch (_) { /* diagnostic only */ }
      this._linkTiming(timingStream, operation.timingWork);
    }
    await p.catch(() => {});
    return this.get(key) || [];
  }

  _linkTiming(stream, work) {
    if (!this.timingRelations || !stream || !work) return;
    try { this.timingRelations.link(stream, work); } catch (_) { /* diagnostic only */ }
  }

  async _timedMint(operation, mintFn) {
    const work = operation.timingWork;
    if (work) { try { this.timingRelations?.startMint(work); } catch (_) { /* diagnostic only */ } }
    let outcome = 'threw';
    try {
      const value = await withTimingWork(work, mintFn);
      outcome = 'returned';
      return value;
    } finally {
      if (work) { try { this.timingRelations?.endMint(work, outcome); } catch (_) { /* diagnostic only */ } }
    }
  }

  async _resolveAndStore(key, mintFn, operation) {

    // ── Shared L2: another worker may have minted (or be minting) this key ──
    let claimed = false;
    let ownerToken;
    let supportsVacantClaim = false;
    if (this._sharedAvailable()) {
      const enc = _sharedKey(key);
      let remote = await this._sharedJson(enc);
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
      if (this._sharedAvailable() && (!remote || remote.status === 'miss')) {
        const claim = await this._sharedJson(`${enc}?claim=1&fenced=1`);
        if (operation.pruned) return;
        if (claim && claim.ok === false && claim.reason !== 'claim-capacity') {
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
          supportsVacantClaim = claim.supportsVacantClaim === true;
          claimed = true;
        }
        // An older resolver may grant a claim without a token; keep local
        // playback available but skip an unsafe shared write/release.
      }
    }

    const parts = key.split(':');
    const sourceName = parts[0];
    const matchId = parts[1];
    const releaseOwnedClaim = async () => {
      if (!claimed || typeof ownerToken !== 'string' || !ownerToken || !this._sharedAvailable()) return;
      // A stale token is rejected atomically by the resolver. Never send an
      // unfenced DELETE or replace a newer owner's result on a deferral.
      try {
        await this._sharedJson(`${_sharedKey(key)}?ownerToken=${encodeURIComponent(ownerToken)}`, { method: 'DELETE' }, 1000);
      } catch (_) { /* retain local cooldown; the fenced claim self-expires */ }
    };
    const storeDeferred = outcome => {
      const entry = this._set(key, sourceName, matchId, [], 'deferred', outcome.retryAfterMs);
      entry.reason = outcome.reason;
      this.statsCounters.deferrals++;
    };
    let deferred = null;
    const p = (async () => {
      try {
        const streams = await (operation.timingWork
          ? this._timedMint(operation, mintFn)
          : withTimingWork(null, mintFn));
        // Pruning can run while the provider is resolving. Discard both
        // positive and negative late answers before touching either cache.
        if (operation.pruned) {
          await releaseOwnedClaim();
          return;
        }
        if (isDeferredResolution(streams)) {
          deferred = streams;
          storeDeferred(streams);
          // The resolver protocol remains ok/failed/minting only. A short
          // local cooldown must not become a shared 30-second dead verdict.
          await releaseOwnedClaim();
          return;
        }
        let status = 'failed';
        let ttl = this.negativeTtlMs;
        let localEntry;
        let storedStreams = [];
        if (Array.isArray(streams) && streams.length > 0) {
          status = 'ok';
          ttl = this._ttlFor(sourceName);
          storedStreams = streams.map(clonePublicStream);
          const retryReason = inconclusiveStreamsReason(streams);
          if (retryReason && storedStreams.every(s => s && !s.url && typeof s.externalUrl === 'string')) {
            storedStreams[0][DIRECT_RETRY_HINT] = retryReason;
            ttl = Math.min(ttl, 2000);
            this.statsCounters.deferrals++;
          }
          // A PPV web fallback is usable as a hand-off, but it must not delay
          // another direct-playback attempt longer than an empty result did.
          if (sourceName === 'ppvst' && streams.every(s => s && !s.url && s.externalUrl)) {
            ttl = Math.min(ttl, this.negativeTtlMs);
          }
          for (const s of streams) {
            if (s && s.url) {
              const rem = this._extractTokenRemainingMs(s.url);
              if (rem > 0) {
                ttl = Math.min(ttl, Math.max(30000, rem - 45000));
              }
            }
          }
          localEntry = this._set(key, sourceName, matchId, storedStreams, 'ok', ttl);
        } else {
          localEntry = this._set(key, sourceName, matchId, [], 'failed', ttl);
        }
        // Keep publication authority until the RPC settles, even if an expiry
        // reader has already removed this entry from the local map.
        operation.publicationEntry = localEntry;
        // Write-through so the other worker inherits the mint instantly.
        if (claimed && this._sharedAvailable()) {
          const publish = token => this._sharedJson(
            _sharedKey(key),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ streams: status === 'ok' ? storedStreams : [], ttlMs: ttl, status, ownerToken: token }),
            },
            2000
          );
          const rememberPublication = async result => {
            const revision = result?.ok === true && sharedRevision(result.revision);
            if (!revision) return;
            localEntry.sharedRevision = revision;
            // Failure/pruning may have happened while the POST was in flight.
            if (localEntry.invalidated || operation.pruned) await this._invalidateShared(key, revision);
          };
          const write = await publish(ownerToken);
          await rememberPublication(write);
          // Background mints can outlive the original lease. Retry once with
          // a fresh lease only if the resolver atomically confirms no cached
          // result or active owner would be displaced. Older resolvers must
          // explicitly advertise this protocol before we attempt recovery.
          if (write && write.ok === false && write.reason === 'stale-owner' && supportsVacantClaim && !operation.pruned && this._sharedAvailable()) {
            const fresh = await this._sharedJson(`${_sharedKey(key)}?claim=1&fenced=1&vacant=1`);
            if (!operation.pruned && fresh && fresh.ok && fresh.vacantOnly === true && typeof fresh.ownerToken === 'string' && fresh.ownerToken) {
              ownerToken = fresh.ownerToken;
              await rememberPublication(await publish(ownerToken));
            }
          }
        }
        if (operation.pruned || localEntry.invalidated) {
          await releaseOwnedClaim();
          return;
        }
        // Publishing can consume the entire two-second retry window. Start
        // that cooldown when this mint finishes so its first caller still
        // receives the verified web fallback. Never rearm media, an explicit
        // invalidation, a pruned operation, or a newer local publication.
        const current = this.entries.get(key);
        if (localEntry.retryReason && !operation.publicationEvicted &&
            this.pendingOperations.get(key) === operation &&
            (!current || current === localEntry)) {
          const completedAt = Date.now();
          localEntry.resolvedAt = completedAt;
          localEntry.expiresAt = Math.max(localEntry.expiresAt, completedAt + ttl);
          localEntry.lastAccess = completedAt;
          this.entries.delete(key);
          this.entries.set(key, localEntry);
          this._evictIfNeeded();
        }
      } catch (error) {
        if (operation.pruned) {
          await releaseOwnedClaim();
          return;
        }
        if (deferred || isDeferredResolution(error) || isInconclusiveResolutionError(error)) {
          if (!deferred) {
            let reason = 'timeout';
            // The predicate has already validated this finite cause chain.
            // Keep the local reason accurate even when a wrapper has its own
            // unrelated code instead of masking the underlying capacity error.
            for (let current = error, depth = 0; current && typeof current === 'object' && depth < 8; current = current.cause, depth++) {
              if (current.name === 'AbortError') { reason = 'cancelled'; break; }
              if (current.code === 'ERR_OUTBOUND_CAPACITY' || /^ERR_NATIVE_(POOL|SLOT)_(BUSY|CAPACITY)$/.test(current.code || '')) reason = 'capacity';
            }
            deferred = isDeferredResolution(error) ? error : createDeferredResolution(reason);
            storeDeferred(deferred);
          }
          await releaseOwnedClaim();
          return;
        }
        this._set(key, sourceName, matchId, [], 'failed', this.negativeTtlMs);
        // Release the shared mint claim so other workers don't stall up to
        // SHARED_POLL_MAX_MS waiting for a result we failed to produce.
        // (Claims self-expire at 30s, but an immediate release lets the next
        // worker retry right away.) Releasing also restores retry diversity:
        // the other worker's attempt may succeed where ours failed.
        if (claimed && this._sharedAvailable()) {
          this._sharedJson(`${_sharedKey(key)}?ownerToken=${encodeURIComponent(ownerToken)}`, { method: 'DELETE' }, 1000).catch(() => {});
        }
      }
    })();

    await p.catch(() => {});
  }

  _set(key, sourceName, matchId, streams, status, ttlMs) {
    const now = Date.now();
    this.entries.delete(key);
    const entry = {
      streams: streams.map(cloneStream), // store our own copy
      matchId, status,
      resolvedAt: now,
      expiresAt: now + ttlMs,
      lastAccess: now
    };
    const retryReason = status === 'ok' ? webRetryReason(streams) : null;
    if (retryReason) entry.retryReason = retryReason;
    this.entries.set(key, entry);
    this._evictIfNeeded();
    return entry;
  }

  /** Pre-flight passed: double the source TTL (capped) and extend the entry. */
  noteSuccess(key) {
    if (!key) return;
    const sourceName = key.split(':')[0];
    const maxTtl = sourceName === 'daddylive' ? 150 * 1000 : (sourceName === 'leaf' ? 4 * 3600 * 1000 : this.maxTtlMs);
    const next = Math.min(this._ttlFor(sourceName) * 2, maxTtl);
    this.ttl.set(sourceName, next);
    const e = this.entries.get(key);
    if (e && e.status === 'ok' && !e.retryReason && e.expiresAt > Date.now()) {
      e.expiresAt = Math.max(e.expiresAt, Date.now() + next);
    }
  }

  /** Pre-flight failed: halve the source TTL (floored) and evict the entry. */
  noteFailure(key) {
    if (!key) return;
    const sourceName = key.split(':')[0];
    const next = Math.max(Math.floor(this._ttlFor(sourceName) / 2), this.minTtlMs);
    this.ttl.set(sourceName, next);
    const entry = this.entries.get(key);
    if (entry) entry.invalidated = true;
    const publicationEntry = this.pendingOperations.get(key)?.publicationEntry;
    if (publicationEntry) publicationEntry.invalidated = true;
    this.entries.delete(key);
    this._invalidateShared(key, entry?.sharedRevision || publicationEntry?.sharedRevision).catch(() => {});
  }

  async _invalidateShared(key, revision) {
    // An older resolver supplies no revision. Keep its bounded L2 entry rather
    // than sending an unconditional delete. PATCH is rejected by old resolver
    // code even if the peer was downgraded after we received this revision.
    if (!sharedRevision(revision) || !this._sharedAvailable()) return;
    await this._sharedJson(`${_sharedKey(key)}?revision=${encodeURIComponent(revision)}`, { method: 'PATCH' }, 1000);
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
    if (this._sharedAvailable()) {
      this._sharedJson(
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
      const operation = this.pendingOperations.get(oldestKey);
      if (operation && operation.publicationEntry === this.entries.get(oldestKey)) operation.publicationEvicted = true;
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
      deferredHits: this.statsCounters.deferredHits,
      deferrals: this.statsCounters.deferrals,
      evictions: this.statsCounters.evictions,
      learnedTtls: Object.fromEntries(this.ttl)
    };
  }
}

module.exports = StreamResolveCache;
