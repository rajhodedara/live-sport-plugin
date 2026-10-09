/**
 * Tests for the composed match-card artwork tier.
 *
 * Focuses on the PURE composer `generateMatchCardSvg()` (no I/O): the badge
 * data URIs are injected directly, so these tests never touch the network.
 */

const { generateMatchCardSvg, SPORT_CONFIGS, sportGlyphMarkup } = require('../src/services/MinimalistPosterService');
const { matchCardUrl } = require('../src/services/ImageService');

// 1x1 transparent PNG, used as a stand-in for an already-embedded badge.
const BADGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Best-effort well-formedness check. Returns null when no XML parser is
 * available so the test degrades to structural assertions instead of failing.
 */
function xmlParseError(svg) {
  let JSDOM;
  try {
    ({ JSDOM } = require('jsdom'));
  } catch (_) {
    return null;
  }
  try {
    const dom = new JSDOM(svg, { contentType: 'image/svg+xml' });
    const err = dom.window.document.querySelector('parsererror');
    return err ? err.textContent : null;
  } catch (e) {
    return e.message;
  }
}

describe('generateMatchCardSvg', () => {
  test('two badges render both embedded images with href and xlink:href', () => {
    const svg = generateMatchCardSvg({
      category: 'football',
      team1: 'Newcastle United',
      team2: 'Leeds United',
      badge1: BADGE,
      badge2: BADGE,
      league: 'Premier League',
      status: 'live',
      time: '8:30 PM'
    });

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect((svg.match(/<image/g) || []).length).toBe(2);
    // Every <image> must carry BOTH attributes for broad renderer support.
    expect((svg.match(/<image/g) || []).length).toBe((svg.match(/xlink:href=/g) || []).length);
    expect(svg).toContain('NEWCASTLE UNITED');
    expect(svg).toContain('LEEDS UNITED');
    expect(svg).toContain('PREMIER LEAGUE');
    expect(svg).toContain('LIVE');
    expect(xmlParseError(svg)).toBeNull();
  });

  test('a single badge degrades cleanly with no undefined/NaN leakage', () => {
    const svg = generateMatchCardSvg({
      category: 'hockey',
      team1: 'Rodez',
      team2: 'Albacete',
      badge1: BADGE,
      league: 'Ligue 1',
      status: 'upcoming',
      time: '7:00 PM'
    });

    expect((svg.match(/<image/g) || []).length).toBe(1);
    // The opponent with no crest is still named.
    expect(svg).toContain('ALBACETE');
    expect(svg).not.toMatch(/undefined|NaN/);
    expect(xmlParseError(svg)).toBeNull();
  });

  test('zero badges produces a non-empty typographic card with the hero text', () => {
    const svg = generateMatchCardSvg({
      category: 'other',
      title: 'Some Niche FC vs FC Nobody',
      league: 'Regional Cup',
      status: '247',
      time: 'Live Now'
    });

    expect(svg.length).toBeGreaterThan(500);
    expect((svg.match(/<image/g) || []).length).toBe(0);
    // Hero matchup is derived from the title (now rendered in all-caps 
    // to match the styling of cards with crests).
    expect(svg).toContain('SOME NICHE FC');
    expect(svg).toContain('FC NOBODY');
    expect(svg).toContain('24/7');
    expect(svg).not.toMatch(/undefined|NaN/);
  });

  test('untrusted team/league names are XML-escaped, never raw markup', () => {
    const svg = generateMatchCardSvg({
      category: 'football',
      team1: 'A & B <script>alert(1)</script>',
      team2: 'X "quote" & \'apos\'',
      league: 'L1 & Co <b>',
      status: 'live',
      time: '1:00 PM'
    });

    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('</script>');
    expect(svg).not.toContain('<SCRIPT>');
    expect(svg).not.toContain('</SCRIPT>');
    expect(svg).not.toContain('<b>');
    expect(svg).not.toContain('<B>');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;SCRIPT&gt;');
    expect(svg).toContain('&quot;');
    expect(svg).toContain('&apos;');
    // The escaped output must still be well-formed XML.
    expect(xmlParseError(svg)).toBeNull();
  });

  test('landscape and poster shapes emit the correct canvas size', () => {
    const landscape = generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B', shape: 'landscape' });
    const poster = generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B', shape: 'poster' });
    const defaulted = generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B' });

    expect(landscape).toContain('width="800" height="450"');
    expect(defaulted).toContain('width="800" height="450"');
    // Stremio posterShape "poster" spec ratio is 1:0.675 -> 600x889.
    expect(poster).toContain('width="600" height="889"');
    expect(xmlParseError(poster)).toBeNull();
  });

  test('an unknown category falls back without throwing', () => {
    expect(() => generateMatchCardSvg({ category: 'quidditch', team1: 'A', team2: 'B' })).not.toThrow();
    const svg = generateMatchCardSvg({ category: 'quidditch', team1: 'A', team2: 'B' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(xmlParseError(svg)).toBeNull();
  });

  test('every app category has a sport config and a glyph', () => {
    const categories = [
      'football', 'basketball', 'motorsport', 'cricket', 'tennis', 'rugby',
      'american_football', 'baseball', 'hockey', 'golf', 'darts', 'mma',
      'networks', 'college', 'other'
    ];
    for (const cat of categories) {
      expect(SPORT_CONFIGS[cat]).toBeDefined();
      expect(typeof SPORT_CONFIGS[cat].accent).toBe('string');
      expect(String(sportGlyphMarkup(cat)).length).toBeGreaterThan(0);
    }
  });

  test('very long names are truncated instead of overflowing the canvas', () => {
    const svg = generateMatchCardSvg({
      category: 'football',
      team1: 'A'.repeat(200),
      team2: 'B'.repeat(200),
      league: 'C'.repeat(200)
    });
    expect(svg).toContain('\u2026');
    expect(xmlParseError(svg)).toBeNull();
  });

  test('motorsport card renders racing telemetry, kerbing, and aerodynamic hero without broadcaster hijacking', () => {
    const svg = generateMatchCardSvg({
      category: 'motorsport',
      title: 'Truck Series - Fr8 208',
      league: 'NASCAR Craftsman Truck Series',
      channelMark: BADGE,
      channelBadge: BADGE,
      channel: 'FS1',
      status: 'upcoming',
      time: '1:30 PM',
      shape: 'landscape'
    });

    expect(svg.startsWith('<svg')).toBe(true);
    // Should contain telemetry lines and apex kerb polygons
    expect(svg).toContain('stroke-dasharray="14,24"');
    expect(svg).toContain('<polygon points="');
    // Title with hyphen should NOT be split into "VS"
    expect(svg).not.toContain('>VS<');
    expect(svg).toContain('TRUCK SERIES');
    expect(svg).toContain('FR8 208');
    // ChannelMark must NOT hijack the hero slot (channelBadge is footer only)
    // Only the footer channelBadge should be rendered as an <image>
    expect((svg.match(/<image/g) || []).length).toBe(1);
    expect(svg).toContain('FS1');
    expect(xmlParseError(svg)).toBeNull();
  });

  test('motorsport card with leagueBadge renders official series emblem in hero disc', () => {
    const svg = generateMatchCardSvg({
      category: 'motorsport',
      title: 'Formula 1 Bahrain Grand Prix',
      league: 'Formula 1',
      leagueBadge: BADGE,
      status: 'live',
      shape: 'poster'
    });

    expect(svg).toContain('width="600" height="889"');
    expect(svg).toContain('FORMULA 1');
    expect(svg).toContain('BAHRAIN');
    expect(svg).toContain('GRAND PRIX');
    // LeagueBadge in header + hero disc
    expect((svg.match(/<image/g) || []).length).toBeGreaterThanOrEqual(1);
    expect(xmlParseError(svg)).toBeNull();
  });
});

describe('matchCardUrl', () => {
  test('encodes only the supplied fields and omits empty ones', () => {
    const url = matchCardUrl('http://localhost:7000', {
      category: 'football',
      team1: 'Rodez',
      team2: 'Albacete',
      league: 'Ligue 1',
      status: 'live',
      time: '8:30 PM',
      shape: 'landscape'
    });

    expect(url.startsWith('http://localhost:7000/img/match?')).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('cat')).toBe('football');
    expect(parsed.searchParams.get('t1')).toBe('Rodez');
    expect(parsed.searchParams.get('lg')).toBe('Ligue 1');
    expect(parsed.searchParams.get('tm')).toBe('8:30 PM');
    // Not supplied -> must not appear.
    expect(parsed.searchParams.has('b1')).toBe(false);
    expect(parsed.searchParams.has('b2')).toBe(false);
  });

  test('works with no spec at all', () => {
    expect(matchCardUrl('http://localhost:7000', {})).toBe('http://localhost:7000/img/match');
  });
});
