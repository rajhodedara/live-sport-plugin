'use strict';

/**
 * Crest plate integrity.
 *
 * A crest slot must never be drawn as a bare ring. The "empty circle" defect
 * shipped once: the live-score hero branch pushed both plates unconditionally,
 * so any scored fixture without resolved crests rendered two hollow circles.
 * These tests pin all three cases the plate helper has to handle.
 */

const { generateMatchCardSvg } = require('../src/services/MinimalistPosterService');

/** Every crest plate circle, in both the filled and the monogram styling. */
const plates = (svg) =>
  [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="(\d+)" fill="rgba\(255,255,255,0\.0(?:45|5)\)"/g)]
    .map((m) => ({ cx: Number(m[1]), cy: Number(m[2]), r: Number(m[3]) }));

const images = (svg) => (svg.match(/<image/g) || []).length;
/** Monogram letters drawn inside a plate (large, condensed, nameFill). */
const monograms = (svg) =>
  [...svg.matchAll(/font-weight="800" fill="url\(#nameFill\)" text-anchor="middle">([^<])</g)].map((m) => m[1]);

/** A plate is satisfied when a crest image or a monogram letter sits in it. */
function emptyPlates(svg) {
  const p = plates(svg);
  const filled = images(svg) + monograms(svg).length;
  return Math.max(0, p.length - filled);
}

const base = { category: 'football', team1: 'Porto', team2: 'Braga', league: 'Liga' };

describe('crest plates are never empty rings', () => {
  test('a scored fixture with no crests shows monograms, not empty circles', () => {
    const svg = generateMatchCardSvg({ ...base, status: 'live', score: '2:1' });
    expect(plates(svg).length).toBe(2);
    expect(images(svg)).toBe(0);
    expect(monograms(svg)).toEqual(['P', 'B']);
    expect(emptyPlates(svg)).toBe(0);
  });

  test('a scored fixture with one crest fills the other slot with a monogram', () => {
    const svg = generateMatchCardSvg({ ...base, status: 'live', score: '2:1', badge1: 'u1' });
    expect(images(svg)).toBe(1);
    expect(monograms(svg)).toEqual(['B']);
    expect(emptyPlates(svg)).toBe(0);
  });

  test('a scored fixture with both crests draws no monograms', () => {
    const svg = generateMatchCardSvg({ ...base, status: 'live', score: '2:1', badge1: 'u1', badge2: 'u2' });
    expect(images(svg)).toBe(2);
    expect(monograms(svg)).toEqual([]);
    expect(emptyPlates(svg)).toBe(0);
  });

  test('a scored fixture with no teams at all draws no plates', () => {
    const svg = generateMatchCardSvg({ category: 'networks', title: 'Sky Sports', status: 'live', score: '2:1' });
    expect(plates(svg).length).toBe(0);
    expect(emptyPlates(svg)).toBe(0);
  });

  test('the portrait hero is safe too', () => {
    const svg = generateMatchCardSvg({ ...base, status: 'live', score: '2:1', shape: 'poster' });
    expect(emptyPlates(svg)).toBe(0);
    expect(monograms(svg)).toEqual(['P', 'B']);
  });

  test('the non-hero landscape rows are safe', () => {
    const both = generateMatchCardSvg({ ...base, status: 'live', badge1: 'u1', badge2: 'u2' });
    const one = generateMatchCardSvg({ ...base, status: 'live', badge1: 'u1' });
    expect(emptyPlates(both)).toBe(0);
    expect(emptyPlates(one)).toBe(0);
  });

  test('a monogram uses the side name initial, not a stray character', () => {
    const svg = generateMatchCardSvg({ category: 'football', team1: 'Real Madrid', team2: '1899 Hoffenheim', status: 'live', score: '1:1' });
    // "Real Madrid" -> R, "1899 Hoffenheim" -> 1 (first letter or digit).
    expect(monograms(svg)).toEqual(['R', '1']);
  });

  test('an accented or non-latin initial still resolves', () => {
    const svg = generateMatchCardSvg({ category: 'football', team1: 'Étoile Sportive', team2: 'Žilina', status: 'live', score: '1:1' });
    expect(monograms(svg).length).toBe(2);
    expect(emptyPlates(svg)).toBe(0);
  });

  test('every generated card leaves no empty plate, across states', () => {
    const specs = [
      { ...base, status: 'live', score: '2:1' },
      { ...base, status: 'live' },
      { ...base, status: 'upcoming' },
      { ...base, status: 'replay', score: '3:1' },
      { ...base, status: 'live', badge1: 'u', shape: 'poster' },
      { category: 'networks', title: 'CNN', status: '247' },
      { category: 'other', title: 'Niche FC vs FC Nobody', status: 'replay' }
    ];
    for (const spec of specs) {
      expect(emptyPlates(generateMatchCardSvg(spec))).toBe(0);
    }
  });
});
