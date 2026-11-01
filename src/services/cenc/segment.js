/**
 * cenc/segment.js — removes CENC (`cenc` / AES-CTR) protection from one
 * fragmented-MP4 media segment, in place.
 *
 * Framing comes from `tfhd` + `trun`; encryption metadata comes from `senc`.
 * Both are needed: `senc` says *how* each sample is encrypted, `trun` says
 * *where* it starts.
 *
 * Crypto note: the CTR keystream covers the **cipher bytes only**. Clear bytes
 * (`BytesOfClearData`, the NAL headers) are not encrypted and do not advance the
 * counter — consecutive cipher runs share one continuous keystream that starts
 * at the sample IV. Decrypting the whole sample and restoring the clear spans
 * (the intuitive reading, and what an earlier draft of this engine did)
 * desynchronises every cipher run by the clear length and yields slices the
 * decoder rejects with "non-intra slice in an IDR NAL unit".
 *
 * One `Decipher` per sample, fed run by run, gives exactly that keystream: the
 * cipher object keeps its counter between `update()` calls.
 */

'use strict';

const crypto = require('crypto');
const {
  children, findChild, findChildren, findTops, collect, writeType, flags
} = require('./boxes');

const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020;

const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTS = 0x000800;

const SENC_OVERRIDE = 0x000001;
const SENC_SUBSAMPLE = 0x000002;

class CencError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'CencError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function isFreeType(type) {
  return type === 'free' || type === 'skip';
}

/** 8-byte IV -> 16-byte counter block (high half = IV, low half = counter 0). */
function counterBlock(iv, ivSize) {
  if (ivSize === 16) return iv.subarray(0, 16);
  const block = Buffer.alloc(16);
  iv.copy(block, 0, 0, Math.min(ivSize, iv.length));
  return block;
}

function readTfhd(buf, tfhd) {
  const tfFlags = flags(buf, tfhd);
  const trackId = tfhd.body + 8 <= tfhd.end ? buf.readUInt32BE(tfhd.body + 4) : 0;
  let p = tfhd.body + 8;
  const out = { trackId, flags: tfFlags, baseDataOffset: null, defaultSampleSize: 0 };

  if (tfFlags & TFHD_BASE_DATA_OFFSET) {
    if (p + 8 > tfhd.end) throw new CencError('TFHD_TRUNCATED');
    out.baseDataOffset = Number(buf.readBigUInt64BE(p));
    p += 8;
  }
  if (tfFlags & TFHD_SAMPLE_DESCRIPTION_INDEX) p += 4;
  if (tfFlags & TFHD_DEFAULT_SAMPLE_DURATION) p += 4;
  if (tfFlags & TFHD_DEFAULT_SAMPLE_SIZE) {
    out.defaultSampleSize = p + 4 <= tfhd.end ? buf.readUInt32BE(p) : 0;
    p += 4;
  }
  if (tfFlags & TFHD_DEFAULT_SAMPLE_FLAGS) p += 4;
  return out;
}

/**
 * Parses one `trun` into absolute sample byte ranges.
 * `data_offset` is signed and relative to the base-data offset.
 */
function readTrun(buf, trun, baseDataOffset, defaultSampleSize, cursor) {
  const trFlags = flags(buf, trun);
  const count = trun.body + 8 <= trun.end ? buf.readUInt32BE(trun.body + 4) : 0;
  let p = trun.body + 8;

  let runStart = cursor;
  if (trFlags & TRUN_DATA_OFFSET) {
    if (p + 4 > trun.end) throw new CencError('TRUN_TRUNCATED');
    runStart = baseDataOffset + buf.readInt32BE(p);
    p += 4;
  }
  if (trFlags & TRUN_FIRST_SAMPLE_FLAGS) p += 4;

  const perSampleSize = Boolean(trFlags & TRUN_SAMPLE_SIZE);
  const samples = [];
  let offset = runStart;

  for (let i = 0; i < count; i++) {
    if (trFlags & TRUN_SAMPLE_DURATION) p += 4;
    let size;
    if (perSampleSize) {
      if (p + 4 > trun.end) throw new CencError('TRUN_TRUNCATED');
      size = buf.readUInt32BE(p);
      p += 4;
    } else {
      size = defaultSampleSize;
    }
    if (trFlags & TRUN_SAMPLE_FLAGS) p += 4;
    if (trFlags & TRUN_SAMPLE_CTS) p += 4;

    if (!size) throw new CencError('SAMPLE_SIZE_UNKNOWN');
    samples.push({ offset, size });
    offset += size;
  }

  return { samples, nextCursor: offset };
}

/** Parses `senc` into [{ iv, ivSize, kid, subsamples }]. */
function readSenc(buf, senc, trackIvSize) {
  const sencFlags = flags(buf, senc);
  let p = senc.body + 4;
  let ivSize = trackIvSize || 8;
  let kid = '';

  if (sencFlags & SENC_OVERRIDE) {
    if (p + 20 > senc.end) throw new CencError('SENC_TRUNCATED');
    ivSize = buf[p + 3] || ivSize;
    kid = buf.toString('hex', p + 4, p + 20);
    p += 20;
  }
  if (p + 4 > senc.end) throw new CencError('SENC_TRUNCATED');
  const count = buf.readUInt32BE(p);
  p += 4;

  const subsampleEncrypted = Boolean(sencFlags & SENC_SUBSAMPLE);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + ivSize > senc.end) throw new CencError('SENC_TRUNCATED');
    const iv = buf.subarray(p, p + ivSize);
    p += ivSize;

    let subsamples = null;
    if (subsampleEncrypted) {
      if (p + 2 > senc.end) throw new CencError('SENC_TRUNCATED');
      const n = buf.readUInt16BE(p);
      p += 2;
      subsamples = [];
      for (let j = 0; j < n; j++) {
        if (p + 6 > senc.end) throw new CencError('SENC_TRUNCATED');
        const clear = buf.readUInt16BE(p);
        const cipher = buf.readUInt32BE(p + 2);
        p += 6;
        subsamples.push({ clear, cipher });
      }
    }
    entries.push({ iv, ivSize, kid, subsamples });
  }
  return entries;
}

