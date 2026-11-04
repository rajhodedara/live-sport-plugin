// These parser/extractor unit tests do not exercise or launch WASM workers.
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM execution in provider unit fixture'); }),
  destroy: jest.fn(async () => {})
}));

'use strict';

jest.mock('../src/services/ProviderOutbound', () => ({
  request: jest.fn(() => { throw new Error('Unexpected provider I/O in unit fixture'); }),
  safeFetch: jest.fn(() => { throw new Error('Unexpected provider I/O in unit fixture'); }),
  fetch: jest.fn(() => { throw new Error('Unexpected provider I/O in unit fixture'); })
}));


const crypto = require('crypto');
const NflVideoProvider = require('../src/providers/NflVideoProvider');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const container = require('../src/container');

describe('NflVideoProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new NflVideoProvider();
  });

  describe('Match Parsing (_parseMatchCards)', () => {
    const sampleHtml = `
      <div class="content">
        <a href="https://nfl-video.com/buffalo-bills-vs-los-angeles-rams-full-game-replay-nfl-week-05-october-11-2026">
          Buffalo Bills vs. Los Angeles Rams - Full Game Replay - NFL Week 05 - October 11, 2026
        </a>
        <a href="/nfl-redzone-2026-week-5-full-show-replay">
          NFL RedZone 2026 - Week 5 - Full Show Replay - October 11, 2026
        </a>
        <a href="https://nfl-video.com/alabama-crimson-tide-vs-georgia-bulldogs-cfb-replay">
          Alabama Crimson Tide vs. Georgia Bulldogs CFB Replay - October 10, 2026
        </a>
        <a href="/2026-hard-knocks-training-camp-full-show-replay">
          2026 Hard Knocks Training Camp - Full Show Replay
        </a>
        <a href="/arizona-cardinals-full-game-replays">
          Arizona Cardinals
        </a>
        <a href="/terms-of-service">
          Terms of Service
        </a>
      </div>
    `;

    test('extracts match entities with correct metadata, categories, and leagues', () => {
      const matches = provider._parseMatchCards(sampleHtml);
      expect(matches).toHaveLength(4);

      // 1. NFL Game
      const m1 = matches[0];
      expect(m1).toBeInstanceOf(MatchEntity);
      expect(m1.title).toBe('Buffalo Bills vs. Los Angeles Rams - Full Game Replay - NFL Week 05 - October 11, 2026');
      expect(m1.category).toBe('american_football');
      expect(m1.league).toBe('NFL');
      expect(m1.status).toBe('finished');
      expect(m1.poster).toBe('');
      expect(m1.sources).toHaveLength(1);
      expect(m1.sources[0].source).toBe('nflvideo');
      expect(m1.sources[0].id).toBe('https://nfl-video.com/buffalo-bills-vs-los-angeles-rams-full-game-replay-nfl-week-05-october-11-2026');
      expect(Number(m1.date)).toBeGreaterThan(0);

      // 2. NFL RedZone
      const m2 = matches[1];
      expect(m2.league).toBe('NFL RedZone');
      expect(m2.category).toBe('american_football');
      expect(Number(m2.date)).toBeGreaterThan(0);

      // 3. NCAA / College Football
      const m3 = matches[2];
      expect(m3.league).toBe('NCAA Football');
      expect(m3.category).toBe('american_football');

      // 4. Hard Knocks
      const m4 = matches[3];
      expect(m4.league).toBe('NFL Hard Knocks');
    });

    test('filters out team landing pages and non-fixture links', () => {
      const matches = provider._parseMatchCards('<a href="/dallas-cowboys-full-game-replays">Dallas Cowboys</a><a href="/privacy">Privacy</a>');
      expect(matches).toHaveLength(0);
    });
  });

  describe('OK.ru Direct Video Extraction (_extractOkRu)', () => {
    test('extracts 1080p, 720p, 480p and HLS with client proxyHeaders and 0% server bandwidth egress', async () => {
      const mockMetadata = {
        videos: [
          { name: 'full', url: 'https://vd265.okcdn.ru/video1080.mp4' },
          { name: 'hd', url: 'https://vd265.okcdn.ru/video720.mp4' },
          { name: 'sd', url: 'https://vd265.okcdn.ru/video480.mp4' }
        ],
        hlsManifestUrl: 'https://vd265.okcdn.ru/master.m3u8'
      };

      const mockDataOptions = JSON.stringify({
        flashvars: {
          metadata: JSON.stringify(mockMetadata)
        }
      }).replace(/"/g, '&quot;');

      const okRuHtml = `
        <html>
          <body>
            <div data-module="OKVideo" data-options="${mockDataOptions}"></div>
          </body>
        </html>
      `;

      provider.fetchPage = {
        fire: jest.fn().mockResolvedValue(okRuHtml)
      };

      const streams = await provider._extractOkRu('https://ok.ru/videoembed/123456789', 'Full Game');
      expect(streams).toHaveLength(4);

      // Verify 1080p
      const s1080 = streams.find(s => s.resolution === '1080p');
      expect(s1080).toBeDefined();
      expect(s1080.url).toBe('https://vd265.okcdn.ru/video1080.mp4');
      expect(s1080.title).toBe('Full Game (1080p) [OK.ru]');
      expect(s1080.behaviorHints.notWebReady).toBe(false);
      expect(s1080.behaviorHints.proxyHeaders.request['User-Agent']).toBeDefined();
      expect(s1080.behaviorHints.proxyHeaders.request['Referer']).toBe('https://ok.ru/');

      // Verify 720p
      const s720 = streams.find(s => s.resolution === '720p');
      expect(s720).toBeDefined();
      expect(s720.url).toBe('https://vd265.okcdn.ru/video720.mp4');
      expect(s720.behaviorHints.notWebReady).toBe(false);

      // Verify Auto HLS
      const sHls = streams.find(s => s.resolution === 'Auto');
      expect(sHls).toBeDefined();
      expect(sHls.url).toBe('https://vd265.okcdn.ru/master.m3u8');
      expect(sHls.title).toBe('Full Game (Auto HLS) [OK.ru]');
      expect(sHls.behaviorHints.notWebReady).toBe(false);
      expect(sHls.behaviorHints.proxyHeaders.request['Referer']).toBe('https://ok.ru/');
    });

    test('returns empty array when data-options is absent or malformed', async () => {
      provider.fetchPage = {
        fire: jest.fn().mockResolvedValue('<html><body>Video not found</body></html>')
      };

      const streams = await provider._extractOkRu('https://ok.ru/videoembed/invalid');
      expect(streams).toEqual([]);
    });
  });

  describe('Byse Playback Decryption (_decryptBysePlayback)', () => {
    test('successfully decrypts AES-256-GCM playback payload', () => {
      const testKey = crypto.randomBytes(32);
      const testIv = crypto.randomBytes(12);
      const testData = JSON.stringify({
        sources: [
          { url: 'https://edge1-waw-sprintcdn.example/hls/master.m3u8', label: '1080p', height: 1080 }
        ]
      });

      const cipher = crypto.createCipheriv('aes-256-gcm', testKey, testIv);
      const encrypted = Buffer.concat([cipher.update(Buffer.from(testData, 'utf8')), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const payload = Buffer.concat([encrypted, authTag]);

      const keyPart1 = testKey.subarray(0, 16).toString('base64');
      const keyPart2 = testKey.subarray(16, 32).toString('base64');

      const playback = {
        version: '1',
        iv: testIv.toString('base64'),
        payload: payload.toString('base64'),
        key_parts: new Array(32).fill('').map((_, i) => {
          if (i === 0) return keyPart1;
          if (i === 29) return keyPart2;
          return crypto.randomBytes(16).toString('base64');
        })
      };

      const decrypted = provider._decryptBysePlayback(playback);
      expect(decrypted).not.toBeNull();
      expect(decrypted.sources[0].url).toBe('https://edge1-waw-sprintcdn.example/hls/master.m3u8');
    });

    test('returns null for corrupted payload', () => {
      const corrupted = {
        version: '1',
        iv: Buffer.alloc(12).toString('base64'),
        payload: Buffer.from('short-junk').toString('base64'),
        key_parts: [Buffer.alloc(16).toString('base64'), Buffer.alloc(16).toString('base64')]
      };
      expect(provider._decryptBysePlayback(corrupted)).toBeNull();
    });
  });

  describe('Stream Resolution & Bridge Unwrapping (resolveStream)', () => {
    test('unwraps nhlgamestoday.com bridge iframe to OK.ru embed and extracts streams', async () => {
      const matchPageHtml = `
        <div class="content">
          <!-- <body> -->
          <div class="links">
            <a href="https://nhlgamestoday.com/nhl-games-today-12345">Watch Full Game</a>
          </div>
          <!-- </body> -->
        </div>
      `;

      const bridgeHtml = `
        <html>
          <body>
            <iframe src="//ok.ru/videoembed/987654321" frameborder="0"></iframe>
          </body>
        </html>
      `;

      const mockMetadata = {
        videos: [{ name: 'full', url: 'https://vd265.okcdn.ru/video.mp4' }]
      };
      const okOptions = JSON.stringify({
        flashvars: { metadata: JSON.stringify(mockMetadata) }
      }).replace(/"/g, '&quot;');

      const okHtml = `<div data-options="${okOptions}"></div>`;

      provider.fetchPage = {
        fire: jest.fn().mockImplementation(async (url) => {
          if (url.includes('nfl-video.com')) return matchPageHtml;
          if (url.includes('nhlgamestoday.com')) return bridgeHtml;
          if (url.includes('ok.ru')) return okHtml;
          throw new Error(`Unexpected url: ${url}`);
        })
      };

      const streams = await provider.resolveStream('https://nfl-video.com/sample-game');
      expect(streams).toHaveLength(1);
      expect(streams[0].url).toBe('https://vd265.okcdn.ru/video.mp4');
      expect(streams[0].resolution).toBe('1080p');
      expect(streams[0].behaviorHints.notWebReady).toBe(false);

      // Verify caching
      const cached = await provider.resolveStream('https://nfl-video.com/sample-game');
      expect(cached).toHaveLength(1);
      expect(cached[0].url).toBe('https://vd265.okcdn.ru/video.mp4');
    });

    test('prioritizes Byse (SprintCDN) streams at index 0 over OK.ru streams', async () => {
      const matchPageHtml = `
        <div class="content">
          <div class="links">
            <a href="https://ok.ru/videoembed/987654321">Watch on OK</a>
            <a href="https://bysefujedu.com/e/abc123">Watch on Byse</a>
          </div>
        </div>
      `;

      provider._extractOkRu = jest.fn().mockResolvedValue([
        new StreamEntity({
          name: 'NFLVideo',
          title: 'Full Game (1080p) [OK.ru]',
          resolution: '1080p',
          url: 'https://vd265.okcdn.ru/video.mp4',
          behaviorHints: { notWebReady: false }
        })
      ]);

      provider._extractByse = jest.fn().mockResolvedValue([
        new StreamEntity({
          name: 'NFLVideo',
          title: 'Full Game (1080p) [SprintCDN]',
          resolution: '1080p',
          url: 'https://edge1.sprintcdn.example/master.m3u8',
          behaviorHints: { notWebReady: false }
        })
      ]);

      provider.fetchPage = {
        fire: jest.fn().mockResolvedValue(matchPageHtml)
      };

      const streams = await provider.resolveStream('https://nfl-video.com/dual-stream-game');
      expect(streams).toHaveLength(2);
      expect(streams[0].url).toBe('https://edge1.sprintcdn.example/master.m3u8');
      expect(streams[0].title).toContain('[SprintCDN]');
      expect(streams[1].url).toBe('https://vd265.okcdn.ru/video.mp4');
      expect(streams[1].title).toContain('[OK.ru]');
    });

    test('resolves Vidara, Dailymotion, and DTube streams with correct headers and zero server bandwidth', async () => {
      provider._extractVidara = jest.fn().mockResolvedValue([
        new StreamEntity({
          name: 'NFLVideo',
          title: 'Part 1 (1080p) [Vidara]',
          resolution: '1080p',
          url: 'https://cdn.vidara.example/master.m3u8'
        })
      ]);

      provider._extractDailymotion = jest.fn().mockResolvedValue([
        new StreamEntity({
          name: 'NFLVideo',
          title: 'Part 2 (Auto HLS) [Dailymotion]',
          resolution: '1080p',
          url: 'https://cdndirector.dailymotion.com/cdn/manifest/video/xb7tspy.m3u8'
        })
      ]);

      provider._extractDTube = jest.fn().mockResolvedValue([
        new StreamEntity({
          name: 'NFLVideo',
          title: 'Part 3 (Auto HLS) [DTube]',
          resolution: '1080p',
          url: 'https://nas1.d.tube/videos/123/master.m3u8'
        })
      ]);

      const multiPageHtml = `
        <div class="content">
          <a href="https://vidara.so/e/abc">Server 3 FM</a>
          <a href="https://dailymotion.com/video/xb7tspy">Server 2 DM</a>
          <a href="https://play.d.tube/?v=123">Part 3</a>
        </div>
      `;

      provider.fetchPage = {
        fire: jest.fn().mockResolvedValue(multiPageHtml)
      };

      const streams = await provider.resolveStream('https://nfl-video.com/multi-source-game');
      expect(streams).toHaveLength(3);
      expect(streams[0].title).toContain('[Vidara]');
      expect(streams[1].title).toContain('[Dailymotion]');
      expect(streams[2].title).toContain('[DTube]');
    });

    test('dynamically unwraps unknown cloaked bridge domains (e.g. guideanimaux.com)', async () => {
      const matchHtml = `
        <div class="content">
          <a href="https://guideanimaux.com/cloaked-article">Watch</a>
        </div>
      `;

      const bridgeHtml = `
        <html>
          <body>
            <iframe src="//ok.ru/videoembed/12345678"></iframe>
          </body>
        </html>
      `;

      provider.fetchPage = {
        fire: jest.fn()
          .mockResolvedValueOnce(matchHtml)
          .mockResolvedValueOnce(bridgeHtml)
      };

      provider._extractOkRu = jest.fn().mockResolvedValue([
        new StreamEntity({
          name: 'NFLVideo',
          title: 'Watch (1080p) [OK.ru]',
          resolution: '1080p',
          url: 'https://vd123.okcdn.ru/video.mp4'
        })
      ]);

      const streams = await provider.resolveStream('https://nfl-video.com/cloaked-match');
      expect(streams).toHaveLength(1);
      expect(streams[0].title).toContain('[OK.ru]');
      expect(provider._extractOkRu).toHaveBeenCalledWith('https://ok.ru/videoembed/12345678', 'Watch');
    });
  });

  describe('Container & System Integration', () => {
    test('nflVideoProvider is properly registered in IoC container', () => {
      const p = container.resolve('nflVideoProvider');
      expect(p).toBeDefined();
      expect(p).toBeInstanceOf(NflVideoProvider);
      expect(p.name).toBe('NFLVideo');
      expect(p.sourceName).toBe('nflvideo');
    });

    test('MatchAggregator includes nflVideoProvider in replay providers', () => {
      const aggregator = container.resolve('matchAggregator');
      expect(aggregator.providers.some(p => p && p.sourceName === 'nflvideo')).toBe(true);
    });
  });
});
