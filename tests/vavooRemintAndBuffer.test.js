'use strict';

const { mergeRemintedUrl, getRemintCacheKey } = require('../src/remint');
const { rewriteHlsPlaylist } = require('../src/services/HlsRewriteService');

describe('Vavoo Remint & Live Buffer Remediation', () => {
  describe('mergeRemintedUrl & getRemintCacheKey for Vavoo/Sunshine', () => {
    test('mergeRemintedUrl returns freshUrl when held/fresh URL is a Sunshine CDN endpoint', () => {
      const heldUrl = 'http://185.244.37.56:8008/sunshine/EXPIRED_TOKEN_123/hls/index.m3u8';
      const freshUrl = 'http://185.244.37.56:8008/sunshine/FRESH_TOKEN_456/hls/index.m3u8';
      const rck = 'vavoo:vavoo_ch_sky_de:0';

      const merged = mergeRemintedUrl(heldUrl, freshUrl, rck);
      expect(merged).toBe(freshUrl);
      expect(merged).toContain('FRESH_TOKEN_456');
      expect(merged).not.toContain('EXPIRED_TOKEN_123');
    });

    test('getRemintCacheKey returns stable rck for Vavoo without DaddyLive index corruption', () => {
      const vavooUrl = 'http://185.244.37.56:8008/sunshine/TOKEN_123/hls/index.m3u8';
      const rck = 'vavoo:vavoo_ch_sky_de:0';

      const key = getRemintCacheKey(rck, vavooUrl);
      expect(key).toBe('vavoo:vavoo_ch_sky_de:0');
      expect(key).not.toBe('vavoo:vavoo_ch_sky_de:0:index');
    });

    test('DaddyLive query replacement still works when not a Sunshine endpoint', () => {
      const heldUrl = 'https://dl-cdn.test/hls/stream1.m3u8?s=oldSig&e=1000';
      const freshUrl = 'https://dl-cdn.test/hls/stream1.m3u8?s=newSig&e=2000';
      const rck = 'daddylive:stream1:0';

      const merged = mergeRemintedUrl(heldUrl, freshUrl, rck);
      expect(merged).toContain('s=newSig');
      expect(merged).toContain('e=2000');
    });
  });

  describe('HlsRewriteService Live Buffering & Target Duration Clamping', () => {
    const manifestUrl = 'http://185.244.37.56:8008/sunshine/TOKEN_123/hls/index.m3u8';

    test('injects #EXT-X-START:TIME-OFFSET into live sliding playlists to prevent BehindLiveWindowException', () => {
      const rawVavooLiveM3u8 = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:20',
        '#EXT-X-MEDIA-SEQUENCE:100',
        '#EXTINF:10.000,',
        '0.ts',
        '#EXTINF:10.000,',
        '1.ts',
        '#EXTINF:10.000,',
        '2.ts',
        '#EXTINF:10.000,',
        '3.ts',
        '#EXTINF:10.000,',
        '4.ts',
        '#EXTINF:10.000,',
        '5.ts'
      ].join('\n');

      const rewritten = rewriteHlsPlaylist(rawVavooLiveM3u8, manifestUrl);
      expect(rewritten).toContain('#EXT-X-START:TIME-OFFSET=-18.0');

      // Verify #EXT-X-START is placed immediately after #EXTM3U
      const lines = rewritten.split('\n');
      expect(lines[0]).toBe('#EXTM3U');
      expect(lines[1]).toBe('#EXT-X-START:TIME-OFFSET=-18.0');
    });

    test('clamps #EXT-X-TARGETDURATION when observed segment durations exceed declared target duration', () => {
      const rawM3u8 = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:50',
        '#EXTINF:6.400,',
        'chunk_1.ts',
        '#EXTINF:6.000,',
        'chunk_2.ts'
      ].join('\n');

      const rewritten = rewriteHlsPlaylist(rawM3u8, manifestUrl);
      expect(rewritten).toContain('#EXT-X-TARGETDURATION:7');
      expect(rewritten).not.toContain('#EXT-X-TARGETDURATION:6');
    });

    test('does NOT inject #EXT-X-START into VOD playlists (with #EXT-X-ENDLIST)', () => {
      const vodM3u8 = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.000,',
        '0.ts',
        '#EXT-X-ENDLIST'
      ].join('\n');

      const rewritten = rewriteHlsPlaylist(vodM3u8, manifestUrl);
      expect(rewritten).not.toContain('#EXT-X-START');
    });

    test('does NOT inject #EXT-X-START into master playlists (#EXT-X-STREAM-INF)', () => {
      const masterM3u8 = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
        'chunklist.m3u8'
      ].join('\n');

      const rewritten = rewriteHlsPlaylist(masterM3u8, manifestUrl);
      expect(rewritten).not.toContain('#EXT-X-START');
    });

    test('does NOT duplicate #EXT-X-START if upstream already declared it', () => {
      const rawM3u8 = [
        '#EXTM3U',
        '#EXT-X-START:TIME-OFFSET=-12.0',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.000,',
        '0.ts'
      ].join('\n');

      const rewritten = rewriteHlsPlaylist(rawM3u8, manifestUrl);
      const matches = rewritten.match(/#EXT-X-START/g) || [];
      expect(matches.length).toBe(1);
      expect(rewritten).toContain('#EXT-X-START:TIME-OFFSET=-12.0');
    });
  });
});
