const { handleCatalog, handleMeta } = require('../src/catalog');
const { handleStream } = require('../src/streams');
const container = require('../src/container');

describe('Replay Hubs & Clean Catalog Architecture', () => {
  const sampleMatches = [
    {
      id: 'rz_match_fb_1',
      title: 'Arsenal vs Chelsea',
      category: 'football',
      league: 'Premier League',
      date: '2026-09-18T19:00:00Z',
      status: 'finished',
      thumbnail_url: 'https://example.com/fb1.png',
      sources: [{ source: 'replayzone', id: 'https://ok.ru/video/12345', name: 'Full Match', url: 'https://ok.ru/video/12345' }]
    },
    {
      id: 'rz_match_fb_2',
      title: 'Real Madrid vs Barcelona',
      category: 'football',
      league: 'La Liga',
      date: '2026-09-17T20:00:00Z',
      status: 'finished',
      thumbnail_url: 'https://example.com/fb2.png',
      sources: [{ source: 'replayzone', id: 'https://ok.ru/video/67890', name: 'Full Match', url: 'https://ok.ru/video/67890' }]
    },
    {
      id: 'rz_match_bb_1',
      title: 'Lakers vs Warriors',
      category: 'basketball',
      league: 'NBA',
      date: '2026-09-18T21:00:00Z',
      status: 'finished',
      thumbnail_url: 'https://example.com/bb1.png',
      sources: [{ source: 'replayzone', id: 'https://ok.ru/video/11111', name: 'Full Match', url: 'https://ok.ru/video/11111' }]
    }
  ];

  beforeAll(() => {
    container.resolve('cacheService').setMatches(sampleMatches);
  });

  test('Replays catalog returns sport hubs and date posters with series type and portrait poster', async () => {
    const res = await handleCatalog('series', 'nuvio_sports_replays', {}, {});
    expect(res).toBeDefined();
    expect(Array.isArray(res.metas)).toBe(true);
    expect(res.metas.length).toBeGreaterThanOrEqual(5);

    // Verify Sport Hub posters
    const fbHub = res.metas.find(m => m.id === 'nuvio_sport_replay_football');
    expect(fbHub).toBeDefined();
    expect(fbHub.type).toBe('series');
    expect(fbHub.posterShape).toBe('regular');
    expect(fbHub.name).toContain('Football');

    // Verify Date posters
    const datePosters = res.metas.filter(m => m.id.startsWith('nuvio_sport_replay_date_'));
    expect(datePosters.length).toBeGreaterThanOrEqual(1);
    expect(datePosters[0].type).toBe('series');
    expect(datePosters[0].name).toContain('Replays');
  });

  test('Clicking a sport hub poster returns date-wise seasons with matches under each date row', async () => {
    const hubMetaRes = await handleMeta('series', 'nuvio_sport_replay_football', {});
    expect(hubMetaRes).toBeDefined();
    expect(hubMetaRes.meta).toBeDefined();
    expect(hubMetaRes.meta.id).toBe('nuvio_sport_replay_football');
    expect(hubMetaRes.meta.type).toBe('series');
    expect(Array.isArray(hubMetaRes.meta.seasons)).toBe(true);
    expect(hubMetaRes.meta.seasons.length).toBe(2);

    // Seasons are organized date-wise
    expect(hubMetaRes.meta.seasons[0].name).toContain('September 18, 2026');
    expect(hubMetaRes.meta.seasons[1].name).toContain('September 17, 2026');

    // Matches are listed under their respective date season
    const s1Matches = hubMetaRes.meta.videos.filter(v => v.season === 1);
    expect(s1Matches.length).toBe(1);
    expect(s1Matches[0].title).toContain('Arsenal vs Chelsea');

    const s2Matches = hubMetaRes.meta.videos.filter(v => v.season === 2);
    expect(s2Matches.length).toBe(1);
    expect(s2Matches[0].title).toContain('Real Madrid vs Barcelona');
  });

  test('Clicking a date poster returns all matches from that specific date', async () => {
    const dateMetaRes = await handleMeta('series', 'nuvio_sport_replay_date_2026-09-18', {});
    expect(dateMetaRes).toBeDefined();
    expect(dateMetaRes.meta).toBeDefined();
    expect(dateMetaRes.meta.name).toContain('September 18, 2026');
    expect(Array.isArray(dateMetaRes.meta.videos)).toBe(true);
    expect(dateMetaRes.meta.videos.length).toBe(2); // 1 football, 1 basketball
  });

  test('handleStream allows episode-specific resolution for match replay playback', async () => {
    jest.spyOn(container.resolve('replayzoneProvider'), 'resolveStream').mockResolvedValue([
      { name: '1080p Replay (Direct MP4)', title: '1080p Replay (Direct MP4)', url: '/api/fastmp4?url=test', behaviorHints: { notWebReady: false } }
    ]);
    const streamRes = await handleStream('series', 'nuvio_sport_rz_match_fb_1:1:1', {});
    expect(streamRes).toBeDefined();
    expect(Array.isArray(streamRes.streams)).toBe(true);
    expect(streamRes.streams.length).toBeGreaterThan(0);
    expect(streamRes.streams[0].name).toContain('Direct Stream');
    expect(streamRes.streams[0].title).toContain('ReplayZone');
  });

  test('generateCollections returns valid Nuvio Collections schema with the replay sport folders', () => {
    const { generateCollections, FOLDER_DEFINITIONS } = require('../src/collections');
    const collections = generateCollections('http://localhost:7000', 'testConfig');
    expect(Array.isArray(collections)).toBe(true);
    expect(collections.length).toBe(1);
    // The four original sports must always be present; the collection grew to
    // include more sports (basketball, tennis, hockey, american football), so
    // assert the invariants rather than a fixed total.
    expect(FOLDER_DEFINITIONS.length).toBeGreaterThanOrEqual(4);
    for (const sport of ['football', 'motorsport', 'baseball', 'rugby']) {
      expect(FOLDER_DEFINITIONS.some(f => f.id === `folder-${sport}-replays`)).toBe(true);
    }
    for (const f of FOLDER_DEFINITIONS) {
      expect(Array.isArray(f.catalogs)).toBe(true);
      expect(f.catalogs.length).toBeGreaterThanOrEqual(1);
    }

    const c = collections[0];
    expect(c.id).toBe('collection-sports-replays');
    expect(c.title).toBe('Sports Replays');
    expect(c.viewMode).toBe('FOLLOW_LAYOUT');
    expect(c.pinToTop).toBe(true);
    expect(Array.isArray(c.folders)).toBe(true);
    expect(c.folders.length).toBe(FOLDER_DEFINITIONS.length);

    const fbFolder = c.folders.find(f => f.id === 'folder-football-replays');
    expect(fbFolder).toBeDefined();
    expect(fbFolder.title).toBe('Football');
    expect(fbFolder.tileShape).toBe('LANDSCAPE');
    expect(fbFolder.coverImageUrl).toContain('/posters/replays/football.jpg');
    expect(fbFolder.heroBackdropUrl).toContain('/posters/replays/football.jpg');
    expect(Array.isArray(fbFolder.catalogSources)).toBe(true);
    expect(fbFolder.catalogSources.length).toBeGreaterThanOrEqual(2);
    expect(fbFolder.catalogSources[0].addonId).toBe('community.nuvio.live-sports');
    expect(fbFolder.catalogSources[0].manifestUrl).toContain('/testConfig/manifest.json');
    expect(fbFolder.catalogSources[0].type).toBe('tv');
  });

  test('handleCatalog returns individual replay matches for sport collection sub-catalogs', async () => {
    const catRes = await handleCatalog('tv', 'nuvio_sports_replays_football', {}, {});
    expect(catRes).toBeDefined();
    expect(Array.isArray(catRes.metas)).toBe(true);
    expect(catRes.metas.length).toBe(2);
    expect(catRes.metas[0].id).toBe('nuvio_sport_rz_match_fb_1');
    expect(catRes.metas[0].name).toContain('Arsenal vs Chelsea');
    expect(catRes.metas[0].type).toBe('tv');
    expect(catRes.metas[0].posterShape).toBe('landscape');

    const premierRes = await handleCatalog('tv', 'nuvio_sports_replays_football_premier_league', {}, {});
    expect(premierRes.metas.length).toBe(1);
    expect(premierRes.metas[0].id).toBe('nuvio_sport_rz_match_fb_1');

    // Date-wise catalog rows in collection
    const date18Res = await handleCatalog('tv', 'nuvio_sports_replays_football_date_2026-09-18', {}, {});
    expect(date18Res.metas.length).toBe(1);
    expect(date18Res.metas[0].id).toBe('nuvio_sport_rz_match_fb_1');
    expect(date18Res.metas[0].type).toBe('tv');
    expect(date18Res.metas[0].posterShape).toBe('landscape');
    expect(date18Res.metas[0].name).toContain('Arsenal vs Chelsea');

    const date17Res = await handleCatalog('tv', 'nuvio_sports_replays_football_date_2026-09-17', {}, {});
    expect(date17Res.metas.length).toBe(1);
    expect(date17Res.metas[0].id).toBe('nuvio_sport_rz_match_fb_2');
    expect(date17Res.metas[0].type).toBe('tv');
    expect(date17Res.metas[0].name).toContain('Real Madrid vs Barcelona');
  });

  test('generateCollections produces rolling relative date rows and competition rows for sport replay folders', () => {
    const { generateCollections } = require('../src/collections');
    const collections = generateCollections('http://localhost:7000', 'testConfig');
    const fbFolder = collections[0].folders.find(f => f.id === 'folder-football-replays');
    expect(fbFolder).toBeDefined();

    const catIds = fbFolder.catalogSources.map(c => c.catalogId);
    expect(catIds).toContain('nuvio_sports_replays_football_today');
    expect(catIds).toContain('nuvio_sports_replays_football_yesterday');
    expect(catIds).toContain('nuvio_sports_replays_football_this_week');
    expect(catIds).toContain('nuvio_sports_replays_football_premier_league');
    expect(catIds).toContain('nuvio_sports_replays_football_older');
    expect(catIds).toContain('nuvio_sports_replays_football');
  });

  test('handleCatalog with genre=Football produces sport hub and sport-specific date posters', async () => {
    const genreRes = await handleCatalog('series', 'nuvio_sports_replays', { genre: 'Football' }, {});
    expect(genreRes).toBeDefined();
    expect(Array.isArray(genreRes.metas)).toBe(true);

    const hub = genreRes.metas.find(m => m.id === 'nuvio_sport_replay_football');
    expect(hub).toBeDefined();

    const datePoster = genreRes.metas.find(m => m.id === 'nuvio_sport_replay_football_date_2026-09-18');
    expect(datePoster).toBeDefined();
    expect(datePoster.name).toContain('Football');
    expect(datePoster.name).toContain('September 18, 2026');
  });

  test('Clicking a sport-specific date poster returns that sport matches for that date', async () => {
    const dateMetaRes = await handleMeta('series', 'nuvio_sport_replay_football_date_2026-09-18', {});
    expect(dateMetaRes).toBeDefined();
    expect(dateMetaRes.meta).toBeDefined();
    expect(dateMetaRes.meta.name).toContain('Football');
    expect(dateMetaRes.meta.name).toContain('September 18, 2026');
    expect(Array.isArray(dateMetaRes.meta.videos)).toBe(true);
    expect(dateMetaRes.meta.videos.length).toBe(1);
    expect(dateMetaRes.meta.videos[0].title).toContain('Arsenal vs Chelsea');
  });
});
