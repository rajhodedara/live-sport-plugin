/**
 * cenc/init.js — reads the initialization segment (`styp` + `moov`) and turns
 * an encrypted track into something a demuxer treats as plain H.264/AAC.
 *
 * Two entry points:
 *
 *   parseInit(buf)    -> { tracks: Map<trackId, TrackInfo> }   read-only
 *   uncloakInit(buf)  -> { buf, tracks }                       mutates `buf`
 *
 * `uncloakInit` only rewrites four-character box *types*; every size and every
 * offset stays byte-identical, so `stsz` / `stco` / `co64` never need repair.
 * That is the whole reason this approach is safe: we are not rebuilding the
 * `stsd`, we are relabelling it.
 */

'use strict';

const { readBox, children, findChild, findChildren, findTop, collect, writeType, version } = require('./boxes');

// Sample entry header sizes (ISO/IEC 14496-12 & 14496-15). After the fixed
// part, child boxes (`avcC`, `esds`, `sinf`, …) begin.
const ENTRY_HEADER = { video: 78, audio: 28, subtitle: 8 };

const VIDEO_ENTRIES = new Set(['encv', 'avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01']);
const AUDIO_ENTRIES = new Set(['enca', 'mp4a', 'ac-3', 'ec-3', 'Opus', 'fLaC']);
const SUBTITLE_ENTRIES = new Set(['encs', 'wvtt', 'stpp']);

function entryKindOf(type) {
  if (VIDEO_ENTRIES.has(type)) return 'video';
  if (AUDIO_ENTRIES.has(type)) return 'audio';
  if (SUBTITLE_ENTRIES.has(type)) return 'subtitle';
  return null;
}

/** First child box of a sample entry (skips the format-specific fixed header). */
function sampleEntryChildren(buf, entry) {
  const kind = entryKindOf(entry.type);
  const skip = kind ? ENTRY_HEADER[kind] : 0;
  const start = entry.body + skip;
  if (start >= entry.end) return [];
  const first = readBox(buf, start, entry.end);
  if (!first || first.size < 8) return [];
  return [...children(buf, start, entry.end)];
}

function readTrackId(buf, tkhd) {
  if (!tkhd) return null;
  const v = version(buf, tkhd);
  const off = tkhd.body + 4 + (v === 1 ? 16 : 8);
  if (off + 4 > tkhd.end) return null;
  return buf.readUInt32BE(off);
}

function readHandlerType(buf, hdlr) {
  if (!hdlr) return '';
  return buf.toString('latin1', hdlr.body + 8, hdlr.body + 12);
}

/**
 * Finds `tenc` in a protection scheme info box.
 *
 * ISO/IEC 23001-7 puts it inside `schi` (`sinf > schi > tenc`); a few packagers
 * write it directly under `sinf`. Both are accepted — the live Akamai/Nitro
 * feeds use the `schi` form, so assuming the flat layout loses the KID and the
 * per-sample IV size entirely.
 */
function findTenc(buf, sinf) {
  if (!sinf) return null;
  return findChild(buf, findChild(buf, sinf, 'schi'), 'tenc') || findChild(buf, sinf, 'tenc');
}

/**
 * tenc layout (ISO/IEC 23001-7) is 4 bytes of version/flags, one reserved byte,
 * isProtected, Per_Sample_IV_Size, then the 16-byte KID:
 *
 *   byte [body+4] : version 0 -> reserved, version 1 -> crypt/skip pattern
 *   byte [body+5] : default_isProtected
 *   byte [body+6] : default_Per_Sample_IV_Size
 *   bytes[7..23]  : default_KID
 *
 * Real packagers do not all agree. The live Amazon/Akamai ClearKey inits write
 * **two** reserved bytes (``00 00 01 08 | KID``), which shifts every field one
 * byte early and yields isProtected=0, IV_size=1 and a KID taken from the middle
 * of the real one. So the KID is located by trying the spec offset and the
 * end-anchored offset (``body length - 16``), and the winner is chosen by
 * (a) matching the KID the manifest already told us, then (b) field sanity.
 */
function parseTenc(buf, tenc, expectedKid = '') {
  if (!tenc) return null;
  const bodyLen = tenc.end - tenc.body;
  if (bodyLen < 19) return null;

  const at = (kidOffset) => ({
    isProtected: buf[tenc.body + kidOffset - 2],
    ivSize: buf[tenc.body + kidOffset - 1],
    kid: buf.toString('hex', tenc.body + kidOffset, tenc.body + kidOffset + 16),
    kidOffset
  });

  const candidates = [];
  if (bodyLen >= 23) candidates.push(at(7));          // spec layout (KID then optional pad)
  if (bodyLen >= 24) candidates.push(at(bodyLen - 16)); // no trailing pad, KID flush to the end

  const sane = (c) => (c.isProtected === 0 || c.isProtected === 1) && [0, 8, 16].includes(c.ivSize);
  const wanted = String(expectedKid || '').toLowerCase().replace(/-/g, '');

  const chosen = (wanted && candidates.find((c) => c.kid === wanted)) || candidates.find(sane) || candidates[0];
  if (!chosen) return null;

  // Constant-IV protection (IV_size == 0) is legal but never used by live
  // ClearKey packagers; refuse rather than guess a counter block.
  let constantIv = 0;
  if (chosen.isProtected === 1 && chosen.ivSize === 0) {
    constantIv = buf[tenc.body + chosen.kidOffset + 16] || 0;
  }

  return { isProtected: chosen.isProtected, ivSize: chosen.ivSize, kid: chosen.kid, constantIv };
}

