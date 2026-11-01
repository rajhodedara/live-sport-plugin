'use strict';

/**
 * Synthetic ISO BMFF fixtures for the CENC tests.
 *
 * There is no captured Nitro segment in the repository, so these build the
 * smallest structure that is still spec-shaped: one `moov` with a protected
 * track, and `moof`+`mdat` segments whose samples are encrypted with a
 * *continuous* per-sample keystream (clear bytes consume keystream) — the way
 * a real packager does it, and the only way a per-subsample decryptor can fail
 * the round-trip.
 *
 * Not a `.test.js` file on purpose: it is a helper, not a suite.
 */

const crypto = require('crypto');

const KEY_HEX = 'ca0b64b84edb4f20eb1e135ff03db4f7';
const KEY = Buffer.from(KEY_HEX, 'hex');
const KID_HEX = '18e6af4a0daf2a1fdfbdc5b541520c88';
const OTHER_KID = 'ffeeddccbbaa99887766554433221100';

function box(type, ...payloads) {
  const body = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'latin1'))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function fullBox(type, version, flags, ...payloads) {
  const head = Buffer.alloc(4);
  head[0] = version;
  head.writeUIntBE(flags, 1, 3);
  return box(type, head, ...payloads);
}

function u32(...values) {
  const out = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => out.writeUInt32BE(v >>> 0, i * 4));
  return out;
}

function u16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

function u8(value) {
  return Buffer.from([value & 0xff]);
}

/** Minimal, structurally valid init segment with one (optionally) protected track. */
function buildInit({
  kind = 'video',
  entryType = 'encv',
  ivSize = 8,
  kid = KID_HEX,
  scheme = 'cenc',
  trackId = 1,
  format = null,
  pssh = true,
  nestedTenc = true,
  tencLayout = 'spec'
} = {}) {
  const isVideo = kind === 'video';
  const header = Buffer.alloc(isVideo ? 78 : 28);
  header.writeUInt16BE(1, 6); // data_reference_index
  if (isVideo) {
    header.writeUInt16BE(1920, 24);
    header.writeUInt16BE(1080, 26);
  } else {
    header.writeUInt16BE(2, 16);        // channel count
    header.writeUInt16BE(16, 18);       // sample size
    header.writeUInt32BE(48000 * 65536, 24);
  }

  const realFormat = format || (isVideo ? 'avc1' : 'mp4a');
  // 'spec'    : reserved(1) isProtected(1) ivSize(1) KID(16)         -> 23B body
  // 'shifted' : reserved(2) isProtected(1) ivSize(1) KID(16)         -> 24B body,
  //             which is what the live Amazon/Akamai ClearKey inits carry.
  const tencBox = tencLayout === 'shifted'
    ? fullBox('tenc', 0, 0, u8(0), u8(0), u8(1), u8(ivSize), Buffer.from(kid, 'hex'))
    : fullBox('tenc', 0, 0, u8(0), u8(1), u8(ivSize), Buffer.from(kid, 'hex'));
  // ISO/IEC 23001-7 nests tenc inside schi; the synthetic fixture must match the
  // real packagers (this is what the live AK47 feeds exposed).
  const sinf = box('sinf',
    box('frma', Buffer.from(realFormat, 'latin1')),
    fullBox('schm', 0, 0, Buffer.from(scheme, 'latin1'), u32(0x00010000)),
    nestedTenc ? box('schi', tencBox) : tencBox);
  const codec = box(isVideo ? 'avcC' : 'esds', Buffer.from([1, 2, 3, 4]));
  const entry = box(entryType, header, codec, sinf);

  const stsd = fullBox('stsd', 0, 0, u32(1), entry);
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const hdlr = fullBox('hdlr', 0, 0, u32(0), Buffer.from(isVideo ? 'vide' : 'soun', 'latin1'), Buffer.alloc(12));
  const mdia = box('mdia', hdlr, minf);
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(trackId), Buffer.alloc(60));
  const trak = box('trak', tkhd, mdia);
  const psshBox = pssh ? fullBox('pssh', 0, 0, Buffer.from(kid, 'hex'), u32(0)) : Buffer.alloc(0);

  return Buffer.concat([box('ftyp', Buffer.from('iso6', 'latin1'), u32(0)), box('moov', trak, psshBox)]);
}

/**
 * Encrypts one sample the way a CENC packager does: clear bytes are copied
 * through untouched and only the cipher runs consume keystream, continuously
 * across runs (a single cipher object, started at the sample IV).
 */
function encryptSample(plain, iv, subsamples) {
  const block = Buffer.alloc(16);
  iv.copy(block, 0, 0, Math.min(iv.length, 16));

  if (!subsamples || subsamples.length === 0) {
    return Buffer.from(crypto.createCipheriv('aes-128-ctr', KEY, block).update(plain));
  }

  const out = Buffer.from(plain); // clear runs stay as-is
  const cipher = crypto.createCipheriv('aes-128-ctr', KEY, block);
  let offset = 0;
  for (const sub of subsamples) {
    if (sub.cipher) {
      const enc = cipher.update(plain.subarray(offset + sub.clear, offset + sub.clear + sub.cipher));
      enc.copy(out, offset + sub.clear);
    }
    offset += sub.clear + sub.cipher;
  }
  return out;
}

