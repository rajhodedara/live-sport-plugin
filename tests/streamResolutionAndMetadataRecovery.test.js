'use strict';

const matchResolver = require('../src/resolver/sktech/SkTechMatchResolver');
const SkTechProvider = require('../src/providers/SkTechProvider');
const PitSportProvider = require('../src/providers/PitSportProvider');
const MatchAggregator = require('../src/services/MatchAggregator');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamScoringService = require('../src/services/StreamScoringService');
const { selectSources } = require('../src/streams');

describe('Stream Resolution, Provider Priority Hierarchy & Metadata Recovery', () => {
  describe('Incident 1: SkTech & SonyLIV Metadata Recovery', () => {
    it('recovers bilateral cricket teams and canonical title from tvg-logo when title is generic stage round', () => {
      const curMeta = {
        rawTitle: '2nd ODI',
        tvgName: '2nd ODI',
        logo: 'https://images.sonyliv.com/NZvsIND_2nd_odi_clean_landscape_thumb.jpg',
        group: 'Sony LIV'
      };
      const streamUrl = 'https://nonyliv.saqlainhaider8198.workers.dev/cricodi_1080p.m3u8';

      const recovered = matchResolver.recoverMatchMetadata('2nd ODI', curMeta, streamUrl);
      expect(recovered.teamA.name).toBe('New Zealand');
      expect(recovered.teamB.name).toBe('India');
      expect(recovered.category).toBe('cricket');
      expect(recovered.title).toBe('New Zealand vs India (2nd ODI)');
    });

    it('correctly handles women squads with _W and -W suffixes', () => {
      const curMeta = {
        rawTitle: 'Final',
        tvgName: 'Final',
        logo: 'https://images.sonyliv.com/AUS_WvsENG_W_final_thumb.jpg',
        group: 'Sony LIV'
      };
      const recovered = matchResolver.recoverMatchMetadata('Final', curMeta, 'https://cdn.example/cric_final.m3u8');
      expect(recovered.teamA.name).toBe('Australia Women');
      expect(recovered.teamB.name).toBe('England Women');
      expect(recovered.category).toBe('cricket');
      expect(recovered.title).toBe('Australia Women vs England Women (Final)');
    });

    it('recovers teams from Tour of series names in tvgName while preserving raw stage round title', () => {
      const curMeta = {
        rawTitle: '1st T20I',
        tvgName: 'India Tour of New Zealand 2026',
        logo: 'https://images.sonyliv.com/banner.jpg',
        group: 'Sony LIV'
      };
      const cleanTitle = matchResolver.cleanEventTitle(curMeta.rawTitle, curMeta.tvgName);
      expect(cleanTitle).toBe('1st T20I');
      const recovered = matchResolver.recoverMatchMetadata(cleanTitle, curMeta, '');
      expect(recovered.teamA.name).toBe('New Zealand');
      expect(recovered.teamB.name).toBe('India');
      expect(recovered.category).toBe('cricket');
      expect(recovered.title).toBe('New Zealand vs India (1st T20I)');
    });

    it('detects cricket category and recovers teams from new cricket country codes (OMN, NLD, LKA)', () => {
      const curMeta = {
        rawTitle: 'Match 12',
        tvgName: 'Match 12',
        logo: 'https://images.sonyliv.com/OMNvsNLD_match12.jpg',
        group: 'Sony LIV'
      };
      const recovered = matchResolver.recoverMatchMetadata('Match 12', curMeta, 'https://cdn.example/crict20_1080p.m3u8');
      expect(recovered.teamA.name).toBe('Oman');
      expect(recovered.teamB.name).toBe('Netherlands');
      expect(recovered.category).toBe('cricket');
      expect(recovered.title).toBe('Oman vs Netherlands (Match 12)');
    });

    it('infers cricket category even when cleanTitle is already Team A vs Team B without category tag', () => {
      const curMeta = {
        rawTitle: 'New Zealand vs India',
        tvgName: 'New Zealand vs India',
        logo: 'https://images.sonyliv.com/live_cricket.jpg',
        group: 'Sony LIV'
      };
      const recovered = matchResolver.recoverMatchMetadata('New Zealand vs India', curMeta, 'https://cdn.example/cricodi_live.m3u8');
      expect(recovered.teamA.name).toBe('New Zealand');
      expect(recovered.teamB.name).toBe('India');
      expect(recovered.category).toBe('cricket');
      expect(recovered.title).toBe('New Zealand vs India');
    });

    it('parseM3UContent builds enriched MatchEntity for SonyLIV cricket fixture', () => {
      const m3uSample = `#EXTM3U
#EXTINF:-1 tvg-id="sony_cricket_01" tvg-name="2nd ODI" tvg-logo="https://cdn.sonyliv/NZvsIND_2nd_odi.jpg" group-title="Sony LIV",2nd ODI 1080p
https://sonyliv.workers.dev/cricodi_1080p/index.m3u8`;

      const matchMap = new Map();
      const matches = [];
      const feed = { label: 'Sony LIV', url: 'https://sonyliv.workers.dev/playlist.m3u' };

      matchResolver.parseM3UContent(m3uSample, feed, matchMap, matches);

      expect(matches).toHaveLength(1);
      const m = matches[0];
      expect(m.title).toBe('New Zealand vs India (2nd ODI)');
      expect(m.category).toBe('cricket');
      expect(m.teamA.name).toBe('New Zealand');
      expect(m.teamB.name).toBe('India');
      expect(m.sources).toHaveLength(1);
      expect(m.sources[0].resolution).toBe('1080P');
    });

    it('MatchAggregator successfully deduplicates DaddyLive main card with SonyLIV enriched card', () => {
      const agg = new MatchAggregator({});
      const kickoff = Date.now() - 6 * 3600 * 1000; // 6 hours ago (during long ODI)

      const daddyLiveMatch = new MatchEntity({
        id: 'dlv_cricket_nz_ind',
        title: 'New Zealand vs India',
        category: 'cricket',
        date: String(kickoff),
        sources: [{ source: 'daddylive', id: '101', channelName: 'Sky Sports Cricket' }]
      });

      const sonyLivMatch = new MatchEntity({
        id: 'sktech_ev_sonyliv_2nd_odi',
        title: 'New Zealand vs India (2nd ODI)',
        category: 'cricket',
        date: String(kickoff),
        team1: { name: 'New Zealand' },
        team2: { name: 'India' },
        sources: [{ source: 'sktech', id: 'm3u_sonyliv_2nd_odi_1080p', channelName: 'Sony LIV (1080P)' }]
      });

      expect(agg.isSameEvent(daddyLiveMatch, sonyLivMatch)).toBe(true);
    });

    it('SkTechProvider allows cricket matches to stay active for up to 10 hours', async () => {
      const provider = new SkTechProvider();
      const now = Date.now();
      const sixHoursAgo = now - 6 * 3600 * 1000;
      const elevenHoursAgo = now - 11 * 3600 * 1000;

      provider.matchResolver = {
        fetchLiveMatches: jest.fn().mockResolvedValue([
          {
            id: 'cricket_live_6h',
            title: 'New Zealand vs India (2nd ODI)',
            category: 'cricket',
            kickoff: sixHoursAgo,
            sources: [{ source: 'sktech', id: 'cric_1' }]
          },
          {
            id: 'cricket_stale_11h',
            title: 'Australia vs England',
            category: 'cricket',
            kickoff: elevenHoursAgo,
            sources: [{ source: 'sktech', id: 'cric_2' }]
          },
          {
            id: 'football_stale_5h',
            title: 'Arsenal vs Chelsea',
            category: 'football',
            kickoff: now - 5 * 3600 * 1000,
            sources: [{ source: 'sktech', id: 'foot_1' }]
          }
        ])
      };
      provider.channelResolver = { fetchChannels: jest.fn().mockResolvedValue([]) };

      const matches = await provider.getMatches();
      const ids = matches.map(m => m.id);

      expect(ids).toContain('sktech_cricket_live_6h');
      expect(ids).not.toContain('sktech_cricket_stale_11h');
      expect(ids).not.toContain('sktech_football_stale_5h');
    });
  });

  describe('Incident 2: Provider Priority & Mirror Capping', () => {
    it('caps DaddyLive mirrors to maximum 4 diverse feeds per fixture in selectSources', () => {
      const mirrors = [];
      const channels = [
        'Sky Sports Premier League', 'TNT Sports 1', 'Canal+ Foot', 'DAZN 1',
        'Sky Sports Main Event', 'Optus Sport 1', 'Astro SuperSport 1', 'beIN Sports 1'
      ];

      for (let i = 0; i < 16; i++) {
        mirrors.push({
          source: 'daddylive',
          id: `dlv_mirror_${i}`,
          channelName: channels[i % channels.length]
        });
      }

      const sources = [
        ...mirrors,
        { source: 'leaf', id: 'leaf_feed_1' },
        { source: 'timstreams', id: 'ts_feed_1' }
      ];

      const selected = selectSources(sources, null);
      const daddySelected = selected.filter(s => s.source === 'daddylive');
      expect(daddySelected).toHaveLength(4);

      // Verify that higher priority sources are preserved and ordered ahead of DaddyLive
      expect(selected[0].source).toBe('leaf');
      expect(selected[1].source).toBe('timstreams');
    });

    it('maintains priority order leaf > timstreams > daddylive > vavoo when daddylive is capped', () => {
      const sources = [
        { source: 'vavoo', id: 'v1' },
        { source: 'daddylive', id: 'dl1', channelName: 'Sky 1' },
        { source: 'daddylive', id: 'dl2', channelName: 'Sky 2' },
        { source: 'daddylive', id: 'dl3', channelName: 'Sky 3' },
        { source: 'daddylive', id: 'dl4', channelName: 'Sky 4' },
        { source: 'daddylive', id: 'dl5', channelName: 'Sky 1' },
        { source: 'leaf', id: 'l1' },
        { source: 'timstreams', id: 'ts1' }
      ];
      const selected = selectSources(sources, null);
      const sourceOrder = selected.map(s => s.source);
      expect(sourceOrder).toEqual(['leaf', 'timstreams', 'daddylive', 'daddylive', 'daddylive', 'daddylive', 'vavoo']);
    });

    it('scores stream sources following leaf > timstreams > ppvst > pitsport > daddylive > vavoo > sktech', () => {
      const scorer = new StreamScoringService();
      const leafScore = scorer.calculateScore({ url: 'http://cdn/1.m3u8', resolution: '1080p' }, 'leaf');
      const timScore = scorer.calculateScore({ url: 'http://cdn/2.m3u8', resolution: '1080p' }, 'timstreams');
      const ppvScore = scorer.calculateScore({ url: 'http://cdn/3.m3u8', resolution: '1080p' }, 'ppvst');
      const pitScore = scorer.calculateScore({ url: 'http://cdn/4.m3u8', resolution: '1080p' }, 'pitsport');
      const dlScore = scorer.calculateScore({ url: 'http://cdn/5.m3u8', resolution: '1080p' }, 'daddylive');
      const vavooScore = scorer.calculateScore({ url: 'http://cdn/6.m3u8', resolution: '1080p' }, 'vavoo');
      const sktechScore = scorer.calculateScore({ url: 'http://cdn/7.m3u8', resolution: '1080p' }, 'sktech');

      expect(leafScore).toBeGreaterThan(timScore);
      expect(timScore).toBeGreaterThan(ppvScore);
      expect(ppvScore).toBeGreaterThan(pitScore);
      expect(pitScore).toBeGreaterThan(dlScore);
      expect(dlScore).toBeGreaterThan(vavooScore);
      expect(vavooScore).toBeGreaterThan(sktechScore);
    });
  });

  describe('Incident 3: PitSport Stream Titling & Presentation', () => {
    it('creates clean stream titles without redundant prefixes or Live Event tags and without TikTok flag', async () => {
      const provider = new PitSportProvider();
      const mockWatchData = {
        url: 'https://cdn.pitsport.test/live/skyf1/index.m3u8',
        channel: { channelname: 'Sky Sports F1' }
      };

      const mockPlayResponse = {
        data: {
          videos: [
            {
              embedUrl: 'https://embdlol.st/embed/01a1add0-2f9b-739f-80bd-c53066f31b1c',
              label: 'Sky Sports F1'
            }
          ]
        }
      };

      jest.spyOn(provider, 'proxyFetch').mockImplementation(async (url) => {
        if (url.includes('/api/v1/programs/102750/play')) {
          return {
            ok: true,
            status: 200,
            json: async () => mockPlayResponse
          };
        }
        if (url.includes('api.embdlol.st/watch')) {
          return {
            ok: true,
            status: 200,
            json: async () => mockWatchData
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const streams = await provider.resolveStream('pitsport_102750_test', 'motorsport', 'Bahrain GP', {
        id: '102750',
        programId: 102750
      });

      const directStream = streams.find(s => s.url);
      expect(directStream).toBeDefined();
      expect(directStream.title).toBe('Sky Sports F1');
      expect(directStream.title).not.toContain('PitSport - ');
      expect(directStream.title).not.toContain('(Live Event)');
      expect(directStream.isTikTok).toBe(true);
      expect(directStream._isTikTok).toBe(true);
    });
  });
});
