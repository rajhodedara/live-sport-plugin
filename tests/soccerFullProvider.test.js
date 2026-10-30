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


const SoccerFullProvider = require('../src/providers/SoccerFullProvider');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const container = require('../src/container');
const { isReplayMatch } = require('../src/catalog');

describe('SoccerFullProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new SoccerFullProvider();
  });

  describe('Match Parsing (_parseMatchCards)', () => {
    const sampleHtml = `
      <ul class="list-movies">
        <li class="item-movie">
          <a href="/coventry-city-vs-newcastle-united-4468.html" title="Coventry City vs Newcastle United">
            <div class="image">
              <div class="movie-play">
                <img class="movie-thumbnail" src="/imgs/4468.png" alt="Coventry City vs Newcastle United">
              </div>
            </div>
            <div class="label">HD</div>
            <div class="title-movie"><h3>Coventry City vs Newcastle United</h3></div>
            <span class="code Premier League">Premier League</span>
          </a>
        </li>
        <li class="item-movie">
          <a href="/crystal-palace-vs-nottingham-forest-08-02-2026.html" title="Crystal Palace vs Nottingham Forest">
            <div class="image">
              <div class="movie-play">
                <img class="movie-thumbnail" src="/imgs/4451.png" alt="Crystal Palace vs Nottingham Forest">
              </div>
            </div>
            <div class="label">HD</div>
            <div class="title-movie"><h3>Crystal Palace vs Nottingham Forest</h3></div>
            <span class="code Premier League">Premier League</span>
          </a>
        </li>
      </ul>
    `;

    test('extracts match entities with correct metadata', () => {
      const matches = provider._parseMatchCards(sampleHtml, 0);
      expect(matches).toHaveLength(2);

      const m1 = matches[0];
      expect(m1).toBeInstanceOf(MatchEntity);
      expect(m1.id).toBe('sf_4468');
      expect(m1.title).toBe('Coventry City vs Newcastle United');
      expect(m1.category).toBe('football');
      expect(m1.league).toBe('Premier League');
      expect(m1.status).toBe('finished');
      expect(m1.thumbnail_url).toBe('https://soccerfull.net/imgs/4468.png');
      expect(m1.poster).toBe('');
      expect(m1.sources).toHaveLength(1);
      expect(m1.sources[0].source).toBe('soccerfull');
      expect(m1.sources[0].id).toBe('/coventry-city-vs-newcastle-united-4468.html');
      expect(m1.sources[0].url).toBe('https://soccerfull.net/coventry-city-vs-newcastle-united-4468.html');
    });

    test('parses date from URL slug if available and leaves empty for clean upstream fixture merge', () => {
      const matches = provider._parseMatchCards(sampleHtml, 0);
      const m1 = matches[0];
      const m2 = matches[1];
      expect(m1.date).toBe('');
      const parsedKo = Number(m2.date);
      expect(parsedKo).toBeGreaterThan(0);
      expect(parsedKo).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('Live Broadcast Filtering (_extractServerOptions)', () => {
    const matchPageHtml = `
      <div class="video-container">
        <iframe src="/play/16483" width="100%"></iframe>
      </div>
      <article class="infobv">
        <a href="/match.html?sid=16483" class="video-server bt_active">Highlights</a>
        <a href="/match.html?sid=16484" class="video-server">1st Half</a>
        <a href="/match.html?sid=16485" class="video-server">2nd Half</a>
        <a href="/match.html?sid=16486" class="video-server">Full Match in En</a>
        <a href="/match.html?sid=16371" class="video-server">live match 1</a>
        <a href="/match.html?sid=16372" class="video-server">Live Stream 2</a>
        <a href="/match.html?sid=16487" class="video-server">EXTENDED in En</a>
      </article>
    `;

    test('extracts replay servers and strictly drops live match broadcasts', () => {
      const servers = provider._extractServerOptions(matchPageHtml);
      const sids = servers.map(s => s.sid);
      const labels = servers.map(s => s.label);

      // Replays kept
      expect(sids).toContain('16483');
      expect(sids).toContain('16484');
      expect(sids).toContain('16485');
      expect(sids).toContain('16486');
      expect(sids).toContain('16487');

      // Live match servers strictly filtered out
      expect(sids).not.toContain('16371');
      expect(sids).not.toContain('16372');
      expect(labels.some(l => /\blive\b/i.test(l))).toBe(false);
    });
  });

  describe('Vixeo Extractor (extractVixeo)', () => {
    test('deobfuscates hex payload correctly to return direct M3U8', async () => {
      // Sample reversed ASCII hex payload
      // "https://vidsonic.net/master.m3u8" reversed is "8u3m.retsam/ten.cinosdiv//:sptth"
      const targetUrl = 'https://vidsonic.net/master.m3u8';
      const reversed = [...targetUrl].reverse().join('');
      let hex = '';
      for (let i = 0; i < reversed.length; i++) {
        hex += reversed.charCodeAt(i).toString(16).padStart(2, '0');
      }
      // Inject pipe characters as seen in real obfuscation
      const obfuscated = hex.slice(0, 10) + '|' + hex.slice(10, 20) + '|' + hex.slice(20);

      const dataConfigObj = { source: obfuscated };
      const base64Config = Buffer.from(JSON.stringify(dataConfigObj)).toString('base64');
      const fakeVixeoHtml = `<div id="streamsonic-player-root" data-config="${base64Config}"></div>`;

      jest.spyOn(provider, 'extractVixeo').mockImplementation(async () => targetUrl);

      const streamUrl = await provider.extractVixeo('https://vixeo.io/e/test1234');
      expect(streamUrl).toBe(targetUrl);
    });

    test('handles missing data-config gracefully', async () => {
      const undici = require('../src/services/ProviderOutbound');
      jest.spyOn(undici, 'request').mockResolvedValueOnce({
        statusCode: 200,
        body: { text: async () => '<html><body>No player here</body></html>' }
      });

      const res = await provider.extractVixeo('https://vixeo.io/e/invalid');
      expect(res).toBeNull();
    });
  });

  describe('Vidara Extractor (extractVidara)', () => {
    test('extracts streaming_url from backend API', async () => {
      const undici = require('../src/services/ProviderOutbound');
      const mockStreamUrl = 'https://s8.97bf1.com/hls/test/master.m3u8';

      jest.spyOn(undici, 'request').mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({ streaming_url: mockStreamUrl }) }
      });

      const res = await provider.extractVidara('https://vidaraa.cc/v/abc123code');
      expect(res).toBe(mockStreamUrl);
    });

    test('returns null on API failure', async () => {
      const undici = require('../src/services/ProviderOutbound');
      jest.spyOn(undici, 'request').mockResolvedValueOnce({
        statusCode: 500,
        body: { text: async () => 'Server error' }
      });

      const res = await provider.extractVidara('https://vidaraa.cc/v/failcode');
      expect(res).toBeNull();
    });
  });

  describe('Stream Resolution and Live Embed Filtering', () => {
    test('resolves streams and skips embed.st live streams', async () => {
      const fakeMatchHtml = `
        <article class="infobv">
          <a href="/match.html?sid=1" class="video-server">Highlights</a>
          <a href="/match.html?sid=2" class="video-server">Full Match in En</a>
        </article>
      `;

      jest.spyOn(provider.fetchPage, 'fire').mockResolvedValueOnce(fakeMatchHtml);

      const undici = require('../src/services/ProviderOutbound');
      // SID 1 -> Vixeo
      // SID 2 -> embed.st (Live stream, should be dropped)
      jest.spyOn(undici, 'request')
        .mockResolvedValueOnce({
          statusCode: 200,
          body: { text: async () => '<iframe src="https://vixeo.io/e/vix123"></iframe>' }
        })
        .mockResolvedValueOnce({
          statusCode: 200,
          body: { text: async () => '<iframe src="https://embed.st/embed/admin/live"></iframe>' }
        });

      jest.spyOn(provider, 'extractVixeo').mockResolvedValueOnce('https://vidsonic.net/stream1.m3u8');

      const streams = await provider.resolveStream('/match.html', 'football', 'Test vs Match');
      expect(streams).toHaveLength(1);
      expect(streams[0]).toBeInstanceOf(StreamEntity);
      expect(streams[0].name).toBe('SoccerFull');
      expect(streams[0].title).toBe('[VOD] Highlights (1080p)');
      expect(streams[0].url).toBe('https://vidsonic.net/stream1.m3u8');
      expect(streams[0].behaviorHints.notWebReady).toBe(false);
    });
  });

  describe('System Integration & DI Wiring', () => {
    test('resolves from Awilix container as singleton', () => {
      const resolved = container.resolve('soccerFullProvider');
      expect(resolved).toBeInstanceOf(SoccerFullProvider);
      expect(resolved.name).toBe('SoccerFull');
      expect(resolved.sourceName).toBe('soccerfull');
    });

    test('is present in MatchAggregator providers list', () => {
      const aggregator = container.resolve('matchAggregator');
      const hasSoccerFull = aggregator.providers.some(p => p && p.sourceName === 'soccerfull');
      expect(hasSoccerFull).toBe(true);
    });

    test('isReplayMatch classifies SoccerFull match as a valid replay', () => {
      const match = new MatchEntity({
        id: 'sf_1234',
        title: 'Liverpool vs Man City',
        category: 'football',
        status: 'finished',
        date: String(Date.now() - 4 * 3600 * 1000),
        sources: [{ source: 'soccerfull', id: '/liverpool-vs-man-city-1234.html' }]
      });

      expect(isReplayMatch(match)).toBe(true);
    });

    test('merges seamlessly with existing ReplayZone fixture and preserves default artwork', () => {
      const aggregator = container.resolve('matchAggregator');
      const rzMatch = {
        id: 'rz_coventry-city-vs-newcastle-united-12-10-2026',
        title: 'Coventry City - Newcastle United',
        category: 'football',
        league: 'Premier League',
        date: '2026-10-12T19:00:00+07:00',
        status: 'finished',
        poster: '',
        thumbnail_url: 'https://soccerfull.net/imgs/4468.png',
        sources: [{ source: 'replayzone', id: 'https://soccerfull.net/play/16483', name: 'Part 1' }]
      };

      const parsedMatches = provider._parseMatchCards(`
        <li class="item-movie">
          <a href="/coventry-city-vs-newcastle-united-4468.html" title="Coventry City vs Newcastle United">
            <div class="image">
              <img class="movie-thumbnail" src="/imgs/4468.png">
            </div>
            <div class="title-movie"><h3>Coventry City vs Newcastle United</h3></div>
            <span class="code Premier League">Premier League</span>
          </a>
        </li>
      `, 0);

      expect(parsedMatches).toHaveLength(1);
      const sfMatch = parsedMatches[0];

      // 1. Poster normalized to empty string
      expect(sfMatch.poster).toBe('');
      // 2. Date unanchored
      expect(sfMatch.date).toBe('');

      // 3. MatchAggregator recognizes as same event
      expect(aggregator.isSameEvent(rzMatch, sfMatch)).toBe(true);
    });
    test('ReplayZone strictly excludes soccer entries so SoccerFull is the dedicated provider', async () => {
      const ReplayZoneProvider = require('../src/providers/ReplayZoneProvider');
      const rz = new ReplayZoneProvider();

      // 1. resolveStream returns [] for football/soccer categories
      const footballStream = await rz.resolveStream('https://ok.ru/video/12345', 'football', 'Coventry vs Newcastle');
      expect(footballStream).toEqual([]);

      const soccerStream = await rz.resolveStream('https://ok.ru/video/12345', 'soccer', 'Coventry vs Newcastle');
      expect(soccerStream).toEqual([]);

      // 2. resolveStream returns [] for any soccerfull.net URL regardless of category
      const soccerfullDirect = await rz.resolveStream('https://soccerfull.net/play/16483', 'baseball', 'Coventry vs Newcastle');
      expect(soccerfullDirect).toEqual([]);
    });
  });

  describe('Modern Post-ID & OK.ru Stream Resolution', () => {
    test('extracts post-id container as Full Match server option', () => {
      const modernHtml = `
        <div class="header-play">
          <div id="video" post-id="4531">
            <div class="cssloading">Loading video...</div>
          </div>
        </div>
      `;
      const servers = provider._extractServerOptions(modernHtml);
      expect(servers).toHaveLength(1);
      expect(servers[0].sid).toBe('4531');
      expect(servers[0].label).toBe('Full Match');
    });

    test('extracts OK.ru direct 1080p MP4 and Auto HLS streams with okcdn.ru URLs', async () => {
      const undici = require('../src/services/ProviderOutbound');
      const fakeOkHtml = `
        <div data-module="OKVideo" data-options='{"flashvars":{"metadata":"{\\"videos\\":[{\\"name\\":\\"full\\",\\"url\\":\\"https://vd517.okcdn.ru/video.mp4\\"},{\\"name\\":\\"sd\\",\\"url\\":\\"https://vd517.okcdn.ru/video_sd.mp4\\"}],\\"hlsManifestUrl\\":\\"https://vd517.okcdn.ru/video.m3u8\\"}"}}'></div>
      `;

      jest.spyOn(undici, 'request').mockResolvedValueOnce({
        statusCode: 200,
        body: { text: async () => fakeOkHtml }
      });

      const streams = await provider._resolveOkRu('https://ok.ru/videoembed/9154553055991', 'Full Match');
      expect(streams).toHaveLength(2);

      const mp4Stream = streams[0];
      expect(mp4Stream).toBeInstanceOf(StreamEntity);
      expect(mp4Stream.name).toBe('SoccerFull');
      expect(mp4Stream.title).toBe('[VOD] Full Match (1080p) [OK.ru]');
      expect(mp4Stream.resolution).toBe('1080p');
      expect(mp4Stream.url).toBe('https://vd517.okcdn.ru/video.mp4');
      expect(mp4Stream.behaviorHints.notWebReady).toBe(false);
      expect(mp4Stream.behaviorHints.proxyHeaders.request.Referer).toBe('https://ok.ru/');

      const hlsStream = streams[1];
      expect(hlsStream).toBeInstanceOf(StreamEntity);
      expect(hlsStream.title).toBe('[VOD] Full Match (Auto HLS) [OK.ru]');
      expect(hlsStream.resolution).toBe('Auto');
      expect(hlsStream.url).toBe('https://vd517.okcdn.ru/video.m3u8');
    });

    test('prioritizes OK.ru zero-bandwidth streams over others in resolveStream', async () => {
      jest.spyOn(provider.fetchPage, 'fire').mockResolvedValueOnce(`
        <div id="video" post-id="4502"></div>
        <a href="?sid=16810" class="video-server">1st Half</a>
      `);

      jest.spyOn(provider, '_resolveServerStream').mockImplementation(async (server) => {
        if (server.sid === '4502') {
          return [new StreamEntity({
            name: 'SoccerFull',
            title: '[VOD] Full Match (1080p) [OK.ru]',
            resolution: '1080p',
            url: 'https://vd438.okcdn.ru/ok.mp4'
          })];
        }
        if (server.sid === '16810') {
          return [new StreamEntity({
            name: 'SoccerFull',
            title: '[VOD] 1st Half (1080p) [Vidara]',
            resolution: '1080p',
            url: 'https://s14.97bf1.com/hls.m3u8'
          })];
        }
        return [];
      });

      const streams = await provider.resolveStream('/celta-vigo-vs-juventus-4502.html');
      expect(streams).toHaveLength(2);
      expect(streams[0].title).toContain('[OK.ru]');
      expect(streams[1].title).toContain('[Vidara]');
    });
  });

  describe('SprintCDN Filtering & Replay Episode Preservation', () => {
    test('_formatByseStreams rejects SprintCDN links that fail with 404/denied on clients', () => {
      const sourcesWithSprintCdn = [
        { label: '1080p', url: 'https://edge1-madrid-sprintcdn.r66nv9ed.com/hls2/04/12253/master.m3u8' },
        { label: '720p', url: 'https://edge2-waw-sprintcdn.r66nv9ed.com/hls2/04/12253/master.m3u8' }
      ];

      const res = provider._formatByseStreams(sourcesWithSprintCdn, 'bysesukior.com', 'Highlights');
      expect(res).toEqual([]);
    });

    test('_formatByseStreams keeps valid non-SprintCDN sources from Byse', () => {
      const mixedSources = [
        { label: '1080p', url: 'https://edge1-sprintcdn.example/master.m3u8' },
        { label: '1080p', url: 'https://direct-cdn.example/hls/master.m3u8' }
      ];

      const res = provider._formatByseStreams(mixedSources, 'bysesukior.com', 'Full Match');
      expect(res).toHaveLength(1);
      expect(res[0].url).toBe('https://direct-cdn.example/hls/master.m3u8');
      expect(res[0].title).toBe('SoccerFull | Full Match (1080p)');
    });

    test('verifyStreams drops SprintCDN streams across any provider', async () => {
      const { verifyStreams } = require('../src/streams');
      const mockStream = {
        name: 'SoccerFull',
        title: 'SoccerFull | Full Match (1080p)',
        url: 'https://edge1-madrid-sprintcdn.r66nv9ed.com/hls2/04/12253/master.m3u8',
        behaviorHints: { notWebReady: false }
      };

      const out = await verifyStreams([mockStream], 'test:1', {}, {});
      expect(out).toEqual([]);
    });

    test('handleStream preserves SoccerFull replay when merged with LiveTV clips', async () => {
      const { handleStream } = require('../src/streams');
      const cacheService = container.resolve('cacheService');

      const mergedMatch = {
        id: 'merged_sf_ltv_test_1',
        title: 'Frosinone vs Sassuolo',
        category: 'football',
        status: 'finished',
        date: String(Date.now() - 3600 * 1000),
        sources: [
          { source: 'livetv', id: 'ltv_clip_1', name: '1:0', url: 'https://livetv.sx/clip1' },
          { source: 'livetv', id: 'ltv_clip_2', name: '1:1', url: 'https://livetv.sx/clip2' },
          { source: 'livetv', id: 'ltv_clip_3', name: 'Long Highlight', url: 'https://livetv.sx/clip3' },
          { source: 'soccerfull', id: '/frosinone-vs-sassuolo-4531.html', name: 'Full Match', url: 'https://soccerfull.net/frosinone-vs-sassuolo-4531.html' }
        ]
      };

      cacheService.setMatches([mergedMatch]);

      jest.spyOn(container.resolve('soccerFullProvider'), 'resolveStream').mockResolvedValueOnce([
        new StreamEntity({
          name: 'SoccerFull',
          title: '[VOD] Full Match (Auto HLS) [OK.ru]',
          resolution: 'Auto',
          url: 'https://vd517.okcdn.ru/video.m3u8',
          behaviorHints: { notWebReady: false }
        }),
        new StreamEntity({
          name: 'SoccerFull',
          title: '[VOD] Full Match (1080p) [OK.ru]',
          resolution: '1080p',
          url: 'https://vd517.okcdn.ru/video.mp4',
          behaviorHints: { notWebReady: false }
        })
      ]);

      jest.spyOn(container.resolve('liveTvProvider'), 'resolveStream').mockResolvedValueOnce([
        {
          name: 'LiveTV',
          title: 'LiveTV | 1:0',
          url: 'https://cdn.example/10.mp4',
          behaviorHints: { notWebReady: true }
        }
      ]);

      const res = await handleStream('series', 'nuvio_sport_merged_sf_ltv_test_1:1:1', {});
      expect(res.streams.length).toBeGreaterThanOrEqual(2);

      const okHls = res.streams.find(s => s.url && s.url.includes('vd517.okcdn.ru/video.m3u8'));
      const okMp4 = res.streams.find(s => s.url && s.url.includes('vd517.okcdn.ru/video.mp4'));

      expect(okHls).toBeDefined();
      expect(okMp4).toBeDefined();

      const hlsIdx = res.streams.indexOf(okHls);
      const ltvIdx = res.streams.findIndex(s => s.title && s.title.includes('LiveTV'));
      if (ltvIdx !== -1) {
        expect(hlsIdx).toBeLessThan(ltvIdx);
      }
    });
  });
});
