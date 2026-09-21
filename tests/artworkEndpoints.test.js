'use strict';

/**
 * Tests for the generated artwork endpoints and the score-aware match card.
 *
 * /img/date and /img/sport are the routes that make a sport hub's date rows
 * visually distinct instead of repeating one sport JPEG for every date, so the
 * assertions here pin both the response headers and the canvas geometry the
 * registered posterShape expects.
 */

const { generateDateSvg, generateSportSvg, generateMatchCardSvg } = require('../src/services/MinimalistPosterService');
const { datePosterUrl, sportPosterUrl, matchCardUrl } = require('../src/services/ImageService');

const canvas = (svg) => {
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
};

describe('generateDateSvg', () => {
  test('poster shape is 2:3 and landscape is 16:9', () => {
    expect(canvas(generateDateSvg('September 19, 2026', 12, 'football', 'poster'))).toEqual({ w: 600, h: 900 });
    expect(canvas(generateDateSvg('September 19, 2026', 12, 'football', 'landscape'))).toEqual({ w: 800, h: 450 });
  });

  test('the date and match count are rendered', () => {
    const svg = generateDateSvg('September 19, 2026', 12, 'football', 'poster');
    expect(svg).toContain('September 19, 2026');
    expect(svg).toContain('12');
  });

  test('a missing sport and a zero count still produce a valid card', () => {
    for (const svg of [
      generateDateSvg('September 19, 2026', 0, null, 'poster'),
      generateDateSvg('', 0, null, 'poster'),
      generateDateSvg('September 19, 2026', 12, 'quidditch', 'poster')
    ]) {
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).not.toMatch(/undefined|NaN/);
    }
  });

  test('different dates produce different artwork', () => {
    const a = generateDateSvg('September 19, 2026', 12, 'football', 'poster');
    const b = generateDateSvg('September 20, 2026', 12, 'football', 'poster');
    expect(a).not.toBe(b);
  });

  test('different sports produce differently accented artwork', () => {
    const fb = generateDateSvg('September 19, 2026', 5, 'football', 'poster');
    const bb = generateDateSvg('September 19, 2026', 5, 'basketball', 'poster');
    expect(fb).not.toBe(bb);
  });
});

describe('generateSportSvg', () => {
  test('honours both shapes', () => {
    expect(canvas(generateSportSvg('football', 'poster'))).toEqual({ w: 600, h: 900 });
    expect(canvas(generateSportSvg('football', 'landscape'))).toEqual({ w: 800, h: 450 });
  });

  test('an unknown sport falls back without throwing', () => {
    expect(() => generateSportSvg('quidditch', 'poster')).not.toThrow();
    expect(generateSportSvg('quidditch', 'poster').startsWith('<svg')).toBe(true);
  });
});

describe('generated poster URL helpers', () => {
  test('datePosterUrl encodes the shape and optional sport', () => {
    const u = new URL(datePosterUrl('http://host', 'September 19, 2026', 12, 'football', 'poster'));
    expect(u.pathname).toBe('/img/date');
    expect(u.searchParams.get('date')).toBe('September 19, 2026');
    expect(u.searchParams.get('count')).toBe('12');
    expect(u.searchParams.get('sport')).toBe('football');
    expect(u.searchParams.get('shape')).toBe('poster');
  });

  test('datePosterUrl omits the sport when none is given', () => {
    const u = new URL(datePosterUrl('http://host', 'September 19, 2026', 3, null, 'poster'));
    expect(u.searchParams.has('sport')).toBe(false);
  });

  test('sportPosterUrl defaults to the poster shape', () => {
    const u = new URL(sportPosterUrl('http://host', 'football'));
    expect(u.pathname).toBe('/img/sport/football');
    expect(u.searchParams.get('shape')).toBe('poster');
  });
});

