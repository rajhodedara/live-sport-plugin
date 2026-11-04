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
const BasketballVideoProvider = require('../src/providers/BasketballVideoProvider');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const container = require('../src/container');

describe('BasketballVideoProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new BasketballVideoProvider();
  });

  describe('Match Parsing (_parseMatchCards)', () => {
    const sampleHtml = `
      <div class="content">
        <a href="https://basketball-video.com/golden-state-warriors-vs-los-angeles-lakers-october-9-2026-full-game-replay">
          Golden State Warriors vs Los Angeles Lakers October 9, 2026
        </a>
        <a href="/las-vegas-aces-vs-new-york-liberty-wnba-finals-october-10-2026">
          Las Vegas Aces vs New York Liberty WNBA Finals October 10, 2026
        </a>
        <a href="https://basketball-video.com/duke-blue-devils-vs-unc-tar-heels-cbb-replay">
          Duke Blue Devils vs UNC Tar Heels CBB Replay
        </a>
        <a href="/real-madrid-vs-panathinaikos-euroleague-game">
          Real Madrid vs Panathinaikos Euroleague Game
        </a>
        <a href="/about-us">
          About Us
        </a>
      </div>
    `;

    test('extracts match entities with correct metadata and league categories', () => {
      const matches = provider._parseMatchCards(sampleHtml);
      expect(matches).toHaveLength(4);

      // 1. NBA Game
      const m1 = matches[0];
      expect(m1).toBeInstanceOf(MatchEntity);
      expect(m1.title).toBe('Golden State Warriors vs Los Angeles Lakers October 9, 2026');
      expect(m1.category).toBe('basketball');
      expect(m1.league).toBe('NBA');
      expect(m1.status).toBe('finished');
      expect(m1.poster).toBe('');
      expect(m1.sources).toHaveLength(1);
      expect(m1.sources[0].source).toBe('basketballvideo');
      expect(m1.sources[0].id).toBe('https://basketball-video.com/golden-state-warriors-vs-los-angeles-lakers-october-9-2026-full-game-replay');
      expect(Number(m1.date)).toBeGreaterThan(0);

      // 2. WNBA Game
      const m2 = matches[1];
      expect(m2.league).toBe('WNBA');
      expect(Number(m2.date)).toBeGreaterThan(0);

      // 3. NCAA / CBB Game
      const m3 = matches[2];
      expect(m3.league).toBe('NCAA');

      // 4. Euroleague Game
      const m4 = matches[3];
      expect(m4.league).toBe('Euroleague');
    });

    test('filters out non-match links cleanly', () => {
      const matches = provider._parseMatchCards('<a href="/terms">Terms of Service</a><a href="/privacy">Privacy</a>');
      expect(matches).toHaveLength(0);
    });
  });

  describe('OK.ru Direct Video Extraction (_extractOkRu)', () => {
    test('extracts 1080p, 720p, 480p and HLS with 0% server bandwidth egress (notWebReady: false)', async () => {
      const mockMetadata = {
        videos: [
          { name: 'full', url: 'https://vd123.okcdn.ru/video1080.mp4' },
          { name: 'hd', url: 'https://vd123.okcdn.ru/video720.mp4' },
          { name: 'sd', url: 'https://vd123.okcdn.ru/video480.mp4' }
        ],
        hlsManifestUrl: 'https://vd123.okcdn.ru/master.m3u8'
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

      const streams = await provider._extractOkRu('https://ok.ru/videoembed/987654321', 'Full Game');
      // Deduplicated: only top quality (1080p) + Auto HLS returned to prevent 240p/360p/480p clutter
      expect(streams).toHaveLength(2);

      // Verify 1080p top quality
      const s1080 = streams.find(s => s.resolution === '1080p');
      expect(s1080).toBeDefined();
      expect(s1080.url).toBe('https://vd123.okcdn.ru/video1080.mp4');
      expect(s1080.title).toBe('Full Game (1080p) [OK.ru]');
      expect(s1080.behaviorHints.notWebReady).toBe(false);

      // Lower bitrates (720p, 480p) should be suppressed
      const s720 = streams.find(s => s.resolution === '720p');
      expect(s720).toBeUndefined();
      const s480 = streams.find(s => s.resolution === '480p');
      expect(s480).toBeUndefined();

      // Verify Auto HLS
      const sHls = streams.find(s => s.resolution === 'Auto');
      expect(sHls).toBeDefined();
      expect(sHls.url).toBe('https://vd123.okcdn.ru/master.m3u8');
      expect(sHls.title).toBe('Full Game (Auto HLS) [OK.ru]');
      expect(sHls.behaviorHints.notWebReady).toBe(false);
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
          { url: 'https://cdn.byse.example/master.m3u8', label: '1080p', height: 1080 }
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
          if (i === 29) return keyPart2; // 31 - 1 - 1 = 29
          return crypto.randomBytes(16).toString('base64');
        })
      };

      const decrypted = provider._decryptBysePlayback(playback);
      expect(decrypted).not.toBeNull();
      expect(decrypted.sources[0].url).toBe('https://cdn.byse.example/master.m3u8');
    });

    test('returns null for invalid ciphertext or auth tag mismatch', () => {
      const corrupted = {
        version: '1',
        iv: Buffer.alloc(12).toString('base64'),
        payload: Buffer.from('invalid-non-gcm-data-that-is-short').toString('base64'),
        key_parts: [Buffer.alloc(16).toString('base64'), Buffer.alloc(16).toString('base64')]
      };
      expect(provider._decryptBysePlayback(corrupted)).toBeNull();
    });
  });

  describe('Stream Resolution & Bridge Unwrapping (resolveStream)', () => {
    test('unwraps nbaontv.com bridge iframe to OK.ru embed and extracts streams', async () => {
      const matchPageHtml = `
        <div class="content">
          <!-- <body> -->
          <div class="links">
            <a href="https://nbaontv.com/embed/12345">Watch Full Game</a>
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
        videos: [{ name: 'full', url: 'https://vd123.okcdn.ru/video.mp4' }]
      };
      const okOptions = JSON.stringify({
        flashvars: { metadata: JSON.stringify(mockMetadata) }
      }).replace(/"/g, '&quot;');

      const okHtml = `<div data-options="${okOptions}"></div>`;

      provider.fetchPage = {
        fire: jest.fn().mockImplementation(async (url) => {
          if (url.includes('basketball-video.com')) return matchPageHtml;
          if (url.includes('nbaontv.com')) return bridgeHtml;
          if (url.includes('ok.ru')) return okHtml;
          throw new Error(`Unexpected url: ${url}`);
        })
      };

      const streams = await provider.resolveStream('https://basketball-video.com/sample-game');
      expect(streams).toHaveLength(1);
      expect(streams[0].url).toBe('https://vd123.okcdn.ru/video.mp4');
      expect(streams[0].resolution).toBe('1080p');
      expect(streams[0].behaviorHints.notWebReady).toBe(false);

      // Verify caching works (second call returns cached streams without refetching)
      const cached = await provider.resolveStream('https://basketball-video.com/sample-game');
      expect(cached).toHaveLength(1);
      expect(cached[0].url).toBe('https://vd123.okcdn.ru/video.mp4');
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
          name: 'BasketballVideo',
          title: 'Full Game (1080p) [OK.ru]',
          resolution: '1080p',
          url: 'https://vd123.okcdn.ru/video.mp4',
          behaviorHints: { notWebReady: false }
        })
      ]);

      provider._extractByse = jest.fn().mockResolvedValue([
        new StreamEntity({
          name: 'BasketballVideo',
          title: 'Full Game (1080p) [SprintCDN]',
          resolution: '1080p',
          url: 'https://edge1.sprintcdn.example/master.m3u8',
          behaviorHints: { notWebReady: false }
        })
      ]);

      provider.fetchPage = {
        fire: jest.fn().mockResolvedValue(matchPageHtml)
      };

      const streams = await provider.resolveStream('https://basketball-video.com/dual-stream-game');
      expect(streams).toHaveLength(2);
      expect(streams[0].url).toBe('https://edge1.sprintcdn.example/master.m3u8');
      expect(streams[0].title).toContain('[SprintCDN]');
      expect(streams[1].url).toBe('https://vd123.okcdn.ru/video.mp4');
      expect(streams[1].title).toContain('[OK.ru]');
    });
  });

  describe('Container & System Integration', () => {
    test('basketballVideoProvider is properly registered in IoC container', () => {
      const p = container.resolve('basketballVideoProvider');
      expect(p).toBeDefined();
      expect(p).toBeInstanceOf(BasketballVideoProvider);
      expect(p.name).toBe('BasketballVideo');
      expect(p.sourceName).toBe('basketballvideo');
    });

    test('MatchAggregator includes basketballVideoProvider in replay providers', () => {
      const aggregator = container.resolve('matchAggregator');
      expect(aggregator.providers.some(p => p && p.sourceName === 'basketballvideo')).toBe(true);
    });
  });
});
