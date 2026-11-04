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
const FullRacesProvider = require('../src/providers/FullRacesProvider');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const container = require('../src/container');

describe('FullRacesProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new FullRacesProvider();
  });

  describe('Container DI Registration', () => {
    test('resolves fullRacesProvider singleton from Awilix container', () => {
      const resolved = container.resolve('fullRacesProvider');
      expect(resolved).toBeDefined();
      expect(resolved).toBeInstanceOf(FullRacesProvider);
      expect(resolved.sourceName).toBe('fullraces');
    });
  });

  describe('Match Parsing (_parseListingHtml)', () => {
    const sampleHtml = `
      <div class="short_item block_elem">
        <div class="poster">
          <a href="/f1-australian-grand-prix-march-08-2026-full-race-replay">
            <img src="/img/f1_australia_2026.png" alt="F1 Australian Grand Prix 2026">
          </a>
        </div>
        <div class="short_descr">
          <h3>
            <a href="/f1-australian-grand-prix-march-08-2026-full-race-replay">Formula 1 Australian Grand Prix March 08, 2026 Full Race Replay</a>
          </h3>
          <div class="short_cat">
            <a href="/2026">Formula 1</a>
          </div>
          <div class="short_descr">
            <p>Formula 1 Australian Grand Prix March 08, 2026 Replay. Watch full race online.</p>
          </div>
        </div>
      </div>
      <div class="short_item block_elem">
        <div class="poster">
          <a href="https://fullraces.com/indycar-firestone-grand-prix-of-st-petersburg-2026">
            <img src="https://fullraces.com/img/indy_stpete.png" alt="IndyCar St. Petersburg">
          </a>
        </div>
        <div class="short_descr">
          <h3>
            <a href="https://fullraces.com/indycar-firestone-grand-prix-of-st-petersburg-2026">IndyCar Firestone Grand Prix of St. Petersburg March 01, 2026</a>
          </h3>
          <div class="short_cat">
            <a href="/indycar">IndyCar</a>
          </div>
          <div class="short_descr">
            <p>IndyCar Firestone Grand Prix of St. Petersburg March 01, 2026 Full Race.</p>
          </div>
        </div>
      </div>
      <div class="short_item block_elem">
        <div class="poster">
          <a href="/nascar-daytona-500-february-15-2026">
            <img src="/img/daytona.png" alt="NASCAR Daytona 500">
          </a>
        </div>
        <div class="short_descr">
          <h3>
            <a href="/nascar-daytona-500-february-15-2026">NASCAR Cup Series Daytona 500 February 15, 2026</a>
          </h3>
          <div class="short_cat">
            <a href="/nascar">NASCAR</a>
          </div>
          <div class="short_descr">
            <p>NASCAR Cup Series Daytona 500 February 15, 2026 Full Race Replay.</p>
          </div>
        </div>
      </div>
    `;

    test('extracts match entities with correct metadata, league, and provider thumbnail', () => {
      const matches = provider._parseListingHtml(sampleHtml);
      expect(matches).toHaveLength(3);

      // 1. Formula 1
      const m1 = matches[0];
      expect(m1).toBeInstanceOf(MatchEntity);
      expect(m1.id).toBe('fr_f1-australian-grand-prix-march-08-2026-full-race-replay');
      expect(m1.title).toBe('Formula 1 Australian Grand Prix March 08, 2026 Full Race Replay');
      expect(m1.category).toBe('motorsport');
      expect(m1.league).toBe('Formula 1');
      expect(m1.status).toBe('finished');
      expect(Number(m1.date)).toBeGreaterThan(0);
      expect(new Date(Number(m1.date)).toISOString().slice(0, 10)).toBe('2026-03-08');
      expect(m1.poster).toBe('https://fullraces.com/img/f1_australia_2026.png');
      expect(m1.thumbnail_url).toBe('https://fullraces.com/img/f1_australia_2026.png');
      expect(m1.sources).toHaveLength(1);
      expect(m1.sources[0].source).toBe('fullraces');
      expect(m1.sources[0].url).toBe('https://fullraces.com/f1-australian-grand-prix-march-08-2026-full-race-replay');

      // 2. IndyCar
      const m2 = matches[1];
      expect(m2.league).toBe('IndyCar');
      expect(Number(m2.date)).toBeGreaterThan(0);
      expect(new Date(Number(m2.date)).toISOString().slice(0, 10)).toBe('2026-03-01');
      expect(m2.poster).toBe('https://fullraces.com/img/indy_stpete.png');

      // 3. NASCAR
      const m3 = matches[2];
      expect(m3.league).toBe('NASCAR');
      expect(Number(m3.date)).toBeGreaterThan(0);
      expect(new Date(Number(m3.date)).toISOString().slice(0, 10)).toBe('2026-02-15');
    });

    test('gracefully returns empty array for non-matching or empty HTML', () => {
      const matches = provider._parseListingHtml('<div>No race items found</div>');
      expect(matches).toEqual([]);
    });
  });

  describe('Source Extraction from Race Detail HTML (_extractSourcesFromHtml)', () => {
    const detailHtml = `
      <div class="news_entry">
        <p style="text-align: center;"><span><strong>Qualifying</strong></span></p>
        <p style="text-align: center;">
          <a href="https://ok.ru/videoembed/111222333" target="_blank">Full HD (OK.ru)</a>
          <a href="https://bysesukior.com/e/abc123code" target="_blank">Full HD (Filemoon)</a>
        </p>
        <p style="text-align: center;"><span><strong>Race</strong></span></p>
        <p style="text-align: center;">
          <a href="https://ok.ru/videoembed/444555666" target="_blank">Full HD (OK.ru)</a>
          <a href="https://www.dailymotion.com/video/x9abcdef" target="_blank">Part 1 (Dailymotion)</a>
        </p>
        <div class="video_iframe">
          <iframe src="//ok.ru/videoembed/777888999" frameborder="0"></iframe>
        </div>
      </div>
    `;

    test('extracts section buttons and direct iframes with clean part names', () => {
      const sources = provider._extractSourcesFromHtml(detailHtml);
      expect(sources.length).toBeGreaterThanOrEqual(4);

      // Section Qualifying OK.ru
      const qOk = sources.find(s => s.url.includes('111222333'));
      expect(qOk).toBeDefined();
      expect(qOk.name).toContain('Qualifying');
      expect(qOk.type).toBe('ok');

      // Section Qualifying Byse/Filemoon
      const qByse = sources.find(s => s.url.includes('abc123code'));
      expect(qByse).toBeDefined();
      expect(qByse.type).toBe('byse');

      // Section Race Dailymotion
      const rDm = sources.find(s => s.url.includes('x9abcdef'));
      expect(rDm).toBeDefined();
      expect(rDm.type).toBe('dailymotion');

      // Direct iframe
      const directIframe = sources.find(s => s.url.includes('777888999'));
      expect(directIframe).toBeDefined();
      expect(directIframe.url).toBe('https://ok.ru/videoembed/777888999');
    });
  });

  describe('OK.ru Direct Video Extraction (_resolveOkRu)', () => {
    test('extracts direct 1080p MP4 CDN and Auto HLS with 0% server egress proxyHeaders', async () => {
      const mockMeta = {
        videos: [
          { name: 'full', url: 'https://vd101.okcdn.ru/video1080.mp4' },
          { name: 'hd', url: 'https://vd101.okcdn.ru/video720.mp4' },
          { name: 'sd', url: 'https://vd101.okcdn.ru/video480.mp4' }
        ],
        hlsManifestUrl: 'https://vd101.okcdn.ru/master.m3u8'
      };

      const mockDataOptions = JSON.stringify({
        flashvars: {
          metadata: JSON.stringify(mockMeta)
        }
      }).replace(/"/g, '&quot;');

      const okHtml = `<html><body><div data-module="OKVideo" data-options="${mockDataOptions}"></div></body></html>`;

      // Mock undici.request for OK.ru
      const undici = require('../src/services/ProviderOutbound');
      jest.spyOn(undici, 'request').mockResolvedValueOnce({
        statusCode: 200,
        body: {
          text: async () => okHtml
        }
      });

      const streams = await provider._resolveOkRu('https://ok.ru/videoembed/123456789', 'Race');
      expect(streams).toHaveLength(2);

      // Best MP4 video (1080p)
      const mp4Stream = streams.find(s => s.resolution === '1080p');
      expect(mp4Stream).toBeDefined();
      expect(mp4Stream.url).toBe('https://vd101.okcdn.ru/video1080.mp4');
      expect(mp4Stream.title).toContain('Race (1080p) [OK.ru]');
      expect(mp4Stream.behaviorHints.notWebReady).toBe(false);
      expect(mp4Stream.behaviorHints.proxyHeaders.request['Referer']).toBe('https://ok.ru/');

      // Auto HLS
      const hlsStream = streams.find(s => s.resolution === 'Auto');
      expect(hlsStream).toBeDefined();
      expect(hlsStream.url).toBe('https://vd101.okcdn.ru/master.m3u8');
      expect(hlsStream.title).toContain('Race (Auto HLS) [OK.ru]');

      jest.restoreAllMocks();
    });
  });

  describe('Byse Playback Decryption (_decryptBysePlayback & extractByse)', () => {
    test('successfully decrypts AES-256-GCM playback payload and yields SprintCDN stream', async () => {
      const testKey = crypto.randomBytes(32);
      const testIv = crypto.randomBytes(12);
      const testData = JSON.stringify({
        sources: [
          { url: 'https://sprintcdn.net/hls/master.m3u8', label: '1080p', height: 1080 }
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
      expect(decrypted.sources[0].url).toBe('https://sprintcdn.net/hls/master.m3u8');

      // Test extractByse end-to-end with mock API response
      const undici = require('../src/services/ProviderOutbound');
      jest.spyOn(undici, 'request').mockResolvedValueOnce({
        statusCode: 200,
        body: {
          json: async () => ({ playback })
        }
      });

      const streams = await provider.extractByse('https://bysesukior.com/e/testcode', 'Race');
      expect(streams).toHaveLength(1);
      expect(streams[0].url).toBe('https://sprintcdn.net/hls/master.m3u8');
      expect(streams[0].resolution).toBe('1080p');
      expect(streams[0].title).toContain('Race (1080p) [SprintCDN]');
      expect(streams[0].behaviorHints.notWebReady).toBe(false);
      expect(streams[0].behaviorHints.proxyHeaders.request['Referer']).toBe('https://bysesukior.com/');

      jest.restoreAllMocks();
    });
  });

  describe('Full Catalog Ingestion Caching (getMatches)', () => {
    test('caches matches for 1 hour avoiding redundant category scrapes', async () => {
      const mockMatches = [
        new MatchEntity({
          id: 'fr_test-gp-2026',
          title: 'Test GP 2026',
          category: 'motorsport',
          league: 'Formula 1',
          date: '2026-03-15',
          sources: [{ source: 'fullraces', id: 'https://fullraces.com/test-gp-2026' }]
        })
      ];

      provider._fetchHtml = jest.fn().mockResolvedValue('<html></html>');
      provider._parseListingHtml = jest.fn().mockReturnValue(mockMatches);

      const matches1 = await provider.getMatches();
      expect(matches1).toHaveLength(1);
      expect(provider._fetchHtml).toHaveBeenCalled();

      // Second call should return cached result immediately without calling _fetchHtml
      const fetchCallsBefore = provider._fetchHtml.mock.calls.length;
      const matches2 = await provider.getMatches();
      expect(matches2).toEqual(matches1);
      expect(provider._fetchHtml.mock.calls.length).toBe(fetchCallsBefore);
    });
  });
});
