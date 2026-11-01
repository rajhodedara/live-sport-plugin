'use strict';

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');

const DashToHlsService = require('../src/services/DashToHlsService');
const dashRouter = require('../src/routes/dash');
const { signPayload, verifyPayload } = require('../src/services/DashPayload');
const { buildPolicy, assertAllowed, isBlockedHost, fetchGuarded } = require('../src/services/DashUpstream');
const { buildInit, buildSegment, sample, IV8, KEY_HEX, KID_HEX } = require('./fixtures/cenc-fixtures');

// Deterministic per-test signer, injected into the router — never an env var,
// so the suite cannot accidentally depend on a deployment secret.
const signer = crypto.createHash('sha256').update('dash-cenc-unit-tests').digest('hex');

const NITRO_MPD_URL = 'https://otte.live.fly.ww.aiv-cdn.net/fra-nitro/out/v1/ab9d1f/cenc.mpd';
const AKAMAI_MPD_URL = 'https://akamai-edge.example.com/dash/live/tennis/manifest.mpd';

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function makeService(xmlByHost, extra = {}) {
  return new DashToHlsService({
    fetcher: async (url) => {
      for (const [host, xml] of Object.entries(xmlByHost)) {
        if (url.includes(host)) return { ok: true, status: 200, url, text: async () => xml };
      }
      return { ok: false, status: 404, url, text: async () => '' };
    },
    ...extra
  });
}

function makePayload(mpdUrl) {
  return { mpdUrl, key: KEY_HEX, kid: KID_HEX, headers: {} };
}

function token(payload, opts = {}) {
  return signPayload(payload, { signWith: signer, ...opts });
}

