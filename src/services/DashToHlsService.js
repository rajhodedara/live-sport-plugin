/**
 * DashToHlsService — Zero-bandwidth MPEG-DASH → HLS v7 converter
 *
 * Converts encrypted ClearKey DASH manifests (.mpd) from AK47 Sports and
 * SK Tech (Amazon Nitro / Akamai CDNs) into standard HLS playlists:
 *
 *   - Master playlist  (#EXT-X-STREAM-INF + #EXT-X-MEDIA audio group)
 *   - Media playlists  (#EXT-X-MAP + #EXT-X-KEY:METHOD=SAMPLE-AES-CTR)
 *
 * The server NEVER proxies media: every segment URL points directly at the
 * upstream CDN. Only the ~KB-sized MPD XML is fetched server-side and the
 * 16-byte AES key is served from /api/dash/key.ts.
 *
 * Playlist shape mirrors the production-proven pattern:
 *   #EXT-X-MEDIA-SEQUENCE is the DASH $Number$ of the first window segment,
 *   sliding naturally as the upstream SegmentTimeline advances.
 */

'use strict';

const { XMLParser } = require('fast-xml-parser');
const { safeFetch } = require('./ProviderOutbound');

// Akamai/CloudFront edges 403 Dalvik UAs on manifest paths; always present a
// desktop browser UA unless the feed carries a more specific non-Dalvik UA.
const DEFAULT_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const DALVIK_UA_RE = /dalvik/i;

const MPD_CACHE_TTL_MS = 3000;
const MPD_CACHE_MAX_ENTRIES = 120;
const MAX_WINDOW_SEGMENTS = 15;
const LIVE_EDGE_TRIM_SEGMENTS = 1; // clock-derived playlists only: stay behind live edge

const HLS_AUDIO_GROUP_ID = 'aud';

const ALWAYS_ARRAY_TAGS = new Set([
  'Period', 'AdaptationSet', 'Representation', 'BaseURL', 'ContentProtection',
  'SegmentTimeline', 'S', 'Role', 'AudioChannelConfiguration', 'FramePacking',
  'EssentialProperty', 'SupplementalProperty'
]);

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Extracts the text of a parsed mixed-content node ("x" or { "#text": "x" }). */
function nodeText(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && node['#text'] !== undefined) return String(node['#text']);
  return '';
}