function parseTrack(buf, trak, expectedKid = '') {
  const tkhd = findChild(buf, trak, 'tkhd');
  const trackId = readTrackId(buf, tkhd);
  if (trackId === null) return null;

  const mdia = findChild(buf, trak, 'mdia');
  const handler = readHandlerType(buf, findChild(buf, mdia, 'hdlr'));
  const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : handler === 'subt' ? 'subtitle' : 'other';

  const stbl = findChild(buf, findChild(buf, mdia, 'minf'), 'stbl');
  const stsd = findChild(buf, stbl, 'stsd');
  let entry = null;
  if (stsd && stsd.body + 8 <= stsd.end) {
    entry = readBox(buf, stsd.body + 8, stsd.end);
  }
  if (!entry) return { trackId, kind, format: '', protected: false, scheme: '', ivSize: 0, kid: '' };

  const protectedTrack = entry.type.startsWith('enc');
  let scheme = '';
  let ivSize = 0;
  let kid = '';
  if (protectedTrack) {
    const sinf = sampleEntryChildren(buf, entry).find((b) => b.type === 'sinf') || null;
    const schm = findChild(buf, sinf, 'schm');
    if (schm && schm.body + 8 <= schm.end) scheme = buf.toString('latin1', schm.body + 4, schm.body + 8);
    const tenc = parseTenc(buf, findTenc(buf, sinf), expectedKid);
    if (tenc) {
      ivSize = tenc.ivSize;
      kid = tenc.kid;
      if (!tenc.isProtected) scheme = '';
    }
  }

  return {
    trackId,
    kind,
    format: entry.type,
    protected: protectedTrack,
    scheme,
    ivSize: ivSize || 8,
    kid
  };
}

/** Reads every `trak` of `moov` and returns a Map keyed by track_ID. */
function parseInit(buf, options = {}) {
  const moov = findTop(buf, 'moov');
  const tracks = new Map();
  if (!moov) return { tracks, moov: null };

  for (const trak of findChildren(buf, moov, 'trak')) {
    const info = parseTrack(buf, trak, options.expectedKid);
    if (info) tracks.set(info.trackId, info);
  }
  return { tracks, moov };
}

/** `seig` (CENC sample-encryption key rotation group) — must not survive uncloaking. */
function maskSeigGroups(buf, root) {
  for (const box of collect(buf, root, ['sgpd', 'sbgp'])) {
    if (box.body + 8 <= box.end && buf.toString('latin1', box.body + 4, box.body + 8) === 'seig') {
      writeType(buf, box, 'free');
    }
  }
}

/**
 * Rewrites protected sample entries to their clear equivalents and neutralises
 * every box that would tell a demuxer the track is encrypted.
 *
 * @returns {{buf: Buffer, tracks: Map}} `buf` is the same object, mutated.
 */
function uncloakInit(buf, options = {}) {
  const { tracks, moov } = parseInit(buf, options);
  if (!moov) return { buf, tracks };

  for (const trak of findChildren(buf, moov, 'trak')) {
    const mdia = findChild(buf, trak, 'mdia');
    const stbl = findChild(buf, findChild(buf, mdia, 'minf'), 'stbl');
    const stsd = findChild(buf, stbl, 'stsd');
    if (!stsd || stsd.body + 8 > stsd.end) continue;

    const entry = readBox(buf, stsd.body + 8, stsd.end);
    if (!entry || !entry.type.startsWith('enc')) continue;

    // encv -> avc1 / enca -> mp4a. `frma` inside sinf names the real format;
    // prefer it when present, fall back to the handler kind.
    const sinf = sampleEntryChildren(buf, entry).find((b) => b.type === 'sinf') || null;
    const frma = findChild(buf, sinf, 'frma');
    const originalFormat = frma && frma.end - frma.body >= 4
      ? buf.toString('latin1', frma.body, frma.body + 4)
      : '';

    const kind = entryKindOf(entry.type);
    const clear = originalFormat || (kind === 'audio' ? 'mp4a' : kind === 'video' ? 'avc1' : '');
    if (clear && clear !== entry.type) writeType(buf, entry, clear);

    // tenc/schm live inside sinf; masking the parent handles both. The child
    // type strings are neutralised as well so that a byte scan for "tenc" (some
    // demuxers do that as a heuristic) cannot conclude the track is protected.
    if (sinf) {
      for (const child of children(buf, sinf.body, sinf.end)) {
        if (child.type === 'schi') {
          // tenc lives here in the spec layout; relabel it before masking schi.
          for (const inner of children(buf, child.body, child.end)) {
            if (inner.type === 'tenc') writeType(buf, inner, 'free');
          }
          writeType(buf, child, 'free');
        } else if (child.type === 'schm' || child.type === 'tenc' || child.type === 'frma') {
          writeType(buf, child, 'free');
        }
      }
      writeType(buf, sinf, 'free');
    }
  }

  for (const pssh of findChildren(buf, moov, 'pssh')) writeType(buf, pssh, 'free');
  maskSeigGroups(buf, moov);

  if (options.maskSencInInit) {
    for (const senc of collect(buf, moov, 'senc')) writeType(buf, senc, 'free');
  }

  return { buf, tracks };
}

module.exports = { parseInit, uncloakInit, parseTenc, sampleEntryChildren, entryKindOf };
