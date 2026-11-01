'use strict';

/**
 * CENC engine tests — synthetic ISO BMFF fixtures live in
 * tests/fixtures/cenc-fixtures.js.
 *
 * The reference-tool check (mp4decrypt / ffmpeg) needs a real captured segment
 * and is not part of `npm test`; see scripts/verify-cenc-golden.js.
 */

const {
  buildInit, buildSegment, sample, IV8, IV16, box, fullBox, u32, KEY, KID_HEX, OTHER_KID
} = require('./fixtures/cenc-fixtures');
const {
  parseInit, uncloakInit, decryptSegment, CencError
} = require('../src/services/DashCencEngine');
const { children } = require('../src/services/cenc/boxes');

const keys = { [KID_HEX]: KEY };

describe('cenc init parsing', () => {
  test('reads track id, handler kind, scheme, IV size and KID from tenc', () => {
    const { tracks } = parseInit(buildInit());
    expect(tracks.get(1)).toMatchObject({
      trackId: 1,
      kind: 'video',
      format: 'encv',
      protected: true,
      scheme: 'cenc',
      ivSize: 8,
      kid: KID_HEX
    });
  });

  test('reads an audio track', () => {
    const { tracks } = parseInit(buildInit({ kind: 'audio', entryType: 'enca', trackId: 7 }));
    expect(tracks.get(7)).toMatchObject({ kind: 'audio', format: 'enca', protected: true });
  });

  test('reads tenc from the spec location sinf > schi > tenc', () => {
    const { tracks } = parseInit(buildInit({ nestedTenc: true, ivSize: 16 }));
    expect(tracks.get(1)).toMatchObject({ ivSize: 16, kid: KID_HEX, scheme: 'cenc' });
  });

  test('still reads a flat sinf > tenc layout', () => {
    const { tracks } = parseInit(buildInit({ nestedTenc: false }));
    expect(tracks.get(1)).toMatchObject({ ivSize: 8, kid: KID_HEX });
  });

  test('reads the two-reserved-byte tenc variant used by live Akamai/Nitro inits', () => {
    // 00 00 01 08 | KID — one byte wider than the spec, which is what the real
    // feeds emit and what made the first live run return KID_MISSING.
    const { tracks } = parseInit(buildInit({ tencLayout: 'shifted', ivSize: 16 }));
    expect(tracks.get(1)).toMatchObject({ protected: true, ivSize: 16, kid: KID_HEX });
  });

  test('uses expectedKid to disambiguate an ambiguous tenc', () => {
    const { tracks } = parseInit(buildInit({ tencLayout: 'shifted' }), { expectedKid: OTHER_KID });
    // KID in the box wins only when it matches; otherwise sanity rules apply.
    expect(tracks.get(1).kid).toBe(KID_HEX);
    const exact = parseInit(buildInit({ tencLayout: 'shifted' }), { expectedKid: KID_HEX });
    expect(exact.tracks.get(1).kid).toBe(KID_HEX);
  });

  test('uncloakInit rewrites encv → avc1, masks sinf/pssh and preserves every box size', () => {
    const init = buildInit();
    const sizesBefore = [...children(init, 0, init.length)].map((b) => [b.type, b.size]);

    const { buf, tracks } = uncloakInit(Buffer.from(init));
    const sizesAfter = [...children(buf, 0, buf.length)].map((b) => [b.type, b.size]);

    expect(sizesAfter).toEqual(sizesBefore);
    expect(buf.includes(Buffer.from('encv', 'latin1'))).toBe(false);
    expect(buf.includes(Buffer.from('avc1', 'latin1'))).toBe(true);
    expect(buf.includes(Buffer.from('sinf', 'latin1'))).toBe(false);
    expect(buf.includes(Buffer.from('pssh', 'latin1'))).toBe(false);
    // tenc/schm/frma live inside the masked sinf and are relabelled with it.
    expect(buf.includes(Buffer.from('tenc', 'latin1'))).toBe(false);
    expect(buf.includes(Buffer.from('schm', 'latin1'))).toBe(false);
    expect(buf.includes(Buffer.from('schi', 'latin1'))).toBe(false);
    expect(tracks.get(1).ivSize).toBe(8);
  });

  test('uncloakInit rewrites enca → mp4a and keeps esds as a direct child', () => {
    const { buf } = uncloakInit(Buffer.from(buildInit({ kind: 'audio', entryType: 'enca' })));
    expect(buf.includes(Buffer.from('mp4a', 'latin1'))).toBe(true);
    expect(buf.includes(Buffer.from('esds', 'latin1'))).toBe(true);
  });

  test('uncloakInit is a no-op for an already-clear track', () => {
    const clearInit = buildInit({ entryType: 'avc1', pssh: false });
    const before = Buffer.from(clearInit);
    const { buf } = uncloakInit(clearInit);
    expect(buf.equals(before)).toBe(true);
  });
});

