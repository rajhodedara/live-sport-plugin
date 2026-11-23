// tests/movieboxSportsProvider.test.js
'use strict';
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM'); }),
  destroy: jest.fn(async () => {})
}));
jest.mock('../src/services/ProviderOutbound', () => ({
  request: jest.fn(() => { throw new Error('Unexpected I/O'); }),
  safeFetch: jest.fn(() => { throw new Error('Unexpected I/O'); }),
  fetch: jest.fn(() => { throw new Error('Unexpected I/O'); }),
}));

const MovieBoxSportsProvider = require('../src/providers/MovieBoxSportsProvider');
const container = require('../src/container');

const AGGREGATE_FIXTURE = {
  code: 0,
  data: {
    list: [
      {
        matchId: 'MB_S_1001',
        homeTeam: 'Real Madrid',
        awayTeam: 'Barcelona',
        leagueName: 'La Liga',
        sportType: 'football',
        matchStatus: 'MatchNotStart',
        matchTime: '1748000000000',
        thumbnail: null,
      },
      {
        matchId: 'MB_S_1002',
        homeTeam: 'LA Lakers',
        awayTeam: 'Boston Celtics',
        leagueName: 'NBA',
        sportType: 'basketball',
        matchStatus: 'MatchIng',
        matchTime: '1747990000000',
        thumbnail: null,
      },
      {
        matchId: 'MB_S_1003',
        homeTeam: 'Team A',
        awayTeam: 'Team B',
        leagueName: 'eSports League',
        sportType: 'esports',          // unknown → other
        matchStatus: 'MatchNotStart',
        matchTime: '1748100000000',
        thumbnail: null,
      }
    ]
  }
};

const DETAIL_FIXTURE_LIVE = {
  code: 0,
  data: {
    matchId: 'MB_S_1002',
    matchStatus: 'MatchIng',
    playPath: 'https://live-pull.aisports.mobi/live/1002_hd.m3u8',
    playSource: [
      { url: 'https://live-pull.aisports.mobi/live/1002_hd.m3u8', quality: 'HD' },
      { url: 'https://live-pull.aisports.mobi/live/1002_sd.m3u8', quality: 'SD' },
    ]
  }
};

const DETAIL_FIXTURE_PREMATCH = {
  code: 0,
  data: {
    matchId: 'MB_S_1001',
    matchStatus: 'MatchNotStart',
    playPath: 'https://live-pull.aisports.mobi/live/1001.m3u8',
    playSource: []
  }
};

describe('MovieBoxSportsProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new MovieBoxSportsProvider();
  });

  describe('Container DI', () => {
    test('resolves movieboxSportsProvider singleton', () => {
      if (!container.hasRegistration('movieboxSportsProvider')) {
        return;
      }
      const resolved = container.resolve('movieboxSportsProvider');
      expect(resolved).toBeInstanceOf(MovieBoxSportsProvider);
      expect(resolved.sourceName).toBe('moviebox_sports');
    });
  });

  describe('_parseAggregate', () => {
    test('maps football to football category', () => {
      const matches = provider._parseAggregate(AGGREGATE_FIXTURE.data.list);
      const football = matches.find(m => m.id === 'MB_S_1001');
      expect(football.category).toBe('football');
      expect(football.homeTeam).toBe('Real Madrid');
      expect(football.awayTeam).toBe('Barcelona');
    });

    test('maps basketball to basketball category', () => {
      const matches = provider._parseAggregate(AGGREGATE_FIXTURE.data.list);
      const bball = matches.find(m => m.id === 'MB_S_1002');
      expect(bball.category).toBe('basketball');
    });

    test('maps unknown sport type to "other"', () => {
      const matches = provider._parseAggregate(AGGREGATE_FIXTURE.data.list);
      const unknown = matches.find(m => m.id === 'MB_S_1003');
      expect(unknown.category).toBe('other');
    });

    test('date is an epoch-ms string', () => {
      const matches = provider._parseAggregate(AGGREGATE_FIXTURE.data.list);
      const m = matches[0];
      expect(typeof m.date).toBe('string');
      expect(Number(m.date)).toBeGreaterThan(1_000_000_000_000);
    });

    test('sources array contains one entry with source = "moviebox_sports"', () => {
      const matches = provider._parseAggregate(AGGREGATE_FIXTURE.data.list);
      expect(matches[0].sources[0].source).toBe('moviebox_sports');
      expect(matches[0].sources[0].id).toBe('MB_S_1001');
    });
  });

  describe('_extractStreams', () => {
    test('returns stream array for MatchIng with proxyHeaders Referer', () => {
      const streams = provider._extractStreams(DETAIL_FIXTURE_LIVE.data);
      expect(streams.length).toBeGreaterThan(0);
      expect(streams[0].url).toMatch(/aisports\.mobi/);
      expect(streams[0].behaviorHints.proxyHeaders.request.Referer).toBe('https://sportslive.wine');
    });

    test('returns [] for MatchNotStart even with a URL present', () => {
      const streams = provider._extractStreams(DETAIL_FIXTURE_PREMATCH.data);
      expect(streams).toEqual([]);
    });

    test('returns [] when playSource is empty and status is MatchIng', () => {
      const data = { ...DETAIL_FIXTURE_LIVE.data, playSource: [], playPath: '' };
      const streams = provider._extractStreams(data);
      expect(streams).toEqual([]);
    });
  });
});