describe('DashToHlsService', () => {
  let nitroXml;
  let akamaiXml;

  beforeAll(() => {
    nitroXml = readFixture('nitro-live.mpd');
    akamaiXml = readFixture('akamai-live.mpd');
  });

  describe('MPD parsing (real Amazon Nitro live manifest)', () => {
    test('extracts video/audio representations from the live (last) period', () => {
      const parsed = makeService({ 'otte.live.fly': nitroXml }).parseMpd(nitroXml, NITRO_MPD_URL);

      expect(parsed.videoReps.length).toBe(6);
      expect(parsed.audioReps.length).toBe(1);
      expect(parsed.videoReps[0].bandwidth).toBe(8200000); // highest first
      expect(parsed.videoReps[0].codecs).toBe('avc1.640028');
      expect(parsed.audioReps[0].lang).toBe('hin');
    });

    test('detects cenc protection → SAMPLE-AES-CTR and keeps CDN token params', () => {
      const parsed = makeService({ 'otte.live.fly': nitroXml }).parseMpd(nitroXml, NITRO_MPD_URL);

      expect(parsed.videoReps[0].encryption).toBe('SAMPLE-AES-CTR');
      expect(parsed.videoReps[0].scheme).toBe('cenc');
      expect(parsed.audioReps[0].encryption).toBe('SAMPLE-AES-CTR');
      expect(parsed.videoReps[0].initUrl).toContain('https://otte.live.fly.ww.aiv-cdn.net/');
      expect(parsed.videoReps[0].initUrl).toMatch(/cenc_video_6_0_init\.mp4\?m=\d+$/);
    });

    test('keeps an absolute media template for server-side URL synthesis', () => {
      const parsed = makeService({ 'otte.live.fly': nitroXml }).parseMpd(nitroXml, NITRO_MPD_URL);
      expect(parsed.videoReps[0].mediaTemplate).toMatch(/^https:\/\/otte\.live\.fly\.ww\.aiv-cdn\.net\/.*\$Number\$\.mp4/);
      expect(parsed.videoReps[0].segmentShape.uniform).toBe(true);
    });

    test('caps the live window and indexes MEDIA-SEQUENCE from DASH $Number$', () => {
      const parsed = makeService({ 'otte.live.fly': nitroXml }).parseMpd(nitroXml, NITRO_MPD_URL);
      const video = parsed.videoReps[0];
      const audio = parsed.audioReps[0];

      expect(video.segments.length).toBeLessThanOrEqual(15);
      expect(audio.segments.length).toBeLessThanOrEqual(15);
      expect(video.segments[0].number).toBe(8550);
      expect(video.segments[video.segments.length - 1].number).toBe(8564);
      expect(video.segments[0].url).toContain('cenc_video_6_0_8550.mp4');
    });
  });

  test('bounds materialized segments for very large SegmentTimeline repeats', () => {
    const xml = '<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000"><SegmentTemplate media="seg-$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="1" r="1000000"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
    const parsed = new DashToHlsService({}).parseMpd(xml, 'https://example.com/manifest.mpd');
    const segments = parsed.videoReps[0].segments;

    expect(segments).toHaveLength(15);
    expect(segments[0].number).toBe(999987);
    expect(segments[14].number).toBe(1000001);
    expect(segments[0].url).toContain('seg-999987.m4s');
  });

  describe('HLS rendering', () => {
    const reqBase = 'http://192.168.1.50:7000';
    const signed = token(makePayload(NITRO_MPD_URL));

    test('master playlist: audio rendition group + child playlists carrying the token', async () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const master = await svc.buildMaster(makePayload(NITRO_MPD_URL), signed, reqBase);

      expect(master).toContain('#EXT-X-VERSION:7');
      expect(master).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud"');
      expect(master).toContain('LANGUAGE="hin"');
      expect(master).toMatch(/#EXT-X-STREAM-INF:BANDWIDTH=\d+,CODECS="avc1\.640028,mp4a\.40\.2",RESOLUTION=1920x1080,AUDIO="aud"/);
      expect(master).toContain(`${reqBase}/api/dash/video.m3u8?d=${signed}`);
      expect(master).toContain(`${reqBase}/api/dash/audio.m3u8?d=${signed}`);
    });

    test('proxied video playlist: no EXT-X-KEY, init + segments through this server', async () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const repId = svc.parseMpd(nitroXml, NITRO_MPD_URL).videoReps[0].id;

      const playlist = await svc.buildMediaPlaylist(makePayload(NITRO_MPD_URL), 'video', signed, reqBase);

      expect(playlist).not.toContain('#EXT-X-KEY');
      expect(playlist).not.toContain('key.ts');
      expect(playlist).toContain(`#EXT-X-MAP:URI="${reqBase}/api/dash/init.mp4?d=${signed}&k=video&r=${repId}"`);
      expect(playlist).toMatch(/#EXT-X-MEDIA-SEQUENCE:8550/);
      expect(playlist).toMatch(/#EXT-X-TARGETDURATION:2/);

      const segmentUrls = playlist.split('\n').filter((l) => l.startsWith('http'));
      expect(segmentUrls.length).toBeGreaterThan(0);
      for (const url of segmentUrls) {
        expect(url.startsWith(`${reqBase}/api/dash/segment.mp4?d=`)).toBe(true);
        expect(url).toContain('&n=');
        expect(url).not.toContain('aiv-cdn.net');
      }
      expect(segmentUrls[0]).toContain('&n=8550');
    });

    test('direct mode (proxy disabled) keeps the legacy CDN playlist', async () => {
      const svc = makeService({ 'otte.live.fly': nitroXml }, { proxyEnabled: false });
      const playlist = await svc.buildMediaPlaylist(makePayload(NITRO_MPD_URL), 'video', signed, reqBase);

      expect(playlist).toContain('#EXT-X-KEY:METHOD=SAMPLE-AES-CTR');
      expect(playlist).toContain('#EXT-X-MAP:URI="https://otte.live.fly.ww.aiv-cdn.net/');
      for (const url of playlist.split('\n').filter((l) => l.startsWith('http'))) {
        expect(url.startsWith('https://otte.live.fly.ww.aiv-cdn.net/')).toBe(true);
      }
    });

    test('playlist window slides monotonically when the upstream timeline advances', async () => {
      const slidXml = nitroXml.split('d="50000" r="41"').join('d="50000" r="42"');
      expect(slidXml).not.toBe(nitroXml);

      const before = await makeService({ 'otte.live.fly': nitroXml })
        .buildMediaPlaylist(makePayload(NITRO_MPD_URL), 'video', signed, reqBase);
      const after = await makeService({ 'otte.live.fly': slidXml })
        .buildMediaPlaylist(makePayload(NITRO_MPD_URL), 'video', signed, reqBase);

      const seqBefore = Number(before.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]);
      const seqAfter = Number(after.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]);
      expect(seqAfter).toBe(seqBefore + 1);
      expect(after.split('\n').filter((l) => l.includes('&n=')).pop()).toContain('&n=8565');
    });

    test('resolves a segment number that already slid out of the window (paused player)', async () => {
      const svc = makeService({ 'otte.live.fly': nitroXml });
      const repId = svc.parseMpd(nitroXml, NITRO_MPD_URL).videoReps[0].id;

      const target = await svc.resolveSegment(makePayload(NITRO_MPD_URL), 'video', repId, 8520);
      expect(target.url).toContain('cenc_video_6_0_8520.mp4');
    });
  });

  describe('Akamai-style fixed-duration MPD (cbcs, $RepresentationID$, BaseURL)', () => {
    const reqBase = 'http://10.0.0.5:7000';
    const signed = token(makePayload(AKAMAI_MPD_URL));

    function patchAvailability(xml, isoTime) {
      return xml.replace(/availabilityStartTime="[^"]*"/, `availabilityStartTime="${isoTime}"`);
    }

    test('derives the live window from wall clock and maps cbcs → SAMPLE-AES (never proxied)', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace('Z', '+00:00');
      const svc = makeService({ 'akamai-edge.example.com': patchAvailability(akamaiXml, twoHoursAgo) });

      const playlist = await svc.buildMediaPlaylist(makePayload(AKAMAI_MPD_URL), 'video', signed, reqBase);
      const seq = Number(playlist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]);

      expect(playlist).toContain('#EXT-X-KEY:METHOD=SAMPLE-AES,');
      expect(playlist).toContain('#EXT-X-MAP:URI="https://akamai-edge.example.com/dash/live/tennis/video_1080/init.mp4"');
      expect(seq).toBeGreaterThanOrEqual(700000);
      expect(playlist).toMatch(/video_1080\/\d+\.m4s/);
    });

    test('emits nothing before the availability start (pre-live guard)', () => {
      const inOneHour = new Date(Date.now() + 3600 * 1000).toISOString().replace('Z', '+00:00');
      const svc = makeService({ 'akamai-edge.example.com': patchAvailability(akamaiXml, inOneHour) });
      expect(() => svc.parseMpd(patchAvailability(akamaiXml, inOneHour), AKAMAI_MPD_URL))
        .toThrow(/no video representations/i);
    });
  });

  describe('upstream header sanitization (Akamai 403s Dalvik UAs)', () => {
    test('prefers a non-Dalvik UA when both variants are present', () => {
      const headers = new DashToHlsService({})._sanitizeUpstreamHeaders({
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; Pixel 5)'
      });
      expect(headers['User-Agent']).toMatch(/Mozilla/);
    });

    test('replaces a Dalvik-only UA and strips hop-by-hop headers', () => {
      const headers = new DashToHlsService({})._sanitizeUpstreamHeaders({
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13)',
        Host: 'evil.example.com',
        Connection: 'keep-alive',
        Referer: 'https://keep-me.example/'
      });
      expect(headers['User-Agent']).toMatch(/Mozilla/);
      expect(headers.Host).toBeUndefined();
      expect(headers.Connection).toBeUndefined();
      expect(headers.Referer).toBe('https://keep-me.example/');
    });
  });
});

