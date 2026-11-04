'use strict';

/**
 * HlsQualityProbe — measured quality metadata for single-rendition HLS.
 *
 * Why this exists
 * ---------------
 * Master playlists declare their quality (`#EXT-X-STREAM-INF:RESOLUTION=…,BANDWIDTH=…`),
 * and `M3U8ParserService.parseManifestText()` already reads it. Providers such as
 * PPV.st hand out exactly that shape, which is why their rows show a real resolution
 * and bitrate.
 *
 * TimStreams (and any TikTok-CDN backed provider) serves a **media** playlist: one
 * rendition, no `#EXT-X-STREAM-INF`, therefore no declared quality at all. The only
 * honest way to label those rows is to measure the media itself:
 *
 *   1. read `#EXTINF` of the first segment from the playlist,
 *   2. ranged-GET a bounded prefix of that segment,
 *   3. bitrate  = (Content-Range total × 8) ÷ EXTINF seconds,
 *   4. resolution = width/height read from the H.264 / HEVC SPS in the MPEG-TS payload.
 *
 * TimStreams segments are MPEG-TS behind the same 42-byte fake RIFF/WEBP header used
 * by Streamed.pk (`SegmentLengthService.CLOAKED_PREFIX_BYTES`), so the cloak is
 * stripped before the SPS scan. Verified against a live segment: 1920×1080.
 *
 * Cost discipline
 * ---------------
 * - One small playlist GET plus one ranged GET (≤ 512 KB) per stream.
 * - Results cached by token-free slug for 10 min; failures cached for 60 s.
 * - Max 4 concurrent probes process-wide; in-flight requests are de-duplicated.
 * - Any failure returns null. The caller keeps its existing fallback label; this
 *   service never throws, never drops a stream and never blocks past its budget.
 */

const CLOAKED_PREFIX_BYTES = 42;
const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 60 * 1000;
const DEFAULT_RANGE_BYTES = 512 * 1024;
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_CONCURRENT = 4;
const PLAYLIST_MAX_BYTES = 256 * 1024;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function headerValue(headers, name) {
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') return headers.get(name);
  } catch (_) { /* fall through to plain-object lookup */ }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

function contentRangeTotal(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/\/(\d+)\s*$/);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/** Bitrate label in the addon-wide convention ("6.2 Mbps" / "840 kbps"). */
function formatBitrate(bps) {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 1000000
    ? `${(n / 1000000).toFixed(1)} Mbps`
    : `${Math.round(n / 1000)} kbps`;
}

/**
 * Height → display tier. 4K is only ever claimed from real luma samples, never
 * inferred from bitrate: a 1080p feed can out-rank a starved 4K one.
 */
function tierForHeight(height) {
  const h = Number(height) || 0;
  if (h >= 2000) return { resolution: '2160p', quality: '4K UHD' };
  if (h >= 1400) return { resolution: '1440p', quality: 'QHD' };
  if (h >= 1000) return { resolution: '1080p', quality: 'FHD' };
  if (h >= 700) return { resolution: '720p', quality: 'HD' };
  if (h >= 500) return { resolution: '576p', quality: 'SD' };
  if (h >= 380) return { resolution: '480p', quality: 'SD' };
  return { resolution: 'SD', quality: 'SD' };
}

/** MPEG-TS sync probe: three consecutive 188-byte packets. */
function looksLikeTs(buf) {
  if (!buf || buf.length < 190) return false;
  return buf[0] === 0x47 && buf[188] === 0x47 && (buf.length < 377 || buf[376] === 0x47);
}

/** Strip the 42-byte fake RIFF/WEBP header TimStreams/Streamed.pk prepend. */
function stripCloak(buf) {
  if (!buf || buf.length <= CLOAKED_PREFIX_BYTES) return buf;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return buf.subarray(CLOAKED_PREFIX_BYTES);
  }
  return buf;
}

/** Remove H.264/HEVC emulation-prevention bytes (0x00 0x00 0x03). */
function stripEmulationPrevention(bytes) {
  const out = Buffer.alloc(bytes.length);
  let len = 0;
  let zeros = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (zeros >= 2 && b === 0x03) { zeros = 0; continue; }
    out[len++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, len);
}

