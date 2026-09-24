const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const container = require('../src/container');
const { selectSources, resolveSource } = require('../src/streams');
const MatchAggregator = require('../src/services/MatchAggregator');

describe('DaddyLiveProvider', () => {
  let provider;
  let circuitBreaker;

  beforeEach(() => {
    circuitBreaker = new CircuitBreakerService();
    provider = new DaddyLiveProvider({ circuitBreaker });
  });

  describe('decodeEconfig', () => {
    test('returns null for empty or invalid input', () => {
      expect(provider.decodeEconfig(null)).toBeNull();
      expect(provider.decodeEconfig('')).toBeNull();
      expect(provider.decodeEconfig('invalid-base64')).toBeNull();
      expect(provider.decodeEconfig(123)).toBeNull();
    });

    test('correctly decodes a valid synthetic _econfig payload', () => {
      // Create a test JSON payload
      const payload = {
        stream_url: 'https://cdn.example.com/hls/live.m3u8?token=xyz',
        stream_url_nop2p: 'https://cdn.example.com/hls/live.m3u8?token=xyz',
        p2p: true
      };
      const jsonStr = JSON.stringify(payload);
      const b64Json = Buffer.from(jsonStr).toString('base64');

      // The algorithm splits b64Json into 4 parts according to order [2, 0, 3, 1]
      // In decodeEconfig:
      // orderedParts[2] comes from part 0
      // orderedParts[0] comes from part 1
      // orderedParts[3] comes from part 2
      // orderedParts[1] comes from part 3
      // And for each part, orderedParts[idx] = atob(slice(0, 3) + slice(4))
      const targetParts = [
        b64Json.slice(0, 10),
        b64Json.slice(10, 20),
        b64Json.slice(20, 30),
        b64Json.slice(30)
      ];

      // To produce targetParts[0], we need part 1
      // To produce targetParts[1], we need part 3
      // To produce targetParts[2], we need part 0
      // To produce targetParts[3], we need part 2
      const makeSegment = (targetStr) => {
        const b64 = Buffer.from(targetStr).toString('base64');
        // Insert dummy char at index 3
        return b64.slice(0, 3) + 'X' + b64.slice(3);
      };

      const seg0 = makeSegment(targetParts[2]);
      const seg1 = makeSegment(targetParts[0]);
      const seg2 = makeSegment(targetParts[3]);
      const seg3 = makeSegment(targetParts[1]);

      // Pad segments to equal length so Math.ceil(len / 4) splits cleanly
      const maxLen = Math.max(seg0.length, seg1.length, seg2.length, seg3.length);
      const padSeg = (s) => s.padEnd(maxLen, ' ');
      const rawDecoded = padSeg(seg0) + padSeg(seg1) + padSeg(seg2) + padSeg(seg3);
      const rawEconfig = Buffer.from(rawDecoded).toString('base64');

      const decoded = provider.decodeEconfig(rawEconfig);
      expect(decoded).not.toBeNull();
      expect(decoded.stream_url).toBe('https://cdn.example.com/hls/live.m3u8?token=xyz');
    });
  });

  describe('getMatches and schedule parsing', () => {
    test('parses UK GMT schedule headers, extracts teams, leagues, and dates', async () => {
      const mockSchedule = {
        'Friday 21st March 2025 - Schedule Time UK GMT': {
          'Soccer</span>': [
            {
              time: '20:00',
              event: 'Premier League : Arsenal vs Chelsea',
              channels: [
                { channel_name: 'Sky Sports Premier League', channel_id: '35' },
                { channel_name: 'TNT Sports 1', channel_id: '31' }
              ],
              channels2: []
            }
          ],
          'Tennis</span>': [
            {
              time: '14:30',
              event: 'Miami Open - Men Singles Quarterfinal',
              channels: [
                { channel_name: 'Tennis Channel', channel_id: '40' }
              ],
              channels2: []
            }
          ],
          'Aussie rules</span>': [
            {
              time: '08:00',
              event: 'AFL : Carlton Blues vs Hawthorn Hawks',
              channels: [
                { channel_name: 'Fox Footy', channel_id: '88' }
              ]
            }
          ],
          'College Basketball</span>': [
            {
              time: '18:00',
              event: 'NCAA Basketball : Texas A&amp;M vs Florida&#039;s Team',
              channels: [
                { channel_name: 'A&amp;E TV USA', channel_id: '302' }
              ]
            }
          ],
          'Empty Sport</span>': [
            {
              time: '10:00',
              event: 'Ghost Event',
              channels: [],
              channels2: []
            }
          ]
        }
      };

      const testNow = Date.parse('21 March 2025 12:00:00 UTC');
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(testNow);

      // Mock proxyFetch to return mockSchedule
      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockSchedule
      });

      const matches = await provider.getMatches();
      dateNowSpy.mockRestore();

      // Should have 4 matches (Empty Sport skipped because 0 channels)
      expect(matches.length).toBe(4);

      const arsenalMatch = matches.find(m => m.title.includes('Arsenal'));
      expect(arsenalMatch).toBeDefined();
      expect(arsenalMatch.category).toBe('football');
      expect(arsenalMatch.league).toBe('Premier League');
      expect(arsenalMatch.title).toBe('Arsenal vs Chelsea');
      expect(arsenalMatch.team1).toEqual({ name: 'Arsenal' });
      expect(arsenalMatch.team2).toEqual({ name: 'Chelsea' });
      expect(arsenalMatch.sources.length).toBe(2);
      expect(arsenalMatch.sources[0]).toMatchObject({
        source: 'daddylive',
        id: '35',
        channelName: 'Sky Sports Premier League',
        country: 'UK',
        countryFlag: '🇬🇧',
        language: 'English'
      });
      // Date verification: 21 March 2025 20:00:00 UTC
      const expectedEpoch = Date.parse('21 March 2025 20:00:00 UTC');
      expect(Number(arsenalMatch.date)).toBe(expectedEpoch);

      const tennisMatch = matches.find(m => m.title.includes('Miami Open'));
      expect(tennisMatch).toBeDefined();
      expect(tennisMatch.category).toBe('tennis');
      expect(tennisMatch.league).toBe('');
      expect(tennisMatch.title).toBe('Miami Open - Men Singles Quarterfinal');

      const aflMatch = matches.find(m => m.title.includes('Carlton Blues'));
      expect(aflMatch).toBeDefined();
      expect(aflMatch.category).toBe('american_football');
      expect(aflMatch.league).toBe('AFL');
      expect(aflMatch.team1).toEqual({ name: 'Carlton Blues' });
      expect(aflMatch.team2).toEqual({ name: 'Hawthorn Hawks' });

      // Verifying HTML entity unescaping
      const ncaaMatch = matches.find(m => m.title.includes('Texas A&M'));
      expect(ncaaMatch).toBeDefined();
      expect(ncaaMatch.league).toBe('NCAA Basketball');
      expect(ncaaMatch.title).toBe("Texas A&M vs Florida's Team");
      expect(ncaaMatch.team1).toEqual({ name: 'Texas A&M' });
      expect(ncaaMatch.team2).toEqual({ name: "Florida's Team" });
      expect(ncaaMatch.sources[0].channelName).toBe('A&E TV USA');
    });

    test('handles fetch errors gracefully without throwing', async () => {
      provider.proxyFetch = jest.fn().mockRejectedValue(new Error('Network offline'));
      const matches = await provider.getMatches();
      expect(matches).toEqual([]);
    });
  });

  describe('resolveStream', () => {
    test('resolves direct M3U8 via _econfig with proxyUrl and headers', async () => {
      const sourceId = '302';
      const playerHtml = `<html><body><iframe src="https://tiestep.top/e/abc123xyz"></iframe></body></html>`;
      
      // Mock decodeEconfig on provider
      const mockStreamUrl = 'https://stream.example.com/live/302.m3u8?token=live123';
      provider.decodeEconfig = jest.fn().mockReturnValue({
        stream_url: mockStreamUrl
      });

      const embedHtml = `<html><script>window._econfig='MOCK_ECONFIG_STRING';</script></html>`;

      provider.proxyFetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, text: async () => playerHtml }) // player page
        .mockResolvedValueOnce({ ok: true, text: async () => embedHtml });  // embed page

      const streams = await provider.resolveStream(sourceId, 'football', 'Arsenal vs Chelsea', { channelName: 'A&E USA' });
      expect(streams.length).toBe(1);
      const stream = streams[0];
      expect(stream.name).toBe('DaddyLive');
      expect(stream.title).toContain('A&E USA');
      expect(stream.url).toContain('/api/manifest?url=' + encodeURIComponent(mockStreamUrl));
      expect(stream.behaviorHints.notWebReady).toBe(true);
      expect(stream.behaviorHints.proxyHeaders.request.Referer).toBe('https://tiestep.top/');
      expect(stream.behaviorHints.proxyHeaders.request.Origin).toBe('https://tiestep.top');
    });

    test('falls back to EmbedExtractorChain if _econfig is not present', async () => {
      const sourceId = '742';
      const playerHtml = `<html><body><iframe src="https://embed.other.st/watch/742"></iframe></body></html>`;
      const embedHtml = `<html><script>var playerConfig = {"file":"https://cdn.other.st/stream/742.m3u8"};</script></html>`;

      provider.proxyFetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, text: async () => playerHtml })
        .mockResolvedValueOnce({ ok: true, text: async () => embedHtml });

      const streams = await provider.resolveStream(sourceId, 'entertainment', 'AXS TV', { channelName: 'AXS TV' });
      expect(streams.length).toBe(1);
      expect(streams[0].url).toContain(encodeURIComponent('https://cdn.other.st/stream/742.m3u8'));
    });

    test('falls back to Web Player stream if no stream could be decrypted', async () => {
      const sourceId = '999';
      provider.proxyFetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });

      const streams = await provider.resolveStream(sourceId, 'football', 'Unknown Match', { channelName: 'Feed 1' });
      expect(streams.length).toBe(1);
      expect(streams[0].externalUrl).toContain('/watch?url=');
      expect(streams[0].title).toContain('Web Player');
    });

    test('caches resolved streams in memory for subsequent requests', async () => {
      const sourceId = '100';
      const playerHtml = `<html><body><iframe src="https://tiestep.top/e/test100"></iframe></body></html>`;
      const embedHtml = `<html><script>window._econfig='MOCK';</script></html>`;
      provider.decodeEconfig = jest.fn().mockReturnValue({ stream_url: 'https://cdn.example.com/hls/100.m3u8' });

      provider.proxyFetch = jest.fn(async (url) => {
        if (url.includes('/stream-')) {
          return { ok: true, text: async () => playerHtml };
        }
        return { ok: true, text: async () => embedHtml };
      });

      const firstCall = await provider.resolveStream(sourceId, 'basketball', 'NBA Match');
      expect(firstCall.length).toBe(1);
      expect(provider.proxyFetch).toHaveBeenCalledTimes(2);

      // Second call should return cached stream without fetching again
      const secondCall = await provider.resolveStream(sourceId, 'basketball', 'NBA Match');
      expect(secondCall.length).toBe(1);
      expect(provider.proxyFetch).toHaveBeenCalledTimes(2);

      // Call with forceRefresh should bypass cache and fetch again
      await provider.resolveStream(sourceId, 'basketball', 'NBA Match', { forceRefresh: true });
      expect(provider.proxyFetch).toHaveBeenCalledTimes(4);

      // clearCache should also invalidate
      provider.clearCache(sourceId);
      await provider.resolveStream(sourceId, 'basketball', 'NBA Match');
      expect(provider.proxyFetch).toHaveBeenCalledTimes(6);
    });

    test('extracts M3U8 from minified Pattern C numeric array (e.g. epiembeds.online)', async () => {
      const sourceId = '742';
      const playerHtml = `<html><body><iframe src="https://epiembeds.online/embed/axs-usa"></iframe></body></html>`;
      
      // Simulate minified JavaScript where numeric array is followed by commas with no spaces
      const targetUrl = 'https://epidd.example.com/hls/live/axs-usa.m3u8';
      const k1 = 243;
      const k2 = 125;
      const scriptBody = `function init(){var url="${targetUrl}";}`;
      const charCodes = [];
      for (let i = 0; i < scriptBody.length; i++) {
        const c = scriptBody.charCodeAt(i);
        // Formula: ((n ^ k1) - k2 + 256) & 255 = c  =>  reverse: n = ((c + k2) & 255) ^ k1
        const n = (((c + k2) & 255) ^ k1);
        charCodes.push(n);
      }

      const embedHtml = `<html><head></head><body><script>(function(){var _rs6=[${charCodes.join(',')}],_nv8=${k1},_rk0=${k2},_tr1="",_nh9;for(_nh9=0;_nh9<_rs6.length;_nh9++){_tr1+=String.fromCharCode(((_rs6[_nh9]^_nv8)-_rk0+256)&255);}window.eval(_tr1);})();</script></body></html>`;

      provider.proxyFetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, text: async () => playerHtml })
        .mockResolvedValueOnce({ ok: true, text: async () => embedHtml });

      const streams = await provider.resolveStream(sourceId, 'entertainment', 'AXS TV', { channelName: 'AXS TV USA' });
      expect(streams.length).toBe(1);
      expect(streams[0].url).toContain(encodeURIComponent(targetUrl));
    });

    test('falls back to secondary baseDomain when first schedule endpoint fails', async () => {
      const mockSchedule = {
        'Friday 21st March 2025 - Schedule Time UK GMT': {
          'Soccer': [{
            time: '20:00',
            event: 'Premier League : Arsenal vs Chelsea',
            channels: [{ channel_name: 'Sky Sports', channel_id: '35' }]
          }]
        }
      };

      // First domain fails, second domain succeeds
      provider.proxyFetch = jest.fn()
        .mockRejectedValueOnce(new Error('dlstreams.st timeout'))
        .mockResolvedValueOnce({ ok: true, json: async () => mockSchedule });

      const data = await provider.fetchSchedule.fire();
      expect(data).toBeDefined();
      expect(provider.proxyFetch).toHaveBeenCalledTimes(2);
      expect(provider.proxyFetch.mock.calls[0][0]).toContain('https://dlstreams.st');
      expect(provider.proxyFetch.mock.calls[1][0]).toContain('https://dlive.sx');
    });
  });

  describe('Container & Streams integration', () => {
    test('daddyLiveProvider is registered as a singleton in container', () => {
      const p = container.resolve('daddyLiveProvider');
      expect(p).toBeDefined();
      expect(p.name).toBe('DaddyLive');
    });

    test('selectSources includes daddylive at priority 2', () => {
      const sources = [
        { source: 'timstreams', id: '1' },
        { source: 'daddylive', id: '2' },
        { source: 'streamsports99', id: '3' }
      ];
      const selected = selectSources(sources, null);
      expect(selected[0].source).toBe('daddylive');
      expect(selected[1].source).toBe('streamsports99');
      expect(selected[2].source).toBe('timstreams');
    });

    test('resolveSource routes to daddyLiveProvider', async () => {
      const mockProvider = container.resolve('daddyLiveProvider');
      const spy = jest.spyOn(mockProvider, 'resolveStream').mockResolvedValueOnce([
        new StreamEntity({
          name: 'DaddyLive',
          title: 'DaddyLive Stream 1',
          url: 'https://proxy.example.com/api/manifest?url=test'
        })
      ]);

      const result = await resolveSource(
        { source: 'daddylive', id: '55', channelName: 'ESPN' },
        { category: 'basketball', title: 'Lakers vs Warriors' },
        null
      );

      expect(spy).toHaveBeenCalledWith('55', 'basketball', 'Lakers vs Warriors', expect.objectContaining({ source: 'daddylive' }));
      expect(result.length).toBe(1);
      expect(result[0]._source).toBe('daddylive');
      spy.mockRestore();
    });

    test('MatchAggregator deduplicates DaddyLive matches with other providers', () => {
      const aggregator = container.resolve('matchAggregator');
      
      const daddyliveMatch = new MatchEntity({
        id: 'dlv_35_arsenal-vs-chelsea',
        title: 'Arsenal vs Chelsea',
        category: 'football',
        date: String(Date.parse('2025-03-21T20:00:00Z')),
        sources: [{ source: 'daddylive', id: '35' }]
      });

      const watchfootyMatch = new MatchEntity({
        id: 'wf_9988',
        title: 'Arsenal vs Chelsea',
        category: 'football',
        date: String(Date.parse('2025-03-21T20:00:00Z')),
        sources: [{ source: 'watchfooty', id: '9988' }]
      });

      expect(aggregator.isSameEvent(daddyliveMatch, watchfootyMatch)).toBe(true);
    });

    test('selectSources filters out Event Stream and Event SD Stream channels', () => {
      const sources = [
        { source: 'daddylive', id: '101', channelName: 'Event Stream' },
        { source: 'daddylive', id: '102', channelName: 'Event SD Stream' },
        { source: 'daddylive', id: '103', channelName: 'Event Stream 1' },
        { source: 'daddylive', id: '104', channelName: 'Event SD' },
        { source: 'daddylive', id: '35', channelName: 'Sky Sports Premier League' }
      ];
      const selected = selectSources(sources, null);
      expect(selected.length).toBe(1);
      expect(selected[0].channelName).toBe('Sky Sports Premier League');
    });

    test('resolveSource rejects Event Stream and Event SD Stream channels immediately', async () => {
      const mockProvider = container.resolve('daddyLiveProvider');
      const spy = jest.spyOn(mockProvider, 'resolveStream');

      const result1 = await resolveSource(
        { source: 'daddylive', id: '101', channelName: 'Event Stream' },
        { category: 'football', title: 'Test Match' },
        null
      );
      const result2 = await resolveSource(
        { source: 'daddylive', id: '102', channelName: 'Event SD Stream' },
        { category: 'football', title: 'Test Match' },
        null
      );

      expect(result1).toEqual([]);
      expect(result2).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('Event Stream detection and 0-stream match exclusion', () => {
    test('DaddyLiveProvider.isEventStream accurately flags event streams while preserving real channels', () => {
      expect(DaddyLiveProvider.isEventStream('Event Stream')).toBe(true);
      expect(DaddyLiveProvider.isEventStream('Event SD Stream')).toBe(true);
      expect(DaddyLiveProvider.isEventStream('Event Stream 1')).toBe(true);
      expect(DaddyLiveProvider.isEventStream('Event SD Stream 2')).toBe(true);
      expect(DaddyLiveProvider.isEventStream('Event SD')).toBe(true);
      expect(DaddyLiveProvider.isEventStream('event stream')).toBe(true);
      expect(DaddyLiveProvider.isEventStream('event sd stream')).toBe(true);
      expect(DaddyLiveProvider.isEventStream('Event-Stream')).toBe(true);
      expect(DaddyLiveProvider.isEventStream('Event - SD Stream')).toBe(true);

      // Real channels that contain the word "event" must NOT be flagged
      expect(DaddyLiveProvider.isEventStream('Sky Sports Main Event')).toBe(false);
      expect(DaddyLiveProvider.isEventStream('Sky Sport Top Event DE')).toBe(false);
      expect(DaddyLiveProvider.isEventStream('TNT Sports 1')).toBe(false);
      expect(DaddyLiveProvider.isEventStream('SuperSport Variety 1')).toBe(false);
    });

    test('getMatches filters out event stream channels and drops matches that end up with 0 streams', async () => {
      const mockSchedule = {
        'Friday 21st March 2025 - Schedule Time UK GMT': {
          'Football</span>': [
            {
              time: '18:00',
              event: 'Premier League : Fulham vs Everton',
              channels: [
                { channel_name: 'Event Stream', channel_id: '501' },
                { channel_name: 'Event SD Stream', channel_id: '502' }
              ],
              channels2: []
            },
            {
              time: '20:00',
              event: 'Premier League : Arsenal vs Chelsea',
              channels: [
                { channel_name: 'Event Stream 1', channel_id: '503' },
                { channel_name: 'Sky Sports Premier League', channel_id: '35' }
              ],
              channels2: []
            }
          ]
        }
      };

      const testNow = Date.parse('21 March 2025 12:00:00 UTC');
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(testNow);

      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockSchedule
      });

      const matches = await provider.getMatches();
      dateNowSpy.mockRestore();

      // Fulham vs Everton only had Event Stream channels, so it must be dropped (0 streams)
      expect(matches.find(m => m.title.includes('Fulham'))).toBeUndefined();

      // Arsenal vs Chelsea had 1 Event Stream and 1 real channel -> kept with only Sky Sports Premier League
      const chelseaMatch = matches.find(m => m.title.includes('Arsenal vs Chelsea'));
      expect(chelseaMatch).toBeDefined();
      expect(chelseaMatch.sources.length).toBe(1);
      expect(chelseaMatch.sources[0].channelName).toBe('Sky Sports Premier League');
    });

    test('MatchAggregator excludes any match with 0 sources', async () => {
      const aggregator = container.resolve('matchAggregator');
      
      const mockP1 = {
        name: 'Mock1',
        getMatches: jest.fn().mockResolvedValue([
          new MatchEntity({
            id: 'm_valid',
            title: 'Team A vs Team B',
            category: 'football',
            sources: [{ source: 'watchfooty', id: '10' }]
          }),
          new MatchEntity({
            id: 'm_empty',
            title: 'Team C vs Team D',
            category: 'football',
            sources: []
          })
        ])
      };

      const originalProviders = aggregator.providers;
      aggregator.providers = [mockP1];

      const merged = await aggregator.syncMatches();
      expect(merged.find(m => m.id === 'm_empty')).toBeUndefined();
      expect(merged.find(m => m.id === 'm_valid')).toBeDefined();

      aggregator.providers = originalProviders;
    });

    test('handleCatalog excludes matches with 0 sources', async () => {
      const { handleCatalog } = require('../src/catalog');
      const cacheService = container.resolve('cacheService');
      
      container.resolve('matchAggregator').syncMatches = async () => [];
      container.resolve('cronService').isSyncing = true;

      const originalMatches = cacheService.getMatches();
      cacheService.setMatches([
        new MatchEntity({
          id: 'valid_match',
          title: 'Live Real Madrid vs Barcelona',
          category: 'football',
          status: 'live',
          sources: [{ source: 'daddylive', id: '20' }]
        }),
        new MatchEntity({
          id: 'zero_source_match',
          title: 'Empty Stream Match',
          category: 'football',
          status: 'live',
          sources: []
        })
      ]);

      const res = await handleCatalog('tv', 'nuvio_sports_football', {}, {});
      expect(res.metas.find(m => m.id === 'nuvio_sport_zero_source_match')).toBeUndefined();
      expect(res.metas.find(m => m.id === 'nuvio_sport_valid_match')).toBeDefined();

      cacheService.setMatches(originalMatches);
    });
  });
});
