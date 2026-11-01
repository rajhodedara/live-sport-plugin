const LeafProvider = require('../src/providers/LeafProvider');
const impitClient = require('../src/impitClient');
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

      // Filters out non-papacito (embed.st) and unlocks paywalled Sky Sports F1 via channel slug fallback
      expect(streams).toHaveLength(3);

      // Stream 1: 1080p FHD
      expect(streams[0].url).toBe(`${BASE_URL}/api/leaf/manifest.m3u8?url=${encodeURIComponent('https://papacito.cfd/m3u/1820218/live.m3u8?ft=temporary_jwt_token')}`);
      expect(streams[0].resolution).toBe('1080p');
      expect(streams[0].quality).toBe('FHD');
      expect(streams[0].bitrate).toBe('6.2 Mbps');
      expect(streams[0].name).toBe('Leaf [FHD]');
      expect(streams[0].title).toBe('(US: NBC SPORTS BAY AREA) FHD');
      expect(streams[0].behaviorHints.notWebReady).toBe(false);
      expect(streams[0].behaviorHints.proxyHeaders.request['Referer']).toBe('https://sports.highfly.to/');
      expect(streams[0].behaviorHints.proxyHeaders.request['Origin']).toBe('https://sports.highfly.to');
      expect(streams[0]._source).toBe('leaf');

      // Stream 2: 4K UHD (Unlocked Premium Feed)
      expect(streams[1].resolution).toBe('4K');
      expect(streams[1].quality).toBe('4K UHD');
      expect(streams[1].name).toBe('Leaf [4K UHD]');
      expect(streams[1].title).toBe('(SKY SPORTS F1) 4K UHD');

      // Stream 3: 720p HD
      expect(streams[2].url).toBe(`${BASE_URL}/api/leaf/manifest.m3u8?url=${encodeURIComponent('https://papacito.cfd/m3u/1413072/live.m3u8?ft=another_jwt')}`);
      expect(streams[2].resolution).toBe('720p');
      expect(streams[2].quality).toBe('HD');
      expect(streams[2].bitrate).toBe('3.5 Mbps');
      expect(streams[2].name).toBe('Leaf [HD]');
      expect(streams[2].title).toBe('(GSW Feed) HD');
      expect(streams[2].behaviorHints.notWebReady).toBe(false);
      expect(streams[2]._source).toBe('leaf');
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
      expect(res[0].url).toContain('/api/leaf/manifest.m3u8?url=');
      expect(res[0].url).toContain(encodeURIComponent('https://papacito.cfd/m3u/12345/live.m3u8?ft=token_val'));
    });
  });

  describe('Broadcaster Normalization & Token Matching', () => {
    test('normalizes Unicode superscripts (RAW, HD, FHD, DE)', () => {
      expect(LeafProvider.normalizeBroadcasterName('RO: DIGI SPORT 1 ᴿᴬᵂ')).toBe('digi sport 1');
      expect(LeafProvider.normalizeBroadcasterName('CZ: ONEPLAY SPORT 1 ᴴᴰ')).toBe('oneplay sport 1');
      expect(LeafProvider.normalizeBroadcasterName('CH: BLUE SPORT D1 ᴅᴇ ғʜᴅ')).toBe('blue sport d1');
    });

    test('normalizes network and country prefixes (VIP:, UK:, RO:, TV:, NOW:, 4K:)', () => {
      expect(LeafProvider.normalizeBroadcasterName('VIP: PREMIER SPORT 2 ᴿᴬᵂ')).toBe('premier sport 2');
      expect(LeafProvider.normalizeBroadcasterName('UK: PREMIER SPORT 2 ᴿᴬᵂ')).toBe('premier sport 2');
      expect(LeafProvider.normalizeBroadcasterName('TV: DAZN LALIGA 2 ᴿᴬᵂ')).toBe('dazn laliga 2');
      expect(LeafProvider.normalizeBroadcasterName('NOW: SKY SPORTS MAIN EVENT ᴿᴬᵂ')).toBe('sky sports main event');
      expect(LeafProvider.normalizeBroadcasterName('4K: SKY SPORTS MAIN EVENTS')).toBe('sky sports main events');
    });

    test('removes quality labels without damaging numeric or word broadcaster parts', () => {
      expect(LeafProvider.normalizeBroadcasterName('ONEPLAY SPORT 1 HD')).toBe('oneplay sport 1');
      expect(LeafProvider.normalizeBroadcasterName('DAZN 1 FAST+ FHD')).toBe('dazn 1 fast+');
      expect(LeafProvider.normalizeBroadcasterName('PREMIER SPORTS 2 4K UHD')).toBe('premier sports 2');
    });

    test('deterministic token matching prevents false substring collision', () => {
      // "sky sport 10" must not match "sky sport 1"
      expect(provider._findChannelSlug('SKY SPORT 10')).toBeNull();
      // "sky sport 1" must match "1968680"
      expect(provider._findChannelSlug('SKY SPORT 1')).toBe('1968680');
      // "sky sport 2" must match "1968679"
      expect(provider._findChannelSlug('SKY SPORT 2')).toBe('1968679');
    });

    test('resolves newly verified Premier Sports 2 mapping (1562519)', () => {
      expect(provider._findChannelSlug('UK: PREMIER SPORT 2 ᴿᴬᵂ')).toBe('1562519');
      expect(provider._findChannelSlug('PREMIER SPORTS 2')).toBe('1562519');
    });

    test('cleans display label preserving broadcaster name and stripping junk', () => {
      expect(LeafProvider.cleanDisplayLabel('🔒 Leaf (Strong) · UK: PREMIER SPORT 2 ᴿᴬᵂ')).toBe('UK: PREMIER SPORT 2 ᴿᴬᵂ');
      expect(LeafProvider.cleanDisplayLabel('Leaf (Strong) · (A) SKY SPORT 1 RAW')).toBe('SKY SPORT 1 RAW');
      expect(LeafProvider.cleanDisplayLabel('Leaf (Strong) · CH: BLUE SPORT D1 ᴅᴇ ғʜᴅ')).toBe('CH: BLUE SPORT D1 ᴅᴇ ғʜᴅ');
    });
  });

  describe('3-Tier Slug Resolution Architecture', () => {
    test('Tier 1: ingests and resolves dynamic catalog channels', () => {
      provider.catalogChannelMap.set('custom regional network', 'slug-reg-999');
      expect(provider._findChannelSlug('CUSTOM REGIONAL NETWORK')).toBe('slug-reg-999');
      // Static mapping takes precedence
      provider.catalogChannelMap.set('premier sports 2', 'fake-slug');
      expect(provider._findChannelSlug('PREMIER SPORTS 2')).toBe('1562519');
    });

    test('Tier 3: learns broadcaster-to-slug mapping from unredacted streams and respects TTL', () => {
      provider.learnedChannelMap.set('learned sports stream', {
        slug: 'slug-learned-123',
        timestamp: Date.now()
      });
      expect(provider._findChannelSlug('LEARNED SPORTS STREAM')).toBe('slug-learned-123');

      // Expired learned mapping is ignored
      provider.learnedChannelMap.set('expired sports stream', {
        slug: 'slug-expired-999',
        timestamp: Date.now() - 25 * 60 * 60 * 1000 // 25 hours ago
      });
      expect(provider._findChannelSlug('EXPIRED SPORTS STREAM')).toBeNull();
    });

    test('preserves Unicode RAW tag in StreamEntity metadata', async () => {
      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          streams: [
            {
              name: 'Leaf (Strong) · RO: DIGI SPORT 1 ᴿᴬᵂ',
              title: '1920x1080 · Stereo · ~9.5 Mbps · Leaf (Strong)',
              url: 'https://papacito.cfd/m3u/1562920/live.m3u8?ft=valid_jwt'
            }
          ]
        })
      });

      const res = await provider.resolveStream('streamed:fixture-test', 'football', 'Match');
      expect(res).toHaveLength(1);
      expect(res[0].name).toBe('Leaf [FHD RAW]');
      expect(res[0].title).toBe('(RO: DIGI SPORT 1 ᴿᴬᵂ) FHD RAW');
    });
  });

  describe('Multi-Catalog Discovery & Deduplication', () => {
    test('deduplicates matches across multiple catalogs and harvests leaf channels', async () => {
      safeFetchSpy = jest.spyOn(impitClient, 'safeFetch').mockImplementation(async (url) => {
        if (url.includes('sports_live.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              metas: [
                { id: 'leaf:now-34334', name: '(FHD) : SKY SPORTS PREMIER LEAGUE' },
                { id: 'streamed:shared-match-1', name: 'Arsenal vs Chelsea', category: 'football' }
              ]
            })
          };
        }
        if (url.includes('sports_today.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              metas: [
                { id: 'streamed:shared-match-1', name: 'Arsenal vs Chelsea', category: 'football' },
                { id: 'streamed:today-match-2', name: 'Real Madrid vs Barcelona', category: 'football' }
              ]
            })
          };
        }
        if (url.includes('sports_football.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              metas: [
                { id: 'streamed:today-match-2', name: 'Real Madrid vs Barcelona', category: 'football' },
                { id: 'streamed:football-match-3', name: 'Milan vs Inter', category: 'football' }
              ]
            })
          };
        }
        return { ok: false, status: 404 };
      });

      const matches = await provider.getMatches();

      // Exactly 3 unique matches must be returned (no duplicates across the 3 catalogs)
      expect(matches).toHaveLength(3);
      expect(matches.map(m => m.id)).toEqual([
        'leaf_shared-match-1',
        'leaf_today-match-2',
        'leaf_football-match-3'
      ]);

      // Dynamic catalog channel leaf:now-34334 must be harvested into catalogChannelMap
      expect(provider.catalogChannelMap.get('sky sports premier league')).toBe('now-34334');
    });
  });
});