/** Parses ISO 8601 durations (PT12H34M56.78S / PT16833.660S) into seconds. */
function parseIsoDuration(str) {
  if (!str || typeof str !== 'string') return 0;
  const m = str.match(/^[-+]?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  return (
    (y ? parseFloat(y) * 365 * 24 * 3600 : 0) +
    (mo ? parseFloat(mo) * 30 * 24 * 3600 : 0) +
    (d ? parseFloat(d) * 24 * 3600 : 0) +
    (h ? parseFloat(h) * 3600 : 0) +
    (mi ? parseFloat(mi) * 60 : 0) +
    (s ? parseFloat(s) : 0)
  );
}

/**
 * Substitutes DASH $Identifier$ templates ($RepresentationID$, $Number$,
 * $Time$, $Bandwidth$; $$ is an escaped dollar sign).
 */
function fillSegmentTemplate(template, vars) {
  return template
    .replace(/\$\$/g, '\u0000')
    .replace(/\$RepresentationID\$/g, String(vars.representationId))
    .replace(/\$Bandwidth\$/g, String(vars.bandwidth))
    .replace(/\$Number%0(\d+)d\$/g, (_, width) => String(vars.number).padStart(parseInt(width, 10), '0'))
    .replace(/\$Number\$/g, String(vars.number))
    .replace(/\$Time%0(\d+)d\$/g, (_, width) => String(vars.time).padStart(parseInt(width, 10), '0'))
    .replace(/\$Time\$/g, String(vars.time))
    .replace(/\u0000/g, '$');
}

class DashToHlsService {
  constructor(options = {}) {
    this._fetcher = options.fetcher || safeFetch;
    this._mpdCache = new Map(); // mpdUrl -> { ts, parsed }
    this._parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: true,
      isArray: (name) => ALWAYS_ARRAY_TAGS.has(name)
    });
  }

  /* ────────────────────────────── HTTP layer ────────────────────────────── */

  /**
   * Builds fetch headers for the upstream MPD request. Drops Dalvik UAs
   * (Akamai 403s them), hop-by-hop headers, and Host overrides.
   */
  _sanitizeUpstreamHeaders(headers = {}) {
    const out = {};
    let chosenUa = '';
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;
      const lower = name.toLowerCase();
      if (lower === 'user-agent') {
        if (!chosenUa && !DALVIK_UA_RE.test(value)) chosenUa = value;
        continue;
      }
      if (['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding'].includes(lower)) continue;
      out[name] = value;
    }
    out['User-Agent'] = chosenUa || DEFAULT_BROWSER_UA;
    out['Accept'] = out['Accept'] || '*/*';
    return out;
  }

  async _fetchParsedMpd(mpdUrl, headers) {
    const cached = this._mpdCache.get(mpdUrl);
    if (cached && Date.now() - cached.ts < MPD_CACHE_TTL_MS) return cached.parsed;

    const res = await this._fetcher(mpdUrl, {
      headers: this._sanitizeUpstreamHeaders(headers),
      timeoutMs: 10000,
      attempts: 2
    });
    if (!res || !res.ok) {
      throw new Error(`Upstream MPD fetch failed (HTTP ${res && res.status})`);
    }
    const xml = await res.text();
    const parsed = this.parseMpd(xml, mpdUrl);

    this._mpdCache.set(mpdUrl, { ts: Date.now(), parsed });
    if (this._mpdCache.size > MPD_CACHE_MAX_ENTRIES) {
      this._mpdCache.delete(this._mpdCache.keys().next().value);
    }
    return parsed;
  }

  /* ─────────────────────────────── Parsing ──────────────────────────────── */

  parseMpd(xml, mpdUrl) {
    let doc;
    try {
      doc = this._parser.parse(xml);
    } catch (err) {
      throw new Error(`MPD XML parse error: ${err.message}`);
    }
    const mpd = doc && (doc.MPD || doc.mpd);
    if (!mpd || typeof mpd !== 'object') {
      throw new Error('Not an MPEG-DASH manifest (no <MPD> root)');
    }

    const periods = asArray(mpd.Period);
    if (periods.length === 0) throw new Error('MPD has no <Period>');

    // Live edge = last period that actually carries segment templates.
    let period = null;
    for (let i = periods.length - 1; i >= 0; i--) {
      if (asArray(periods[i].AdaptationSet).some((a) => a.SegmentTemplate || asArray(a.Representation).some((r) => r.SegmentTemplate))) {
        period = periods[i];
        break;
      }
    }
    if (!period) throw new Error('MPD has no period with SegmentTemplate');

    const mpdBase = this._resolveBase(asArray(mpd.BaseURL).map(nodeText), mpdUrl);
    const periodBase = this._resolveBase(asArray(period.BaseURL).map(nodeText), mpdBase);
    const periodStartSec = parseIsoDuration(period['@_start'] || '0');

    const dynamic = String(mpd['@_type'] || 'static').toLowerCase() === 'dynamic';
    const availabilityStartTime = Date.parse(mpd['@_availabilityStartTime'] || '') || 0;
    const timeShiftBufferSec = parseIsoDuration(mpd['@_timeShiftBufferDepth'] || '') || 0;

    const videoReps = [];
    const audioReps = [];

    for (const adaptationSet of asArray(period.AdaptationSet)) {
      const asTemplate = this._templateAttrs(adaptationSet.SegmentTemplate);
      const asMime = String(adaptationSet['@_mimeType'] || adaptationSet['@_contentType'] || '');
      const asProtection = this._readProtection(asArray(adaptationSet.ContentProtection));
      const lang = adaptationSet['@_lang'] || adaptationSet['@_lang'] || '';

      for (const representation of asArray(adaptationSet.Representation)) {
        const repTemplate = this._templateAttrs(representation.SegmentTemplate, asTemplate);
        const mime = String(representation['@_mimeType'] || asMime || '');
        const kind = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : null;
        if (!kind) continue;
        if (!repTemplate || !repTemplate.media) continue;

        const repBase = this._resolveBase(asArray(representation.BaseURL).map(nodeText), periodBase);
        const protection = this._readProtection(asArray(representation.ContentProtection)) || asProtection;

        const rep = {
          kind,
          id: String(representation['@_id'] !== undefined ? representation['@_id'] : ''),
          bandwidth: Number(representation['@_bandwidth'] || 0),
          codecs: String(representation['@_codecs'] || ''),
          width: Number(representation['@_width'] || 0),
          height: Number(representation['@_height'] || 0),
          lang: String(representation['@_lang'] || lang || ''),
          encryption: protection ? protection.scheme : null,
          initUrl: repTemplate.initialization
            ? this._absolutize(fillSegmentTemplate(repTemplate.initialization, {
              representationId: String(representation['@_id'] || ''), bandwidth: Number(representation['@_bandwidth'] || 0), number: 0, time: 0
            }), repBase)
            : '',
          segments: this._computeSegments(repTemplate, {
            representationId: String(representation['@_id'] || ''),
            bandwidth: Number(representation['@_bandwidth'] || 0),
            baseUrl: repBase,
            dynamic,
            availabilityStartTime,
            periodStartSec,
            timeShiftBufferSec
          })
        };
        if (rep.segments.length === 0) continue;

        (kind === 'video' ? videoReps : audioReps).push(rep);
      }
    }

    if (videoReps.length === 0) throw new Error('MPD exposes no video representations');

    videoReps.sort((a, b) => b.bandwidth - a.bandwidth);
    audioReps.sort((a, b) => b.bandwidth - a.bandwidth);

    return { dynamic, videoReps, audioReps };
  }

  /** Flattens a SegmentTemplate node (Representation-level wins over set-level). */
  _templateAttrs(node, base = {}) {
    const src = Array.isArray(node) ? node[node.length - 1] : node;
    if (!src || typeof src !== 'object') return Object.keys(base).length ? base : null;
    const attrs = { ...base };
    for (const key of ['media', 'initialization', 'timescale', 'duration', 'startNumber', 'presentationTimeOffset']) {
      const v = src[`@_${key}`];
      if (v !== undefined) attrs[key] = v;
    }
    if (src.SegmentTimeline !== undefined) {
      // SegmentTimeline is an always-array tag; the timeline object is inside.
      attrs.timeline = Array.isArray(src.SegmentTimeline) ? src.SegmentTimeline[0] : src.SegmentTimeline;
    }
    return Object.keys(attrs).length ? attrs : null;
  }

  /** Reads the mp4protection scheme (cenc → SAMPLE-AES-CTR, cbcs → SAMPLE-AES). */
  _readProtection(entries) {
    for (const cp of entries) {
      const uri = String(cp['@_schemeIdUri'] || '').toLowerCase();
      if (uri.includes('mp4protection')) {
        const value = String(cp['@_value'] || 'cenc').toLowerCase();
        return { scheme: value === 'cbcs' ? 'SAMPLE-AES' : 'SAMPLE-AES-CTR', value };
      }
    }
    return null;
  }

  _resolveBase(baseUrls, parent) {
    for (let i = baseUrls.length - 1; i >= 0; i--) {
      const candidate = baseUrls[i].trim();
      if (candidate) return this._absolutize(candidate, parent);
    }
    return parent;
  }

  _absolutize(uri, base) {
    try {
      return new URL(uri, base).toString();
    } catch (_) {
      return uri;
    }
  }

  /**
   * Enumerates the live window as [{ number, time, durationSec, url }].
   * SegmentTimeline mode (Amazon Nitro / Akamai live) trusts the server's
   * own window; fixed-duration mode derives numbers from wall clock.
   */
  _computeSegments(template, ctx) {
    const timescale = Number(template.timescale || 1) || 1;
    const startNumber = Number(template.startNumber || 1);
    const pto = Number(template.presentationTimeOffset || 0);
    const mediaTemplate = String(template.media || '');
    const segments = [];

    const push = (number, time, durationRaw) => {
      if (durationRaw <= 0) return;
      segments.push({
        number,
        time,
        durationSec: durationRaw / timescale,
        url: this._absolutize(fillSegmentTemplate(mediaTemplate, {
          representationId: ctx.representationId, bandwidth: ctx.bandwidth, number, time
        }), ctx.baseUrl)
      });
    };

    const timeline = template.timeline;
    if (timeline && typeof timeline === 'object') {
      const entries = [];
      let cursor = null;
      let totalIterations = 0;
      let totalValidSegments = 0;

      // First pass computes each S entry's timeline position and counts valid
      // segments without allocating an object for every repeated segment.
      for (const s of asArray(timeline.S)) {
        const t = s['@_t'] !== undefined ? Number(s['@_t']) : (cursor === null ? pto : cursor);
        const d = Number(s['@_d'] || 0);
        const r = s['@_r'] !== undefined ? Number(s['@_r']) : 0;
        const count = Number.isFinite(r) && r >= 0 ? Math.floor(r) + 1 : 0;

        entries.push({ t, d, count, firstNumber: startNumber + totalIterations });
        totalIterations += count;
        if (d > 0) totalValidSegments += count;
        cursor = t + d * (r + 1);
      }

      // Only materialize the final window. Large repeat counts must not cause
      // thousands of temporary segment objects that are immediately discarded.
      const firstKeptValidIndex = Math.max(0, totalValidSegments - MAX_WINDOW_SEGMENTS);
      let validIndex = 0;
      for (const entry of entries) {
        if (entry.d > 0) {
          const skip = Math.max(0, firstKeptValidIndex - validIndex);
          for (let i = skip; i < entry.count; i++) {
            push(entry.firstNumber + i, entry.t + entry.d * i, entry.d);
          }
          validIndex += entry.count;
        }
      }
      return segments;
    }

    const fixedDuration = Number(template.duration || 0);
    if (fixedDuration > 0) {
      const segDurSec = fixedDuration / timescale;
      if (ctx.dynamic && ctx.availabilityStartTime > 0) {
        const elapsedSec = (Date.now() - ctx.availabilityStartTime) / 1000 - ctx.periodStartSec;
        const totalPublished = Math.floor(elapsedSec / segDurSec);
        if (totalPublished <= LIVE_EDGE_TRIM_SEGMENTS) return []; // pre-live / clock skew
        const newestNumber = startNumber + totalPublished - LIVE_EDGE_TRIM_SEGMENTS;
        const windowSize = Math.min(
          MAX_WINDOW_SEGMENTS,
          ctx.timeShiftBufferSec > 0 ? Math.floor(ctx.timeShiftBufferSec / segDurSec) || MAX_WINDOW_SEGMENTS : MAX_WINDOW_SEGMENTS
        );
        const firstNumber = Math.max(startNumber, newestNumber - windowSize + 1);
        for (let n = firstNumber; n <= newestNumber; n++) {
          push(n, pto + (n - startNumber) * fixedDuration, fixedDuration);
        }
      } else {
        for (let n = startNumber; n < startNumber + MAX_WINDOW_SEGMENTS; n++) {
          push(n, pto + (n - startNumber) * fixedDuration, fixedDuration);
        }
      }
      return segments;
    }

    return segments;
  }

  /* ────────────────────────────── Rendering ─────────────────────────────── */

  _keyLine(reqBase, key, encryption) {
    if (!encryption) return '';
    const keyUrl = `${reqBase}/api/dash/key.ts?k=${key}`;
    return `#EXT-X-KEY:METHOD=${encryption},URI="${keyUrl}",KEYFORMAT="identity",KEYFORMATVERSIONS="1"`;
  }

  _childPlaylistUrl(reqBase, name, dRaw) {
    return `${reqBase}/api/dash/${name}.m3u8?d=${dRaw}`;
  }

  renderMaster(parsed, reqBase, dRaw) {
    const video = parsed.videoReps[0];
    const audio = parsed.audioReps[0];

    const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
    if (audio) {
      const attrs = [
        'TYPE=AUDIO', `GROUP-ID="${HLS_AUDIO_GROUP_ID}"`,
        `NAME="${audio.lang || 'Audio'}"`, 'DEFAULT=YES', 'AUTOSELECT=YES'
      ];
      if (audio.lang) attrs.push(`LANGUAGE="${audio.lang}"`);
      attrs.push(`URI="${this._childPlaylistUrl(reqBase, 'audio', dRaw)}"`);
      lines.push(`#EXT-X-MEDIA:${attrs.join(',')}`);
    }

    const streamAttrs = [`BANDWIDTH=${video.bandwidth + (audio ? audio.bandwidth : 0)}`];
    const codecs = [video.codecs, audio ? audio.codecs : ''].filter(Boolean).join(',');
    if (codecs) streamAttrs.push(`CODECS="${codecs}"`);
    if (video.width && video.height) streamAttrs.push(`RESOLUTION=${video.width}x${video.height}`);
    if (audio) streamAttrs.push(`AUDIO="${HLS_AUDIO_GROUP_ID}"`);
    lines.push(`#EXT-X-STREAM-INF:${streamAttrs.join(',')}`);
    lines.push(this._childPlaylistUrl(reqBase, 'video', dRaw));

    return lines.join('\n') + '\n';
  }

  renderMediaPlaylist(rep, reqBase, key, dRaw) {
    const first = rep.segments[0];
    const maxDuration = rep.segments.reduce((max, s) => Math.max(max, s.durationSec), 0);

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(maxDuration))}`,
      `#EXT-X-MEDIA-SEQUENCE:${first.number}`
    ];
    const keyLine = this._keyLine(reqBase, key, rep.encryption);
    if (keyLine) lines.push(keyLine);
    if (rep.initUrl) lines.push(`#EXT-X-MAP:URI="${rep.initUrl}"`);

    for (const seg of rep.segments) {
      lines.push(`#EXTINF:${seg.durationSec.toFixed(3)},`);
      lines.push(seg.url);
    }
    return lines.join('\n') + '\n';
  }

  /* ──────────────────────────── Public API ──────────────────────────────── */

  async buildMaster(payload, dRaw, reqBase) {
    const parsed = await this._fetchParsedMpd(payload.mpdUrl, payload.headers);
    return this.renderMaster(parsed, reqBase, dRaw);
  }

  async buildMediaPlaylist(payload, kind, dRaw, reqBase) {
    const parsed = await this._fetchParsedMpd(payload.mpdUrl, payload.headers);
    const reps = kind === 'audio' ? parsed.audioReps : parsed.videoReps;
    const rep = reps && reps[0];
    if (!rep) throw new Error(`MPD exposes no ${kind} representation`);
    return this.renderMediaPlaylist(rep, reqBase, payload.key, dRaw);
  }
}

module.exports = DashToHlsService;