function resolveKey(keysByKid, kid) {
  if (!keysByKid) return null;
  if (kid && keysByKid[kid]) return keysByKid[kid];
  const normalised = String(kid || '').toLowerCase().replace(/-/g, '');
  if (normalised && keysByKid[normalised]) return keysByKid[normalised];
  return keysByKid.__fallback || null;
}

/**
 * Decrypts every sample described by every `traf` of every `moof` in `buf`.
 *
 * @param {Buffer} buf                segment (`styp` + `moof` + `mdat`, possibly repeated)
 * @param {object} opts
 * @param {Map}    opts.tracks        trackId -> {ivSize, kid, protected}  (from parseInit)
 * @param {object} opts.keysByKid     kidHex -> Buffer(16); `__fallback` allowed
 * @returns {{buf: Buffer, stats: {samples:number, bytes:number, moofs:number, trafs:number}}}
 * @throws {CencError} KID_MISSING | SENC_MISSING | NO_MOOF | TRUN_TRUNCATED | SIZE_MISMATCH
 */
function decryptSegment(buf, opts = {}) {
  const tracks = opts.tracks || new Map();
  const keysByKid = opts.keysByKid || {};
  const stats = { samples: 0, bytes: 0, moofs: 0, trafs: 0, skipped: 0 };
  const moofs = findTops(buf, 'moof');

  if (moofs.length === 0) {
    // A clear segment routed here by mistake: pass it through untouched rather
    // than failing a channel that is only partially encrypted.
    return { buf, stats };
  }

  for (const moof of moofs) {
    stats.moofs += 1;
    for (const traf of findChildren(buf, moof, 'traf')) {
      stats.trafs += 1;
      const tfhd = findChild(buf, traf, 'tfhd');
      if (!tfhd) throw new CencError('TFHD_MISSING');
      const header = readTfhd(buf, tfhd);
      const track = tracks.get(header.trackId) || null;

      const senc = findChild(buf, traf, 'senc');
      if (!senc) {
        if (track && track.protected) {
          throw new CencError('SENC_MISSING', `traf ${header.trackId} has no senc`, { trackId: header.trackId });
        }
        stats.skipped += 1;
        continue;
      }

      const baseDataOffset = header.baseDataOffset !== null ? header.baseDataOffset : moof.start;
      const entries = readSenc(buf, senc, track && track.ivSize);

      // Collect this traf's samples across all its runs before decrypting, so
      // a sample-count mismatch is caught before any byte is touched.
      const samples = [];
      let cursor = baseDataOffset;
      for (const trun of findChildren(buf, traf, 'trun')) {
        const run = readTrun(buf, trun, baseDataOffset, header.defaultSampleSize, cursor);
        cursor = run.nextCursor;
        samples.push(...run.samples);
      }

      if (entries.length !== samples.length) {
        throw new CencError('SENC_COUNT_MISMATCH',
          `senc has ${entries.length} entries for ${samples.length} samples`,
          { trackId: header.trackId });
      }

      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const entry = entries[i];
        if (sample.offset < 0 || sample.offset + sample.size > buf.length) {
          throw new CencError('SAMPLE_OUT_OF_BOUNDS',
            `sample ${i} [${sample.offset}, +${sample.size}] exceeds segment (${buf.length})`);
        }

        const key = resolveKey(keysByKid, entry.kid || (track && track.kid));
        if (!key) {
          throw new CencError('KID_MISSING', `no key for KID ${entry.kid || (track && track.kid) || '(unknown)'}`,
            { kid: entry.kid || (track && track.kid) });
        }

        const ivBlock = counterBlock(entry.iv, entry.ivSize || (track && track.ivSize) || 8);
        const decipher = crypto.createDecipheriv('aes-128-ctr', key, ivBlock);
        const sampleEnd = sample.offset + sample.size;

        if (!entry.subsamples || entry.subsamples.length === 0) {
          // Whole-sample encryption (AAC and some video packagers).
          const plain = decipher.update(buf.subarray(sample.offset, sampleEnd));
          plain.copy(buf, sample.offset);
        } else {
          let cursor = 0;
          for (const ss of entry.subsamples) {
            if (cursor + ss.clear + ss.cipher > sample.size) {
              throw new CencError('SUBSAMPLE_OVERFLOW',
                `subsample runs past sample ${i} (${cursor}+${ss.clear}+${ss.cipher} > ${sample.size})`);
            }
            if (ss.cipher > 0) {
              const from = sample.offset + cursor + ss.clear;
              const plain = decipher.update(buf.subarray(from, from + ss.cipher));
              plain.copy(buf, from);
            }
            cursor += ss.clear + ss.cipher;
          }
        }

        stats.samples += 1;
        stats.bytes += sample.size;
      }
    }

    // Neutralise every box that would still advertise encryption.
    for (const box of collect(buf, moof, ['senc', 'saiz', 'saio', 'pssh'])) writeType(buf, box, 'free');
    for (const box of collect(buf, moof, ['sgpd', 'sbgp'])) {
      if (box.body + 8 <= box.end && buf.toString('latin1', box.body + 4, box.body + 8) === 'seig') {
        writeType(buf, box, 'free');
      }
    }
  }

  return { buf, stats };
}

module.exports = { decryptSegment, CencError, counterBlock };
