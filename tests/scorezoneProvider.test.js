'use strict';

const http = require('node:http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const ScoreZoneProvider = require('../src/providers/ScoreZoneProvider');
const scoreZoneRoute = require('../src/routes/scoreZoneStream');
const { tokenCache, playlistCache } = scoreZoneRoute;
const impitClient = require('../src/impitClient');
const MatchAggregator = require('../src/services/MatchAggregator');
const {
  selectSources,
  verifyStreams,
  prewarmSkipProvidersSet
} = require('../src/streams');
const StreamEntity = require('../src/domain/StreamEntity');

const TEST_SECRET = 'scorezone_test_secret_32_characters_long_123';

function mintSourceId(meta, secret = TEST_SECRET) {
  const b64 = Buffer.from(JSON.stringify(meta)).toString('base64url');
  const sig = secret
    ? crypto.createHmac('sha256', secret).update(b64).digest('hex').slice(0, 16)
    : '';
  return `${b64}.${sig}`;
}

describe('ScoreZoneProvider & Manifest Proxy Test Suite', () => {
  let server;
  let baseUrl;
  let provider;
  let safeFetchSpy;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    const app = express();
    app.use(scoreZoneRoute);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    const streamedWasmPool = require('../src/services/StreamedWasmPool');
    await streamedWasmPool.destroy();
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.APP_SECRET = TEST_SECRET;
    delete process.env.SESSION_SECRET;
    tokenCache.clear();
    playlistCache.clear();
    provider = new ScoreZoneProvider();
  });

  afterEach(() => {
    if (safeFetchSpy) {
      safeFetchSpy.mockRestore();
      safeFetchSpy = null;
    }
    process.env = { ...originalEnv };
    tokenCache.clear();
    playlistCache.clear();
  });

  function request(method, path) {
    return new Promise((resolve, reject) => {
      const u = new URL(path, baseUrl);
      const req = http.request(u, { method, headers: { Connection: 'close' } }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  // 1. selectSources allows scorezone
  test('1. selectSources allows scorezone', () => {
    const candidateSources = [
      { source: 'scorezone', id: 'sz-123' },
      { source: 'unknown_scraped_source', id: 'unk-456' }
    ];
    const filtered = selectSources(candidateSources);
    expect(filtered.some(s => s.source === 'scorezone')).toBe(true);
    expect(filtered.find(s => s.source === 'scorezone').id).toBe('sz-123');
  });

  // 2. MatchEntity top-level date & league populated
  test('2. MatchEntity top-level date & league populated', async () => {
    const cannedEsd = '20261102200000'; // 2026-11-02 20:00:00 UTC
    const expectedMs = Date.UTC(2026, 10, 2, 20, 0, 0); // 1793649600000

    safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockImplementation(async (url) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Stages: [
            {
              CompN: 'Premier League',
              Cnm: 'England',
              Snm: 'Regular Season',
              Events: [
                {
                  Eid: '998877',
                  Esd: cannedEsd,
                  T1: [{ Nm: 'Arsenal' }],
                  T2: [{ Nm: 'Chelsea' }]
                }
              ]
            }
          ]
        })
      };
    });

    const matches = await provider.getMatches();
    expect(matches.length).toBeGreaterThan(0);
    const m = matches.find(item => item.id === 'scorezone_998877');
    expect(m).toBeDefined();
    expect(m.date).toBe(String(expectedMs));
    expect(m.league).toBe('Premier League');
    expect(m.title).toBe('Arsenal vs Chelsea');
    expect(m.sources[0].source).toBe('scorezone');
  });

  // 3. mintVerifiedSources preserves stream (behaviorHints.notWebReady === false)
  test('3. mintVerifiedSources preserves stream', async () => {
    const candidate = new StreamEntity({
      name: 'ScoreZone',
      title: 'ScoreZone | Main',
      url: `${baseUrl}/api/scorezone/manifest/invalid_proxy_url/1.m3u8`,
      behaviorHints: { notWebReady: false },
      sourceName: 'scorezone',
      _source: 'scorezone'
    });

    const verified = await verifyStreams([candidate]);
    expect(verified).toHaveLength(1);
    expect(verified[0].url).toBe(candidate.url);
  });

  // 4. proxyFetch timeout enforced per sport
  test('4. proxyFetch timeout enforced per sport', async () => {
    const proxyFetchSpy = jest.spyOn(provider, 'proxyFetch').mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ Stages: [] })
      };
    });

    await provider.getMatches();
    expect(proxyFetchSpy).toHaveBeenCalled();
    const callOpts = proxyFetchSpy.mock.calls[0][1];
    expect(callOpts).toBeDefined();
    expect(callOpts.timeoutMs).toBe(8000);
  });

  // 5. reactive remint on 401/403
  test('5. reactive remint on 401/403', async () => {
    const meta = { h: 'Home', a: 'Away', s: 'football', e: '5566', t: Date.now() };
    const sourceId = mintSourceId(meta);

    let playbackCalls = 0;
    let manifestCalls = 0;

    safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockImplementation(async (url, opts = {}) => {
      if (url.includes('/api/matches/channels')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ key: 'fresh_match_key', channels: [{ id: 'ch1', name: 'Feed 1', locked: false }] })
        };
      }
      if (url.includes('/api/matches/playback')) {
        playbackCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: `https://testscore.pxxl.pro/hls/token_${playbackCalls}/index.m3u8` })
        };
      }
      if (url.includes('testscore.pxxl.pro/hls/token_1/index.m3u8')) {
        manifestCalls++;
        return { ok: false, status: 403, text: async () => 'Forbidden' };
      }
      if (url.includes('testscore.pxxl.pro/hls/token_2/index.m3u8')) {
        manifestCalls++;
        return {
          ok: true,
          status: 200,
          text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg-1.ts\n'
        };
      }
      return { ok: false, status: 404, text: async () => 'Not found' };
    });

    const res = await request('GET', `/api/scorezone/manifest/${encodeURIComponent(sourceId)}/ch1.m3u8`);
    expect(res.status).toBe(200);
    expect(playbackCalls).toBe(2); // First token expired/dead -> reminted fresh token
    expect(manifestCalls).toBe(2);
    expect(res.body).toContain('https://testscore.pxxl.pro/hls/token_2/seg-1.ts');
  });

  // 6. HMAC signature and parameter bounds enforced
  test('6. HMAC signature and parameter bounds enforced', async () => {
    const meta = { h: 'Team A', a: 'Team B', s: 'football', e: '101' };
    const validSourceId = mintSourceId(meta);

    // Tampered payload
    const tampered = validSourceId.slice(0, -4) + 'abcd';
    const resTampered = await request('GET', `/api/scorezone/manifest/${encodeURIComponent(tampered)}/ch1.m3u8`);
    expect(resTampered.status).toBe(403);

    // Missing signature dot
    const resNoDot = await request('GET', `/api/scorezone/manifest/invalidSourceIdNoDot/ch1.m3u8`);
    expect(resNoDot.status).toBe(403);

    // Non-JSON base64
    const badB64 = Buffer.from('not-json').toString('base64url');
    const badSig = crypto.createHmac('sha256', TEST_SECRET).update(badB64).digest('hex').slice(0, 16);
    const resBadB64 = await request('GET', `/api/scorezone/manifest/${encodeURIComponent(`${badB64}.${badSig}`)}/ch1.m3u8`);
    expect(resBadB64.status).toBe(400);
  });

  // 7. disabled by default in aggregator
  test('7. disabled by default in aggregator', () => {
    delete process.env.SCOREZONE_ENABLED;
    const szProviderDisabled = new ScoreZoneProvider();
    const aggDefault = new MatchAggregator({ scorezoneProvider: szProviderDisabled });
    expect(aggDefault.providers.some(p => p && p.name === 'ScoreZone')).toBe(false);

    process.env.SCOREZONE_ENABLED = 'true';
    const szProviderEnabled = new ScoreZoneProvider();
    const aggEnabled = new MatchAggregator({ scorezoneProvider: szProviderEnabled });
    expect(aggEnabled.providers.some(p => p && p.name === 'ScoreZone')).toBe(true);
  });

  // 8. fetches today + tomorrow UTC
  test('8. fetches today + tomorrow UTC', async () => {
    const requestedUrls = [];
    safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockImplementation(async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ Stages: [] })
      };
    });

    await provider.getMatches();

    const now = new Date();
    const toYmd = d => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}${m}${day}`;
    };
    const todayStr = toYmd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    const tomorrowStr = toYmd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));

    expect(requestedUrls.some(u => u.includes(todayStr))).toBe(true);
    expect(requestedUrls.some(u => u.includes(tomorrowStr))).toBe(true);
  });

  // 9. rethrows when all sports fail or schema malformed
  test('9. rethrows when all sports fail or schema malformed', async () => {
    // Total failure: all sport endpoints reject
    safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockImplementation(async () => {
      return { ok: false, status: 500, text: async () => 'Internal Server Error' };
    });

    await expect(provider.getMatches()).rejects.toThrow('ScoreZone livescore sync failed across all sports');

    // Schema malformed: missing Stages property entirely
    safeFetchSpy.mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ invalid: true, error: 'Cloudflare block' })
      };
    });

    await expect(provider.getMatches()).rejects.toThrow('ScoreZone livescore sync failed across all sports');

    // Valid response with 0 stages -> returns [] cleanly without throwing
    safeFetchSpy.mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ Stages: [] })
      };
    });

    await expect(provider.getMatches()).resolves.toEqual([]);
  });

  // 10. source scan validates index.js prefix and regex
  test('10. source scan validates index.js prefix and regex', () => {
    const indexPath = path.resolve(__dirname, '../src/index.js');
    const content = fs.readFileSync(indexPath, 'utf8');

    expect(content).toContain("'/api/scorezone'");
    expect(content).toMatch(/api\\\/leaf\|api\\\/scorezone/);
  });

  // 11. manifest route sets CORS ACAO * and private no-store
  test('11. manifest route sets CORS ACAO * and private no-store', async () => {
    const meta = { h: 'A', a: 'B', s: 'football', e: '201' };
    const sourceId = mintSourceId(meta);

    safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockImplementation(async (url) => {
      if (url.includes('/api/matches/channels')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ key: 'k1', channels: [{ id: 'c1', name: 'Feed' }] })
        };
      }
      if (url.includes('/api/matches/playback')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: 'https://testscore.pxxl.pro/hls/t1/index.m3u8' })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nchunk.ts\n'
      };
    });

    const res = await request('GET', `/api/scorezone/manifest/${encodeURIComponent(sourceId)}/c1.m3u8`);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('private, no-cache, no-store, must-revalidate');
    expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
  });

  // 12. master playlist variants re-enter scorezone route via ?v=
  test('12. master playlist variants re-enter scorezone route via ?v=', async () => {
    const meta = { h: 'A', a: 'B', s: 'football', e: '301' };
    const sourceId = mintSourceId(meta);

    const masterM3u = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'https://testscore.pxxl.pro/hls/t1/360p.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=1280x720',
      'https://testscore.pxxl.pro/hls/t1/720p.m3u8',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="https://testscore.pxxl.pro/hls/t1/audio.m3u8"'
    ].join('\n');

    safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockImplementation(async (url) => {
      if (url.includes('/api/matches/channels')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ key: 'k1', channels: [{ id: 'c1', name: 'Feed' }] })
        };
      }
      if (url.includes('/api/matches/playback')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: 'https://testscore.pxxl.pro/hls/t1/index.m3u8' })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => masterM3u
      };
    });

    const res = await request('GET', `/api/scorezone/manifest/${encodeURIComponent(sourceId)}/c1.m3u8`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(`?v=0`);
    expect(res.body).toContain(`?v=1`);
    expect(res.body).toContain(`?v=2`);
    expect(res.body).not.toContain('/api/manifest');
  });

  // 13. media playlist segments resolve to direct CDN
  test('13. media playlist segments resolve to direct CDN', async () => {
    const meta = { h: 'A', a: 'B', s: 'football', e: '401' };
    const sourceId = mintSourceId(meta);

    const mediaM3u = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXTINF:6.0,',
      'segment-100.ts',
      '#EXTINF:6.0,',
      'segment-101.ts'
    ].join('\n');

    safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockImplementation(async (url) => {
      if (url.includes('/api/matches/channels')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ key: 'k1', channels: [{ id: 'c1', name: 'Feed' }] })
        };
      }
      if (url.includes('/api/matches/playback')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: 'https://cdn.scorezone.edge/live/token/stream.m3u8' })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => mediaM3u
      };
    });

    const res = await request('GET', `/api/scorezone/manifest/${encodeURIComponent(sourceId)}/c1.m3u8`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('https://cdn.scorezone.edge/live/token/segment-100.ts');
    expect(res.body).toContain('https://cdn.scorezone.edge/live/token/segment-101.ts');
    expect(res.body).not.toContain('/api/hlschunk');
  });

  // 14. prewarm skips scorezone by default
  test('14. prewarm skips scorezone by default', () => {
    delete process.env.PREWARM_SKIP_PROVIDERS;
    const skipSet = prewarmSkipProvidersSet();
    expect(skipSet.has('scorezone')).toBe(true);
  });

  // 15. variant SSRF query rejected
  test('15. variant SSRF query rejected', async () => {
    const meta = { h: 'A', a: 'B', s: 'football', e: '501' };
    const sourceId = mintSourceId(meta);

    // SSRF URL in variant parameter
    const resSsrf = await request('GET', `/api/scorezone/manifest/${encodeURIComponent(sourceId)}/c1.m3u8?v=http://attacker.com/evil.m3u8`);
    expect(resSsrf.status).toBe(400);

    // Non-integer string
    const resString = await request('GET', `/api/scorezone/manifest/${encodeURIComponent(sourceId)}/c1.m3u8?v=variant`);
    expect(resString.status).toBe(400);

    // Oversized number (> 2 digits)
    const resLong = await request('GET', `/api/scorezone/manifest/${encodeURIComponent(sourceId)}/c1.m3u8?v=12345`);
    expect(resLong.status).toBe(400);
  });

  // 16. no-secret path returns empty streams
  test('16. no-secret path returns empty streams', async () => {
    delete process.env.APP_SECRET;
    delete process.env.SESSION_SECRET;

    const noSecretProvider = new ScoreZoneProvider();
    const meta = { h: 'A', a: 'B', s: 'football', e: '601' };
    const sourceId = mintSourceId(meta, 'some_secret');

    const streams = await noSecretProvider.resolveStream(sourceId, 'football', 'Match');
    expect(streams).toEqual([]);
  });

  // 17. OPTIONS preflight returns 204 with headers
  test('17. OPTIONS preflight returns 204 with headers', async () => {
    const res = await request('OPTIONS', `/api/scorezone/manifest/anySource/anyChannel.m3u8`);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(res.headers['access-control-allow-headers']).toContain('Range');
    expect(res.headers['access-control-max-age']).toBe('86400');
  });
});
