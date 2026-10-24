const LeafProvider = require('../src/providers/LeafProvider');
const impitClient = require('../src/impitClient');

describe('LeafProvider Unit Tests', () => {
  let provider;
  let safeFetchSpy;

  beforeEach(() => {
    provider = new LeafProvider();
  });

  afterEach(() => {
    if (safeFetchSpy) {
      safeFetchSpy.mockRestore();
    }
  });

  describe('getMatches()', () => {
    test('ingests live sporting fixtures and 24/7 sports channels', async () => {
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

      // All 4 items should be returned (2 channels + 2 live fixtures)
      expect(matches).toHaveLength(4);

      // Verify 24/7 channel structure
      const channel1 = matches[0];
      expect(channel1.category).toBe('networks');
      expect(channel1.date).toBe('');
      expect(channel1.popular).toBe('1');
      expect(channel1.title).toBe('Sky Sports Premier League');
      expect(channel1.channelIdentityKey).toBe('skysportpremierleague');
      expect(channel1.sources).toHaveLength(1);
      expect(channel1.sources[0].source).toBe('leaf');
      expect(channel1.sources[0].id).toBe('leaf:334343434');

      const channel2 = matches[1];
      expect(channel2.category).toBe('networks');
      expect(channel2.title).toBe('Sky Sports F1');
      expect(channel2.channelIdentityKey).toBe('skysportf1');

      // Verify live fixture structure
      const match1 = matches[2];
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

      const match2 = matches[3];
      expect(match2.title).toBe('Arsenal vs Chelsea');
      expect(match2.category).toBe('football');
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
    test('strictly isolates papacito.cfd streams and preserves dynamic signed JWT tokens', async () => {
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

      // Stream 1: 1080p FHD preserving dynamic signed JWT
      expect(streams[0].url).toBe('https://papacito.cfd/m3u/1820218/live.m3u8?ft=temporary_jwt_token');
      expect(streams[0].resolution).toBe('1080p');
      expect(streams[0].quality).toBe('FHD');
      expect(streams[0].bitrate).toBe('6.2 Mbps');
      expect(streams[0].name).toBe('Leaf [FHD]');
      expect(streams[0].title).toBe('(US: NBC SPORTS BAY AREA) FHD');
      expect(streams[0].behaviorHints.notWebReady).toBe(true);
      expect(streams[0]._source).toBe('leaf');

      // Stream 2: 720p HD preserving dynamic signed JWT
      expect(streams[1].url).toBe('https://papacito.cfd/m3u/1413072/live.m3u8?ft=another_jwt');
      expect(streams[1].resolution).toBe('720p');
      expect(streams[1].quality).toBe('HD');
      expect(streams[1].bitrate).toBe('3.5 Mbps');
      expect(streams[1].name).toBe('Leaf [HD]');
      expect(streams[1].title).toBe('(GSW Feed) HD');
      expect(streams[1].behaviorHints.notWebReady).toBe(true);
      expect(streams[1]._source).toBe('leaf');
    });

    test('falls back to master token if upstream returns bare URL without tokens', async () => {
      const mockStreamsResponse = {
        streams: [
          {
            name: 'Leaf (Strong) · Raw Channel',
            title: '1920x1080 · ~5.0 Mbps',
            url: 'https://papacito.cfd/m3u/bare_channel_1/live.m3u8',
            behaviorHints: { notWebReady: true }
          }
        ]
      };

      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockStreamsResponse
      });

      const streams = await provider.resolveStream('leaf:bare_channel_1', 'networks', 'Raw Channel');
      expect(streams).toHaveLength(1);
      expect(streams[0].url).toBe(`https://papacito.cfd/m3u/bare_channel_1/live.m3u8?token=${provider.masterToken}`);
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
  });
});