describe('SSRF guard', () => {
  test('blocks private, loopback and metadata hosts', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.169.254',
      '100.64.0.1', '::1', 'fd00::1', 'metadata.google.internal', 'printer.local', 'localhost']) {
      expect(isBlockedHost(host)).toBe(true);
    }
    expect(isBlockedHost('otte.live.fly.ww.aiv-cdn.net')).toBe(false);
  });

  test('rejects a host outside the stream allowlist, credentials, and a protocol downgrade', () => {
    const policy = buildPolicy(NITRO_MPD_URL, ['https://otte.live.fly.ww.aiv-cdn.net/x/init.mp4']);
    expect(() => assertAllowed('https://evil.example.com/x.mp4', policy))
      .toThrow(expect.objectContaining({ code: 'SSRF_HOST_NOT_ALLOWED' }));
    expect(() => assertAllowed('https://user:pass@otte.live.fly.ww.aiv-cdn.net/x.mp4', policy))
      .toThrow(expect.objectContaining({ code: 'SSRF_CREDENTIALS' }));
    expect(() => assertAllowed('http://otte.live.fly.ww.aiv-cdn.net/x.mp4', policy))
      .toThrow(expect.objectContaining({ code: 'SSRF_PROTOCOL' }));
    expect(() => assertAllowed('https://otte.live.fly.ww.aiv-cdn.net/x.mp4', policy)).not.toThrow();
  });

  test('rejects a redirect that leaves the allowlist before serving the body', async () => {
    const policy = buildPolicy(NITRO_MPD_URL);
    const fetcher = async () => ({ ok: true, status: 200, url: 'http://169.254.169.254/latest/meta-data/' });

    await expect(fetchGuarded('https://otte.live.fly.ww.aiv-cdn.net/x.mp4', { policy, fetcher }))
      .rejects.toThrow(expect.objectContaining({ code: 'SSRF_PRIVATE_HOST' }));
  });
});

