jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(),
  shutdown: jest.fn()
}));

const container = require('../src/container');
const TeamLogoService = require('../src/services/TeamLogoService');
TeamLogoService.prototype.findTeamLogo = async () => null;
const { handleCatalog } = require('../src/catalog');

describe('liveLeagueCatalog', () => {
  const FIXED_NOW = 1764000000000; // Fixed timestamp
  let dateNowSpy;

  const sampleMatches = [
    {
      id: 'live-epl',
      title: 'Liverpool vs Chelsea',
      category: 'football',
      league: 'English Premier League',
      team1: 'Liverpool',
      team2: 'Chelsea',
      date: new Date(FIXED_NOW - 30 * 60 * 1000).toISOString(), // started 30 min ago
      status: 'live',
      sources: [{ source: 'streamedpk', id: 's1', name: 'Stream 1', url: 'https://cdn.example.com/epl.m3u8' }]
    },
    {
      id: 'live-ucl',
      title: 'Arsenal vs Inter',
      category: 'football',
      league: 'UEFA Champions League',
      team1: 'Arsenal',
      team2: 'Inter',
      date: new Date(FIXED_NOW - 45 * 60 * 1000).toISOString(), // started 45 min ago
      status: 'live',
      sources: [{ source: 'streamedpk', id: 's2', name: 'Stream 2', url: 'https://cdn.example.com/ucl.m3u8' }]
    },
    {
      id: 'future-ucl',
      title: 'Real Madrid vs Bayern',
      category: 'football',
      league: 'UEFA Champions League',
      team1: 'Real Madrid',
      team2: 'Bayern',
      date: new Date(FIXED_NOW + 2 * 60 * 60 * 1000).toISOString(), // in 2 hours
      status: 'live', // provider says live, but kickoff is in future!
      sources: [{ source: 'streamedpk', id: 's3', name: 'Stream 3', url: 'https://cdn.example.com/future.m3u8' }]
    },
    {
      id: 'replay-ucl',
      title: 'PSG vs Man City',
      category: 'football',
      league: 'UEFA Champions League',
      team1: 'PSG',
      team2: 'Man City',
      date: new Date(FIXED_NOW - 24 * 60 * 60 * 1000).toISOString(),
      status: 'finished',
      sources: [{ source: 'soccerfull', id: 's4', name: 'Replay', url: 'https://cdn.example.com/replay.m3u8' }]
    },
    {
      id: 'channel',
      title: 'Sky Sports Football',
      category: 'networks',
      isChannel: true,
      date: '0',
      status: 'live',
      sources: [{ source: 'dlv', id: 's5', name: 'Channel', url: 'https://cdn.example.com/channel.m3u8' }]
    },
    {
      id: 'custom-sep-1',
      title: 'Team Alpha vs Team Beta',
      category: 'football',
      league: 'Cup A&B=1',
      date: new Date(FIXED_NOW - 15 * 60 * 1000).toISOString(),
      status: 'live',
      sources: [{ source: 'streamedpk', id: 's6', name: 'Stream 6', url: 'https://cdn.example.com/c1.m3u8' }]
    },
    {
      id: 'custom-sep-2',
      title: 'Team Gamma vs Team Delta',
      category: 'football',
      league: 'Cup A',
      date: new Date(FIXED_NOW - 15 * 60 * 1000).toISOString(),
      status: 'live',
      sources: [{ source: 'streamedpk', id: 's7', name: 'Stream 7', url: 'https://cdn.example.com/c2.m3u8' }]
    }
  ];

  beforeAll(() => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    container.resolve('matchAggregator').syncMatches = async () => [];
    container.resolve('cronService').syncing = true; // block ensureFresh
    const tls = container.resolve('teamLogoService');
    tls.findTeamLogo = async () => null;
    tls.getLeagueLogo = () => null;
    tls.getTeamLogo = () => null;
    const cacheService = container.resolve('cacheService');
    cacheService.setMatches(sampleMatches);
  });

  afterAll(() => {
    if (dateNowSpy) dateNowSpy.mockRestore();
  });

  const matchIdFromMeta = m => m.id.replace(/^nuvio_sport_/, '').split(':')[0];

  // Table assertions
  test('Live row, EPL only: returns live-epl and channel', async () => {
    const conf = { liveLeagues: { ids: ['epl'], custom: [], other: false } };
    const res = await handleCatalog('tv', 'nuvio_sports_live', {}, conf);
    const ids = res.metas.map(matchIdFromMeta);
    expect(ids).toContain('live-epl');
    expect(ids).toContain('channel');
    expect(ids).not.toContain('live-ucl');
    expect(ids).not.toContain('future-ucl');
  });

  test('Same Live row, UCL only, same cache revision: returns live-ucl and channel', async () => {
    const conf = { liveLeagues: { ids: ['ucl'], custom: [], other: false } };
    const res = await handleCatalog('tv', 'nuvio_sports_live', {}, conf);
    const ids = res.metas.map(matchIdFromMeta);
    expect(ids).toContain('live-ucl');
    expect(ids).toContain('channel');
    expect(ids).not.toContain('live-epl');
  });

  test('Mixed row, EPL only: returns live-epl, future-ucl, and channel', async () => {
    const conf = { liveLeagues: { ids: ['epl'], custom: [], other: false } };
    const res = await handleCatalog('tv', 'nuvio_sports_football', {}, conf);
    const ids = res.metas.map(matchIdFromMeta);
    expect(ids).toContain('live-epl');
    expect(ids).toContain('future-ucl'); // upcoming is not filtered
    expect(ids).toContain('channel');
    expect(ids).not.toContain('live-ucl'); // live UCL is filtered out
  });

  test('Upcoming row, EPL only: returns future-ucl', async () => {
    const conf = { liveLeagues: { ids: ['epl'], custom: [], other: false } };
    const res = await handleCatalog('tv', 'nuvio_sports_upcoming', {}, conf);
    const ids = res.metas.map(matchIdFromMeta);
    expect(ids).toContain('future-ucl');
  });

  test('Same Live row, explicit empty: returns only channel', async () => {
    const conf = { liveLeagues: { ids: [], custom: [], other: false } };
    const res = await handleCatalog('tv', 'nuvio_sports_live', {}, conf);
    const ids = res.metas.map(matchIdFromMeta);
    expect(ids).toEqual(['channel']);
  });

  test('Same Live row, config omitted: returns live-epl, live-ucl, and channel', async () => {
    const res = await handleCatalog('tv', 'nuvio_sports_live', {}, {});
    const ids = res.metas.map(matchIdFromMeta);
    expect(ids).toContain('live-epl');
    expect(ids).toContain('live-ucl');
    expect(ids).toContain('channel');
  });

  test('Replay competition row, explicit empty: returns replay-ucl, identical to unconfigured', async () => {
    const unconfRes = await handleCatalog('series', 'nuvio_sports_replays_football_ucl', {}, {});
    const emptyConf = { liveLeagues: { ids: [], custom: [], other: false } };
    const confRes = await handleCatalog('series', 'nuvio_sports_replays_football_ucl', {}, emptyConf);
    expect(confRes.metas.map(m => m.id)).toEqual(unconfRes.metas.map(m => m.id));
    expect(confRes.metas.some(m => m.id.includes('replay-ucl'))).toBe(true);
  });

  // Regression cases:
  test('Regression: excluded live fixture is excluded from sport row, Your Teams, and search', async () => {
    const conf = {
      liveLeagues: { ids: ['epl'], custom: [], other: false },
      favoriteTeams: 'Arsenal'
    };

    // Sport row:
    const sportRes = await handleCatalog('tv', 'nuvio_sports_football', {}, conf);
    expect(sportRes.metas.map(matchIdFromMeta)).not.toContain('live-ucl');

    // Your Teams:
    const teamsRes = await handleCatalog('tv', 'nuvio_sports_teams', {}, conf);
    expect(teamsRes.metas.map(matchIdFromMeta)).not.toContain('live-ucl');

    // Search:
    const searchRes = await handleCatalog('tv', 'nuvio_sports_football', { search: 'Arsenal' }, conf);
    expect(searchRes.metas.map(matchIdFromMeta)).not.toContain('live-ucl');
  });

  test('Search and pagination: filtered-out live fixtures precede first eligible result without shifting offset', async () => {
    // In nuvio_sports_live with custom-sep fixtures excluded by epl-only, live-epl should be first returned
    const conf = { liveLeagues: { ids: ['epl'], custom: [], other: false } };
    const res = await handleCatalog('tv', 'nuvio_sports_live', { search: 'vs', skip: '0' }, conf);
    const ids = res.metas.map(matchIdFromMeta);
    expect(ids[0]).toBe('live-epl');
    expect(ids).not.toContain('live-ucl');
  });

  test('Page cache key isolation: custom names containing &, =, | produce distinct cache entries', async () => {
    const conf1 = { liveLeagues: { ids: [], custom: ['Cup A&B=1'], other: false } };
    const conf2 = { liveLeagues: { ids: [], custom: ['Cup A'], other: false } };

    const res1 = await handleCatalog('tv', 'nuvio_sports_live', {}, conf1);
    const res2 = await handleCatalog('tv', 'nuvio_sports_live', {}, conf2);

    const ids1 = res1.metas.map(matchIdFromMeta);
    const ids2 = res2.metas.map(matchIdFromMeta);

    expect(ids1).toContain('custom-sep-1');
    expect(ids1).not.toContain('custom-sep-2');

    expect(ids2).toContain('custom-sep-2');
    expect(ids2).not.toContain('custom-sep-1');
  });
});
