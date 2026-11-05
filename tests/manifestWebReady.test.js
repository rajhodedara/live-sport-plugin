'use strict';

jest.mock('../src/impitClient', () => ({
  safeFetch: jest.fn(),
  isImpitAvailable: () => false,
  getImpit: () => null,
}));

const { safeFetch } = require('../src/impitClient');
const container = require('../src/container');
const { handleStream } = require('../src/streams');

const M3U8_FIXTURE = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXTINF:4.0,\nseg0.ts\n';

describe('Manifest Proxy Web-Ready Stream Normalization (Issue #42)', () => {
  const testMatches = [
    {
      id: 'test_manifest_event_proxied',
      title: 'Arsenal vs Chelsea',
      category: 'football',
      sources: [
        { source: 'daddylive', id: 'dlv_1', name: 'DaddyLive 1' }
      ]
    },
    {
      id: 'test_manifest_event_direct',
      title: 'Lakers vs Warriors',
      category: 'basketball',
      sources: [
        { source: 'daddylive', id: 'dlv_2', name: 'DaddyLive 2' }
      ]
    },
    {
      id: 'test_manifest_event_ppvst',
      title: 'Man City vs Liverpool',
      category: 'football',
      sources: [
        { source: 'ppvst', id: 'ppv_1', name: 'PPV 1' }
      ]
    }
  ];

  beforeEach(() => {
    safeFetch.mockReset();
    safeFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => M3U8_FIXTURE
    });

    const resolveCache = container.resolve('streamResolveCache');
    if (resolveCache) {
      if (resolveCache.entries && typeof resolveCache.entries.clear === 'function') resolveCache.entries.clear();
      if (resolveCache.inFlight && typeof resolveCache.inFlight.clear === 'function') resolveCache.inFlight.clear();
      if (resolveCache._cache && typeof resolveCache._cache.clear === 'function') resolveCache._cache.clear();
    }

    container.resolve('matchAggregator').syncMatches = async () => [];
    container.resolve('cronService').syncing = true;
    container.resolve('cacheService').setMatches(testMatches);
  });

  test('enforces notWebReady: false and preserves bounded proxyHeaders for DaddyLive /api/manifest streams', async () => {
    jest.spyOn(container.resolve('daddyLiveProvider'), 'resolveStream').mockResolvedValue([
      {
        name: 'DaddyLive',
        title: 'DaddyLive Stream 1',
        url: 'https://nuviosports.xyz/api/manifest?url=https%3A%2F%2Fds169.bluetier.top%2FbeIN%2Findex.m3u8&referer=https%3A%2F%2Fwideiptv.top%2F&origin=https%3A%2F%2Fwideiptv.top',
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'Referer': 'https://wideiptv.top/',
              'Origin': 'https://wideiptv.top',
              'Cookie': 'secret=123'
            }
          }
        },
        _source: 'daddylive'
      }
    ]);

    const res = await handleStream('tv', 'nuvio_sport_test_manifest_event_proxied', {});
    expect(res).toBeDefined();
    expect(Array.isArray(res.streams)).toBe(true);

    const dlv = res.streams.find(s => s.url && s.url.includes('/api/manifest'));
    expect(dlv).toBeDefined();
    expect(dlv.behaviorHints.notWebReady).toBe(false);
    expect(dlv.behaviorHints.proxyHeaders).toEqual({
      request: {
        'Referer': 'https://wideiptv.top/',
        'Origin': 'https://wideiptv.top'
      }
    });
  });

  test('removes proxyHeaders for non-whitelisted /api/manifest streams', async () => {
    jest.spyOn(container.resolve('ppvStProvider'), 'resolveStream').mockResolvedValue([
      {
        name: 'PPV.st',
        title: 'PPV Stream 1',
        url: 'https://nuviosports.xyz/api/manifest?url=https%3A%2F%2Fcdn.example.com%2Findex.m3u8',
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'Referer': 'https://example.com/',
              'Origin': 'https://example.com'
            }
          }
        },
        _source: 'ppvst'
      }
    ]);

    const res = await handleStream('tv', 'nuvio_sport_test_manifest_event_ppvst', {});
    expect(res).toBeDefined();
    const st = res.streams.find(s => s.url && s.url.includes('/api/manifest'));
    expect(st).toBeDefined();
    expect(st.behaviorHints.notWebReady).toBe(false);
    expect(st.behaviorHints.proxyHeaders).toBeUndefined();
  });

  test('enforces notWebReady: false and sets proxyHeaders for direct unproxied m3u8 streams', async () => {
    jest.spyOn(container.resolve('daddyLiveProvider'), 'resolveStream').mockResolvedValue([
      {
        name: 'DaddyLive',
        title: 'DaddyLive Direct',
        url: 'https://direct.daddylive.st/live/stream.m3u8',
        behaviorHints: {},
        _source: 'daddylive'
      }
    ]);

    const res = await handleStream('tv', 'nuvio_sport_test_manifest_event_direct', {});
    expect(res).toBeDefined();
    expect(Array.isArray(res.streams)).toBe(true);

    const direct = res.streams.find(s => s.url && s.url.includes('direct.daddylive.st'));
    expect(direct).toBeDefined();
    expect(direct.behaviorHints.notWebReady).toBe(false);
    expect(direct.behaviorHints.proxyHeaders).toBeDefined();
    expect(direct.behaviorHints.proxyHeaders.request.Referer).toBe('https://thedaddy.pk/');
  });
});