describe('GET /api/dash/* routes', () => {
  let server;
  let baseUrl;
  let svc;
  let repId;
  let calls;
  let initBuf;
  let segmentBuf;
  let plainSample;

  beforeAll((done) => {
    const xml = readFixture('nitro-live.mpd');
    svc = makeService({ 'otte.live.fly': xml });
    repId = svc.parseMpd(xml, NITRO_MPD_URL).videoReps[0].id;

    initBuf = buildInit();
    plainSample = sample(48, IV8(21), [{ clear: 4, cipher: 44 }]);
    segmentBuf = buildSegment([{ trackId: 1, runs: [[plainSample]] }]);
    calls = [];

    const fetcher = async (url) => {
      calls.push(url);
      if (/\.mpd/.test(url)) return { ok: true, status: 200, url, text: async () => xml };
      if (/init\.mp4/.test(url)) return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(initBuf) };
      if (/\.mp4/.test(url)) return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(segmentBuf) };
      return { ok: false, status: 404, url, text: async () => '' };
    };

    const app = express();
    app.use(dashRouter.createDashRouter(svc, { fetcher, signWith: signer }));
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    if (server) server.close(done);
    else done();
  });

  beforeEach(() => { calls.length = 0; });

  const payload = makePayload(NITRO_MPD_URL);

  test('master playlist is served for a signed token', async () => {
    const res = await fetch(`${baseUrl}/api/dash/index.m3u8?d=${token(payload)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(await res.text()).toContain('#EXT-X-STREAM-INF:');
  });

  test('child playlists carry a freshly signed, expiring token', async () => {
    const res = await fetch(`${baseUrl}/api/dash/video.m3u8?d=${token(payload)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const childToken = body.match(/init\.mp4\?d=([^&]+)&/)[1];
    const verified = verifyPayload(childToken, { signWith: signer });

    expect(verified.ok).toBe(true);
    expect(verified.payload.e).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('init.mp4 returns the uncloaked moov with no protected boxes', async () => {
    const res = await fetch(`${baseUrl}/api/dash/init.mp4?d=${token(payload)}&k=video&r=${repId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.includes(Buffer.from('encv', 'latin1'))).toBe(false);
    expect(body.includes(Buffer.from('sinf', 'latin1'))).toBe(false);
    expect(body.length).toBe(initBuf.length);
  });

  test('segment.mp4 returns decrypted plaintext, not ciphertext', async () => {
    const res = await fetch(`${baseUrl}/api/dash/segment.mp4?d=${token(payload)}&k=video&r=${repId}&n=8550`);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());

    expect(body.length).toBe(segmentBuf.length);
    expect(body.subarray(body.length - 48).equals(plainSample.plain)).toBe(true);
    expect(body.includes(Buffer.from('senc', 'latin1'))).toBe(false);
  });

  test('serves a repeated segment from cache without touching the CDN again', async () => {
    const url = `${baseUrl}/api/dash/segment.mp4?d=${token(payload)}&k=video&r=${repId}&n=8551`;
    expect((await fetch(url)).status).toBe(200);
    const before = calls.filter((c) => c.includes('8551')).length;
    expect(before).toBe(1);

    expect((await fetch(url)).status).toBe(200);
    expect(calls.filter((c) => c.includes('8551')).length).toBe(before);
  });

  test('coalesces two concurrent requests for the same segment into one upstream fetch', async () => {
    const url = `${baseUrl}/api/dash/segment.mp4?d=${token(payload)}&k=video&r=${repId}&n=8552`;
    const [a, b] = await Promise.all([fetch(url), fetch(url)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls.filter((c) => c.includes('8552')).length).toBe(1);
  });

  test('rejects an unsigned (legacy base64) payload with 403 on every endpoint', async () => {
    const legacy = Buffer.from(JSON.stringify(payload)).toString('base64url');
    for (const p of ['index.m3u8', 'video.m3u8', 'audio.m3u8', 'init.mp4', 'segment.mp4']) {
      const res = await fetch(`${baseUrl}/api/dash/${p}?d=${legacy}&k=video&r=${repId}&n=8550`);
      expect(res.status).toBe(403);
    }
  });

  test('rejects a tampered signature with 403', async () => {
    const good = token(payload);
    const [body] = good.split('.');
    const bad = `${body}.${'A'.repeat(43)}`;
    expect((await fetch(`${baseUrl}/api/dash/index.m3u8?d=${bad}`)).status).toBe(403);
  });

  test('rejects an expired token with 403', async () => {
    expect((await fetch(`${baseUrl}/api/dash/index.m3u8?d=${token(payload, { ttlSec: -60 })}`)).status).toBe(403);
  });

  test('rejects a missing token with 400 and a bad segment number with 400', async () => {
    expect((await fetch(`${baseUrl}/api/dash/index.m3u8`)).status).toBe(400);
    const res = await fetch(`${baseUrl}/api/dash/segment.mp4?d=${token(payload)}&k=video&r=${repId}&n=abc`);
    expect(res.status).toBe(400);
  });

  test('a client-supplied u= parameter is ignored (no open proxy)', async () => {
    const res = await fetch(
      `${baseUrl}/api/dash/segment.mp4?d=${token(payload)}&k=video&r=${repId}&n=8553&u=${encodeURIComponent('http://169.254.169.254/')}`
    );
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.includes('169.254'))).toBe(false);
  });

  test('refuses to fetch an MPD on a private host even when the token is signed', async () => {
    const evil = token({ ...payload, mpdUrl: 'http://169.254.169.254/latest/meta-data/x.mpd' });
    const res = await fetch(`${baseUrl}/api/dash/index.m3u8?d=${evil}`);
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.includes('169.254'))).toBe(false);
  });

  test('key.ts still answers for playlists already cached by players', async () => {
    const res = await fetch(`${baseUrl}/api/dash/key.ts?k=${KEY_HEX}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString('hex')).toBe(KEY_HEX);
    expect((await fetch(`${baseUrl}/api/dash/key.ts?k=zzz`)).status).toBe(400);
  });
});
