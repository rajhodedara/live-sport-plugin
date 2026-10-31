jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
const LeafProvider = require('../src/providers/LeafProvider');
const impitClient = require('../src/services/ProviderOutbound');
const { BASE_URL } = require('../src/config');

const TEST_CONFIG = Buffer.from(JSON.stringify({ freeUserId: 'test-user-id.abcdef' }))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

describe('LeafProvider Unit Tests', () => {
  let provider;
  let safeFetchSpy;

  beforeEach(() => {
    // Leaf reads its per-install config from the environment (never hardcoded),
    // so every test has to provide one before the provider is constructed.
    process.env.LEAF_INSTALL_CONFIG = TEST_CONFIG;
    delete process.env.LEAF_API_URL;
    provider = new LeafProvider();
  });

  afterEach(() => {
    if (safeFetchSpy) {
      safeFetchSpy.mockRestore();
      safeFetchSpy = null;
    }
    delete process.env.LEAF_INSTALL_CONFIG;
    delete process.env.LEAF_API_URL;
  });

  describe('buildApiUrl()', () => {
    test('joins the origin and the base64url install config', () => {
      expect(provider.apiUrl).toBe('https://sports.highfly.to/' + TEST_CONFIG);
    });

    test('honours LEAF_API_URL as a whole-base override (the production kill switch)', () => {
      process.env.LEAF_API_URL = 'http://127.0.0.1:9/leaf-disabled';
      const disabled = new LeafProvider();
      expect(disabled.apiUrl).toBe('http://127.0.0.1:9/leaf-disabled');
      expect(disabled.configured).toBe(true);
    });

    test('strips trailing manifest.json from LEAF_API_URL if supplied', () => {
      process.env.LEAF_API_URL = 'https://sports.highfly.to/scoped_id/manifest.json';
      const p = new LeafProvider();
      expect(p.apiUrl).toBe('https://sports.highfly.to/scoped_id');
    });

    test('is unconfigured when no install config is supplied', async () => {
      delete process.env.LEAF_INSTALL_CONFIG;
      const bare = new LeafProvider();
      expect(bare.configured).toBe(false);
      await expect(bare.resolveStream('streamed:x', 'football', 'X vs Y')).resolves.toEqual([]);
    });
  });

  describe('getMatches()', () => {
    test('filters out 24/7 channels and returns only live sporting fixtures', async () => {
      const mockCatalogResponse = {
        metas: [
          {
            id: 'leaf:334343434',
            name: '(FHD) : SKY SPORTS PREMIER LEAGUE',
            category: 'networks'
          },
          {
            id: 'leaf:3443434',
            name: '(4K) : SKY SPORTS F1',
            category: 'networks'
          },
          {
            id: 'streamed:golden-state-warriors-vs-memphis-grizzlies-2601690',
            name: 'Golden State Warriors vs Memphis Grizzlies',
            category: 'basketball'
          },
          {
            id: 'streamed:arsenal-vs-chelsea-24001',
            name: 'Arsenal vs Chelsea',
            category: 'football'
          }
        ]
      };

      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockCatalogResponse
      });

      const matches = await provider.getMatches();

      // Only the 2 live fixtures should be returned; the 2 24/7 channels must be omitted
      expect(matches).toHaveLength(2);
      expect(matches.map(m => m.title)).toEqual([
        'Golden State Warriors vs Memphis Grizzlies',
        'Arsenal vs Chelsea'
      ]);

      // Check MatchEntity structure
      const match1 = matches[0];
      expect(match1.id).toBe('leaf_golden-state-warriors-vs-memphis-grizzlies-2601690');
      expect(match1.aliasIds).toContain('streamed:golden-state-warriors-vs-memphis-grizzlies-2601690');
      expect(match1.category).toBe('basketball');
      expect(match1.status).toBe('live');
      expect(match1.sources).toHaveLength(1);
      expect(match1.sources[0]).toEqual({
        source: 'leaf',
        id: 'streamed:golden-state-warriors-vs-memphis-grizzlies-2601690',
        name: 'Golden State Warriors vs Memphis Grizzlies'
      });
    });

    test('returns empty array when network fails', async () => {
      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockRejectedValue(new Error('Network error'));
      const matches = await provider.getMatches();
      expect(matches).toEqual([]);
    });

    test('returns empty array when upstream returns non-200 status', async () => {
      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: false,
        status: 502
      });
      const matches = await provider.getMatches();
      expect(matches).toEqual([]);
    });
  });

  describe('resolveStream()', () => {
    test('strictly isolates papacito.cfd streams and preserves upstream signed playback token', async () => {
      const mockStreamsResponse = {
        streams: [
          {
            name: 'Leaf (Strong) · US: NBC SPORTS BAY AREA (A)...',
            title: '1920x1080 · Stereo · ~6.2 Mbps · Leaf (Strong) · small delay',
            url: 'https://papacito.cfd/m3u/1820218/live.m3u8?ft=temporary_jwt_token',
            behaviorHints: { notWebReady: true }
          },
          {
            name: '🔒 Leaf (Strong) · (4K) : SKY SPORTS F1',
            title: '3840x2160 · Stereo · ~13.2 Mbps · Leaf (Strong) · 🔒 Upgrade to Premium',
            url: 'https://www.google.com',
            behaviorHints: { notWebReady: true }
          },
          {
            name: 'Streamed.su · Stream 1',
            title: 'English · 720p',
            url: 'https://embed.st/embed/golf/2549/1',
            behaviorHints: { notWebReady: true }
          },
          {
            name: 'Leaf (Strong) · GSW Feed',
            title: '1280x720 · Stereo · ~3.5 Mbps · Leaf (Strong)',
            url: 'https://papacito.cfd/m3u/1413072/live.m3u8?ft=another_jwt',
            behaviorHints: { notWebReady: true }
          }
        ]
      };

      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockStreamsResponse
      });

      const streams = await provider.resolveStream('streamed:golden-state-warriors-vs-memphis-grizzlies-2601690', 'basketball', 'Warriors vs Grizzlies');

      // Must strictly filter out google.com (paywall redirect) and embed.st (streamed.su)
      expect(streams).toHaveLength(2);

      // Stream 1: 1080p FHD
      expect(streams[0].url).toBe(`${BASE_URL}/api/manifest?url=${encodeURIComponent('https://papacito.cfd/m3u/1820218/live.m3u8?ft=temporary_jwt_token')}&referer=${encodeURIComponent('https://sports.highfly.to/')}&origin=${encodeURIComponent('https://sports.highfly.to')}`);
      expect(streams[0].resolution).toBe('1080p');
      expect(streams[0].quality).toBe('FHD');
      expect(streams[0].bitrate).toBe('6.2 Mbps');
      expect(streams[0].name).toBe('Leaf [FHD]');
      expect(streams[0].title).toBe('(US: NBC SPORTS BAY AREA) FHD');
      expect(streams[0].behaviorHints.notWebReady).toBe(false);
      expect(streams[0]._source).toBe('leaf');

      // Stream 2: 720p HD
      expect(streams[1].url).toBe(`${BASE_URL}/api/manifest?url=${encodeURIComponent('https://papacito.cfd/m3u/1413072/live.m3u8?ft=another_jwt')}&referer=${encodeURIComponent('https://sports.highfly.to/')}&origin=${encodeURIComponent('https://sports.highfly.to')}`);
      expect(streams[1].resolution).toBe('720p');
      expect(streams[1].quality).toBe('HD');
      expect(streams[1].bitrate).toBe('3.5 Mbps');
      expect(streams[1].name).toBe('Leaf [HD]');
      expect(streams[1].title).toBe('(GSW Feed) HD');
      expect(streams[1].behaviorHints.notWebReady).toBe(false);
      expect(streams[1]._source).toBe('leaf');
    });

    test('drops the upstream install-nag stub instead of surfacing it as a stream', async () => {
      // This is the real payload upstream returns today: one fake stream whose
      // url is the configure page. It must never reach a player.
      const nag = {
        streams: [
          {
            name: 'Please reinstall the addon',
            title: 'We have updated our free addon to improve service quality.\nPlease visit sports.highfly.to/configure\nto get a new addon link.',
            url: 'https://sports.highfly.to/configure',
            behaviorHints: { notWebReady: true }
          }
        ]
      };

      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => nag
      });

      const streams = await provider.resolveStream('streamed:test-fixture', 'basketball', 'Test vs Match');
      expect(streams).toEqual([]);
    });

    test('skips an unsigned papacito URL rather than minting a token locally', async () => {
      const mockStreamsResponse = {
        streams: [
          {
            name: 'Leaf · Test Stream',
            title: '1920x1080 · Stereo · ~6.2 Mbps',
            url: 'https://papacito.cfd/m3u/999888/live.m3u8',
            behaviorHints: { notWebReady: true }
          }
        ]
      };
      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockStreamsResponse
      });

      const streams = await provider.resolveStream('streamed:test-fixture', 'football', 'Test vs Match');
      expect(streams).toEqual([]);
    });

    test('returns empty array when upstream stream resolution fails', async () => {
      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockRejectedValue(new Error('Connection reset'));
      const streams = await provider.resolveStream('streamed:invalid-match', 'football', 'Invalid Match');
      expect(streams).toEqual([]);
    });

    test('returns empty array when no source ID is provided', async () => {
      const streams = await provider.resolveStream('', 'football', 'Invalid Match');
      expect(streams).toEqual([]);
    });

    test('resolves streams when initialized via LEAF_API_URL', async () => {
      delete process.env.LEAF_INSTALL_CONFIG;
      process.env.LEAF_API_URL = 'https://sports.highfly.to/scoped_config_base';
      const customProvider = new LeafProvider();
      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          streams: [
            {
              name: 'Leaf (Strong) · Court 1',
              title: '1920x1080 · ~5.0 Mbps',
              url: 'https://papacito.cfd/m3u/12345/live.m3u8?ft=token_val'
            }
          ]
        })
      });
      const res = await customProvider.resolveStream('streamed:tennis-match', 'tennis', 'Match');
      expect(res).toHaveLength(1);
      expect(res[0].url).toContain('/api/manifest?url=');
      expect(res[0].url).toContain(encodeURIComponent('https://papacito.cfd/m3u/12345/live.m3u8?ft=token_val'));
    });
  });
});
