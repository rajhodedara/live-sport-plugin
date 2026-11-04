'use strict';

/**
 * SoccerFull cloaked-segment handling.
 *
 * The offsets here are the whole point: SoccerFull wraps MPEG-TS in a 120-byte
 * PNG, while the shared rewriter assumes the 42-byte WebP/RIFF prefix that
 * PPV.st uses. Declaring the wrong offset feeds header bytes to the demuxer.
 */

const { rewriteSoccerFullPlaylist } = require('../src/services/SoccerFullHlsRewrite');

// Probes are asserted on how they are *scheduled*, never on their result, so no
// test in this file touches the network.
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(() => new Promise(() => {})) }));
const segmentLengthService = require('../src/services/SoccerFullSegmentLength');

const { detectCloakPrefix, SoccerFullSegmentLength } = segmentLengthService;

/** PNG signature + filler, 'IEND'<CRC> ending at `total` bytes, then TS sync bytes. */
function pngCloaked(total = 120) {
  const buf = Buffer.alloc(total + 600, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  Buffer.from('IHDR').copy(buf, 12);
  const iend = total - 8; // 'IEND' is followed by a 4-byte CRC
  Buffer.from('IEND').copy(buf, iend);
  for (let i = 0; i < 3; i++) buf[total + i * 188] = 0x47;
  return buf;
}

function webpCloaked(prefix = 42) {
  const buf = Buffer.alloc(prefix + 600, 0);
  Buffer.from('RIFF').copy(buf, 0);
  Buffer.from('WEBP').copy(buf, 8);
  const exif = prefix - 8;
  Buffer.from('EXIF').copy(buf, exif);
  for (let i = 0; i < 3; i++) buf[prefix + i * 188] = 0x47;
  return buf;
}

describe('SoccerFullSegmentLength.detectCloakPrefix', () => {
  test('measures a 120-byte PNG cloak (SoccerFull / ~tplv-...-ttam-origin)', () => {
    expect(detectCloakPrefix(pngCloaked(120))).toBe(120);
  });

  test('measures a 42-byte RIFF/WEBP cloak (PPV.st / Streamed.pk)', () => {
    expect(detectCloakPrefix(webpCloaked(42))).toBe(42);
  });

  test('returns 0 for an uncloaked TS object', () => {
    const buf = Buffer.alloc(800, 0);
    for (let i = 0; i < 3; i++) buf[i * 188] = 0x47;
    expect(detectCloakPrefix(buf)).toBe(0);
  });

  test('falls back to 42 when the wrapper is unrecognised', () => {
    expect(detectCloakPrefix(Buffer.from('not-a-container-header'))).toBe(42);
    expect(detectCloakPrefix(null)).toBe(42);
  });
});

describe('SoccerFullSegmentLength caches', () => {
  test('getPrefixBytes falls back to 42 until a probe warms the host', () => {
    const svc = new SoccerFullSegmentLength();
    expect(svc.getPrefixBytes('https://p16-ad-site-sign-sg.tiktokcdn.com/a.image')).toBe(42);
    svc.prefixCache.set('p16-ad-site-sign-sg.tiktokcdn.com', { bytes: 120, expiresAt: Date.now() + 60000 });
    expect(svc.getPrefixBytes('https://p16-ad-site-sign-sg.tiktokcdn.com/b.image')).toBe(120);
  });

  test('an unprobed segment gets a padded estimate, never the exact-size guess', () => {
    const svc = new SoccerFullSegmentLength();
    const estimate = svc.getSegmentLength('https://example.test/a.image', { duration: 4 });
    // 4s * 6 Mbps * 1.5 safety factor, minus the prefix, TS-aligned
    expect(estimate % 188).toBe(0);
    expect(estimate).toBeGreaterThan((4 * 6000000) / 8);
  });

  test('bounds concurrent length probes so a 1500-segment playlist cannot flood the CDN', () => {
    const svc = new SoccerFullSegmentLength({ maxConcurrentProbes: 2 });
    const urls = Array.from({ length: 10 }, (_, i) => `https://cdn.example/${i}.image`);

    urls.forEach(u => svc.probeLength(u));

    expect(svc.activeProbes).toBe(2);
    expect(svc.inFlightLength.size).toBe(2);

    // Rewriting still returns an estimate for the rest instead of blocking.
    expect(svc.getSegmentLength(urls[9], { duration: 4 })).toBeGreaterThan(0);
  });
});

describe('rewriteSoccerFullPlaylist', () => {
  const manifestUrl = 'https://soccerfull.net/hls/17964.m3u8';
  const body = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:4.000,',
    'https://p16-ad-site-sign-sg.tiktokcdn.com/a.image?x=1',
    '#EXTINF:4.000,',
    'https://p19-ad-site-sign-sg.tiktokcdn.com/b.image?x=2',
    '#EXT-X-ENDLIST'
  ].join('\n');

  beforeEach(() => {
    segmentLengthService.clear();
    // Warm the host so the rewrite uses the measured offset, not the fallback.
    segmentLengthService.prefixCache.set('p16-ad-site-sign-sg.tiktokcdn.com', { bytes: 120, expiresAt: Date.now() + 60000 });
    segmentLengthService.prefixCache.set('p19-ad-site-sign-sg.tiktokcdn.com', { bytes: 120, expiresAt: Date.now() + 60000 });
    segmentLengthService.setCachedLength('https://p16-ad-site-sign-sg.tiktokcdn.com/a.image?x=1', 1997688);
    segmentLengthService.setCachedLength('https://p19-ad-site-sign-sg.tiktokcdn.com/b.image?x=2', 1997688);
  });

  test('declares @120, not the shared @42, for every PNG-cloaked segment', () => {
    const out = rewriteSoccerFullPlaylist(body, manifestUrl);
    const ranges = out.split('\n').filter(l => l.startsWith('#EXT-X-BYTERANGE:'));
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toBe('#EXT-X-BYTERANGE:1997688@120');
    expect(ranges[1]).toBe('#EXT-X-BYTERANGE:1997688@120');
    expect(out).not.toContain('@42');
  });

  test('keeps segments as direct CDN URIs (no media proxy hop)', () => {
    const out = rewriteSoccerFullPlaylist(body, manifestUrl);
    const uris = out.split('\n').filter(l => l && !l.startsWith('#'));
    expect(uris[0]).toBe('https://p16-ad-site-sign-sg.tiktokcdn.com/a.image?x=1');
    expect(out).not.toContain('/api/manifest');
    expect(out).not.toContain('/api/hlschunk');
  });

  test('raises #EXT-X-VERSION to 4 because byterange requires it', () => {
    const out = rewriteSoccerFullPlaylist(body, manifestUrl);
    expect(out).toContain('#EXT-X-VERSION:4');
    expect(out).not.toContain('#EXT-X-VERSION:3');
  });

  test('adds HLS version 4 when a versionless playlist gains byte ranges', () => {
    const versionless = body.replace('#EXT-X-VERSION:3\n', '');
    const out = rewriteSoccerFullPlaylist(versionless, manifestUrl);
    expect(out.split('\n').slice(0, 2)).toEqual(['#EXTM3U', '#EXT-X-VERSION:4']);
    expect(out).toContain('#EXT-X-BYTERANGE:1997688@120');
  });

  test('keeps an existing HLS version above 4', () => {
    const out = rewriteSoccerFullPlaylist(body.replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:6'), manifestUrl);
    expect(out).toContain('#EXT-X-VERSION:6');
    expect(out).not.toContain('#EXT-X-VERSION:4');
  });

  test('leaves a versionless plain-segment playlist unchanged', () => {
    const plain = '#EXTM3U\n#EXTINF:4,\nhttps://cdn.example.test/segment.ts\n#EXT-X-ENDLIST';
    expect(rewriteSoccerFullPlaylist(plain, manifestUrl)).toBe(plain);
  });

  test('routes child playlists back through the addon', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2325091,RESOLUTION=1280x720',
      'index-v1-a1.m3u8?t=tok'
    ].join('\n');
    const out = rewriteSoccerFullPlaylist(master, manifestUrl, {
      toProxyUrl: u => `https://addon.test/api/soccerfull/manifest?url=${encodeURIComponent(u)}`
    });
    expect(out).toContain('/api/soccerfull/manifest?url=');
    expect(out).toContain(encodeURIComponent('https://soccerfull.net/hls/index-v1-a1.m3u8?t=tok'));
  });
});
