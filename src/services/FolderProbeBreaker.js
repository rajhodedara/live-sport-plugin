'use strict';

/**
 * Per-folder circuit breaker for the DaddyLive folder probes.
 *
 * Every uncached channel resolution downloads one ~650 KB folder page per
 * folder (`player`, `cast`, `plus`, `casting`). When a folder has stopped
 * producing a playable stream for every channel (empty page, retired player,
 * gated embed), each of those downloads is a guaranteed miss.
 *
 * This breaker only DECIDES whether to spend that download. It never inspects
 * or alters what a folder returns:
 *   - closed:    probe normally. `failureThreshold` CONSECUTIVE misses open it,
 *                but only when the folder has also produced no hit for
 *                `quietMs`: a folder that still resolves some channels (even a
 *                small share) is left alone. Any hit resets the count.
 *   - open:      skip the folder for `openMs`.
 *   - half-open: after `openMs` exactly ONE probe is let through. A hit closes
 *                the breaker; a miss re-opens it immediately.
 *
 * Only a definitive miss ("page answered, no stream came out of it") counts.
 * Timeouts, aborts, capacity rejections and HTTP errors are NOT recorded, so a
 * transient problem can never open the breaker.
 */
class FolderProbeBreaker {
  constructor({ failureThreshold = 15, openMs = 180000, quietMs = 900000, now = Date.now, maxKeys = 64 } = {}) {
    this.failureThreshold = Math.max(1, failureThreshold | 0);
    this.openMs = Math.max(1000, openMs | 0);
    this.quietMs = Math.max(0, quietMs);
    this.now = now;
    this.lastHit = new Map(); // key -> timestamp of the last hit
    this.maxKeys = maxKeys;
    this.state = new Map(); // key -> { misses, openUntil, probing }
  }

  _get(key) {
    let s = this.state.get(key);
    if (!s) {
      if (this.state.size >= this.maxKeys) this.state.clear();
      s = { misses: 0, openUntil: 0, probing: false };
      this.state.set(key, s);
    }
    return s;
  }

  /** True when the probe should be skipped. Grants the single half-open probe. */
  shouldSkip(key) {
    const s = this.state.get(key);
    if (!s || !s.openUntil) return false;
    if (this.now() < s.openUntil) return true;
    if (s.probing) return true;
    s.probing = true;
    return false;
  }

  recordHit(key) {
    if (this.lastHit.size >= this.maxKeys) this.lastHit.clear();
    this.lastHit.set(key, this.now());
    const s = this.state.get(key);
    if (!s) return false;
    const wasOpen = s.openUntil > 0;
    this.state.delete(key);
    return wasOpen;
  }

  /** Returns true when this miss opened (or re-opened) the breaker. */
  recordMiss(key) {
    const s = this._get(key);
    const halfOpen = s.probing;
    s.probing = false;
    s.misses += 1;
    if (halfOpen) {
      s.openUntil = this.now() + this.openMs;
      return true;
    }
    const lastHit = this.lastHit.get(key);
    const recentlyUseful = lastHit !== undefined && this.now() - lastHit < this.quietMs;
    if (s.misses >= this.failureThreshold && !recentlyUseful) {
      s.openUntil = this.now() + this.openMs;
      return true;
    }
    return false;
  }

  /** Release a half-open probe that ended without a verdict (error/abort). */
  recordInconclusive(key) {
    const s = this.state.get(key);
    if (s) s.probing = false;
  }

  snapshot() {
    const out = {};
    for (const [k, s] of this.state) out[k] = { misses: s.misses, open: s.openUntil > this.now() };
    return out;
  }
}

module.exports = FolderProbeBreaker;