function createBitReader(buf) {
  let bit = 0;
  const total = buf.length * 8;
  const bit1 = () => {
    if (bit >= total) throw new Error('bitstream exhausted');
    const v = (buf[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit++;
    return v;
  };
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bit1();
    return v;
  };
  const ue = () => {
    let leadingZeros = 0;
    while (bit1() === 0) {
      leadingZeros++;
      if (leadingZeros > 31) throw new Error('invalid exp-golomb');
    }
    if (leadingZeros === 0) return 0;
    return ((1 << leadingZeros) - 1) + bits(leadingZeros);
  };
  const se = () => {
    const k = ue();
    return (k & 1) ? (k + 1) / 2 : -(k / 2);
  };
  const skip = (n) => { for (let i = 0; i < n; i++) bit1(); };
  return { bit1, bits, ue, se, skip };
}

const H264_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** H.264 SPS → { width, height }. */
function parseH264Sps(payload) {
  const r = createBitReader(stripEmulationPrevention(payload));
  const profileIdc = r.bits(8);
  r.bits(8); // constraint flags + reserved
  r.bits(8); // level_idc
  r.ue(); // seq_parameter_set_id

  let chromaFormatIdc = 1;
  if (H264_HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.bit1(); // separate_colour_plane_flag
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit1(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit1()) { // seq_scaling_matrix_present_flag
      const lists = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) {
        if (!r.bit1()) continue;
        const size = i < 6 ? 16 : 64;
        let last = 8;
        let next = 8;
        for (let j = 0; j < size; j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }

  r.ue(); // log2_max_frame_num_minus4
  const picOrderCntType = r.ue();
  if (picOrderCntType === 0) {
    r.ue();
  } else if (picOrderCntType === 1) {
    r.bit1();
    r.se();
    r.se();
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit1(); // gaps_in_frame_num_value_allowed_flag

  const widthInMbs = r.ue() + 1;
  const heightInMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit1();
  if (!frameMbsOnly) r.bit1(); // mb_adaptive_frame_field_flag
  r.bit1(); // direct_8x8_inference_flag

  let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
  if (r.bit1()) {
    cropLeft = r.ue();
    cropRight = r.ue();
    cropTop = r.ue();
    cropBottom = r.ue();
  }

  const chromaArrayType = chromaFormatIdc === 3 ? 0 : chromaFormatIdc;
  const cropUnitX = chromaArrayType === 0 ? 1 : (chromaArrayType === 3 ? 1 : 2);
  const cropUnitY = (chromaArrayType === 0 ? 1 : (chromaArrayType === 3 ? 1 : 2)) * (2 - frameMbsOnly);

  const width = widthInMbs * 16 - (cropLeft + cropRight) * cropUnitX;
  const height = (2 - frameMbsOnly) * heightInMapUnits * 16 - (cropTop + cropBottom) * cropUnitY;
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height, codec: 'h264' };
}

/** HEVC SPS → { width, height }. */
function parseHevcSps(payload) {
  const r = createBitReader(stripEmulationPrevention(payload));
  r.bits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.bits(3);
  r.bit1(); // sps_temporal_id_nesting_flag

  // profile_tier_level(1, maxSubLayersMinus1)
  r.bits(2); // general_profile_space
  r.bit1(); // general_tier_flag
  r.bits(5); // general_profile_idc
  r.bits(32); // general_profile_compatibility_flags
  r.bits(48); // general_constraint_indicator_flags
  r.bits(8); // general_level_idc
  const profilePresent = [];
  const levelPresent = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent[i] = r.bit1();
    levelPresent[i] = r.bit1();
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) r.bits(2); // reserved_zero_2bits
  }
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) r.bits(88);
    if (levelPresent[i]) r.bits(8);
  }

  r.ue(); // sps_seq_parameter_set_id
  const chromaFormatIdc = r.ue();
  if (chromaFormatIdc === 3) r.bit1(); // separate_colour_plane_flag
  let width = r.ue();
  let height = r.ue();
  if (r.bit1()) { // conformance_window_flag
    const left = r.ue();
    const right = r.ue();
    const top = r.ue();
    const bottom = r.ue();
    const subWidthC = (chromaFormatIdc === 1 || chromaFormatIdc === 2) ? 2 : 1;
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
    width -= (left + right) * subWidthC;
    height -= (top + bottom) * subHeightC;
  }
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height, codec: 'hevc' };
}

