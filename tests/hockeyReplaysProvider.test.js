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
const HockeyReplaysProvider = require('../src/providers/HockeyReplaysProvider');
const MatchAggregator = require('../src/services/MatchAggregator');
const StreamEntity = require('../src/domain/StreamEntity');
const undici = require('../src/services/ProviderOutbound');

describe('HockeyReplaysProvider & NHL Replay Merging', () => {
  let provider;

  beforeEach(() => {
    provider = new HockeyReplaysProvider();
    jest.clearAllMocks();
  });

  describe('Match Listing Parsing (_parseMatchCards)', () => {
    it('correctly extracts and normalizes NHL game replay cards', () => {
      const sampleHtml = `
        <div class="aside_content">
          <div class="inf_raited">
            <div class="inf_raited_img">
              <a href="https://hockeyreplays.com/calgary-flames-vegas-golden-knights-nhl-regular-season-full-game-replay-october-15-2026">
                Calgary Flames @ Vegas Golden Knights - NHL Regular Season - Full Game Replay - October 15, 2026
              </a>
            </div>
          </div>
          <div class="inf_raited">
            <div class="inf_raited_img">
              <a href="/edmonton-oilers-florida-panthers-stanley-cup-finals-game-7-full-game-replay-june-24-2025">
                Edmonton Oilers vs Florida Panthers - Stanley Cup Finals Game 7 - Full Game Replay - June 24, 2025
              </a>
            </div>
          </div>
        </div>
      `;

      const matches = provider._parseMatchCards(sampleHtml);
      expect(matches).toHaveLength(2);

      const m1 = matches[0];
      expect(m1.title).toBe('Calgary Flames vs Vegas Golden Knights - NHL Regular Season - Full Game Replay - October 15, 2026');
      expect(m1.category).toBe('hockey');
      expect(m1.league).toBe('NHL Regular Season');
      expect(m1.team1).toEqual({ name: 'Calgary Flames' });
      expect(m1.team2).toEqual({ name: 'Vegas Golden Knights' });
      expect(new Date(Number(m1.date)).toISOString()).toContain('2026-10-15');
      expect(m1.sources[0].source).toBe('hockeyreplays');
      expect(m1.sources[0].url).toBe('https://hockeyreplays.com/calgary-flames-vegas-golden-knights-nhl-regular-season-full-game-replay-october-15-2026');

      const m2 = matches[1];
      expect(m2.title).toBe('Edmonton Oilers vs Florida Panthers - Stanley Cup Finals Game 7 - Full Game Replay - June 24, 2025');
      expect(m2.category).toBe('hockey');
      expect(m2.league).toBe('NHL Playoffs');
      expect(m2.team1).toEqual({ name: 'Edmonton Oilers' });
      expect(m2.team2).toEqual({ name: 'Florida Panthers' });
      expect(new Date(Number(m2.date)).toISOString()).toContain('2025-06-24');
    });
  });

  describe('Ok.ru Direct Stream Extraction (_extractOkRu)', () => {
    it('decrypts metadata into direct 1080p MP4 and HLS streams with proxy headers', async () => {
      const mockOkOptions = {
        flashvars: {
          metadata: JSON.stringify({
            videos: [
              { name: 'full', url: 'https://vd1.okcdn.ru/video_1080.mp4' },
              { name: 'hd', url: 'https://vd1.okcdn.ru/video_720.mp4' }
            ],
            hlsMasterPlaylistUrl: 'https://vd1.okcdn.ru/video.m3u8'
          })
        }
      };

      const rawJson = JSON.stringify(mockOkOptions).replace(/"/g, '&quot;');
      const mockOkHtml = `<html><body><div data-module="OKVideo" data-options="${rawJson}"></div></body></html>`;

      provider.fetchPage = {
        fire: jest.fn().mockResolvedValue(mockOkHtml)
      };

      const streams = await provider._extractOkRu('https://ok.ru/videoembed/16513884883628', 'Full Game');
      expect(streams.length).toBe(3);

      const mp4Stream = streams.find(s => s.name.includes('1080p'));
      expect(mp4Stream).toBeDefined();
      expect(mp4Stream.url).toBe('https://vd1.okcdn.ru/video_1080.mp4');
      expect(mp4Stream.behaviorHints.proxyHeaders.request.Referer).toBe('https://ok.ru/');

      const hlsStream = streams.find(s => s.name.includes('Adaptive HLS'));
      expect(hlsStream).toBeDefined();
      expect(hlsStream.url).toBe('https://vd1.okcdn.ru/video.m3u8');
    });
  });

  describe('Dailymotion Direct Auto HLS Extraction (_extractDailymotion)', () => {
    it('extracts Auto HLS manifest and handles string or array set-cookie headers', async () => {
      undici.request.mockResolvedValueOnce({
        statusCode: 200,
        headers: {
          'set-cookie': 'ts=12345; path=/; domain=.dailymotion.com; Secure'
        },
        body: {
          json: async () => ({
            qualities: {
              auto: [{ url: 'https://cdndirector.dailymotion.com/cdn/manifest/video/xafs41q.m3u8?sec=xyz' }]
            }
          })
        }
      });

      const streams = await provider._extractDailymotion('https://geo.dailymotion.com/player.html?video=xafs41q', 'Part 1');
      expect(streams).toHaveLength(1);
      expect(streams[0].title).toBe('HockeyReplays (Part 1 - Auto HLS)');
      expect(streams[0].url).toContain('cdndirector.dailymotion.com');
      expect(streams[0].behaviorHints.proxyHeaders.request['Origin']).toBe('https://geo.dailymotion.com');
      expect(streams[0].behaviorHints.proxyHeaders.request['Cookie']).toBe('ts=12345');
    });
  });

  describe('Byse Playback Decryption (_decryptBysePlayback)', () => {
    it('successfully decrypts AES-256-GCM playback payload', () => {
      const testKey = crypto.randomBytes(32);
      const testIv = crypto.randomBytes(12);
      const testData = JSON.stringify({
        sources: [
          { label: '1080p', url: 'https://edge1-waw-sprintcdn.example/hls/nhl_master.m3u8' }
        ]
      });

      const cipher = crypto.createCipheriv('aes-256-gcm', testKey, testIv);
      const encrypted = Buffer.concat([cipher.update(testData, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const payload = Buffer.concat([encrypted, authTag]);

      const keyPart1 = testKey.subarray(0, 16).toString('base64');
      const keyPart2 = testKey.subarray(16, 32).toString('base64');

      const playback = {
        version: '1',
        iv: testIv.toString('base64'),
        payload: payload.toString('base64'),
        key_parts: Array.from({ length: 32 }, (_, i) => {
          if (i === 0) return keyPart1;
          if (i === 29) return keyPart2;
          return crypto.randomBytes(16).toString('base64');
        })
      };

      const decrypted = provider._decryptBysePlayback(playback);
      expect(decrypted).not.toBeNull();
      expect(decrypted.sources[0].url).toBe('https://edge1-waw-sprintcdn.example/hls/nhl_master.m3u8');
    });
  });

  describe('Multi-Server Stream Resolution (resolveStream)', () => {
    it('resolves Dailymotion multi-part and OK.ru embeds from hockey replay page', async () => {
      const samplePageHtml = `
        <!-- <body> -->
        <p><strong>Server #1 (DM)</strong></p>
        <p><a href="https://geo.dailymotion.com/player.html?video=xafs41q">Part 1</a></p>
        <p><a href="https://geo.dailymotion.com/player.html?video=xafs41u">Part 2</a></p>
        <p><strong>Server #2 (OK)</strong></p>
        <p><a href="https://ok.ru/videoembed/12345">Watch</a></p>
        <!-- </body> -->
      `;

      provider.fetchPage = {
        fire: jest.fn().mockResolvedValue(samplePageHtml)
      };

      provider._extractDailymotion = jest.fn()
        .mockResolvedValueOnce([
          new StreamEntity({ name: 'HockeyReplays', title: 'HockeyReplays (Part 1 - Auto HLS)', url: 'https://dm.example/p1.m3u8' })
        ])
        .mockResolvedValueOnce([
          new StreamEntity({ name: 'HockeyReplays', title: 'HockeyReplays (Part 2 - Auto HLS)', url: 'https://dm.example/p2.m3u8' })
        ]);

      provider._extractOkRu = jest.fn().mockResolvedValueOnce([
        new StreamEntity({ name: 'HockeyReplays', title: 'HockeyReplays (Server #2 (OK) - 720p)', url: 'https://ok.example/video.mp4' })
      ]);

      const streams = await provider.resolveStream('https://hockeyreplays.com/game-replay');
      expect(streams).toHaveLength(3);
      expect(streams[0].title).toBe('HockeyReplays (Server #2 (OK) - 720p)');
      expect(streams[1].title).toBe('HockeyReplays (Part 1 - Auto HLS)');
      expect(streams[2].title).toBe('HockeyReplays (Part 2 - Auto HLS)');
    });
  });

  describe('MatchAggregator Multi-Source Merge with LiveTV', () => {
    it('merges HockeyReplays full game and LiveTV highlight into 1 master fixture card', async () => {
      const liveTvFixture = {
        id: 'livetv_vegas-calgary-20261016',
        title: 'Vegas Golden Knights vs Calgary Flames - NHL',
        category: 'hockey',
        league: 'NHL',
        date: '2026-10-16T02:00:00.000Z',
        team1: { name: 'Vegas Golden Knights' },
        team2: { name: 'Calgary Flames' },
        sources: [
          { source: 'livetv', id: 'ltv_1', name: 'LiveTV Clip', url: 'https://livetv.sx/1' }
        ]
      };

      const hockeyReplaysFixture = {
        id: 'hr_calgary-flames-vegas-golden-knights-october-15-2026',
        title: 'Calgary Flames vs Vegas Golden Knights - NHL Regular Season - Full Game Replay - October 15, 2026',
        category: 'hockey',
        league: 'NHL Regular Season',
        date: '2026-10-15T00:00:00.000Z',
        team1: { name: 'Calgary Flames' },
        team2: { name: 'Vegas Golden Knights' },
        sources: [
          { source: 'hockeyreplays', id: 'https://hockeyreplays.com/vegas', name: 'Full Game Replay', url: 'https://hockeyreplays.com/vegas' }
        ]
      };

      const mockLiveTvProvider = {
        sourceName: 'livetv',
        getMatches: jest.fn().mockResolvedValue([liveTvFixture])
      };

      const mockHockeyReplaysProvider = {
        sourceName: 'hockeyreplays',
        getMatches: jest.fn().mockResolvedValue([hockeyReplaysFixture])
      };

      const mockCacheService = {
        getMatches: jest.fn().mockReturnValue([]),
        setMatches: jest.fn(),
        getReplays: jest.fn().mockReturnValue([])
      };

      const aggregator = new MatchAggregator({
        liveTvProvider: mockLiveTvProvider,
        hockeyReplaysProvider: mockHockeyReplaysProvider,
        cacheService: mockCacheService
      });

      const merged = await aggregator.syncMatches();
      expect(merged).toHaveLength(1);

      const master = merged[0];
      const sourceNames = master.sources.map(s => s.source);
      expect(sourceNames).toContain('livetv');
      expect(sourceNames).toContain('hockeyreplays');
      expect(master.sources).toHaveLength(2);
    });
  });
});
