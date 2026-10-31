'use strict';

/**
 * SoccerFull segment length + cloaking-prefix measurement.
 *
 * SoccerFull's `/hls/<sid>.m3u8` playlists hand the player *complete* objects
 * whose payload is MPEG-TS hidden behind a fake image header. The player has to
 * be told where the video actually starts, so the rewritten playlist declares
 * `#EXT-X-BYTERANGE:<len>@<offset>` for every segment.
 *
 * The shared `SegmentLengthService` hardcodes that offset at 42 bytes, because
 * PPV.st / Streamed.pk cloak their chunks in a WebP/RIFF wrapper. SoccerFull uses
 * a different generator (`~tplv-...-ttam-origin`) that wraps the same TS in a
 * 120-byte PNG: signature (8) + IHDR (25) + sRGB (13) + gAMA/... with `IEND` at
 * byte 112, so the first 0x47 sync lands at 120.
 *
 * Declaring 42 for that object leaves 78 bytes of PNG tail in front of the
 * demuxer. Rather than change the shared service (PPV.st depends on its exact
 * behaviour), this module measures the prefix per host and caches it, and keeps
 * the same safety rule the PPV.st fix established: a probed length is exact, an
 * unprobed one is over-declared 1.5x, because an over-declared range returns
 * what exists while an under-declared one silently truncates the chunk tail.
 */

const { safeFetch } = require('./ProviderOutbound');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Historical WebP/RIFF prefix and the fallback when nothing can be measured.
const DEFAULT_PREFIX_BYTES = 42;
const PREFIX_PROBE_BYTES = 4096;
const PREFIX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LENGTH_CACHE_TTL_MS = 60 * 60 * 1000;
const PROBE_RETRY_MS = 10 * 1000;
const MAX_ENTRIES = 2000;

// Same rationale as SegmentLengthService: only an unprobed estimate is padded.
const ESTIMATE_SAFETY_FACTOR = 1.5;
const DEFAULT_BITRATE = 6000000;
const DEFAULT_FALLBACK_LENGTH = 1022720; // 5440 * 188

/**
 * Where does MPEG-TS start inside a cloaked object?
 *
 * Pure function so the offsets are unit-testable without a network call.
 *
 * @param {Buffer} buf First bytes of the object (>= 376 bytes preferred)
 * @returns {number} Byte offset where MPEG-TS begins
 */
function detectCloakPrefix(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return DEFAULT_PREFIX_BYTES;

  // Already a bare TS packet.
  if (buf[0] === 0x47) return 0;

  // PNG cloak: 89 50 4E 47 ... IHDR ... IEND<CRC>
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const iend = buf.indexOf(Buffer.from('IEND'));
    // 'IEND' is the 4-byte chunk type; its 4-byte CRC follows.
    if (iend >= 0 && iend + 8 <= buf.length) return iend + 8;
    return DEFAULT_PREFIX_BYTES;
  }

  // RIFF/WEBP cloak: RIFF<size>WEBP....EXIF<size><payload>
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    const exif = buf.indexOf(Buffer.from('EXIF'));
    if (exif >= 0 && exif + 8 <= buf.length) return exif + 8;
    return DEFAULT_PREFIX_BYTES;
  }

  // Unknown wrapper: first offset with three 188-byte-spaced sync bytes.
  const limit = Math.min(buf.length - 376, PREFIX_PROBE_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return i;
  }

  return DEFAULT_PREFIX_BYTES;
}

