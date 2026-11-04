'use strict';

const { safeFetch } = require('../impitClient');

const MAX_CACHE_SIZE = 5000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL for immutable chunk lengths
const DEFAULT_FALLBACK_LENGTH = 1022720; // 5440 * 188 bytes (MPEG-TS packet aligned)
const DEFAULT_BITRATE = 6000000; // 6 Mbps default for 1080p
const CLOAKED_PREFIX_BYTES = 42; // fake WebP/RIFF header Streamed.pk / TikTok CDN prepends

// Over-declare the fallback estimate. An over-declared range is harmless: the CDN
// answers 206 with the bytes that actually exist, so the player still receives the
// whole segment. An under-declared range truncates the tail of every chunk
// mid-GOP, which the decoder shows as a cut frame at each segment boundary.
// Probed lengths stay exact; only this fallback is padded.
//
// PPV.st is why 1.0 cannot come back: its chunks carry ~6.9 Mbps against a
// 5.45 Mbps BANDWIDTH declaration, so a 1.0 estimate cut 12-33 % of every chunk
// whenever a probe did not land.
const ESTIMATE_SAFETY_FACTOR = 1.5;

// After a failed probe, suppress re-probing for this long so the ~2-4s playlist
// rewrite cadence does not fire a new probe for the same URL every cycle.
const PROBE_RETRY_MS = 10 * 1000;
const MAX_FAILURE_ENTRIES = 5000;
// A CDN can ignore Range: bytes=0-0 and reply with a full 200 video segment.
// Only response headers are needed; never buffer the media payload for a probe.
const PROBE_MAX_BODY_BYTES = 1024;

// Auth-style refusals are the only answer that justifies repeating a probe with
// the provider Referer/Origin; anything else would just repeat the same request.
const isRefusal = status => status === 401 || status === 403;

class SegmentLengthService {
  constructor(opts = {}) {
    this.maxSize = opts.maxSize || MAX_CACHE_SIZE;
    this.autoProbe = opts.autoProbe !== false;
    this.maxConcurrentProbes = Number.isSafeInteger(opts.maxConcurrentProbes) && opts.maxConcurrentProbes > 0
      ? opts.maxConcurrentProbes
      : 4;
    this.activeProbes = 0;
    this.cache = new Map(); // url -> { length, expiresAt }
    this.inFlightProbes = new Map(); // url -> Promise<number|null>
    this.probeFailures = new Map(); // url -> timestamp of last failed probe
  }

  /**
   * Align byte count to MPEG-TS packet boundary (188 bytes).
   *
   * @param {number} rawBytes
   * @returns {number}
   */
  alignToTsPacket(rawBytes) {
    if (rawBytes <= 188) return 188;
    return Math.floor(rawBytes / 188) * 188;
  }

  /**
   * Check if a segment URL has a valid probed length in cache.
   *
   * @param {string} segmentUrl
   * @returns {boolean}
   */
  hasValidLength(segmentUrl) {
    const cached = this.cache.get(segmentUrl);
    return Boolean(cached && cached.expiresAt > Date.now() && cached.length > 0);
  }

  /**
   * Get cached segment length or compute a fast over-declared fallback while
   * probing in the background. Only a PROBED length is ever cached — estimates
   * are recomputed per call so a failed probe retries on the next playlist
   * cycle instead of poisoning the cache with a wrong length.
   *
   * @param {string} segmentUrl Upstream segment URL
   * @param {Object} [opts={}]
   * @param {number} [opts.duration] Segment duration in seconds (from #EXTINF)
   * @param {number} [opts.bitrate] Stream bitrate in bps (from #EXT-X-STREAM-INF)
   * @param {string} [opts.referer]
   * @param {string} [opts.origin]
   * @returns {number} Segment byte length (excluding the 42 fake prefix bytes)
   */
  getSegmentLength(segmentUrl, opts = {}) {
    const cached = this.cache.get(segmentUrl);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.length;
    }

    // Trigger non-blocking background probe — unless one just failed for this
    // URL (avoid probe-spamming a URL that will not answer every rewrite).
    const failedAt = this.probeFailures.get(segmentUrl) || 0;
    if (this.autoProbe && now - failedAt > PROBE_RETRY_MS) {
      this.probeContentLength(segmentUrl, opts).catch(() => {});
    }