/** Deterministic sample of an exact length, plus its encrypted form. */
function sample(plainLength, iv, subsamples = null) {
  const plain = Buffer.alloc(plainLength);
  const seed = crypto.createHash('sha512').update(`${plainLength}:${iv.toString('hex')}`).digest();
  for (let i = 0; i < plainLength; i++) plain[i] = (seed[i % seed.length] + i * 37) & 0xff;
  return { iv, subsamples, plain, encrypted: encryptSample(plain, iv, subsamples) };
}

const IV8 = (seed) => {
  const out = Buffer.alloc(8);
  out.writeUInt32BE(seed >>> 0, 0);
  out.writeUInt32BE(0x01020304, 4);
  return out;
};
const IV16 = (seed) => crypto.createHash('md5').update(String(seed)).digest();

/**
 * Builds a full segment (`moof` + `mdat`) and patches every `trun.data_offset`
 * once the moof size is known.
 *
 * @param {Array} trafs [{trackId, ivSize, sencKid, subsampleFlag, includeSenc,
 *                        runs: [[sample, ...], ...]}]
 */
function buildSegment(trafs) {
  const parts = trafs.map((traf) => {
    const flat = traf.runs.flat();
    const ivSize = traf.ivSize || 8;
    const subsampleFlag = traf.subsampleFlag !== undefined
      ? traf.subsampleFlag
      : Boolean(flat[0].subsamples);

    const truns = traf.runs.map((run) => fullBox(
      'trun', 0, 0x000001 | 0x000200,
      u32(run.length),
      Buffer.alloc(4), // data_offset placeholder, patched below
      Buffer.concat(run.map((s) => u32(s.encrypted.length)))
    ));

    const sencEntries = [];
    for (const s of flat) {
      sencEntries.push(s.iv);
      if (subsampleFlag) {
        const subs = s.subsamples || [{ clear: 0, cipher: s.encrypted.length }];
        sencEntries.push(u16(subs.length));
        for (const sub of subs) sencEntries.push(u16(sub.clear), u32(sub.cipher));
      }
    }

    const sencFlags = (traf.sencKid ? 0x1 : 0) | (subsampleFlag ? 0x2 : 0);
    const senc = traf.includeSenc === false ? Buffer.alloc(0) : fullBox(
      'senc', 0, sencFlags,
      traf.sencKid
        ? Buffer.concat([Buffer.alloc(3), u8(ivSize), Buffer.from(traf.sencKid, 'hex')])
        : Buffer.alloc(0),
      u32(flat.length),
      ...sencEntries
    );

    const tfhd = fullBox('tfhd', 0, 0, u32(traf.trackId));
    return { traf: box('traf', tfhd, ...truns, senc), flat, runs: traf.runs };
  });

  const moof = box('moof', fullBox('mfhd', 0, 0, u32(1)), ...parts.map((p) => p.traf));
  const mdatHeader = 8;

  // Collect truns in emission order so offsets can be patched in the same order.
  const moofBox = (function top(buf) {
    const size = buf.readUInt32BE(0);
    return { type: buf.toString('latin1', 4, 8), size, start: 0, body: 8, end: size };
  }(moof));
  const trunBoxes = [];
  for (let off = moofBox.body; off + 8 <= moofBox.end;) {
    const trafSize = moof.readUInt32BE(off);
    const trafType = moof.toString('latin1', off + 4, off + 8);
    if (trafType === 'traf') {
      for (let p = off + 8; p + 8 <= off + trafSize;) {
        const size = moof.readUInt32BE(p);
        if (size < 8) break;
        if (moof.toString('latin1', p + 4, p + 8) === 'trun') {
          trunBoxes.push({ body: p + 8 });
        }
        p += size;
      }
    }
    off += trafSize;
  }

  const payload = Buffer.concat(parts.flatMap((p) => p.flat.map((s) => s.encrypted)));
  let payloadOffset = 0;
  let trunIndex = 0;
  for (const part of parts) {
    for (const run of part.runs) {
      const trun = trunBoxes[trunIndex++];
      moof.writeInt32BE(moof.length + mdatHeader + payloadOffset, trun.body + 8);
      payloadOffset += run.reduce((sum, s) => sum + s.encrypted.length, 0);
    }
  }

  return Buffer.concat([moof, box('mdat', payload)]);
}

module.exports = {
  KEY,
  KEY_HEX,
  KID_HEX,
  OTHER_KID,
  box,
  fullBox,
  u32,
  u16,
  u8,
  buildInit,
  buildSegment,
  sample,
  encryptSample,
  IV8,
  IV16
};
