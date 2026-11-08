'use strict';

process.env.NODE_ENV = 'test';

const PitSportProvider = require('../src/providers/PitSportProvider');
const container = require('../src/container');
const { selectSources } = require('../src/streams');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');

describe('PitSportProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new PitSportProvider();
  });

  describe('Container & DI Registration', () => {
    test('resolves from container as PitSportProvider singleton', () => {
      const resolved = container.resolve('pitSportProvider');
      expect(resolved).toBeInstanceOf(PitSportProvider);
      expect(resolved.sourceName).toBe('pitsport');
      expect(resolved.name).toBe('PitSport');
    });

    test('is registered in MatchAggregator providers list', () => {
      const resolved = container.resolve('pitSportProvider');
      const aggregator = container.resolve('matchAggregator');
      expect(aggregator.providers).toContain(resolved);
    });

    test('selectSources includes and prioritizes pitsport source', () => {
      const candidateSources = [
        { source: 'streamsports99', id: 's99-1' },
        { source: 'pitsport', id: '102750' },
        { source: 'unknown_source', id: 'unk-1' }
      ];
      const selected = selectSources(candidateSources);
      expect(selected.some(s => s.source === 'pitsport')).toBe(true);
      const pitsportSource = selected.find(s => s.source === 'pitsport');
      expect(pitsportSource.id).toBe('102750');
      // Priority 2 should place pitsport ahead of streamsports99 (priority 4)
      const pitsportIdx = selected.findIndex(s => s.source === 'pitsport');
      const s99Idx = selected.findIndex(s => s.source === 'streamsports99');
      expect(pitsportIdx).toBeLessThan(s99Idx);
    });
  });

  describe('getMatches()', () => {
    const mockHomeApiResponse = {
      data: {
        carousel: [
          {
            programId: 102750,
            slug: 'jacksonville-jaguars-at-baltimore-ravens',
            background: 'http://pitsport.st/uploads/nfl-801eb12d.webp',
            logo: 'http://pitsport.st/uploads/nfl-2a4401bb.png',
            titleText: 'Jacksonville Jaguars at Baltimore Ravens',
            footer: 'NFL',
            sessionStart: 1793927700,
            liveState: 'live',
            competitionSlug: 'nfl',
            hasVideo: true
          }
        ],
        live: [
          {
            programId: 102750, // Duplicate of carousel item to test deduplication
            slug: 'jacksonville-jaguars-at-baltimore-ravens',
            background: 'http://pitsport.st/uploads/nfl-801eb12d.webp',
            logo: 'http://pitsport.st/uploads/nfl-2a4401bb.png',
            titleText: 'Jacksonville Jaguars at Baltimore Ravens',
            footer: 'NFL',
            sessionStart: 1793927700,
            liveState: 'live',
            competitionSlug: 'nfl',
            hasVideo: true
          },
          {
            programId: 102626,
            slug: 'orlando-magic-at-phoenix-suns',
            background: 'http://pitsport.st/uploads/nba-bg.webp',
            logo: 'http://pitsport.st/uploads/nba-logo.png',
            titleText: 'Orlando Magic at Phoenix Suns',
            footer: 'NBA',
            sessionStart: 1793930400,
            liveState: 'live',
            competitionSlug: 'nba',
            hasVideo: true
          },
          {
            programId: 102806,
            slug: 'tna-impact-nov-5-2026',
            background: null,
            logo: null,
            titleText: 'TNA iMPACT! - Nov 5, 2026',
            footer: 'Wrestling',
            sessionStart: 1793930400,
            liveState: 'live',
            competitionSlug: 'wrestling',
            hasVideo: true
          }
        ],
        upcoming: [
          {
            programId: 102823,
            slug: 'sandown-motor-raceway-free-practice-1',
            background: 'http://pitsport.st/uploads/v8supers-30d6491f.webp',
            logo: 'http://pitsport.st/uploads/supercars-f7fee247.png',
            title: [{ text: 'Sandown Motor Raceway — Free Practice 1', flag: null }],
            titleText: 'Sandown Motor Raceway — Free Practice 1',
            footer: 'Australian Supercars Championship',
            sessionStart: 1793936400,
            liveState: 'upcoming',
            competitionSlug: 'australian-supercars-championship',
            hasVideo: true
          },
          {
            programId: 102850,
            slug: 'monaco-grand-prix-qualifying',
            background: 'http://pitsport.st/uploads/f1.webp',
            logo: 'http://pitsport.st/uploads/f1.png',
            titleText: 'Monaco Grand Prix - Qualifying',
            footer: 'Formula 1',
            sessionStart: 1794000000,
            liveState: 'upcoming',
            competitionSlug: 'formula-1',
            hasVideo: true
          }
        ]
      }
    };

    test('parses and deduplicates matches across carousel, live, and upcoming lists', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1793928000 * 1000);
      jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
        ok: true,
        json: async () => mockHomeApiResponse
      });

      const matches = await provider.getMatches();
      // Total 5 unique programs (programId 102750 appears in both carousel and live)
      expect(matches).toHaveLength(5);

      // Verify NFL match with team extraction
      const nflMatch = matches.find(m => m.id === 'pitsport_102750_jacksonville-jaguars-at-baltimore-ravens');
      expect(nflMatch).toBeDefined();
      expect(nflMatch.title).toBe('Jacksonville Jaguars at Baltimore Ravens');
      expect(nflMatch.category).toBe('american_football');
      expect(nflMatch.date).toBe(String(1793927700 * 1000));
      expect(nflMatch.status).toBe('live');
      expect(nflMatch.league).toBe('NFL');
      expect(nflMatch.logo).toBe('http://pitsport.st/uploads/nfl-2a4401bb.png');
      expect(nflMatch.poster).toBe('');
      expect(nflMatch.thumbnail_url).toBe('');
      expect(nflMatch.team1).toEqual({ name: 'Jacksonville Jaguars' });
      expect(nflMatch.team2).toEqual({ name: 'Baltimore Ravens' });
      expect(nflMatch.sources).toHaveLength(1);
      expect(nflMatch.sources[0]).toEqual({
        source: 'pitsport',
        id: '102750',
        programId: 102750,
        playHref: '/programs/102750/play',
        slug: 'jacksonville-jaguars-at-baltimore-ravens',
        channelName: 'NFL',
        name: 'Jacksonville Jaguars at Baltimore Ravens'
      });

      // Verify NBA match
      const nbaMatch = matches.find(m => m.id.startsWith('pitsport_102626'));
      expect(nbaMatch).toBeDefined();
      expect(nbaMatch.category).toBe('basketball');
      expect(nbaMatch.poster).toBe('');
      expect(nbaMatch.thumbnail_url).toBe('');
      expect(nbaMatch.team1).toEqual({ name: 'Orlando Magic' });
      expect(nbaMatch.team2).toEqual({ name: 'Phoenix Suns' });

      // Verify Wrestling match mapped to mma
      const wrestlingMatch = matches.find(m => m.id.startsWith('pitsport_102806'));
      expect(wrestlingMatch).toBeDefined();
      expect(wrestlingMatch.category).toBe('mma');
      expect(wrestlingMatch.poster).toBe('');
      expect(wrestlingMatch.thumbnail_url).toBe('');

      // Verify Australian Supercars Championship mapped to motorsport
      const supercarsMatch = matches.find(m => m.id.startsWith('pitsport_102823'));
      expect(supercarsMatch).toBeDefined();
      expect(supercarsMatch.category).toBe('motorsport');
      expect(supercarsMatch.status).toBe('upcoming');
      expect(supercarsMatch.date).toBe(String(1793936400 * 1000));
      expect(supercarsMatch.poster).toBe('http://pitsport.st/uploads/v8supers-30d6491f.webp');
      expect(supercarsMatch.thumbnail_url).toBe('http://pitsport.st/uploads/v8supers-30d6491f.webp');

      // Verify F1 match mapped to motorsport
      const f1Match = matches.find(m => m.id.startsWith('pitsport_102850'));
      expect(f1Match).toBeDefined();
      expect(f1Match.category).toBe('motorsport');
      expect(f1Match.poster).toBe('http://pitsport.st/uploads/f1.webp');
      expect(f1Match.thumbnail_url).toBe('http://pitsport.st/uploads/f1.webp');
    });

    test('handles empty or HTTP error response gracefully', async () => {
      jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
        ok: false,
        status: 502
      });

      const matches = await provider.getMatches();
      expect(matches).toEqual([]);
    });

    test('handles exception during fetch without throwing', async () => {
      jest.spyOn(provider, 'proxyFetch').mockRejectedValue(new Error('Network error'));

      const matches = await provider.getMatches();
      expect(matches).toEqual([]);
    });
  });

  describe('resolveStream()', () => {
    test('resolves HLS manifest and web player fallback from program play endpoint and watch API', async () => {
      const mockPlayResponse = {
        data: {
          programId: 102750,
          video: {
            embedId: 101989,
            embedUrl: 'https://embdlol.st/embed/01a1add0-2f9b-739f-80bd-c53066f31b1c',
            origin: 'https://embdlol.st'
          },
          videos: [
            {
              embedId: 101989,
              embedUrl: 'https://embdlol.st/embed/01a1add0-2f9b-739f-80bd-c53066f31b1c',
              label: 'Main Feed',
              origin: 'https://embdlol.st'
            }
          ]
        }
      };

      const mockWatchResponse = {
        channel: {
          channelname: 'NFL1',
          channelCode: 'aeg1lwf9'
        },
        url: 'https://prod-e2.tonzoidio.st/hmk/token123/out/v1/channel(aeg1lwf9)/index.m3u8'
      };

      jest.spyOn(provider, 'proxyFetch').mockImplementation(async (url, opts) => {
        if (url.includes('/api/v1/programs/102750/play')) {
          return {
            ok: true,
            status: 200,
            json: async () => mockPlayResponse
          };
        }
        if (url.includes('api.embdlol.st/watch')) {
          const body = JSON.parse(opts.body);
          expect(body.watchId).toBe('01a1add0-2f9b-739f-80bd-c53066f31b1c');
          return {
            ok: true,
            status: 200,
            json: async () => mockWatchResponse
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const streams = await provider.resolveStream('102750', 'american_football', 'Jaguars vs Ravens', {
        id: '102750',
        programId: 102750
      });

      expect(streams).toHaveLength(2);

      // Direct HLS stream
      const hlsStream = streams.find(s => s.url);
      expect(hlsStream).toBeDefined();
      expect(hlsStream.name).toBe('PitSport');
      expect(hlsStream.title).toBe('NFL1');
      expect(hlsStream.url).toContain('/api/manifest?url=');
      expect(hlsStream.url).toContain(encodeURIComponent('https://prod-e2.tonzoidio.st/hmk/token123/out/v1/channel(aeg1lwf9)/index.m3u8'));
      expect(hlsStream.behaviorHints.notWebReady).toBe(true);
      expect(hlsStream.behaviorHints.proxyHeaders.request.Referer).toBe('https://embdlol.st/');
      expect(hlsStream.behaviorHints.proxyHeaders.request.Origin).toBe('https://embdlol.st');
      expect(hlsStream.isTikTok).toBe(true);
      expect(hlsStream._isTikTok).toBe(true);
      expect(hlsStream._source).toBe('pitsport');

      // Web player fallback
      const webStream = streams.find(s => s.externalUrl);
      expect(webStream).toBeDefined();
      expect(webStream.name).toBe('PitSport');
      expect(webStream.externalUrl).toContain('/watch?url=');
      expect(webStream.externalUrl).toContain(encodeURIComponent('https://embdlol.st/embed/01a1add0-2f9b-739f-80bd-c53066f31b1c'));
    });

    test('returns only Web Player fallback if watch resolver fails', async () => {
      const mockPlayResponse = {
        data: {
          videos: [
            {
              embedUrl: 'https://embdlol.st/embed/01a1add0-2f9b-739f-80bd-c53066f31b1c',
              label: 'Feed 1'
            }
          ]
        }
      };

      jest.spyOn(provider, 'proxyFetch').mockImplementation(async (url) => {
        if (url.includes('/play')) {
          return { ok: true, status: 200, json: async () => mockPlayResponse };
        }
        if (url.includes('api.embdlol.st/watch')) {
          return { ok: false, status: 404, json: async () => ({ error: 'Channel not found' }) };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const streams = await provider.resolveStream('102750', 'nfl', 'Event Title');
      expect(streams).toHaveLength(1);
      expect(streams[0].externalUrl).toBeDefined();
      expect(streams[0].url).toBeUndefined();
    });

    test('returns empty array if play API fails', async () => {
      jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
        ok: false,
        status: 404
      });

      const streams = await provider.resolveStream('102750', 'nfl', 'Event Title');
      expect(streams).toEqual([]);
    });

    test('returns empty array if programId is missing', async () => {
      const streams = await provider.resolveStream(null, 'nfl', 'Event Title', null);
      expect(streams).toEqual([]);
    });

    test('correctly parses programId from prefixed match id format (pitsport_102750_slug)', async () => {
      let requestedUrl = '';
      jest.spyOn(provider, 'proxyFetch').mockImplementation(async (url) => {
        if (url.includes('/api/v1/programs/')) {
          requestedUrl = url;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                videos: [
                  { embedUrl: 'https://embdlol.st/embed/abc-123', label: 'Feed 1' }
                ]
              }
            })
          };
        }
        if (url.includes('api.embdlol.st/watch')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://cdn.example.com/live.m3u8' })
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const streams = await provider.resolveStream('pitsport_102750_jaguars-vs-ravens', 'american_football', 'Jaguars vs Ravens');
      expect(requestedUrl).toBe('https://pitsport.st/api/v1/programs/102750/play');
      expect(streams).toHaveLength(2);
      expect(streams[0].channelName).toBe('Feed 1');
    });

    test('deduplicates video and videos when both are present in play data', async () => {
      jest.spyOn(provider, 'proxyFetch').mockImplementation(async (url) => {
        if (url.includes('/play')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                video: { embedUrl: 'https://embdlol.st/embed/same-uuid', label: 'Main Feed' },
                videos: [
                  { embedUrl: 'https://embdlol.st/embed/same-uuid', label: 'Main Feed' },
                  { embedUrl: 'https://embdlol.st/embed/diff-uuid', label: 'Second Feed' }
                ]
              }
            })
          };
        }
        if (url.includes('api.embdlol.st/watch')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://cdn.example.com/live.m3u8' })
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const streams = await provider.resolveStream('102750', 'nfl', 'Event Title');
      // 2 unique feeds -> 2 HLS streams + 2 Web Player fallbacks = 4 streams total
      expect(streams).toHaveLength(4);
    });
  });

  describe('TimingRelations integration', () => {
    test('TimingRelations recognizes pitsport as registered timing source', () => {
      const { createTimingRelations, normalizeTimingSource } = require('../src/services/TimingRelations');
      expect(normalizeTimingSource('pitsport')).toBe('pitsport');

      let emittedSource = null;
      const relations = createTimingRelations({
        emit: (row) => {
          if (row && row.type === 'source_mint_start') {
            emittedSource = row.source;
          }
        }
      });
      const workHandle = relations.work('pitsport');
      relations.startMint(workHandle);
      expect(emittedSource).toBe('pitsport');
    });
  });

  describe('Aggregation & Poster Safeguards', () => {
    const MatchAggregator = require('../src/services/MatchAggregator');
    const agg = new MatchAggregator({});

    test('German football alias merges Hamburg SV and Hamburger SV across all spelling variants', () => {
      const e1 = {
        id: 'dlv_1',
        title: 'Hamburger SV vs Borussia Monchengladbach',
        category: 'football',
        date: '1793970000000'
      };
      const e2 = {
        id: 'pitsport_102795_hamburg-sv-vs-borussia-monchengladbach',
        title: 'Hamburg SV vs Borussia Mönchengladbach',
        category: 'football',
        date: '1793970000000'
      };
      const scorezone = {
        id: 'scorezone_1812746',
        title: "Hamburger SV vs Borussia M'gladbach",
        category: 'football',
        date: '1793970000000'
      };
      const moenchengladbach = {
        id: 'other_1',
        title: 'Hamburg vs Borussia Moenchengladbach',
        category: 'football',
        date: '1793970000000'
      };

      expect(agg.isSameEvent(e1, e2)).toBe(true);
      expect(agg.isSameEvent(e2, scorezone)).toBe(true);
      expect(agg.isSameEvent(e1, scorezone)).toBe(true);
      expect(agg.isSameEvent(scorezone, moenchengladbach)).toBe(true);
    });

    test('Motorsport circuit aliases merge Interlagos with São Paulo and Brazilian Grand Prix variants', () => {
      const sp = {
        id: 'sp_1',
        title: 'Formula 1 São Paulo Grand Prix - Practice 1',
        category: 'motorsport',
        date: '1793970000000'
      };
      const br = {
        id: 'br_1',
        title: 'Formula 1: Brazilian Grand Prix - Practice 1',
        category: 'motorsport',
        date: '1793970000000'
      };
      const gpOfBrazil = {
        id: 'dlv_gp_brazil',
        title: 'Grand Prix of Brazil - Practice 1',
        league: 'Formula 1',
        category: 'motorsport',
        date: '1793970000000'
      };
      const pitsportInterlagos = {
        id: 'pitsport_102815_interlagos',
        title: 'Formula 1: Interlagos — Free Practice 1',
        category: 'motorsport',
        date: '1793970000000'
      };

      expect(agg.isSameEvent(sp, pitsportInterlagos)).toBe(true);
      expect(agg.isSameEvent(br, pitsportInterlagos)).toBe(true);
      expect(agg.isSameEvent(gpOfBrazil, pitsportInterlagos)).toBe(true);

      // Verify that replay provider (rz_) remains isolated from live fixtures
      const rzReplay = {
        id: 'rz_brazil_fp1',
        title: 'Grand Prix of Brazil - Practice 1',
        league: 'Formula 1',
        category: 'motorsport',
        date: '1793970000000'
      };
      expect(agg.isSameEvent(rzReplay, pitsportInterlagos)).toBe(false);
    });

    test('Motorsport circuit aliases merge Lusail with Qatar Grand Prix', () => {
      const qatar = {
        id: 'q_1',
        title: 'MotoGP Qatar Grand Prix - Practice 1',
        category: 'motorsport',
        date: '1793959200000'
      };
      const pitsportLusail = {
        id: 'pitsport_102831_lusail',
        title: 'MotoGP: Lusail — Free Practice 1',
        category: 'motorsport',
        date: '1793959200000'
      };

      expect(agg.isSameEvent(qatar, pitsportLusail)).toBe(true);
    });

    test('Motorsport title prefixing does not duplicate existing series labels or prefix generic footers', async () => {
      jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            live: [
              {
                programId: 9001,
                titleText: 'NASCAR Cup Series: Pennzoil 400',
                footer: 'NASCAR',
                competitionSlug: 'nascar',
                sessionStart: 1793927700
              },
              {
                programId: 9002,
                titleText: 'F1: Monaco Grand Prix - Qualifying',
                footer: 'Formula 1',
                competitionSlug: 'formula-1',
                sessionStart: 1793927700
              },
              {
                programId: 9003,
                titleText: 'Interlagos — Free Practice 1',
                footer: 'Motorsport',
                competitionSlug: 'motorsport',
                sessionStart: 1793927700
              }
            ]
          }
        })
      });

      const matches = await provider.getMatches();
      const nascar = matches.find(m => m.id.startsWith('pitsport_9001'));
      expect(nascar.title).toBe('NASCAR Cup Series: Pennzoil 400'); // not duplicated

      const f1 = matches.find(m => m.id.startsWith('pitsport_9002'));
      expect(f1.title).toBe('F1: Monaco Grand Prix - Qualifying'); // not duplicated

      const generic = matches.find(m => m.id.startsWith('pitsport_9003'));
      expect(generic.title).toBe('Interlagos — Free Practice 1'); // generic "Motorsport" footer ignored
    });

    test('Aggregator strips non-motorsport pitsport poster and background during merge', async () => {
      const existing = {
        id: 'fixture_1',
        title: 'Hamburg SV vs Borussia Mönchengladbach',
        category: 'football',
        date: '1793970000000',
        poster: '',
        thumbnail_url: '',
        background: '',
        sources: [{ source: 'daddylive', id: '1' }]
      };
      const pitsportMatch = {
        id: 'pitsport_102795',
        title: 'Hamburger SV vs Borussia Monchengladbach',
        category: 'football',
        date: '1793970000000',
        poster: 'http://pitsport.st/uploads/bundesliga-b066ab50.webp',
        thumbnail_url: 'http://pitsport.st/uploads/bundesliga-b066ab50.webp',
        background: 'http://pitsport.st/uploads/bundesliga-b066ab50.webp',
        sources: [{ source: 'pitsport', id: '102795' }]
      };

      const testAgg = new MatchAggregator({ cacheService: { getMatches: () => [], setMatches: () => {} } });
      testAgg.providers = [
        { sourceName: 'daddylive', getMatches: async () => [existing] },
        { sourceName: 'pitsport', getMatches: async () => [pitsportMatch] }
      ];
      const merged = await testAgg.syncMatches();
      expect(merged).toHaveLength(1);
      // Non-motorsport PitSport poster & background must NOT be adopted
      expect(merged[0].poster || '').toBe('');
      expect(merged[0].thumbnail_url || '').toBe('');
      expect(merged[0].background || '').toBe('');
    });
  });
});