/**
 * Scan an Annex-B elementary stream for a parameter set and return its dimensions.
 * H.264 SPS = NAL type 7; HEVC SPS = NAL type 33.
 */
function parseAnnexBResolution(buf) {
  if (!buf || buf.length < 8) return null;
  for (let i = 0; i + 6 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 1) continue;

    const h264Header = buf[i + 3];
    if ((h264Header & 0x1f) === 7) {
      try {
        const dims = parseH264Sps(buf.subarray(i + 4, i + 4 + 512));
        if (dims) return dims;
      } catch (_) { /* keep scanning */ }
    }

    // HEVC NAL header is two bytes; type lives in bits 1-6 of the first byte.
    const hevcType = (h264Header >> 1) & 0x3f;
    if (hevcType === 33) {
      try {
        const dims = parseHevcSps(buf.subarray(i + 5, i + 5 + 512));
        if (dims) return dims;
      } catch (_) { /* keep scanning */ }
    }
  }
  return null;
}

/** Read the first segment and its duration from a media playlist. */
function parseMediaPlaylist(text) {
  if (typeof text !== 'string' || !text.includes('#EXT')) return null;
  const lines = text.split(/\r?\n/);
  let duration = null;
  let uri = null;
  let targetDuration = null;
  let isMaster = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) { isMaster = true; continue; }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const n = parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length));
      if (Number.isFinite(n) && n > 0) targetDuration = n;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const n = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
      if (duration === null && Number.isFinite(n) && n > 0) duration = n;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (uri === null) uri = line;
  }
  return { isMaster, duration, uri, targetDuration };
}

/** Token-free cache key: the signed path segments change on every mint. */
function probeCacheKey(manifestUrl, referer) {
  try {
    const parsed = new URL(manifestUrl);
    const slug = parsed.pathname.split('/').filter(Boolean).pop() || parsed.pathname;
    return `${parsed.host}|${slug}|${referer || ''}`;
  } catch (_) {
    return String(manifestUrl || '');
  }
}

class HlsQualityProbe {
  constructor(opts = {}) {
    this.ttlMs = clampInt(opts.ttlMs, 1000, 60 * 60 * 1000, DEFAULT_TTL_MS);
    this.negativeTtlMs = clampInt(opts.negativeTtlMs, 1000, 60 * 60 * 1000, DEFAULT_NEGATIVE_TTL_MS);
    this.timeoutMs = clampInt(opts.timeoutMs, 500, 15000, DEFAULT_TIMEOUT_MS);
    this.rangeBytes = clampInt(opts.rangeBytes, 64 * 1024, 4 * 1024 * 1024, DEFAULT_RANGE_BYTES);
    this.maxEntries = clampInt(opts.maxEntries, 10, 20000, DEFAULT_MAX_ENTRIES);
    this.maxConcurrent = clampInt(opts.maxConcurrentProbes, 1, 16, DEFAULT_MAX_CONCURRENT);
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.cache = new Map(); // key -> { expiresAt, value }
    this.inFlight = new Map(); // key -> Promise
    this.active = 0;
    this.waiters = [];
  }

  _cacheGet(key) {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  _cacheSet(key, value, ttlMs) {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { expiresAt: this.now() + ttlMs, value });
  }