describe('cenc segment decryption', () => {
  const tracksOf = (init) => parseInit(init).tracks;

  test('decrypts two cipher runs with one keystream while leaving clear bytes untouched', () => {
    // Shape taken from the live feeds: [clear NAL header][cipher slice], sometimes
    // two runs per sample. Clear bytes must NOT advance the counter — asserting the
    // second run is what catches a whole-sample keystream (the earlier, wrong
    // implementation failed exactly here, and ffmpeg rejected the output with
    // "non-intra slice in an IDR NAL unit").
    const tracks = tracksOf(buildInit());
    const subsamples = [{ clear: 5, cipher: 24 }, { clear: 7, cipher: 40 }];
    const s = sample(5 + 24 + 7 + 40, IV8(1), subsamples);
    const segment = buildSegment([{ trackId: 1, runs: [[s]] }]);
    const original = Buffer.from(segment);

    const { buf, stats } = decryptSegment(segment, { tracks, keysByKid: keys });
    expect(stats.samples).toBe(1);

    const encStart = buf.length - s.plain.length;
    // whole sample is plaintext...
    expect(buf.subarray(encStart).equals(s.plain)).toBe(true);
    // ...including the cipher runs, which would still be ciphertext on a
    // per-subsample keystream bug
    expect(buf.subarray(encStart + 5, encStart + 29).equals(s.plain.subarray(5, 29))).toBe(true);
    expect(buf.subarray(encStart + 36, encStart + 76).equals(s.plain.subarray(36, 76))).toBe(true);
    // clear spans are byte-identical to what we received
    expect(buf.subarray(encStart, encStart + 5).equals(original.subarray(encStart, encStart + 5))).toBe(true);
    expect(buf.subarray(encStart + 29, encStart + 36).equals(original.subarray(encStart + 29, encStart + 36))).toBe(true);
  });

  test('round-trips whole-sample encryption (no subsample table, AAC layout)', () => {
    const tracks = tracksOf(buildInit({ kind: 'audio', entryType: 'enca', ivSize: 16 }));
    const s = sample(96, IV16(2), null);
    const segment = buildSegment([{ trackId: 1, ivSize: 16, subsampleFlag: false, runs: [[s]] }]);

    const { buf } = decryptSegment(segment, { tracks, keysByKid: keys });
    expect(buf.subarray(buf.length - 96).equals(s.plain)).toBe(true);
  });

  test('honours a 16-byte IV declared by senc override', () => {
    const tracks = tracksOf(buildInit());
    const s = sample(64, IV16(3), [{ clear: 4, cipher: 60 }]);
    const segment = buildSegment([{ trackId: 1, ivSize: 16, sencKid: OTHER_KID, runs: [[s]] }]);

    const { buf } = decryptSegment(segment, { tracks, keysByKid: { [OTHER_KID]: KEY } });
    expect(buf.subarray(buf.length - 64).equals(s.plain)).toBe(true);
  });

  test('walks two trun boxes inside one traf', () => {
    const tracks = tracksOf(buildInit());
    const a = sample(40, IV8(4), [{ clear: 4, cipher: 36 }]);
    const b = sample(40, IV8(5), [{ clear: 4, cipher: 36 }]);
    const segment = buildSegment([{ trackId: 1, runs: [[a], [b]] }]);

    const { buf, stats } = decryptSegment(segment, { tracks, keysByKid: keys });
    expect(stats.samples).toBe(2);
    expect(buf.subarray(buf.length - 80, buf.length - 40).equals(a.plain)).toBe(true);
    expect(buf.subarray(buf.length - 40).equals(b.plain)).toBe(true);
  });

  test('walks two traf boxes inside one moof', () => {
    const tracks = tracksOf(buildInit());
    const a = sample(48, IV8(6), [{ clear: 4, cipher: 44 }]);
    const b = sample(48, IV8(7), [{ clear: 4, cipher: 44 }]);
    const segment = buildSegment([
      { trackId: 1, runs: [[a]] },
      { trackId: 1, runs: [[b]] }
    ]);

    const { buf, stats } = decryptSegment(segment, { tracks, keysByKid: keys });
    expect(stats.trafs).toBe(2);
    expect(buf.subarray(buf.length - 96, buf.length - 48).equals(a.plain)).toBe(true);
    expect(buf.subarray(buf.length - 48).equals(b.plain)).toBe(true);
  });

  test('neutralises senc into free without changing the segment length', () => {
    const tracks = tracksOf(buildInit());
    const s = sample(32, IV8(8), [{ clear: 4, cipher: 28 }]);
    const segment = buildSegment([{ trackId: 1, runs: [[s]] }]);
    const before = segment.length;

    const { buf } = decryptSegment(segment, { tracks, keysByKid: keys });
    expect(buf.length).toBe(before);
    expect(buf.includes(Buffer.from('senc', 'latin1'))).toBe(false);
    expect(buf.includes(Buffer.from('free', 'latin1'))).toBe(true);
  });

  test('fails loudly when a protected traf has no senc', () => {
    const tracks = tracksOf(buildInit());
    const s = sample(32, IV8(9), [{ clear: 4, cipher: 28 }]);
    const segment = buildSegment([{ trackId: 1, includeSenc: false, runs: [[s]] }]);

    expect(() => decryptSegment(segment, { tracks, keysByKid: keys }))
      .toThrow(expect.objectContaining({ code: 'SENC_MISSING' }));
  });

  test('fails loudly on an unknown KID instead of emitting ciphertext', () => {
    const tracks = tracksOf(buildInit());
    const s = sample(32, IV8(10), [{ clear: 4, cipher: 28 }]);
    const segment = buildSegment([{ trackId: 1, sencKid: OTHER_KID, runs: [[s]] }]);

    expect(() => decryptSegment(segment, { tracks, keysByKid: keys }))
      .toThrow(expect.objectContaining({ code: 'KID_MISSING' }));
  });

  test('passes a clear segment through untouched', () => {
    const clear = Buffer.concat([
      box('moof', fullBox('mfhd', 0, 0, u32(1))),
      box('mdat', Buffer.from([1, 2, 3]))
    ]);
    const copy = Buffer.from(clear);
    const { buf, stats } = decryptSegment(clear, { tracks: new Map(), keysByKid: {} });
    expect(stats.samples).toBe(0);
    expect(buf.equals(copy)).toBe(true);
  });

  test('reports CencError for a truncated segment rather than reading past the buffer', () => {
    const tracks = tracksOf(buildInit());
    const s = sample(32, IV8(11), [{ clear: 4, cipher: 28 }]);
    const segment = buildSegment([{ trackId: 1, runs: [[s]] }]);
    const trunc = segment.subarray(0, segment.length - 40);

    expect(() => decryptSegment(trunc, { tracks, keysByKid: keys })).toThrow(CencError);
  });
});
