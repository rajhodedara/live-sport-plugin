// Shared resolve cache — the L2 table both cluster workers read/write so a
// stream minted by one worker is instant for the other. Keys mirror the
// worker-side StreamResolveCache keys ("source:matchId:srcId"); matchId is
// recovered as the segment between the first two colons for pruning.

import { randomUUID } from 'node:crypto'

const MAX_ENTRIES = 500
const DEFAULT_CLAIM_TTL_MS = 30000
const MAX_CLAIM_TTL_MS = 120000
const MAX_CLAIMS = 1000
const CLAIM_SWEEP_INTERVAL_MS = 1000

const entries = new Map() // key -> { streams, status, expiresAt, storedAt }
const claims = new Map()  // key -> { expiresAt, ownerToken, fenced }
let nextClaimSweepAt = 0

// A failed/abandoned mint may never POST or DELETE its reservation. Reclaim
// expired keys even if they are never requested again. Throttle full scans to
// once per second of cache activity; no background timer keeps the server alive.
function sweepExpiredClaims(now, force = false) {
  if (!force && now < nextClaimSweepAt) return
  nextClaimSweepAt = now + CLAIM_SWEEP_INTERVAL_MS
  for (const [key, claim] of claims) {
    if (claim.expiresAt <= now) claims.delete(key)
  }
}

function evictIfNeeded() {
  if (entries.size <= MAX_ENTRIES) return
  const oldest = [...entries.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)
  const excess = entries.size - MAX_ENTRIES
  for (let i = 0; i < excess; i++) entries.delete(oldest[i][0])
}

function matchIdOf(key) {
  const first = key.indexOf(':')
  if (first === -1) return null
  const second = key.indexOf(':', first + 1)
  if (second === -1) return null
  return key.slice(first + 1, second)
}

export function cacheGet(key) {
  const now = Date.now()
  sweepExpiredClaims(now)
  // The addressed key expires immediately even between full sweeps.
  const claim = claims.get(key)
  if (claim && claim.expiresAt <= now) claims.delete(key)
  const e = entries.get(key)
  if (!e) {
    // No entry yet — but if a mint claim is held, the key is being minted by
    // another worker right now. Reporting 'minting' (not 'miss') lets the
    // polling worker wait for the result instead of duplicating the mint.
    const held = claims.get(key)
    if (held && held.expiresAt > now) return { status: 'minting' }
    return { status: 'miss' }
  }
  if (now > e.expiresAt) {
    entries.delete(key)
    const held = claims.get(key)
    if (held && held.expiresAt > now) return { status: 'minting' }
    return { status: 'miss' }
  }
  return { status: e.status, streams: e.streams, expiresAt: e.expiresAt, revision: e.revision }
}

// Reserve the right to mint a key. ok:false means another worker holds a
// fresh claim and is minting right now — the caller should poll cacheGet.
export function cacheClaim(key, ttlMs = DEFAULT_CLAIM_TTL_MS, fenced = false, vacantOnly = false) {
  const now = Date.now()
  sweepExpiredClaims(now)
  if (vacantOnly) {
    if (!fenced) return { ok: false, reason: 'fence-required' }
    const entry = entries.get(key)
    // This check and acquisition are synchronous: a late mint cannot claim
    // over a result another worker published just before the request arrived.
    if (entry && entry.expiresAt >= now) return { ok: false, reason: 'cache-present' }
  }
  const held = claims.get(key)
  if (held && held.expiresAt > now) return { ok: false }
  if (held) claims.delete(key)
  if (claims.size >= MAX_CLAIMS) sweepExpiredClaims(now, true)
  // Never evict a live owner to make room for another mint.
  if (claims.size >= MAX_CLAIMS) return { ok: false, reason: 'claim-capacity' }
  const requestedTtl = Number(ttlMs)
  const ttl = Number.isFinite(requestedTtl) && requestedTtl > 0 ? requestedTtl : DEFAULT_CLAIM_TTL_MS
  const ownerToken = randomUUID()
  claims.set(key, { expiresAt: now + Math.min(MAX_CLAIM_TTL_MS, Math.max(5000, ttl)), ownerToken, fenced })
  return fenced ? { ok: true, ownerToken, supportsVacantClaim: true, vacantOnly } : { ok: true }
}

// Token-bearing operations must still own the current unexpired reservation.
// Unfenced legacy callers are supported, but cannot alter an active fenced claim.
function ownershipError(key, ownerToken) {
  const held = claims.get(key)
  if (ownerToken !== undefined) {
    if (typeof ownerToken !== 'string' || !held || held.expiresAt <= Date.now() || held.ownerToken !== ownerToken) {
      return { ok: false, reason: 'stale-owner' }
    }
  } else if (held && held.fenced && held.expiresAt > Date.now()) {
    return { ok: false, reason: 'owner-required' }
  }
  return null
}

export function cacheSet(key, streams, ttlMs, status = 'ok', ownerToken) {
  const rejected = ownershipError(key, ownerToken)
  if (rejected) return rejected
  const ttl = Math.max(1000, Number(ttlMs) || 60000)
  const revision = randomUUID()
  entries.set(key, {
    streams: Array.isArray(streams) ? streams : [],
    status: status === 'failed' ? 'failed' : 'ok',
    expiresAt: Date.now() + ttl,
    storedAt: Date.now(),
    revision,
  })
  claims.delete(key)
  evictIfNeeded()
  return { ok: true, entries: entries.size, revision }
}

export function cacheDelete(key, ownerToken, expectedRevision) {
  const rejected = ownershipError(key, ownerToken)
  if (rejected) return rejected
  if (expectedRevision !== undefined) {
    const entry = entries.get(key)
    if (typeof expectedRevision !== 'string' || !entry || entry.revision !== expectedRevision) {
      return { ok: false, reason: 'stale-revision' }
    }
    entries.delete(key)
    // Invalidating a published entry never releases an unrelated mint claim.
    return { ok: true }
  }
  entries.delete(key)
  claims.delete(key)
  return { ok: true }
}

// Drop entries whose match is no longer active — mirrors the worker-side
// pruneEnded semantics, including the __channel__ evergreen exemption.
export function cachePrune(activeIds) {
  sweepExpiredClaims(Date.now())
  const ids = activeIds instanceof Set ? activeIds : new Set(activeIds || [])
  let pruned = 0
  for (const [key] of entries) {
    const matchId = matchIdOf(key)
    if (!matchId || matchId === '__channel__') continue
    if (!ids.has(matchId)) {
      entries.delete(key)
      pruned++
    }
  }
  return { ok: true, pruned }
}

export function cacheStats() {
  let ok = 0
  let failed = 0
  const now = Date.now()
  sweepExpiredClaims(now)
  for (const [, e] of entries) {
    if (now > e.expiresAt) continue
    if (e.status === 'ok') ok++
    else failed++
  }
  return { entries: entries.size, ok, failed, claims: claims.size }
}
