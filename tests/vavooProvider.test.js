'use strict';

const VavooProvider = require('../src/providers/VavooProvider');
const { VavooTokenManager, VAVOO_BASE_SITES } = require('../src/providers/VavooProvider');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const MatchAggregator = require('../src/services/MatchAggregator');

describe('VavooProvider & Dual-Ping Architecture', () => {
  const originalEnv = process.env.VAVOO_ENABLED;

  afterEach(() => {
    process.env.VAVOO_ENABLED = originalEnv;
  });

  describe('Feature Flag & getMatches', () => {
    it('returns empty array when VAVOO_ENABLED is unset or false', async () => {
      delete process.env.VAVOO_ENABLED;
      const provider = new VavooProvider();
      const matches = await provider.getMatches();
      expect(matches).toEqual([]);

      process.env.VAVOO_ENABLED = 'false';
      const matchesFalse = await provider.getMatches();
      expect(matchesFalse).toEqual([]);
    });

    it('returns verified 24/7 channels as MatchEntity items when VAVOO_ENABLED=true', async () => {
      process.env.VAVOO_ENABLED = 'true';
      const provider = new VavooProvider();
      const matches = await provider.getMatches();

      expect(Array.isArray(matches)).toBe(true);
      expect(matches.length).toBeGreaterThan(1700);

      // Spot check first channel
      const first = matches[0];
      expect(first).toBeInstanceOf(MatchEntity);
      expect(first.category).toBe('networks');
      expect(first.date === '0' || first.date === '').toBe(true);
      expect(first.id).toMatch(/^vavoo_ch_/);
      expect(first.sources.length).toBeGreaterThanOrEqual(1);
      expect(first.sources[0].source).toBe('vavoo');
      expect(first.sources[0].type).toBe('channel');

      // Verify UK sports channels exist in the catalog
      const ukSports = matches.filter(m => m.league === 'United Kingdom' && /tnt sport|sky sport/i.test(m.title));
      expect(ukSports.length).toBeGreaterThan(10);

      // Verify 4K channels exist in the catalog
      const fourK = matches.filter(m => /4k|uhd/i.test(m.title));
      expect(fourK.length).toBeGreaterThanOrEqual(70);

      // Regional, language, quality, and backup variants are alternatives on
      // one Cartoon Network card rather than duplicate catalog entries.
      const cartoonNetwork = matches.filter(m => m.title === 'CARTOON NETWORK');
      expect(cartoonNetwork).toHaveLength(1);
      expect(cartoonNetwork[0].league).toBe('Multi-region');
      expect(cartoonNetwork[0].sources.length).toBeGreaterThanOrEqual(20);
      expect(cartoonNetwork[0].sources.map(s => s.group)).toEqual(expect.arrayContaining(['Arabia', 'France', 'Germany', 'Italy', 'United Kingdom']));
    });
  });

  describe('Dual-Ping Token Manager', () => {
    it('uses primary vypn.net ping when available', async () => {
      const mockPayload = Buffer.from(JSON.stringify({
        data: JSON.stringify({ validUntil: Date.now() + 15 * 60 * 1000 })
      })).toString('base64');

      const mockFetch = jest.fn().mockImplementation((url) => {
        if (url.includes('vypn.net')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ addonSig: mockPayload })
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const tm = new VavooTokenManager();
      const sig = await tm.getOrRefreshSig(mockFetch);

      expect(sig).toBe(mockPayload);
      expect(tm.activeSource).toBe('vypn.net');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('vypn.net');
    });

    it('fails over to lokke.app if vypn.net throws or times out', async () => {
      const mockPayloadLokke = Buffer.from(JSON.stringify({
        data: JSON.stringify({ validUntil: Date.now() + 15 * 60 * 1000 })
      })).toString('base64');

      const mockFetch = jest.fn().mockImplementation((url) => {
        if (url.includes('vypn.net')) {
          return Promise.reject(new Error('ETIMEDOUT primary'));
        }
        if (url.includes('lokke.app')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ addonSig: mockPayloadLokke })
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const tm = new VavooTokenManager();
      const sig = await tm.getOrRefreshSig(mockFetch);

      expect(sig).toBe(mockPayloadLokke);
      expect(tm.activeSource).toBe('lokke.app');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain('vypn.net');
      expect(mockFetch.mock.calls[1][0]).toContain('lokke.app');
    });

    it('reuses in-memory cached signature when valid without refetching', async () => {
      const mockPayload = Buffer.from(JSON.stringify({
        data: JSON.stringify({ validUntil: Date.now() + 15 * 60 * 1000 })
      })).toString('base64');

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ addonSig: mockPayload })
      });

      const tm = new VavooTokenManager();
      const sig1 = await tm.getOrRefreshSig(mockFetch);
      const sig2 = await tm.getOrRefreshSig(mockFetch);

      expect(sig1).toBe(mockPayload);
      expect(sig2).toBe(mockPayload);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Cached!
    });
  });

  describe('resolveStream & Zero Bandwidth Compliance', () => {
    it('returns empty array when VAVOO_ENABLED is not true', async () => {
      delete process.env.VAVOO_ENABLED;
      const provider = new VavooProvider();
      const streams = await provider.resolveStream('https://vavoo.to/vavoo-iptv/play/123', 'networks', 'TNT Sport 1');
      expect(streams).toEqual([]);
    });

    it('resolves stream and emits StreamEntity with native behaviorHints.proxyHeaders', async () => {
      process.env.VAVOO_ENABLED = 'true';

      const mockTokenManager = {
        getOrRefreshSig: jest.fn().mockResolvedValue('test_valid_signature_123')
      };

      const provider = new VavooProvider({ tokenManager: mockTokenManager });

      const fakeCdnUrl = 'https://vavoo.to/live2/play/650428399516358385ad3/index.m3u8?n=1&b=5&sig=fake_sig';
      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ url: fakeCdnUrl }])
      });

      const streams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/650428399516358385ad3',
        'networks',
        'TNT SPORT 1',
        { id: 'https://vavoo.to/vavoo-iptv/play/650428399516358385ad3', group: 'United Kingdom', language: 'en', is4k: false }
      );

      expect(streams.length).toBe(1);
      const stream = streams[0];
      expect(stream).toBeInstanceOf(StreamEntity);
      expect(stream.name).toBe('Vavoo');
      expect(stream.url).toContain('/api/manifest?url=');
      expect(stream.url).toContain(encodeURIComponent(fakeCdnUrl));
      expect(stream.url).toContain('referer=' + encodeURIComponent('https://vavoo.to/'));
      expect(stream.resolution).toBe('1080p');
      expect(stream.behaviorHints).toBeDefined();
      expect(stream.behaviorHints.notWebReady).toBe(true);
      expect(stream.behaviorHints.proxyHeaders.request).toEqual({
        'User-Agent': 'MediaHubMX/2',
        'Referer': 'https://vavoo.to/'
      });
    });

    it('properly formats 4K resolution and high priority score for 4K channels', async () => {
      process.env.VAVOO_ENABLED = 'true';

      const mockTokenManager = {
        getOrRefreshSig: jest.fn().mockResolvedValue('sig4k')
      };

      const provider = new VavooProvider({ tokenManager: mockTokenManager });
      const fakeCdnUrl = 'https://vavoo.to/live2/play/4k123/index.m3u8?sig=4k';
      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ url: fakeCdnUrl })
      });

      const streams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/4k123',
        'networks',
        'CANAL+ SPORT 4K',
        { id: 'https://vavoo.to/vavoo-iptv/play/4k123', group: 'France', language: 'fr', is4k: true }
      );

      expect(streams.length).toBe(1);
      expect(streams[0].resolution).toBe('4K');
      expect(streams[0].score).toBe(95);
      expect(streams[0].title).toContain('[4K UHD]');
    });
  });

  describe('MatchAggregator Channel-Fixture Isolation', () => {
    it('isolates vavoo_ch_ continuous channels from discrete fixtures', () => {
      const aggregator = new MatchAggregator();

      const vavooChannel = {
        id: 'vavoo_ch_sky-sports-premier-league-uk',
        title: 'SKY SPORT PREMIER LEAGUE',
        category: 'networks',
        date: '0'
      };

      const fixture = {
        id: 'spk_12345',
        title: 'Arsenal vs Chelsea',
        category: 'football',
        date: String(Date.now() + 3600000)
      };

      const preChannel = aggregator._precompute(vavooChannel);
      const preFixture = aggregator._precompute(fixture);

      expect(preChannel.isChannel).toBe(true);
      expect(preFixture.isChannel).toBe(false);

      // Verify they never merge
      expect(aggregator.isSameEvent(vavooChannel, fixture)).toBe(false);
    });

    it('isolates vavoo_ch_ channels from replays', () => {
      const aggregator = new MatchAggregator();

      const vavooChannel = {
        id: 'vavoo_ch_tnt-sport-1-uk',
        title: 'TNT SPORT 1',
        category: 'networks',
        date: '0'
      };

      const replay = {
        id: 'rz_99999',
        title: 'TNT SPORT 1 Replay',
        category: 'football',
        status: 'finished',
        date: '2026-09-01'
      };

      expect(aggregator.isSameEvent(vavooChannel, replay)).toBe(false);
    });
  });

  describe('Multi-Base Mirror Failover (VAVOO_BASE_SITES)', () => {
    it('fails over to kool.to when vavoo.to returns 502 or 500 error', async () => {
      process.env.VAVOO_ENABLED = 'true';
      const mockTokenManager = {
        getOrRefreshSig: jest.fn().mockResolvedValue('valid_sig')
      };
      const provider = new VavooProvider({ tokenManager: mockTokenManager });

      const fakeCdnUrl = 'https://vavoo.to/live2/play/123/index.m3u8';
      provider.proxyFetch = jest.fn().mockImplementation((url) => {
        if (url.startsWith('https://vavoo.to/')) {
          return Promise.resolve({ ok: false, status: 502 });
        }
        if (url.startsWith('https://kool.to/')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve([{ url: fakeCdnUrl }])
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      const streams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/123',
        'networks',
        'Sky Sports F1'
      );

      expect(streams.length).toBe(1);
      expect(streams[0].url).toContain(encodeURIComponent(fakeCdnUrl));
      expect(provider.baseIndex).toBe(1); // Rotated to kool.to
    });

    it('rotates baseIndex so subsequent calls start from the healthy mirror', async () => {
      process.env.VAVOO_ENABLED = 'true';
      const mockTokenManager = {
        getOrRefreshSig: jest.fn().mockResolvedValue('valid_sig')
      };
      const provider = new VavooProvider({ tokenManager: mockTokenManager });
      provider.baseIndex = 1; // already on kool.to

      const fakeCdnUrl = 'https://vavoo.to/live2/play/456/index.m3u8';
      provider.proxyFetch = jest.fn().mockImplementation((url) => {
        if (url.startsWith('https://kool.to/')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve([{ url: fakeCdnUrl }])
          });
        }
        return Promise.resolve({ ok: false, status: 500 });
      });

      const streams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/456',
        'networks',
        'TNT Sports 2'
      );

      expect(streams.length).toBe(1);
      expect(provider.proxyFetch).toHaveBeenCalledTimes(1);
      expect(provider.proxyFetch.mock.calls[0][0]).toContain('https://kool.to/');
    });

    it('normalizes mirror and watch URLs (e.g. kool.to, /watch?live=X, /play/X)', async () => {
      process.env.VAVOO_ENABLED = 'true';
      const mockTokenManager = {
        getOrRefreshSig: jest.fn().mockResolvedValue('valid_sig')
      };
      const provider = new VavooProvider({ tokenManager: mockTokenManager });

      const fakeCdnUrl = 'https://vavoo.to/live2/play/norm123/index.m3u8';
      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ url: fakeCdnUrl }])
      });

      const streams = await provider.resolveStream(
        'https://kool.to/watch?live=norm123',
        'networks',
        'DAZN 1'
      );

      expect(streams.length).toBe(1);
      const callBody = JSON.parse(provider.proxyFetch.mock.calls[0][1].body);
      expect(callBody.url).toBe('https://vavoo.to/vavoo-iptv/play/norm123');
    });

    it('returns empty array when all base sites fail without crashing', async () => {
      process.env.VAVOO_ENABLED = 'true';
      const mockTokenManager = {
        getOrRefreshSig: jest.fn().mockResolvedValue('valid_sig')
      };
      const provider = new VavooProvider({ tokenManager: mockTokenManager });
      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503
      });

      const streams = await provider.resolveStream(
        'https://vavoo.to/vavoo-iptv/play/exhaust_test',
        'networks',
        'Offline Channel'
      );

      expect(streams).toEqual([]);
      expect(provider.proxyFetch).toHaveBeenCalledTimes(VAVOO_BASE_SITES.length); // Attempted all base sites
    });
  });
});
