// These parser/extractor unit tests do not exercise or launch WASM workers.
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM execution in provider unit fixture'); }),
  destroy: jest.fn(async () => {})
}));

jest.mock('../src/services/ProviderOutbound', () => ({
  fetchUndici: (...args) => {
    if (!jest.isMockFunction(global.fetch)) throw new Error('Unexpected SK Tech I/O in unit fixture');
    return global.fetch(...args);
  }
}));

'use strict';

process.env.NODE_ENV = 'test';

const { crypto: skCrypto, embedExtractor, matchResolver, channelResolver } = require('../src/resolver/sktech');
const SkTechProvider = require('../src/providers/SkTechProvider');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const container = require('../src/container');

describe('SK Tech TV Dual-Pillar Resolver & Provider', () => {
  let provider;

  beforeEach(() => {
    provider = new SkTechProvider({
      circuitBreaker: {
        wrapSync: (name, fn) => ({ fire: fn })
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Cryptography Engine (SkTechCrypto)
  // ──────────────────────────────────────────────────────────────────────────
  describe('SkTechCrypto', () => {
    test('decrypts Tier 1 & Tier 2 payload accurately', () => {
      // Sample mock ciphertext encrypted with primary AES key and inverted
      const plaintext = JSON.stringify([{ name: 'Test Server', link: 'https://cdn.example.com/live.m3u8' }]);
      const cipher = require('crypto').createCipheriv('aes-128-cbc', skCrypto.primaryKey, skCrypto.primaryIv);
      let aesEncrypted = cipher.update(plaintext, 'utf8', 'base64');
      aesEncrypted += cipher.final('base64');

      // Reverse
      const reversed = aesEncrypted.split('').reverse().join('');
      const tier1Base64 = Buffer.from(reversed, 'utf8').toString('base64');

      // Bijective inverse substitute
      let substituted = '';
      const inverseMap = new Map();
      for (const [k, v] of skCrypto.dMap.entries()) {
        inverseMap.set(v, k);
      }
      for (const ch of tier1Base64) {
        substituted += inverseMap.get(ch) || ch;
      }

      const decrypted = skCrypto.decryptPrimary(substituted);
      expect(decrypted).toBe(plaintext);
    });

    test('decrypts secondary tokenApi payload', () => {
      const plaintext = JSON.stringify({ playback_url: 'https://cdn.example.com/hls/test.m3u8' });
      const cipher = require('crypto').createCipheriv('aes-128-cbc', skCrypto.secondaryKey, skCrypto.secondaryIv);
      let enc = cipher.update(plaintext, 'utf8', 'base64');
      enc += cipher.final('base64');

      const decrypted = skCrypto.decryptSecondary(enc);
      expect(decrypted).toBe(plaintext);
    });

    test('handles empty or invalid inputs gracefully without unhandled exceptions', () => {
      expect(skCrypto.decryptPrimary('')).toBe('');
      expect(skCrypto.decryptPrimary(null)).toBe('');
      expect(skCrypto.decryptSecondary('')).toBe('');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Delimiter & Embed Extractor (SkTechEmbedExtractor)
  // ──────────────────────────────────────────────────────────────────────────
  describe('SkTechEmbedExtractor', () => {
    test('strips delimiter tags ([rts], [digital], [sonysk]) from URLs', () => {
      const raw = 'https://dehkho24h.alpha-circuit.workers.dev/?token=1b8j9b-796c8a[rts]|User-Agent=CustomUA&Referer=https://ref.com/';
      const parsed = embedExtractor.parseDelimited(raw);

      expect(parsed.url).toBe('https://dehkho24h.alpha-circuit.workers.dev/?token=1b8j9b-796c8a');
      expect(parsed.headers['User-Agent']).toBe('CustomUA');
      expect(parsed.headers['Referer']).toBe('https://ref.com/');
    });

    test('parses DRM scheme and license parameters', () => {
      const raw = 'https://cdn.example.com/cenc.mpd|drmscheme=clearkey&drmlicense=14ee:17d2';
      const parsed = embedExtractor.parseDelimited(raw);

      expect(parsed.url).toBe('https://cdn.example.com/cenc.mpd');
      expect(parsed.drmScheme).toBe('clearkey');
      expect(parsed.drmLicense).toBe('14ee:17d2');
    });

    test('unpacks Clappr array join obfuscation', () => {
      const html = `
        <html>
          <script>
            function _0xabc123() {
              return ["https://", "stream.cdn.net", "\\/live\\/", "playlist.m3u8"].join('');
            }
            player.load({ source: _0xabc123() });
          </script>
        </html>
      `;
      const unpacked = embedExtractor.extractClapprArrayJoin(html);
      expect(unpacked).toBe('https://stream.cdn.net/live/playlist.m3u8');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Pillar 1: Live Sports Matches (SkTechMatchResolver)
  // ──────────────────────────────────────────────────────────────────────────
  describe('SkTechMatchResolver (Pillar 1)', () => {
    test('normalizes categories and parses UTC kickoff epoch correctly', () => {
      expect(matchResolver.normalizeCategory('Football')).toBe('football');
      expect(matchResolver.normalizeCategory('Premier League')).toBe('football');
      expect(matchResolver.normalizeCategory('Cricket T20')).toBe('cricket');
      expect(matchResolver.normalizeCategory('WWE Raw')).toBe('mma');
      expect(matchResolver.normalizeCategory('Formula 1')).toBe('motorsport');
      expect(matchResolver.normalizeCategory('Tennis ATP')).toBe('tennis');

      const epoch = matchResolver.parseKickoff('13/10/2026', '20:30:00');
      const expectedUtc = Date.UTC(2026, 9, 13, 20, 30, 0);
      expect(epoch).toBe(expectedUtc);
    });

    test('resolves match streams prioritizing direct HLS over converted DASH HLS', async () => {
      const mockRawOptions = [
        {
          name: 'Server 1 DASH',
          link: 'https://otte.cache.aiv-cdn.net/live/cenc.mpd|user-agent=TestUA',
          api: '14eeabf30c14b7fbf3008c03099ce011:17d2ac8dbc5429bd70af3433aa12158d'
        },
        {
          name: 'Server 2 HLS',
          link: 'https://amagi.tv/live/master.m3u8|user-agent=TestUA&referer=https://amagi.tv'
        },
        {
          name: 'Server 3 R2',
          link: 'https://pub-123.r2.dev/stream.mp4'
        }
      ];

      jest.spyOn(skCrypto, 'decryptPrimary').mockReturnValueOnce(JSON.stringify(mockRawOptions));
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => 'encrypted'
      });

      const streams = await matchResolver.resolveMatchStreams('pro/test.txt', 'Arsenal vs Chelsea');
      expect(streams).toHaveLength(3);

      // Verify Priority Order: Direct HLS & R2 first, converted DASH HLS last
      expect(streams[0].title).toContain('Server 2 HLS');
      expect(streams[0].url).toContain('amagi.tv');
      expect(streams[1].title).toContain('Server 3 R2');
      expect(streams[2].title).toContain('Server 1 DASH');

      // DASH entries now route through the zero-bandwidth /api/dash converter
      // with the ClearKey embedded in the base64url payload
      expect(streams[2].url).toMatch(/\/api\/dash\/index\.m3u8\?d=.+$/);
      const payload = JSON.parse(Buffer.from(streams[2].url.split('d=')[1], 'base64url').toString('utf8'));
      expect(payload.mpdUrl).toBe('https://otte.cache.aiv-cdn.net/live/cenc.mpd');
      expect(payload.key).toBe('17d2ac8dbc5429bd70af3433aa12158d');
      expect(payload.kid).toBe('14eeabf30c14b7fbf3008c03099ce011');
      expect(streams[2].behaviorHints.notWebReady).toBe(false);

      // Verify Zero Server Bandwidth: URLs are direct CDNs or in-addon dash routes
      for (const s of streams) {
        expect(s.url).not.toContain('/api/manifest');
        expect(s.url).not.toContain('localhost');
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Pillar 2: 24/7 TV Channels (SkTechChannelResolver)
  // ──────────────────────────────────────────────────────────────────────────
  describe('SkTechChannelResolver (Pillar 2)', () => {
    test('maps 24/7 channels under category networks with kickoff 0', async () => {
      const mockCategories = [
        {
          cat: JSON.stringify({
            name: 'SONY LIVE',
            type: 'm3u',
            api: 'https://nonyliv.example.com/nonyliv.m3u',
            logo: 'https://img.example.com/sony.png',
            visible: true
          })
        },
        {
          cat: JSON.stringify({
            name: 'SPORTS WORLD',
            type: 'custom',
            api: 'channels/U1BPUlRTIFdPUkxEMTc2ODY5OTM1MTk5OQ.txt',
            logo: 'https://img.example.com/sport.png',
            visible: true
          })
        }
      ];

      const mockSportsChannels = [
        {
          channel: JSON.stringify({
            name: 'TSN 1',
            logo: 'https://img.example.com/tsn.png',
            links: 'pro/tsn1.txt'
          })
        },
        {
          channel: JSON.stringify({
            name: 'TNT Sports 1 UK',
            logo: 'https://img.example.com/tnt.png',
            links: 'pro/tnt1.txt'
          })
        }
      ];

      jest.spyOn(skCrypto, 'decryptPrimary')
        .mockReturnValueOnce(JSON.stringify(mockCategories))
        .mockReturnValueOnce(JSON.stringify(mockSportsChannels));

      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, text: async () => 'enc_categories' })
        .mockResolvedValueOnce({ ok: true, text: async () => '#EXTM3U\n#EXTINF:-1,SONY LIVE\nhttps://cdn.example.com/sony.m3u8' })
        .mockResolvedValueOnce({ ok: true, text: async () => 'enc_channels' });

      const channels = await channelResolver.fetchChannels();
      expect(channels.length).toBeGreaterThanOrEqual(3);

      const tsn = channels.find(c => c.title === 'TSN 1');
      expect(tsn).toBeDefined();
      expect(tsn.category).toBe('networks');
      expect(tsn.kickoff).toBe(0);

      const sony = channels.find(c => c.title === 'SONY LIVE');
      expect(sony).toBeDefined();
      expect(sony.category).toBe('networks');
      expect(sony.kickoff).toBe(0);
    });

    test('resolves M3U playlist file into constituent streams', async () => {
      const mockM3u = `
#EXTM3U
#EXTINF:-1 tvg-name="Star Sports 1",Star Sports 1 HD
https://cdn.example.com/star1.m3u8|User-Agent=VLC
#EXTINF:-1 tvg-name="Sony Ten 1",Sony Ten 1 HD
https://cdn.example.com/sony1.m3u8|User-Agent=ExoPlayer
      `;

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => mockM3u
      });

      const streams = await channelResolver.resolveChannelStream({
        id: 'sktech_ch_m3u_1',
        title: 'Star Sports Pack',
        type: 'm3u',
        api: 'https://cdn.example.com/pack.m3u'
      });

      expect(streams).toHaveLength(2);
      expect(streams[0].title).toBe('SK Tech | Star Sports 1 HD');
      expect(streams[0].url).toBe('https://cdn.example.com/star1.m3u8');
      expect(streams[0].behaviorHints.proxyHeaders.request['User-Agent']).toBe('VLC');
      expect(streams[1].title).toBe('SK Tech | Sony Ten 1 HD');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. SkTechProvider Integration
  // ──────────────────────────────────────────────────────────────────────────
  describe('SkTechProvider', () => {
    test('getMatches merges Pillar 1 fixtures and Pillar 2 networks into MatchEntities', async () => {
      jest.spyOn(matchResolver, 'fetchLiveMatches').mockResolvedValueOnce([
        {
          id: 'sk_m1',
          title: 'Liverpool vs Real Madrid',
          category: 'football',
          kickoff: Date.now() + 3600000,
          rawCategory: 'UEFA Champions League',
          linkPath: 'pro/liv_rm.txt',
          teamA: { name: 'Liverpool', logo: 'https://logo.com/liv.png' },
          teamB: { name: 'Real Madrid', logo: 'https://logo.com/rm.png' },
          poster: 'https://logo.com/liv.png'
        }
      ]);

      jest.spyOn(channelResolver, 'fetchChannels').mockResolvedValueOnce([
        {
          id: 'sk_c1',
          title: 'Sky Sports Main Event',
          category: 'networks',
          kickoff: 0,
          type: 'pro',
          links: 'pro/sky.txt',
          logo: 'https://logo.com/sky.png'
        }
      ]);

      const matches = await provider.getMatches();
      expect(matches).toHaveLength(2);

      // Verify Pillar 1 Fixture
      const fixture = matches.find(m => m.title === 'Liverpool vs Real Madrid');
      expect(fixture).toBeInstanceOf(MatchEntity);
      expect(fixture.category).toBe('football');
      expect(fixture.team1.name).toBe('Liverpool');
      expect(fixture.sources[0].source).toBe('sktech');
      expect(fixture.sources[0].id).toBe('pro/liv_rm.txt');

      // Verify Pillar 2 24/7 Network
      const network = matches.find(m => m.title === 'Sky Sports Main Event');
      expect(network).toBeInstanceOf(MatchEntity);
      expect(network.category).toBe('networks');
      expect(network.date).toBe('');
      expect(network.popular).toBe('1');
      expect(network.sources[0].source).toBe('sktech');
    });

    test('resolveStream returns StreamEntities with direct CDN links and proxyHeaders', async () => {
      jest.spyOn(matchResolver, 'resolveMatchStreams').mockResolvedValueOnce([
        {
          name: '⚡ Direct Stream',
          title: 'SK Tech | HD Server (HLS Direct)',
          url: 'https://cdn.example.com/direct.m3u8',
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: { 'User-Agent': 'Mozilla/5.0' }
            }
          },
          score: 90
        }
      ]);

      const streams = await provider.resolveStream('pro/liv_rm.txt', 'football', 'Liverpool vs Real Madrid', {
        type: 'fixture',
        links: 'pro/liv_rm.txt'
      });

      expect(streams).toHaveLength(1);
      const s = streams[0];
      expect(s).toBeInstanceOf(StreamEntity);
      expect(s.name).toBe('SK Tech');
      expect(s.url).toBe('https://cdn.example.com/direct.m3u8');
      expect(s.url).not.toContain('/api/manifest');
      expect(s.behaviorHints.proxyHeaders.request['User-Agent']).toBe('Mozilla/5.0');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Core Wiring (Container & MatchAggregator)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Dependency Injection & Aggregator Integration', () => {
    test('resolves skTechProvider from container', () => {
      const resolved = container.resolve('skTechProvider');
      expect(resolved).toBeInstanceOf(SkTechProvider);
      expect(resolved.name).toBe('SkTech');
    });

    test('includes skTechProvider in matchAggregator provider list', () => {
      const aggregator = container.resolve('matchAggregator');
      const skTechInstance = aggregator.providers.find(p => p.name === 'SkTech');
      expect(skTechInstance).toBeDefined();
    });

    test('merges diacritic-heavy international fixtures into single poster (e.g. Cong An Hanoi vs Kashima Antlers)', () => {
      const aggregator = container.resolve('matchAggregator');
      const now = Date.now();
      const m1 = new MatchEntity({
        id: 'dlv_103_cong-an-hanoi-vs-kashima-antlers',
        title: 'Cong An Hanoi vs Kashima Antlers',
        category: 'football',
        date: String(now),
        sources: [{ source: 'daddylive', id: '103' }]
      });
      const m2 = new MatchEntity({
        id: 'sktech_match_31_kashima',
        title: 'Cơng An Hà Nội vs Kashima Antlers',
        category: 'football',
        date: String(now),
        sources: [{ source: 'sktech', id: 'pro/kashima.txt' }]
      });

      const isSame = aggregator.isSameEvent(m1, m2);
      expect(isSame).toBe(true);
    });

    test('formatClearKey normalizes hex colon pairs into W3C base64url keys', () => {
      const res = skCrypto.formatClearKey('6752015acf084572a08dfe21796f8b45:ff823ddbe5625c35d3e93f0ed4520115');
      expect(res).toEqual({
        keyId: 'Z1IBWs8IRXKgjf4heW-LRQ',
        key: '_4I92-ViXDXT6T8O1FIBFQ'
      });
    });

    test('cleanEventTitle strips language prefixes, quality suffixes, and commentary tags', () => {
      expect(matchResolver.cleanEventTitle('ENG | India vs West Indies')).toBe('India vs West Indies');
      expect(matchResolver.cleanEventTitle('[HINDI] India vs West Indies (1080p)')).toBe('India vs West Indies');
      expect(matchResolver.cleanEventTitle('Tamil | India vs West Indies - Hindi')).toBe('India vs West Indies');
      expect(matchResolver.cleanEventTitle('India vs West Indies [FHD]')).toBe('India vs West Indies');
    });

    test('resolveChannelStream falls back to direct URL if pro/ resolution returns empty', async () => {
      jest.spyOn(matchResolver, 'resolveMatchStreams').mockResolvedValueOnce([]);
      const channel = {
        id: 'sktech_jtv_1',
        title: '|Hindi| Tata Play Movies',
        url: 'https://cdn.tataplay.com/live/movie.m3u8',
        links: 'pro/expired_token.txt',
        group: 'Tata Play'
      };

      const streams = await channelResolver.resolveChannelStream(channel);
      expect(streams).toHaveLength(1);
      expect(streams[0].url).toBe('https://cdn.tataplay.com/live/movie.m3u8');
      expect(streams[0].title).toContain('Tata Play Movies');
    });
  });
});