    return this.estimateLength(opts);
  }

  /**
   * Over-declared length estimate used until a probe lands.
   *
   * @param {Object} [opts={}]
   * @returns {number}
   */
  estimateLength(opts = {}) {
    let estimatedTotal;
    if (opts.duration && opts.duration > 0) {
      const bitrate = opts.bitrate || DEFAULT_BITRATE;
      estimatedTotal = Math.round((opts.duration * bitrate * ESTIMATE_SAFETY_FACTOR) / 8);
    } else {
      estimatedTotal = Math.round(DEFAULT_FALLBACK_LENGTH * ESTIMATE_SAFETY_FACTOR);
    }
    const videoBytes = Math.max(188, estimatedTotal - CLOAKED_PREFIX_BYTES);
    return this.alignToTsPacket(videoBytes);
  }

  /**
   * Probe upstream Content-Length. Signed CDN objects (TikTok .image etc.)
   * refuse HEAD but serve ranged GETs, so "Range: bytes=0-0" is tried first:
   * it returns 1 byte plus "Content-Range: bytes 0-0/<total>" carrying the
   * true object size. HEAD is kept as a fallback for CDNs that allow it.
   *
   * The probe starts WITHOUT the provider Referer on purpose, because that is
   * what the player sends and some CDNs reject it outright: on the PPV.st /
   * TikTok CDN the embed Referer alone turns every segment into 403 (Referer
   * only -> 403, bare + Range -> 206 with the exact total), which silently
   * forced every chunk onto the estimate. A 401/403 answer retries once with
   * the provider headers, so CDNs that genuinely gate on the Referer still
   * resolve to an exact length.
   *
   * Resolves with the probed byte length (excluding the 42-byte prefix), or
   * null when the probe failed. Caches only real probed lengths.
   *
   * @param {string} segmentUrl
   * @param {Object} [opts={}]
   * @returns {Promise<number|null>}
   */
  async probeContentLength(segmentUrl, opts = {}) {
    const cached = this.cache.get(segmentUrl);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.length;
    }

    if (this.inFlightProbes.has(segmentUrl)) {
      return this.inFlightProbes.get(segmentUrl);
    }

    // Segment probes are best-effort background work. Do not queue unlimited
    // distinct URLs when concurrent manifests are rewritten; callers can use
    // the existing estimated length and a later playlist cycle can retry.
    if (this.activeProbes >= this.maxConcurrentProbes) {
      return null;
    }
    this.activeProbes++;

    const bareHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    };
    const gatedHeaders = {
      ...bareHeaders,
      'Referer': opts.referer || 'https://embed.st/',
      'Origin': opts.origin || 'https://embed.st'
    };

    const probePromise = (async () => {
      try {
        const ranged = await this._rangedProbe(segmentUrl, bareHeaders);
        if (ranged.total > CLOAKED_PREFIX_BYTES) {
          return this._cacheProbedLength(segmentUrl, ranged.total);
        }

        // A refusal is the only signal worth repeating with provider headers.
        // A CDN that answered but carried no usable size will not answer better
        // just because we re-introduce a Referer it may dislike.
        const providerRequired = isRefusal(ranged.status);
        const activeHeaders = providerRequired ? gatedHeaders : bareHeaders;

        if (providerRequired) {
          const retried = await this._rangedProbe(segmentUrl, activeHeaders);
          if (retried.total > CLOAKED_PREFIX_BYTES) {
            return this._cacheProbedLength(segmentUrl, retried.total);
          }
        }

        // HEAD fallback for CDNs that allow it (Content-Length = full object).
        const head = await this._headProbe(segmentUrl, activeHeaders);
        if (head.total > CLOAKED_PREFIX_BYTES) {
          return this._cacheProbedLength(segmentUrl, head.total);
        }
        if (!providerRequired && isRefusal(head.status)) {
          const gatedHead = await this._headProbe(segmentUrl, gatedHeaders);
          if (gatedHead.total > CLOAKED_PREFIX_BYTES) {
            return this._cacheProbedLength(segmentUrl, gatedHead.total);
          }
        }
      } catch (error) {
        // Local transport admission is not evidence that the CDN probe failed.
        if (error.code === 'ERR_OUTBOUND_CAPACITY') return null;
      }

      // Probe failed: cache NOTHING. A cached estimate would be served as
      // truth for the entry's whole TTL and never re-probed — the failure
      // mode that truncates every segment by the estimate's error. Only
      // remember the failure briefly so rewrites within one playlist cycle
      // don't spam probes for the same URL.
      if (this.probeFailures.size >= MAX_FAILURE_ENTRIES) {
        this.probeFailures.clear();
      }
      this.probeFailures.set(segmentUrl, Date.now());
      return null;
    })().finally(() => {
      this.inFlightProbes.delete(segmentUrl);
      this.activeProbes = Math.max(0, this.activeProbes - 1);
    });

    this.inFlightProbes.set(segmentUrl, probePromise);
    return probePromise;
  }

  /**
   * Store a probed length and clear any failure suppression for the URL.
   *
   * @param {string} segmentUrl
   * @param {number} total Upstream object size including the cloaking prefix
   * @returns {number} Payload byte length excluding the prefix
   */
  _cacheProbedLength(segmentUrl, total) {
    const videoBytes = total - CLOAKED_PREFIX_BYTES;
    this.setCachedLength(segmentUrl, videoBytes);
    this.probeFailures.delete(segmentUrl);
    return videoBytes;
  }

  /**
   * Ranged GET probe. Signed CDN objects (TikTok .image etc.) refuse HEAD but
   * serve ranged GETs, so "Range: bytes=0-0" is the primary shape: it returns
   * 1 byte plus "Content-Range: bytes 0-0/<total>" carrying the true size.
   *
   * @param {string} segmentUrl
   * @param {Object} headers
   * @returns {Promise<{status: number, total: number}>}
   */
  async _rangedProbe(segmentUrl, headers) {
    const res = await safeFetch(segmentUrl, {
      method: 'GET',
      guardExternal: true,
      headers: { ...headers, Range: 'bytes=0-0' },
      timeoutMs: 4000,
      attempts: 1,
      maxBodyBytes: PROBE_MAX_BODY_BYTES
    });
    // A 206 Content-Length is just the partial body (often one byte), not the
    // complete segment. Trust only Content-Range's total for 206. A 200 means
    // the CDN ignored Range, but its full object Content-Length is still
    // useful. Error response lengths are never segment sizes.
    const total = res && (res.status === 206 || res.status === 200)
      ? this._totalLengthFromHeaders(res.headers, res.status === 200)
      : 0;
    return { status: res && res.status ? res.status : 0, total };
  }

  /**
   * HEAD probe, kept for CDNs that expose the full object size this way.
   *
   * @param {string} segmentUrl
   * @param {Object} headers
   * @returns {Promise<{status: number, total: number}>}
   */
  async _headProbe(segmentUrl, headers) {
    const res = await safeFetch(segmentUrl, {
      method: 'HEAD',
      guardExternal: true,
      headers,
      timeoutMs: 4000,
      attempts: 1,
      maxBodyBytes: PROBE_MAX_BODY_BYTES
    });
    const total = res && res.status === 200
      ? this._totalLengthFromHeaders(res.headers)
      : 0;
    return { status: res && res.status ? res.status : 0, total };
  }

  /**
   * Extract the total object size from Content-Range ("bytes 0-0/<total>") or
   * Content-Length headers. Returns 0 when neither carries a usable size.
   *
   * @param {Object} headers Response-like headers with .get()
   * @returns {number}
   */
  _totalLengthFromHeaders(headers, allowContentLength = true) {
    try {
      const contentRange = headers.get('content-range');
      if (contentRange) {
        const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(contentRange);
        if (m) {
          const total = parseInt(m[1], 10);
          if (Number.isFinite(total) && total > 0) return total;
        }
      }
      if (!allowContentLength) return 0;
      const cl = headers.get('content-length');
      if (cl) {
        const n = parseInt(cl, 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch (_) {}
    return 0;
  }

  setCachedLength(segmentUrl, length, ttlMs = CACHE_TTL_MS) {
    if (this.cache.size >= this.maxSize) {
      // LRU Eviction: remove oldest 20%
      const keysToDelete = [...this.cache.keys()].slice(0, Math.floor(this.maxSize * 0.2));
      for (const k of keysToDelete) {
        this.cache.delete(k);
      }
    }

    this.cache.set(segmentUrl, {
      length,
      expiresAt: Date.now() + ttlMs
    });
  }

  clear() {
    this.cache.clear();
    this.inFlightProbes.clear();
    this.probeFailures.clear();
  }
}

// Export singleton instance and class
const defaultService = new SegmentLengthService();
defaultService.SegmentLengthService = SegmentLengthService;

module.exports = defaultService;
