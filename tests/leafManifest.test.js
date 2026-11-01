'use strict';

const http = require('node:http');
const express = require('express');
const leafManifestRoute = require('../src/routes/leafManifest');
const { parseUpstreamManifest, generateSlidingPlaylist, sessionCache } = leafManifestRoute;
const impitClient = require('../src/impitClient');

describe('LeafManifest Synthetic Generator Unit Tests', () => {
  let server;
  let baseUrl;
  let safeFetchSpy;

  beforeAll(async () => {
    const app = express();
    app.use(leafManifestRoute);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    sessionCache.clear();
  });

  afterEach(() => {
    if (safeFetchSpy) {
      safeFetchSpy.mockRestore();
      safeFetchSpy = null;
    }
    sessionCache.clear();
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
  }

  describe('parseUpstreamManifest()', () => {
    test('extracts cdnBase, slug, session, edge, and targetDuration from valid playlist', () => {
      const mockPlaylist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:2974',
        '#EXT-X-DISCONTINUITY-SEQUENCE:18',
        '#EXT-X-ALLOW-CACHE:NO',
        '#EXTINF:6.000,',
        'https://w1.papacito.cfd/leaf/632410/1793459956/seg_2975.ts',
        '#EXTINF:6.000,',
        'https://w1.papacito.cfd/leaf/632410/1793459956/seg_2976.ts'
      ].join('\n');

      const parsed = parseUpstreamManifest(mockPlaylist, 'https://papacito.cfd/m3u/632410/live.m3u8');
      expect(parsed.cdnBase).toBe('https://w1.papacito.cfd');
      expect(parsed.slug).toBe('632410');
      expect(parsed.session).toBe('1793459956');
      expect(parsed.edge).toBe(2975);
      expect(parsed.targetDuration).toBe(6);
      expect(parsed.discontinuitySeq).toBe(18);
      expect(typeof parsed.at).toBe('number');
    });

    test('throws error if playlist is not m3u8', () => {
      expect(() => parseUpstreamManifest('<html>error</html>', 'url')).toThrow('Upstream returned non-m3u8 body');
    });

    test('throws error if anti-piracy trap playlist is returned', () => {
      const antipiracyPlaylist = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        'https://w1.papacito.cfd/_antipiracy/v2/seg_000.ts'
      ].join('\n');
      expect(() => parseUpstreamManifest(antipiracyPlaylist, 'url')).toThrow('Upstream returned anti-piracy trap');
    });

    test('throws error if stream_notice trap playlist is returned', () => {
      const streamNoticePlaylist = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:11',
        'https://w1.papacito.cfd/leaf/stream_notice/1793376749/seg_005.ts'
      ].join('\n');
      expect(() => parseUpstreamManifest(streamNoticePlaylist, 'url')).toThrow('Upstream returned anti-piracy trap');
    });

    test('throws error if no papacito leaf segments found', () => {
      const emptyPlaylist = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:1'
      ].join('\n');
      expect(() => parseUpstreamManifest(emptyPlaylist, 'url')).toThrow('No valid Papacito media segments found');
    });
  });

  describe('generateSlidingPlaylist()', () => {
    test('generates valid RFC 8216 HLS playlist with 8 direct CDN segments', () => {
      const sessionData = {
        cdnBase: 'https://w1.papacito.cfd',
        slug: '632410',
        session: '1793459956',
        edge: 2975,
        targetDuration: 6,
        discontinuitySeq: 18,
        at: Date.now()
      };

      const playlist = generateSlidingPlaylist(sessionData);
      expect(playlist).toContain('#EXTM3U');
      expect(playlist).toContain('#EXT-X-VERSION:3');
      expect(playlist).toContain('#EXT-X-TARGETDURATION:6');
      expect(playlist).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:18');
      expect(playlist).toContain('https://w1.papacito.cfd/leaf/632410/1793459956/seg_2975.ts');

      const segmentCount = (playlist.match(/\.ts/g) || []).length;
      expect(segmentCount).toBe(8);
    });

    test('clamps to edge when stream starts, then slides freely as time advances', () => {
      const now = Date.now();
      // 1. Initial 36s (6 segments): clamped to edge (2000) because 2006 - 8 < 2000
      const initialData = {
        cdnBase: 'https://w1.papacito.cfd',
        slug: '632410',
        session: '1793459956',
        edge: 2000,
        targetDuration: 6,
        discontinuitySeq: 0,
        at: now - 36000
      };
      const p1 = generateSlidingPlaylist(initialData);
      expect(p1).toContain('#EXT-X-MEDIA-SEQUENCE:2000');
      expect(p1).toContain('https://w1.papacito.cfd/leaf/632410/1793459956/seg_2000.ts');

      // 2. Advanced 60s (10 segments): liveEdge = 2010 -> mediaSeq = 2010 - 8 = 2002
      const advancedData = {
        cdnBase: 'https://w1.papacito.cfd',
        slug: '632410',
        session: '1793459956',
        edge: 2000,
        targetDuration: 6,
        discontinuitySeq: 0,
        at: now - 60000
      };
      const p2 = generateSlidingPlaylist(advancedData);
      expect(p2).toContain('#EXT-X-MEDIA-SEQUENCE:2002');
      expect(p2).toContain('https://w1.papacito.cfd/leaf/632410/1793459956/seg_2002.ts');
      expect(p2).toContain('https://w1.papacito.cfd/leaf/632410/1793459956/seg_2009.ts');
    });
  });

  describe('GET /api/leaf/manifest.m3u8 route', () => {
    test('fetches upstream once and returns 200 with mpegurl content type', async () => {
      const mockRawPlaylist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:100',
        '#EXTINF:6.000,',
        'https://w1.papacito.cfd/leaf/test_slug/test_session/seg_101.ts'
      ].join('\n');

      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => mockRawPlaylist
      });

      const res = await get('/api/leaf/manifest.m3u8?url=https%3A%2F%2Fpapacito.cfd%2Fm3u%2Ftest_slug%2Flive.m3u8%3Fft%3Dtoken123');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.body).toContain('https://w1.papacito.cfd/leaf/test_slug/test_session/seg_101.ts');
      expect(safeFetchSpy).toHaveBeenCalledTimes(1);

      // Second request within cache TTL must NOT call upstream safeFetch again
      const res2 = await get('/api/leaf/manifest.m3u8?url=https%3A%2F%2Fpapacito.cfd%2Fm3u%2Ftest_slug%2Flive.m3u8%3Fft%3Dtoken123');

      expect(res2.status).toBe(200);
      expect(safeFetchSpy).toHaveBeenCalledTimes(1); // 0 additional upstream fetches
    });

    test('supports base64url state payload (?d=...) without upstream fetch', async () => {
      const stateObj = {
        cdnBase: 'https://w1.papacito.cfd',
        slug: 'direct_slug',
        session: 'direct_session',
        edge: 500,
        targetDuration: 6,
        discontinuitySeq: 2,
        at: Date.now()
      };
      const b64 = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

      const res = await get(`/api/leaf/manifest.m3u8?d=${b64}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain('https://w1.papacito.cfd/leaf/direct_slug/direct_session/seg_500.ts');
    });

    test('returns 400 when missing url and d parameters', async () => {
      const res = await get('/api/leaf/manifest.m3u8');
      expect(res.status).toBe(400);
    });

    test('returns 502 when upstream fetch fails', async () => {
      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockRejectedValue(new Error('Connection refused'));

      const res = await get('/api/leaf/manifest.m3u8?url=https%3A%2F%2Fpapacito.cfd%2Fm3u%2Ffail%2Flive.m3u8');

      expect(res.status).toBe(502);
    });
  });
});
