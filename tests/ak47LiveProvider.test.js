'use strict';

process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const Ak47LiveProvider = require('../src/providers/Ak47LiveProvider');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const { verifyPayload } = require('../src/services/DashPayload');
const container = require('../src/container');

describe('Ak47LiveProvider Unit & Integration Tests', () => {
  let provider;

  beforeEach(() => {
    provider = new Ak47LiveProvider({ cacheTtlMs: 5000 });
  });

  describe('AK47 Obfuscation Decryption Engine', () => {
    test('successfully decrypts double-base64 pair-swapped AES-128-CBC payloads', () => {
      const payload = {
        name: 'Test Stream',
        url: 'https://example.com/live.m3u8'
      };

      // Encrypt with AK47 scheme: JSON -> AES-128-CBC -> Base64 -> Reverse -> Pair Swap -> Base64
      const key = Buffer.from('az1sUE8zNnNUVXpN', 'ascii');
      const iv = Buffer.from('dz00QVhsNmZZU0Fw', 'ascii');
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      cipher.setAutoPadding(true);
      const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);

      const b64_inner = encrypted.toString('base64');
      const rev = Buffer.from(b64_inner, 'ascii').reverse();
      for (let i = 0; i < rev.length - 1; i += 2) {
        const tmp = rev[i];
        rev[i] = rev[i + 1];
        rev[i + 1] = tmp;
      }
      const rawEncryptedPayload = rev.toString('base64');

      const decrypted = provider._decryptAk47Payload(rawEncryptedPayload);
      expect(decrypted).toEqual(payload);
    });

    test('returns null for corrupted or invalid payload', () => {
      expect(provider._decryptAk47Payload('')).toBeNull();
      expect(provider._decryptAk47Payload('invalid-base64-content')).toBeNull();
    });
  });

  describe('Strict Zero-DASH Enforcement & M3U Parser', () => {
    test('parses valid HLS streams and captures #EXTVLCOPT headers', () => {
      const sampleM3u = `
#EXTM3U
#EXTVLCOPT:http-referrer=http://www.fawanews.sc/
#EXTVLCOPT:http-origin=http://www.fawanews.sc
#EXTVLCOPT:http-user-agent=CustomUA/1.0
#EXTINF:-1 tvg-id="" tvg-name="Boxing : Fundora vs Hadribeaj --- CH 1" tvg-logo="https://example.com/logo.png" group-title="Boxing",Boxing : Fundora vs Hadribeaj --- CH 1
http://193.47.62.100:8080/live/stream1/playlist.m3u8
      `;

      const entries = provider._parseM3u(sampleM3u);
      expect(entries.length).toBe(1);
      expect(entries[0]).toEqual({
        rawTitle: 'Boxing : Fundora vs Hadribeaj --- CH 1',
        groupTitle: 'Boxing',
        tvgLogo: 'https://example.com/logo.png',
        streamUrl: 'http://193.47.62.100:8080/live/stream1/playlist.m3u8',
        referer: 'http://www.fawanews.sc/',
        origin: 'http://www.fawanews.sc',
        userAgent: 'CustomUA/1.0'
      });
    });

    test('strictly drops MPEG-DASH (.mpd) and DRM-encrypted (cenc) manifests', () => {
      const mixedM3u = `
#EXTM3U
#EXTINF:-1 tvg-name="TNT SPORTS 1" group-title="Broadcast",TNT SPORTS 1
https://otte.cache.aiv-cdn.net/cenc/live/channel.mpd
#EXTINF:-1 tvg-name="Sky Sports Main Event" group-title="Broadcast",Sky Sports Main Event
https://edge-node.net/dash/live/manifest.mpd?token=xyz
#EXTINF:-1 tvg-name="Valid HLS Stream" group-title="Football",Valid HLS Stream
http://193.47.62.200:8080/live/valid/index.m3u8
#EXTINF:-1 tvg-name="Another DASH Stream" group-title="Sports",Another DASH Stream
http://example.com/cenc/stream.m3u8
      `;

      const entries = provider._parseM3u(mixedM3u);
      expect(entries.length).toBe(1);
      expect(entries[0].rawTitle).toBe('Valid HLS Stream');
      expect(entries[0].streamUrl).toBe('http://193.47.62.200:8080/live/valid/index.m3u8');
    });

    test('ignores non-HTTP schemes and empty/malformed lines', () => {
      const badM3u = `
#EXTM3U
#EXTINF:-1,Invalid Scheme
rtmp://live.stream/live
#EXTINF:-1,File Path
file:///etc/passwd
#EXTINF:-1,No URL
      `;
      const entries = provider._parseM3u(badM3u);
      expect(entries.length).toBe(0);
    });
  });

  describe('Match Info Extraction & Category Normalization', () => {
    test('extracts clean title, channel label, teams, and normalized category', () => {
      const info = provider._extractMatchInfo(
        'Boxing : Fundora vs Hadribeaj --- CH 1',
        'Boxing'
      );

      expect(info.title).toBe('Fundora vs Hadribeaj');
      expect(info.channelLabel).toBe('CH 1');
      expect(info.team1).toBe('Fundora');
      expect(info.team2).toBe('Hadribeaj');
      expect(info.category).toBe('mma');
    });

    test('handles Server numbers and alternate separators', () => {
      const info = provider._extractMatchInfo(
        'Arsenal vs Chelsea - Server 2',
        'Australia A-League'
      );

      expect(info.title).toBe('Arsenal vs Chelsea');
      expect(info.channelLabel).toBe('Server 2');
      expect(info.team1).toBe('Arsenal');
      expect(info.team2).toBe('Chelsea');
      expect(info.category).toBe('football');
    });

    test('maps Basketball leagues to basketball category', () => {
      const info = provider._extractMatchInfo(
        'Sydney Kings vs Melbourne United --- CH 2',
        'Basketball NBL'
      );

      expect(info.title).toBe('Sydney Kings vs Melbourne United');
      expect(info.channelLabel).toBe('CH 2');
      expect(info.team1).toBe('Sydney Kings');
      expect(info.team2).toBe('Melbourne United');
      expect(info.category).toBe('basketball');
    });
  });

  describe('Multi-Channel Mirror Grouping & Ingest', () => {
    test('aggregates multi-channel mirrors under a single MatchEntity card', async () => {
      const mockFeed = `
#EXTM3U
#EXTINF:-1 tvg-name="Boxing : Fundora vs Hadribeaj --- CH 1" group-title="Boxing",Boxing : Fundora vs Hadribeaj --- CH 1
http://193.47.62.1:8080/live/ch1.m3u8
#EXTINF:-1 tvg-name="Boxing : Fundora vs Hadribeaj --- CH 2" group-title="Boxing",Boxing : Fundora vs Hadribeaj --- CH 2
http://193.47.62.2:8080/live/ch2.m3u8
      `;

      jest.spyOn(provider, 'proxyFetch').mockImplementation(async (url) => {
        if (url.includes('events.txt')) {
          return { status: 404, text: async () => '' };
        }
        return {
          status: 200,
          text: async () => mockFeed
        };
      });

      const matches = await provider.getMatches();
      expect(matches.length).toBe(1);

      const match = matches[0];
      expect(match).toBeInstanceOf(MatchEntity);
      expect(match.title).toBe('Fundora vs Hadribeaj');
      expect(match.category).toBe('mma');
      expect(match.sources.length).toBe(2);
      expect(match.sources[0].channelName).toBe('CH 1');
      expect(match.sources[0].id).toBe('http://193.47.62.1:8080/live/ch1.m3u8');
      expect(match.sources[1].channelName).toBe('CH 2');
      expect(match.sources[1].id).toBe('http://193.47.62.2:8080/live/ch2.m3u8');
    });

    test('serves subsequent requests from cache within TTL', async () => {
      const mockFeed = `
#EXTM3U
#EXTINF:-1 group-title="Football",Team A vs Team B --- CH 1
http://193.47.62.1:8080/live/game.m3u8
      `;

      const spy = jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
        status: 200,
        text: async () => mockFeed
      });

      const first = await provider.getMatches();
      const second = await provider.getMatches();

      expect(first).toBe(second); // same object reference
      expect(spy).toHaveBeenCalledTimes(3); // 1 encrypted events feed + 2 playlist feeds fetched on initial call
    });

    test('handles upstream feed fetch failure gracefully', async () => {
      jest.spyOn(provider, 'proxyFetch').mockRejectedValue(new Error('Network timeout'));

      const matches = await provider.getMatches();
      expect(Array.isArray(matches)).toBe(true);
      expect(matches.length).toBe(0);
    });

    test('parses real event dates, formats solo event titles, and filters invisible events', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 25, 15, 0, 0));
      const mockEvents = [
        {
          event: JSON.stringify({
            eventName: 'LaLiga',
            teamAName: 'Real Madrid',
            teamBName: 'Barcelona',
            category: 'Football',
            date: '25/10/2026',
            time: '20:00:00',
            visible: true,
            links: 'pro/elclasico.txt',
            link_names: ['HD 1']
          })
        },
        {
          event: JSON.stringify({
            eventName: 'Horse Racing',
            teamAName: 'Horse Racing',
            teamBName: 'Horse Racing',
            category: 'Other',
            date: '25/10/2026',
            time: '14:00:00',
            visible: true,
            links: 'pro/racing.txt',
            link_names: ['HD']
          })
        },
        {
          event: JSON.stringify({
            eventName: 'Hidden Dummy',
            teamAName: 'Dummy A',
            teamBName: 'Dummy B',
            category: 'Football',
            visible: false,
            links: 'pro/dummy.txt'
          })
        }
      ];

      const key = Buffer.from('az1sUE8zNnNUVXpN', 'ascii');
      const iv = Buffer.from('dz00QVhsNmZZU0Fw', 'ascii');
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      cipher.setAutoPadding(true);
      const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(mockEvents), 'utf8')), cipher.final()]);
      const b64 = enc.toString('base64');
      const rev = Buffer.from(b64, 'ascii').reverse();
      for (let i = 0; i < rev.length - 1; i += 2) {
        const tmp = rev[i];
        rev[i] = rev[i + 1];
        rev[i + 1] = tmp;
      }
      const encryptedEvents = rev.toString('base64');

      jest.spyOn(provider, 'proxyFetch').mockImplementation(async (url) => {
        if (url.includes('events.txt')) {
          return { status: 200, text: async () => encryptedEvents };
        }
        return { status: 404, text: async () => '' };
      });

      const matches = await provider.getMatches();
      expect(matches.length).toBe(2);

      const match1 = matches.find(m => m.title.includes('Real Madrid'));
      expect(match1).toBeDefined();
      expect(match1.title).toBe('Real Madrid vs Barcelona');
      expect(match1.team1).toEqual({ name: 'Real Madrid' });
      expect(match1.team2).toEqual({ name: 'Barcelona' });
      expect(match1.date).toBe(String(Date.UTC(2026, 9, 25, 20, 0, 0)));

      const match2 = matches.find(m => m.title === 'Horse Racing');
      expect(match2).toBeDefined();
      expect(match2.title).toBe('Horse Racing');
      expect(match2.team1).toBeNull();
      expect(match2.team2).toBeNull();
      nowSpy.mockRestore();
    });
  });

  describe('resolveStream & Proxy Headers Decoration', () => {
    test('resolves stream with /api/manifest proxy and request headers', async () => {
      const src = {
        id: 'http://193.47.62.50:8080/live/stream.m3u8',
        channelName: 'CH 1',
        referer: 'http://www.fawanews.sc/',
        origin: 'http://www.fawanews.sc',
        userAgent: 'CustomUA/2.0'
      };

      const resolved = await provider.resolveStream(src.id, 'mma', 'Fundora vs Hadribeaj', src);
      expect(resolved.length).toBe(1);

      const stream = resolved[0];
      expect(stream).toBeInstanceOf(StreamEntity);
      expect(stream.name).toBe('Ak47Live');
      expect(stream.title).toContain('[CH 1]');
      expect(stream.title).toContain('Fundora vs Hadribeaj');
      expect(stream.url).toContain('/api/manifest?url=http%3A%2F%2F193.47.62.50%3A8080%2Flive%2Fstream.m3u8');
      expect(stream.behaviorHints.notWebReady).toBe(true);
      expect(stream.behaviorHints.proxyHeaders.request['Referer']).toBe('http://www.fawanews.sc/');
      expect(stream.behaviorHints.proxyHeaders.request['Origin']).toBe('http://www.fawanews.sc');
      expect(stream.behaviorHints.proxyHeaders.request['User-Agent']).toBe('CustomUA/2.0');
    });

    test('strictly drops DASH URLs passed to resolveStream', async () => {
      const dashSrc = {
        id: 'https://otte.cache.aiv-cdn.net/cenc/live/channel.mpd',
        channelName: 'TNT SPORTS 1'
      };

      const resolved = await provider.resolveStream(dashSrc.id, 'football', 'Match', dashSrc);
      expect(resolved).toEqual([]);
    });

    test('returns empty array for invalid stream URLs', async () => {
      const resolved = await provider.resolveStream('', 'football', 'Match');
      expect(resolved).toEqual([]);
    });

    test('resolves encrypted pro/*.txt streams and extracts piped headers', async () => {
      const mockStreams = [
        {
          name: 'SonyLiv (Asia)',
          link: 'https://sonymtmnew.akamaized.net/live/index.m3u8|Referer=https://www.sonyliv.com/&Origin=https://www.sonyliv.com'
        }
      ];

      // Encrypt mockStreams using AK47 cipher
      const key = Buffer.from('az1sUE8zNnNUVXpN', 'ascii');
      const iv = Buffer.from('dz00QVhsNmZZU0Fw', 'ascii');
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      cipher.setAutoPadding(true);
      const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(mockStreams), 'utf8')), cipher.final()]);
      const b64 = enc.toString('base64');
      const rev = Buffer.from(b64, 'ascii').reverse();
      for (let i = 0; i < rev.length - 1; i += 2) {
        const tmp = rev[i];
        rev[i] = rev[i + 1];
        rev[i + 1] = tmp;
      }
      const encryptedPro = rev.toString('base64');

      jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
        status: 200,
        text: async () => encryptedPro
      });

      const src = {
        id: 'pro/mock123.txt#0',
        linksPath: 'pro/mock123.txt',
        streamIndex: 0,
        channelName: 'SonyLiv (Asia)'
      };

      const resolved = await provider.resolveStream(src.id, 'football', 'Real Sociedad vs Lillestrom', src);
      expect(resolved.length).toBe(1);
      expect(resolved[0].title).toContain('SonyLiv (Asia)');
      expect(resolved[0].behaviorHints.proxyHeaders.request['Referer']).toBe('https://www.sonyliv.com/');
      expect(resolved[0].behaviorHints.proxyHeaders.request['Origin']).toBe('https://www.sonyliv.com');
    });

    test('drops DASH/DRM and embed.st/WASM streams from pro feeds', async () => {
      const mockStreams = [
        {
          name: 'PARAMOUNT+ FHD',
          link: 'https://example.com/live.mpd',
          drm_scheme: 'clearkey',
          key: 'somekey'
        },
        {
          name: 'HD QUALITY',
          tokenApi: JSON.stringify({ api: 'https://embed.st/embed/admin/ppv-test/1' })
        },
        {
          name: 'SD QUALITY',
          link: 'https://embedindia.st/stream.m3u8'
        }
      ];

      const key = Buffer.from('az1sUE8zNnNUVXpN', 'ascii');
      const iv = Buffer.from('dz00QVhsNmZZU0Fw', 'ascii');
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      cipher.setAutoPadding(true);
      const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(mockStreams), 'utf8')), cipher.final()]);
      const b64 = enc.toString('base64');
      const rev = Buffer.from(b64, 'ascii').reverse();
      for (let i = 0; i < rev.length - 1; i += 2) {
        const tmp = rev[i];
        rev[i] = rev[i + 1];
        rev[i + 1] = tmp;
      }
      const encryptedPro = rev.toString('base64');

      jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
        status: 200,
        text: async () => encryptedPro
      });

      // Stream 0: DASH / DRM
      const dashRes = await provider.resolveStream('pro/test.txt#0', 'football', 'Match', {
        id: 'pro/test.txt#0',
        linksPath: 'pro/test.txt',
        streamIndex: 0
      });
      expect(dashRes).toEqual([]);

      // Stream 1: embed.st tokenApi
      const embedRes = await provider.resolveStream('pro/test.txt#1', 'football', 'Match', {
        id: 'pro/test.txt#1',
        linksPath: 'pro/test.txt',
        streamIndex: 1
      });
      expect(embedRes).toEqual([]);

      // Stream 2: embedindia.st direct link
      const wasmRes = await provider.resolveStream('pro/test.txt#2', 'football', 'Match', {
        id: 'pro/test.txt#2',
        linksPath: 'pro/test.txt',
        streamIndex: 2
      });
      expect(wasmRes).toEqual([]);
    });

    describe('ClearKey DASH → Zero-Bandwidth HLS Conversion', () => {
      const KEY_HEX = '567c863bc12eb74788ea74888c042e1b';
      const KID_HEX = 'f3df7843080ae743bf865dc5fdf64c68';
      const MPD_URL = 'https://otte.cache.aiv-cdn.net/bom-nitro/out/v1/f7f0da1ee112481ca0024e6d4dd97f4a/cenc.mpd';
      const PIPED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

      function encryptAk47(obj) {
        const key = Buffer.from('az1sUE8zNnNUVXpN', 'ascii');
        const iv = Buffer.from('dz00QVhsNmZZU0Fw', 'ascii');
        const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
        cipher.setAutoPadding(true);
        const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
        const b64 = enc.toString('base64');
        const rev = Buffer.from(b64, 'ascii').reverse();
        for (let i = 0; i < rev.length - 1; i += 2) {
          const tmp = rev[i];
          rev[i] = rev[i + 1];
          rev[i + 1] = tmp;
        }
        return rev.toString('base64');
      }

      test('resolves real-format pro entries (api:"kid:key", piped UA) into /api/dash HLS StreamEntities', async () => {
        jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
          status: 200,
          text: async () => encryptAk47([
            {
              name: 'TNT2UK SPORTS FHD',
              link: `${MPD_URL}|user-agent=${PIPED_UA}`,
              scheme: 0,
              api: `${KID_HEX}:${KEY_HEX}`,
              tokenApi: ''
            }
          ])
        });

        const resolved = await provider.resolveStream('pro/bein.txt#0', 'football', 'Japan vs Venezuela', {
          id: 'pro/bein.txt#0',
          linksPath: 'pro/bein.txt',
          streamIndex: 0,
          channelName: 'TNT2UK SPORTS FHD'
        });

        expect(resolved.length).toBe(1);
        const stream = resolved[0];
        expect(stream).toBeInstanceOf(StreamEntity);
        expect(stream.name).toBe('Ak47Live');
        // Channel name in parens so the pipeline label extractor surfaces it
        expect(stream.title).toContain('(TNT2UK SPORTS FHD)');
        expect(stream.title).toContain('Japan vs Venezuela');
        expect(stream.url).toMatch(/\/api\/dash\/index\.m3u8\?d=.+$/);
        expect(stream.behaviorHints.notWebReady).toBe(false);

        const verified = verifyPayload(stream.url.split('d=')[1]);
        expect(verified.ok).toBe(true);
        const payload = verified.payload;
        expect(payload.mpdUrl).toBe(MPD_URL);
        expect(payload.key).toBe(KEY_HEX);
        expect(payload.kid).toBe(KID_HEX);
        expect(payload.headers['User-Agent']).toBe(PIPED_UA);
      });

      test('also honours legacy key/kid fields and strips piped link suffixes', async () => {
        jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
          status: 200,
          text: async () => encryptAk47([
            { name: 'TSN FHD', link: `${MPD_URL}|Referer=https://ak.example/`, key: KEY_HEX, kid: KID_HEX }
          ])
        });

        const resolved = await provider.resolveStream('pro/tsn.txt#0', 'football', 'Match', {
          id: 'pro/tsn.txt#0',
          linksPath: 'pro/tsn.txt',
          streamIndex: 0
        });

        expect(resolved.length).toBe(1);
        const verifiedToken = verifyPayload(resolved[0].url.split('d=')[1]);
        expect(verifiedToken.ok).toBe(true);
        const payload = verifiedToken.payload;
        expect(payload.mpdUrl).toBe(MPD_URL); // no |Referer=... suffix
        expect(payload.key).toBe(KEY_HEX);
        expect(payload.kid).toBe(KID_HEX);
      });

      test('still drops DRM .mpd entries whose key is not a valid 16-byte hex string', async () => {
        jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
          status: 200,
          text: async () => encryptAk47([
            { name: 'WIDEVINE ONLY', link: MPD_URL, drm_scheme: 'widevine' },
            { name: 'BAD KEY', link: MPD_URL, api: 'zzz:not-hex' },
            { name: 'KEY NO MPD', link: 'https://cdn.example.com/live.m3u8', key: KEY_HEX, kid: KID_HEX }
          ])
        });

        for (const idx of [0, 1, 2]) {
          const resolved = await provider.resolveStream(`pro/drm.txt#${idx}`, 'football', 'Match', {
            id: `pro/drm.txt#${idx}`,
            linksPath: 'pro/drm.txt',
            streamIndex: idx
          });
          expect(resolved).toEqual([]);
        }
      });
    });
  });

  describe('Container & System Integration', () => {
    test('ak47LiveProvider is registered as singleton in container', () => {
      const resolved = container.resolve('ak47LiveProvider');
      expect(resolved).toBeInstanceOf(Ak47LiveProvider);
    });

    test('MatchAggregator includes ak47LiveProvider in providers list', () => {
      const aggregator = container.resolve('matchAggregator');
      const hasAk47 = aggregator.providers.some(p => p && p.name === 'Ak47Live');
      expect(hasAk47).toBe(true);
    });

    test('selectSources ranks DaddyLive at Priority 1, ak47live at Priority 2, and keeps it in fallback list', () => {
      const { selectSources } = require('../src/streams');
      const sources = [
        { source: 'streamedpk', id: 'sp1' },
        { source: 'daddylive', id: 'dl1' },
        { source: 'ak47live', id: 'http://193.47.62.1:8080/live/ch1.m3u8' },
        { source: 'streamsports99', id: 'ss1' }
      ];

      const sorted = selectSources(sources);
      expect(sorted[0].source).toBe('daddylive');
      expect(sorted[1].source).toBe('ak47live');
      expect(sorted.some(s => s.source === 'ak47live')).toBe(true);

      const withConfig = selectSources(sources, { sources: 'ak47live,daddylive' });
      expect(withConfig.length).toBe(2);
      expect(withConfig[0].source).toBe('daddylive');
      expect(withConfig[1].source).toBe('ak47live');
    });
  });
});
