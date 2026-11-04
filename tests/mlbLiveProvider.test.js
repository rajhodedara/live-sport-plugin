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
const MlbLiveProvider = require('../src/providers/MlbLiveProvider');
const LiveTVProvider = require('../src/providers/LiveTVProvider');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const container = require('../src/container');

describe('MlbLiveProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new MlbLiveProvider();
  });

  describe('Match Parsing (_parseMatchCards)', () => {
    const sampleHtml = `
      <div class="content">
        <a href="https://mlblive.net/new-york-yankees-vs-los-angeles-dodgers-full-game-replay-october-15-2026">
          New York Yankees vs Los Angeles Dodgers - Full Game Replay - October 15, 2026
        </a>
        <a href="/world-series-game-7-toronto-blue-jays-vs-atlanta-braves-replay-october-28-2026">
          World Series Game 7 - Toronto Blue Jays vs Atlanta Braves - Replay - October 28, 2026
        </a>
        <a href="https://mlblive.net/boston-red-sox-vs-chicago-white-sox-full-game-replay">
          Boston Red Sox vs Chicago White Sox - Full Game Replay
        </a>
        <a href="/privacy-policy">
          Privacy Policy
        </a>
        <a href="/2026-mlb-full-game-replays">
          2026 MLB Full Game Replays
        </a>
      </div>
    `;

    test('extracts match entities with correct metadata, categories, and leagues', () => {
      const matches = provider._parseMatchCards(sampleHtml);
      expect(matches).toHaveLength(3);

      // 1. Regular/Playoff MLB Game
      const m1 = matches[0];
      expect(m1).toBeInstanceOf(MatchEntity);
      expect(m1.title).toBe('New York Yankees vs Los Angeles Dodgers - Full Game Replay - October 15, 2026');
      expect(m1.category).toBe('baseball');
      expect(m1.league).toBe('MLB');
      expect(m1.status).toBe('finished');
      expect(m1.sources).toHaveLength(1);
      expect(m1.sources[0].source).toBe('mlblive');
      expect(m1.sources[0].id).toBe('https://mlblive.net/new-york-yankees-vs-los-angeles-dodgers-full-game-replay-october-15-2026');
      expect(m1.team1.name).toBe('New York Yankees');
      expect(m1.team2.name).toBe('Los Angeles Dodgers');

      // 2. World Series Game
      const m2 = matches[1];
      expect(m2.league).toBe('MLB World Series');
      expect(m2.category).toBe('baseball');
      expect(m2.team1.name).toBe('Toronto Blue Jays');
      expect(m2.team2.name).toBe('Atlanta Braves');

      // 3. Red Sox vs White Sox
      const m3 = matches[2];
      expect(m3.league).toBe('MLB');
      expect(m3.team1.name).toBe('Boston Red Sox');
      expect(m3.team2.name).toBe('Chicago White Sox');
    });

    test('filters out landing pages, navigation links, and duplicate paths', () => {
      const matches = provider._parseMatchCards('<a href="/terms">Terms</a><a href="/contact">Contact</a>');
      expect(matches).toHaveLength(0);
    });
  });

  describe('OK.ru Direct Video Extraction (_extractOkRu)', () => {
    test('extracts 1080p, 720p, 480p and HLS with client proxyHeaders and 0% server bandwidth egress', async () => {
      const mockMetadata = {
        videos: [
          { name: 'full', url: 'https://vd500.okcdn.ru/video1080.mp4' },
          { name: 'hd', url: 'https://vd500.okcdn.ru/video720.mp4' },
          { name: 'sd', url: 'https://vd500.okcdn.ru/video480.mp4' }
        ],
        hlsManifestUrl: 'https://vd500.okcdn.ru/master.m3u8'
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

      const streams = await provider._extractOkRu('//ok.ru/videoembed/1234567890', 'Full Game');
      expect(streams).toHaveLength(4);

      // Auto HLS
      const hlsStream = streams.find((s) => s.resolution === 'Auto');
      expect(hlsStream).toBeDefined();
      expect(hlsStream.url).toBe('https://vd500.okcdn.ru/master.m3u8');
      expect(hlsStream.behaviorHints.proxyHeaders.request['Referer']).toBe('https://ok.ru/');
      expect(hlsStream.behaviorHints.notWebReady).toBe(false);

      // 1080p MP4
      const p1080Stream = streams.find((s) => s.resolution === '1080p');
      expect(p1080Stream).toBeDefined();
      expect(p1080Stream.url).toBe('https://vd500.okcdn.ru/video1080.mp4');
      expect(p1080Stream.behaviorHints.proxyHeaders.request['Referer']).toBe('https://ok.ru/');
    });
  });

  describe('Byse AES-256-GCM Decryption (_decryptBysePlayback)', () => {
    test('successfully decrypts AES-256-GCM playback payload into SprintCDN streams', () => {
      const testKey = crypto.randomBytes(32);
      const testIv = crypto.randomBytes(12);

      const testData = JSON.stringify({
        sources: [
          { url: 'https://edge1-waw-sprintcdn.example/hls/mlb_master.m3u8', label: '1080p', height: 1080 }
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
      expect(decrypted.sources[0].url).toBe('https://edge1-waw-sprintcdn.example/hls/mlb_master.m3u8');
    });

    test('returns null for corrupted payload or invalid authTag', () => {
      const corrupted = {
        version: '1',
        iv: Buffer.alloc(12).toString('base64'),
        payload: Buffer.from('corrupted-data').toString('base64'),
        key_parts: [Buffer.alloc(16).toString('base64'), Buffer.alloc(16).toString('base64')]
      };
      expect(provider._decryptBysePlayback(corrupted)).toBeNull();
    });
  });

  describe('Stream Resolution & Priority (resolveStream)', () => {
    test('prioritizes Byse (SprintCDN) streams over OK.ru and caches results', async () => {
      const matchPageHtml = `
        <div class="content">
          <iframe src="//ok.ru/videoembed/999888777"></iframe>
          <iframe src="https://bysesukior.com/e/mlbxyz"></iframe>
        </div>
      `;

      provider.fetchPage = {
        fire: jest.fn().mockImplementation(async (url) => {
          if (url.includes('mlblive.net')) return matchPageHtml;
          throw new Error(`Unexpected url: ${url}`);
        })
      };

      provider._extractOkRu = jest.fn().mockResolvedValue([
        new StreamEntity({
          name: 'MLBLive [Replay]',
          title: 'MLBLive (OK.ru) - 720p',
          url: 'https://vd500.okcdn.ru/720.mp4',
          resolution: '720p',
          isDirect: true
        })
      ]);

      provider._extractByse = jest.fn().mockResolvedValue([
        new StreamEntity({
          name: 'MLBLive [Replay]',
          title: 'MLBLive (SprintCDN) - 1080p',
          url: 'https://edge-sprintcdn.example/master.m3u8',
          resolution: '1080p',
          isDirect: true
        })
      ]);

      const streams = await provider.resolveStream('https://mlblive.net/game-test');
      expect(streams).toHaveLength(2);
      expect(streams[0].title).toContain('SprintCDN');
      expect(streams[1].title).toContain('OK.ru');

      // Second call uses cache
      const cached = await provider.resolveStream('https://mlblive.net/game-test');
      expect(cached).toHaveLength(2);
      expect(provider.fetchPage.fire).toHaveBeenCalledTimes(1);
    });
  });

  describe('LiveTVProvider MLB Normalization & Archive Parsing', () => {
    test('normalizes MLB franchise names from LiveTV archive tables', () => {
      const mockHtml = `
        <a class="main" href="/enx/videotourney/99/"><b>MLB</b></a>
        <table height=27>
          <tr>
            <td><b>NY Yankees&ndash;LA Dodgers</b></td>
            <td><font color="#949494"><b>5:3</b></font></td>
            <td><span class="date">23:00</span></td>
            <td><a class="small" href="/enx/showvideo/999_nyy_lad">Highlights</a></td>
          </tr>
        </table>
        <table height=27>
          <tr>
            <td><b>Boston&ndash;Chi White Sox</b></td>
            <td><font color="#949494"><b>4:2</b></font></td>
            <td><span class="date">23:30</span></td>
            <td><a class="small" href="/enx/showvideo/998_bos_cws">Highlights</a></td>
          </tr>
        </table>
      `;

      const items = LiveTVProvider.parseArchive(mockHtml, '20261015');
      expect(items).toHaveLength(2);

      expect(items[0].title).toBe('New York Yankees vs Los Angeles Dodgers - MLB');
      expect(items[0].team1).toEqual({ name: 'New York Yankees' });
      expect(items[0].team2).toEqual({ name: 'Los Angeles Dodgers' });
      expect(items[0].category).toBe('baseball');
      expect(items[0].league).toBe('MLB');

      expect(items[1].title).toBe('Boston Red Sox vs Chicago White Sox - MLB');
      expect(items[1].team1).toEqual({ name: 'Boston Red Sox' });
      expect(items[1].team2).toEqual({ name: 'Chicago White Sox' });
      expect(items[1].category).toBe('baseball');
      expect(items[1].league).toBe('MLB');
    });
  });

  describe('MatchAggregator Multi-Source Replay Merging', () => {
    test('coalesces LiveTV and MLBLive games into unified master card with isSameEvent', () => {
      const aggregator = container.resolve('matchAggregator');

      const liveTvMatch = {
        id: 'livetv-mlb-12345',
        title: 'New York Yankees vs Los Angeles Dodgers - MLB',
        category: 'baseball',
        league: 'MLB',
        date: '2026-10-15T23:00:00.000Z',
        status: 'finished',
        team1: { name: 'New York Yankees' },
        team2: { name: 'Los Angeles Dodgers' },
        sources: [
          {
            source: 'livetv',
            id: 'livetv-mlb-12345',
            name: 'Highlights'
          }
        ]
      };

      const mlbLiveMatch = {
        id: 'mlb_new-york-yankees-vs-los-angeles-dodgers',
        title: 'New York Yankees vs Los Angeles Dodgers - Full Game Replay - October 15, 2026',
        category: 'baseball',
        league: 'MLB',
        date: '2026-10-15T00:00:00.000Z',
        status: 'finished',
        team1: { name: 'New York Yankees' },
        team2: { name: 'Los Angeles Dodgers' },
        sources: [
          {
            source: 'mlblive',
            id: 'https://mlblive.net/new-york-yankees-vs-los-angeles-dodgers-full-game-replay-october-15-2026',
            name: 'Full Game Replay'
          }
        ]
      };

      expect(aggregator.isSameEvent(liveTvMatch, mlbLiveMatch)).toBe(true);
    });

    test('coalesces compound team names like Red Sox and White Sox correctly', () => {
      const aggregator = container.resolve('matchAggregator');

      const liveTvMatch = {
        id: 'livetv-mlb-67890',
        title: 'Boston Red Sox vs Chicago White Sox - MLB',
        category: 'baseball',
        league: 'MLB',
        date: '2026-10-16T23:00:00.000Z',
        status: 'finished',
        team1: { name: 'Boston Red Sox' },
        team2: { name: 'Chicago White Sox' },
        sources: [
          {
            source: 'livetv',
            id: 'livetv-mlb-67890',
            name: 'Highlights'
          }
        ]
      };

      const mlbLiveMatch = {
        id: 'mlb_boston-red-sox-vs-chicago-white-sox',
        title: 'Boston Red Sox vs Chicago White Sox - Full Game Replay',
        category: 'baseball',
        league: 'MLB',
        date: '2026-10-16T00:00:00.000Z',
        status: 'finished',
        team1: { name: 'Boston Red Sox' },
        team2: { name: 'Chicago White Sox' },
        sources: [
          {
            source: 'mlblive',
            id: 'https://mlblive.net/boston-red-sox-vs-chicago-white-sox-full-game-replay',
            name: 'Full Game Replay'
          }
        ]
      };

      expect(aggregator.isSameEvent(liveTvMatch, mlbLiveMatch)).toBe(true);
    });
  });

  describe('Container Registration', () => {
    test('mlbLiveProvider is registered in container and available as a replay provider', () => {
      const resolvedProvider = container.resolve('mlbLiveProvider');
      expect(resolvedProvider).toBeInstanceOf(MlbLiveProvider);
      expect(resolvedProvider.sourceName).toBe('mlblive');

      const aggregator = container.resolve('matchAggregator');
      expect(aggregator.providers.some((p) => p && p.sourceName === 'mlblive')).toBe(true);
    });
  });
});
