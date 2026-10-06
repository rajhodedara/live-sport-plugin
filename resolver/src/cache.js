// Shared resolve cache — the L2 table both cluster workers read/write so a
// stream minted by one worker is instant for the other. Keys mirror the
// worker-side StreamResolveCache keys ("source:matchId:srcId"); matchId is
// recovered as the segment between the first two colons for pruning.

const MAX_ENTRIES = 500
const DEFAULT_CLAIM_TTL_MS = 30000

const entries = new Map() // key -> { streams, status, expiresAt, storedAt }
const claims = new Map()  // key -> claimExpiresAt (a worker is actively minting)

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
  const e = entries.get(key)
  if (!e) {
    // No entry yet — but if a mint claim is held, the key is being minted by
    // another worker right now. Reporting 'minting' (not 'miss') lets the
    // polling worker wait for the result instead of duplicating the mint.
    const held = claims.get(key)
    if (held && held > Date.now()) return { status: 'minting' }
    return { status: 'miss' }
  }
  const now = Date.now()
  if (now > e.expiresAt) {
    entries.delete(key)
    const held = claims.get(key)
    if (held && held > now) return { status: 'minting' }
    return { status: 'miss' }
  }
  return { status: e.status, streams: e.streams, expiresAt: e.expiresAt }
}

// Reserve the right to mint a key. ok:false means another worker holds a
// fresh claim and is minting right now — the caller should poll cacheGet.
export function cacheClaim(key, ttlMs = DEFAULT_CLAIM_TTL_MS) {
  const now = Date.now()
  const held = claims.get(key)
  if (held && held > now) return { ok: false }
  claims.set(key, now + Math.max(5000, Number(ttlMs) || DEFAULT_CLAIM_TTL_MS))
  return { ok: true }
}

export function cacheSet(key, streams, ttlMs, status = 'ok') {
  const ttl = Math.max(1000, Number(ttlMs) || 60000)
  entries.set(key, {
    streams: Array.isArray(streams) ? streams : [],
    status: status === 'failed' ? 'failed' : 'ok',
    expiresAt: Date.now() + ttl,
    storedAt: Date.now(),
  })
  claims.delete(key)
  evictIfNeeded()
  return { ok: true, entries: entries.size }
}

export function cacheDelete(key) {
  entries.delete(key)
  claims.delete(key)
  return { ok: true }
}

// Drop entries whose match is no longer active — mirrors the worker-side
// pruneEnded semantics, including the __channel__ evergreen exemption.
export function cachePrune(activeIds) {
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
  for (const [, e] of entries) {
    if (now > e.expiresAt) continue
    if (e.status === 'ok') ok++
    else failed++
  }
  return { entries: entries.size, ok, failed, claims: claims.size }
}
