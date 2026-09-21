'use strict';

/**
 * Tests for the measured-image-dimension layer in ImageService.
 *
 * The catalog needs to tell real landscape artwork apart from a square or
 * portrait crest, and the only trustworthy signal is the image's own encoded
 * dimensions. These tests run against the real files in public/ so the parser
 * is verified against genuine PNG and JPEG bytes, not synthetic fixtures.
 */

const fs = require('fs');
const path = require('path');
const { parseImageDimensions, getCachedMeta } = require('../src/services/ImageService');

const PUBLIC = path.join(__dirname, '..', 'public');

describe('parseImageDimensions', () => {
  test('reads real PNG dimensions from an actual asset', () => {
    const dims = parseImageDimensions(fs.readFileSync(path.join(PUBLIC, 'logo.png')));
    expect(dims).toEqual({ width: 512, height: 512 });
  });

  test('reads real JPEG dimensions from an actual asset', () => {
    const dims = parseImageDimensions(
      fs.readFileSync(path.join(PUBLIC, 'posters', 'replays', 'luffy_football.jpg'))
    );
    expect(dims).toEqual({ width: 1024, height: 576 });
    // 16:9 artwork must clear the landscape bar the catalog applies.
    expect(dims.width / dims.height).toBeGreaterThanOrEqual(1.2);
  });

  test('the square logo is correctly below the landscape threshold', () => {
    const dims = parseImageDimensions(fs.readFileSync(path.join(PUBLIC, 'logo.png')));
    // This is exactly the case the old URL-substring test got wrong: a 1:1
    // crest must never be used as a landscape poster.
    expect(dims.width / dims.height).toBeLessThan(1.2);
  });

  test('every curated sport poster is genuine landscape artwork', () => {
    const dir = path.join(PUBLIC, 'posters', 'replays');
    const files = fs.readdirSync(dir).filter((f) => /^luffy_.*\.jpg$/.test(f));
    expect(files.length).toBe(8);
    for (const f of files) {
      const d = parseImageDimensions(fs.readFileSync(path.join(dir, f)));
      expect(d.width).not.toBeNull();
      expect(d.height).not.toBeNull();
      expect(d.width / d.height).toBeGreaterThanOrEqual(1.2);
    }
  });

  test('non-image and malformed input returns nulls without throwing', () => {
    expect(parseImageDimensions(Buffer.from('this is definitely not an image'))).toEqual({
      width: null, height: null
    });
    expect(parseImageDimensions(Buffer.alloc(4))).toEqual({ width: null, height: null });
    expect(parseImageDimensions(Buffer.alloc(0))).toEqual({ width: null, height: null });
    expect(parseImageDimensions(null)).toEqual({ width: null, height: null });
    expect(parseImageDimensions(undefined)).toEqual({ width: null, height: null });
    expect(parseImageDimensions('not a buffer')).toEqual({ width: null, height: null });
  });

  test('a PNG signature with a truncated body degrades to nulls', () => {
    const real = fs.readFileSync(path.join(PUBLIC, 'logo.png'));
    expect(parseImageDimensions(real.slice(0, 12))).toEqual({ width: null, height: null });
  });

  test('a JPEG truncated before its frame header degrades to nulls', () => {
    const real = fs.readFileSync(path.join(PUBLIC, 'posters', 'replays', 'luffy_tennis.jpg'));
    expect(parseImageDimensions(real.slice(0, 10))).toEqual({ width: null, height: null });
  });
});

describe('getCachedMeta', () => {
  test('returns null for a URL that was never fetched', () => {
    expect(getCachedMeta('https://example.invalid/never-fetched.png')).toBeNull();
  });

  test('returns null for invalid input rather than throwing', () => {
    expect(getCachedMeta('')).toBeNull();
    expect(getCachedMeta(null)).toBeNull();
    expect(getCachedMeta('not-a-url')).toBeNull();
  });
});