function alignToTsPacket(bytes) {
  if (bytes <= 188) return 188;
  return Math.floor(bytes / 188) * 188;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

/**
 * Total object size from a ranged/HEAD response.
 *
 * A 206 `Content-Length` is only the partial body, so the size must come from
 * `Content-Range: bytes 0-0/<total>`. A 200 means Range was ignored and its
 * `Content-Length` is the whole object.
 */
function totalFromHeaders(headers, allowContentLength = true) {
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

class SoccerFullSegmentLength {
  constructor(opts = {}) {
    this.maxEntries = Number.isSafeInteger(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : MAX_ENTRIES;
    this.prefixCache = new Map();   // host -> { bytes, expiresAt }
    this.lengthCache = new Map();   // url  -> { length, expiresAt }
    this.inFlightPrefix = new Map(); // host -> Promise<number>
    this.inFlightLength = new Map(); // url  -> Promise<number|null>
    this.failures = new Map();      // url  -> timestamp of last failed probe
    this.maxConcurrentProbes = Number.isSafeInteger(opts.maxConcurrentProbes) && opts.maxConcurrentProbes > 0
      ? opts.maxConcurrentProbes
      : 4;
    this.activeProbes = 0;
  }

  _evict(map) {
    if (map.size < this.maxEntries) return;
    const drop = Math.max(1, Math.floor(this.maxEntries * 0.2));
    let i = 0;
    for (const key of map.keys()) {
      if (i++ >= drop) break;
      map.delete(key);
    }
  }

  /**
   * Cached prefix for the segment's host. Synchronous because the playlist
   * rewrite must not block on the network; warmed by `probePrefixBytes`.
   */
  getPrefixBytes(segmentUrl) {
    const host = hostOf(segmentUrl);
    if (!host) return DEFAULT_PREFIX_BYTES;
    const cached = this.prefixCache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached.bytes;
    return DEFAULT_PREFIX_BYTES;
  }

  /**
   * Measure the cloaking prefix from one segment and cache it per host.
   *
   * Ranged GET on the first few KB, sent without the embed Referer — the same
   * shape the player uses, and the reason the PPV.st length probe works again
   * (TikTok's CDN answers 403 to that header alone).
   *
   * Never rejects; falls back to the historical 42 on any failure.
   *
   * @param {string} segmentUrl
   * @returns {Promise<number>}
   */
  async probePrefixBytes(segmentUrl) {
    const host = hostOf(segmentUrl);
    if (!host) return DEFAULT_PREFIX_BYTES;

    const cached = this.prefixCache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached.bytes;
    if (this.inFlightPrefix.has(host)) return this.inFlightPrefix.get(host);

    const promise = (async () => {
      try {
        const res = await safeFetch(segmentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            'Range': `bytes=0-${PREFIX_PROBE_BYTES - 1}`
          },
          timeoutMs: 4000,
          attempts: 1,
          maxBodyBytes: PREFIX_PROBE_BYTES * 2
        });
        if (!res || (res.status !== 200 && res.status !== 206)) return DEFAULT_PREFIX_BYTES;
        const buf = Buffer.from(await res.arrayBuffer());
        const bytes = detectCloakPrefix(buf);
        this._evict(this.prefixCache);
        this.prefixCache.set(host, { bytes, expiresAt: Date.now() + PREFIX_CACHE_TTL_MS });
        return bytes;
      } catch (_) {
        return DEFAULT_PREFIX_BYTES;
      }
    })().finally(() => {
      this.inFlightPrefix.delete(host);
    });

    this.inFlightPrefix.set(host, promise);
    return promise;
  }

  hasValidLength(segmentUrl) {
    const cached = this.lengthCache.get(segmentUrl);
    return Boolean(cached && cached.expiresAt > Date.now() && cached.length > 0);
  }

  setCachedLength(segmentUrl, length, ttlMs = LENGTH_CACHE_TTL_MS) {
    this._evict(this.lengthCache);
    this.lengthCache.set(segmentUrl, { length, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Payload byte count for the byterange declaration.
   *
   * Returns the exact measured payload when a probe has landed, otherwise a
   * padded estimate and schedules a background probe.
   *
   * @param {string} segmentUrl
   * @param {{duration?: number, bitrate?: number}} [opts]
   * @returns {number}
   */
  getSegmentLength(segmentUrl, opts = {}) {
    const cached = this.lengthCache.get(segmentUrl);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.length;

    const failedAt = this.failures.get(segmentUrl) || 0;
    if (now - failedAt > PROBE_RETRY_MS && !this.inFlightLength.has(segmentUrl)) {
      this.probeLength(segmentUrl).catch(() => {});
    }

    return this.estimateLength(opts);
  }

  estimateLength(opts = {}) {
    let estimatedTotal;
    if (opts.duration && opts.duration > 0) {
      const bitrate = opts.bitrate || DEFAULT_BITRATE;
      estimatedTotal = Math.round((opts.duration * bitrate * ESTIMATE_SAFETY_FACTOR) / 8);
    } else {
      estimatedTotal = Math.round(DEFAULT_FALLBACK_LENGTH * ESTIMATE_SAFETY_FACTOR);
    }
    const payload = Math.max(188, estimatedTotal - DEFAULT_PREFIX_BYTES);
    return alignToTsPacket(payload);
  }

  /**
   * Probe the exact payload size (total object minus measured prefix).
   *
   * @param {string} segmentUrl
   * @returns {Promise<number|null>} payload bytes, or null when the probe failed
   */
  async probeLength(segmentUrl) {
    const cached = this.lengthCache.get(segmentUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.length;
    if (this.inFlightLength.has(segmentUrl)) return this.inFlightLength.get(segmentUrl);

    // A cold SoccerFull playlist can carry 1500+ segments. Rewriting fires one
    // background probe per uncached segment, so without this cap the first
    // manifest request would open 1500+ concurrent ranged GETs against the CDN
    // and starve the event loop (observed: a valid playlist answered 502 while
    // the box was saturated). Unprobed segments keep their padded estimate,
    // which is safe by construction - the CDN clamps an over-declared range.
    if (this.activeProbes >= this.maxConcurrentProbes) return null;
    this.activeProbes++;

    const promise = (async () => {
      try {
        const res = await safeFetch(segmentUrl, {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, 'Range': 'bytes=0-0' },
          timeoutMs: 4000,
          attempts: 1,
          maxBodyBytes: 1024
        });

        if (res && (res.status === 206 || res.status === 200)) {
          const total = totalFromHeaders(res.headers, res.status === 200);
          if (total > 0) {
            const prefix = await this.probePrefixBytes(segmentUrl);
            const payload = Math.max(188, total - prefix);
            this.setCachedLength(segmentUrl, payload);
            this.failures.delete(segmentUrl);
            return payload;
          }
        }
      } catch (_) {}

      // Cache nothing on failure: a cached estimate would be served as truth for
      // the whole TTL and never re-probed.
      if (this.failures.size >= this.maxEntries) this.failures.clear();
      this.failures.set(segmentUrl, Date.now());
      return null;
    })().finally(() => {
      this.inFlightLength.delete(segmentUrl);
      this.activeProbes = Math.max(0, this.activeProbes - 1);
    });

    this.inFlightLength.set(segmentUrl, promise);
    return promise;
  }

  clear() {
    this.prefixCache.clear();
    this.lengthCache.clear();
    this.inFlightPrefix.clear();
    this.inFlightLength.clear();
    this.failures.clear();
  }
}

const defaultService = new SoccerFullSegmentLength();
defaultService.SoccerFullSegmentLength = SoccerFullSegmentLength;
defaultService.detectCloakPrefix = detectCloakPrefix;

module.exports = defaultService;