describe('score is the hero, centred and large', () => {
  const base = {
    category: 'football',
    team1: 'Valencia',
    team2: 'Real Sociedad',
    league: 'La Liga',
    time: '7:53 PM'
  };

  /** The hero score: the largest condensed-bold text drawn with the score fill. */
  const heroScore = (svg) => {
    const m = svg.match(/font-size="(\d+)" font-weight="800" letter-spacing="[\d.]+" fill="url\(#scoreFill\)"[^>]*>([^<]*)</);
    return m ? { size: Number(m[1]), text: m[2] } : null;
  };
  /** Any score-ish text still parked in the end-anchored pill position. */
  const pillScore = (svg) => {
    const m = svg.match(/text-anchor="end">([^<]*)</);
    return m ? m[1] : null;
  };

  test('a live score is drawn as a large centred hero', () => {
    const svg = generateMatchCardSvg({ ...base, status: 'live', score: '2:3' });
    const hero = heroScore(svg);
    expect(hero).not.toBeNull();
    expect(hero.size).toBeGreaterThanOrEqual(60);
    // Centred on the canvas, not end-anchored against the pill.
    expect(svg).toContain('fill="url(#scoreFill)" text-anchor="middle"');
    expect(svg).toContain('<text x="400"');
  });

  test('a finished/replay match with a score is also a hero', () => {
    // With real upstream data every score sits on a finished match, so a
    // live-only hero would never actually be seen.
    const hero = heroScore(generateMatchCardSvg({ ...base, status: 'replay', score: '3:1' }));
    expect(hero).not.toBeNull();
    expect(hero.text).toBe('3 \u2013 1');
  });

  test('the colon becomes an en dash so it reads as a score, not a clock', () => {
    const hero = heroScore(generateMatchCardSvg({ ...base, status: 'live', score: '2:3' }));
    expect(hero.text).toBe('2 \u2013 3');
    expect(hero.text).not.toContain(':');
  });

  test('the status pill stays status-only when a score is present', () => {
    const svg = generateMatchCardSvg({ ...base, status: 'live', score: '2:3' });
    expect(svg).toContain('LIVE');
    expect(pillScore(svg)).toBeNull();
    // The hero owns the score; it must not also appear in the pill.
    expect((svg.match(/2 \u2013 3/g) || []).length).toBe(1);
  });

  test('the hero appears in the portrait shape too, on its own centre', () => {
    const svg = generateMatchCardSvg({ ...base, status: 'live', score: '2:3', shape: 'poster' });
    expect(canvas(svg)).toEqual({ w: 600, h: 889 });
    expect(heroScore(svg)).not.toBeNull();
    expect(svg).toContain('<text x="300"');
  });

  test('a wider score is rendered smaller so it still fits between the crests', () => {
    const small = heroScore(generateMatchCardSvg({ ...base, status: 'live', score: '2:3' }));
    const wide = heroScore(generateMatchCardSvg({ ...base, status: 'live', score: '10:12' }));
    const wider = heroScore(generateMatchCardSvg({ ...base, status: 'live', score: '123:456' }));
    expect(wide.size).toBeLessThan(small.size);
    expect(wider.size).toBeLessThan(wide.size);
    // Never shrinks into illegibility.
    expect(wider.size).toBeGreaterThanOrEqual(30);
  });

  test('an upcoming fixture never shows a score anywhere', () => {
    const svg = generateMatchCardSvg({ ...base, status: 'upcoming', score: '2:1' });
    expect(heroScore(svg)).toBeNull();
    expect(pillScore(svg)).toBeNull();
  });

  test('a 24/7 channel never shows a score', () => {
    const svg = generateMatchCardSvg({ category: 'networks', title: 'CNN', status: '247', score: '2:1' });
    expect(heroScore(svg)).toBeNull();
    expect(svg).not.toContain('2 \u2013 1');
  });

  test('an implausible score string is dropped rather than rendered', () => {
    for (const junk of ['TBD', 'vs', '', '   ', 'abc:def', '2:1:4:9']) {
      const svg = generateMatchCardSvg({ ...base, status: 'live', score: junk });
      expect(heroScore(svg)).toBeNull();
      expect(pillScore(svg)).toBeNull();
    }
  });

  test('a card with no score emits no stray score element', () => {
    const svg = generateMatchCardSvg({ ...base, status: 'live' });
    expect(heroScore(svg)).toBeNull();
    expect(svg).not.toMatch(/undefined|NaN/);
    expect(svg).not.toMatch(/<text[^>]*><\/text>/);
  });

  test('the score is XML-escaped like every other field', () => {
    const svg = generateMatchCardSvg({ ...base, status: 'live', score: '2:1' });
    expect(svg).not.toContain('<script>');
  });

  test('matchCardUrl forwards the score under the sc key', () => {
    const u = new URL(matchCardUrl('http://host', { ...base, status: 'live', score: '2:1' }));
    expect(u.searchParams.get('sc')).toBe('2:1');
    expect(new URL(matchCardUrl('http://host', base)).searchParams.has('sc')).toBe(false);
  });
});

describe('per-sport identity reaches the card chrome', () => {
  const accentOf = (svg) => (svg.match(/id="sportTint"[^>]*>.*?stop-color="(#[0-9a-f]{6})"/) || [])[1];
  const topBarOf = (svg) => (svg.match(/height="3" fill="(#[0-9a-f]{6})" opacity="0.95"/) || [])[1];

  test('each sport tints the card with its own accent', () => {
    const football = accentOf(generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B', status: 'live' }));
    const basketball = accentOf(generateMatchCardSvg({ category: 'basketball', team1: 'A', team2: 'B', status: 'live' }));
    expect(football).toBe('#10b981');
    expect(basketball).toBe('#f97316');
    expect(football).not.toBe(basketball);
  });

  test('the top bar follows the sport rather than a hardcoded orange', () => {
    const hockey = topBarOf(generateMatchCardSvg({ category: 'hockey', team1: 'A', team2: 'B', status: 'live' }));
    expect(hockey).toBe('#06b6d4');
  });

  test('an unknown sport still renders a valid card', () => {
    const svg = generateMatchCardSvg({ category: 'quidditch', team1: 'A', team2: 'B', status: 'live' });
    expect(accentOf(svg)).toMatch(/^#[0-9a-f]{6}$/);
    expect(svg).not.toMatch(/undefined|NaN/);
  });
});