  async _acquire() {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  _release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * @param {string} manifestUrl verified media playlist URL
   * @param {Object} opts
   * @param {Function} opts.fetch fetch implementation (provider proxyFetch)
   * @param {string} [opts.referer]
   * @param {string} [opts.origin]
   * @param {string} [opts.userAgent]
   * @returns {Promise<null|{width:number,height:number,resolution:string,quality:string,bitrate:string,impliedBps:number,segmentBytes:number,duration:number,codec:string,cached?:boolean}>}
   */
  async probe(manifestUrl, opts = {}) {
    const fetchImpl = opts.fetch;
    if (typeof manifestUrl !== 'string' || !/^https?:\/\//i.test(manifestUrl)) return null;
    if (typeof fetchImpl !== 'function') return null;

    const key = probeCacheKey(manifestUrl, opts.referer);
    const cached = this._cacheGet(key);
    if (cached !== undefined) {
      return cached ? { ...cached, cached: true } : null;
    }
    const running = this.inFlight.get(key);
    if (running) return running;

    const task = this._run(manifestUrl, { ...opts, fetch: fetchImpl })
      .catch(() => null)
      .then((value) => {
        this._cacheSet(key, value, value ? this.ttlMs : this.negativeTtlMs);
        return value ? { ...value, cached: false } : null;
      })
      .finally(() => { this.inFlight.delete(key); });

    this.inFlight.set(key, task);
    return task;
  }

  async _run(manifestUrl, opts) {
    await this._acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { 'User-Agent': opts.userAgent || 'Mozilla/5.0' };
      if (opts.referer) headers.Referer = opts.referer;
      if (opts.origin) headers.Origin = opts.origin;

      const playlistRes = await opts.fetch(manifestUrl, {
        headers,
        signal: controller.signal,
        maxBodyBytes: PLAYLIST_MAX_BYTES
      });
      if (!playlistRes || !playlistRes.ok) return null;
      const playlistText = typeof playlistRes.text === 'function'
        ? await playlistRes.text()
        : String(playlistRes.body || '');
      const playlist = parseMediaPlaylist(playlistText);
      // A master playlist declares its own quality; streams.js already reads it,
      // and guessing a rendition here would contradict the declared ladder.
      if (!playlist || playlist.isMaster || !playlist.uri || !playlist.duration) return null;

      let segmentUrl;
      try {
        segmentUrl = new URL(playlist.uri, manifestUrl).toString();
      } catch (_) { return null; }

      const segmentRes = await opts.fetch(segmentUrl, {
        headers: { ...headers, Range: `bytes=0-${this.rangeBytes - 1}` },
        signal: controller.signal,
        maxBodyBytes: this.rangeBytes + 64 * 1024
      });
      if (!segmentRes || !segmentRes.ok) return null;

      const raw = Buffer.from(await segmentRes.arrayBuffer());
      if (!raw.length) return null;

      const media = stripCloak(raw);
      const dims = looksLikeTs(media) ? parseAnnexBResolution(media) : null;

      const rangeTotal = contentRangeTotal(headerValue(segmentRes.headers, 'content-range'));
      const contentLength = Number(headerValue(segmentRes.headers, 'content-length')) || 0;
      const segmentBytes = rangeTotal
        || (segmentRes.status === 200 && contentLength >= raw.length ? contentLength : null);
      const impliedBps = segmentBytes && playlist.duration > 0
        ? (segmentBytes * 8) / playlist.duration
        : 0;

      if (!dims && !(impliedBps > 0)) return null;

      const tier = dims ? tierForHeight(dims.height) : null;
      return {
        width: dims ? dims.width : null,
        height: dims ? dims.height : null,
        codec: dims ? dims.codec : null,
        resolution: tier ? tier.resolution : null,
        quality: tier ? tier.quality : null,
        bitrate: impliedBps > 0 ? formatBitrate(impliedBps) : '',
        impliedBps: Math.round(impliedBps),
        segmentBytes: segmentBytes || null,
        duration: playlist.duration
      };
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
      this._release();
    }
  }
}

HlsQualityProbe.CLOAKED_PREFIX_BYTES = CLOAKED_PREFIX_BYTES;
HlsQualityProbe.formatBitrate = formatBitrate;
HlsQualityProbe.tierForHeight = tierForHeight;
HlsQualityProbe.stripCloak = stripCloak;
HlsQualityProbe.looksLikeTs = looksLikeTs;
HlsQualityProbe.parseAnnexBResolution = parseAnnexBResolution;
HlsQualityProbe.parseMediaPlaylist = parseMediaPlaylist;
HlsQualityProbe.probeCacheKey = probeCacheKey;

module.exports = HlsQualityProbe;
