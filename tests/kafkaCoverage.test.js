'use strict';

const KafkaProvider = require('../src/providers/KafkaProvider');

const NOW = Date.UTC(2026, 10, 23, 19, 0);
const IN_WINDOW = NOW + 30 * 60000;
const TOO_LATE = NOW + 5 * 3600000;

function fakeStore(overrides = {}) {
  return {
    isReady: jest.fn(() => true),
    findTeam: jest.fn((name) => (name === 'Chicago Bulls' ? [{ id: 'trex:bulls', name: 'NBA TEAM| CHICAGO BULLS', group: 'NBA TEAM', league: 'nba', score: 3000 }] : [])),
    findChannel: jest.fn(() => [{ id: 'trex:csn', name: 'US| CHICAGO SPORTS NETWORK', group: 'US', score: 2000 }]),
    ...overrides
  };
}

function fakeEventSearch(overrides = {}) {
  return {
    isInWindow: jest.fn((kickoff) => kickoff <= NOW + 4 * 3600000 && kickoff >= NOW - 15 * 60000),
    cachedFor: jest.fn(() => [{ id: 'trex:event', name: 'LIVE | BULLS VS CAVALIERS 8K', group: 'US', score: 8000 }]),
    findForFixture: jest.fn(async () => [{ id: 'trex:event', name: 'LIVE | BULLS VS CAVALIERS 8K', group: 'US', score: 8000 }]),
    sweep: jest.fn(async () => new Map([['f1', [{ id: 'trex:event' }]]])),
    ...overrides
  };
}

function fixture(overrides = {}) {
  return {
    id: 'f1',
    title: 'Chicago Bulls vs Cleveland Cavaliers',
    category: 'basketball',
    date: IN_WINDOW,
    team1: { name: 'Chicago Bulls' },
    team2: { name: 'Cleveland Cavaliers' },
    sources: [{ source: 'daddylive', id: 'd1', channelName: 'Chicago Sports Network', country: 'United States', countryCode: 'US' }],
    ...overrides
  };
}

describe('KafkaProvider coverage sources', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.KAFKA_INJECTION_CAP;
    delete process.env.KAFKA_EVENT_SEARCH_ENABLED;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('orders event, then team, then label sources with the generic catalog id', () => {
    const provider = new KafkaProvider({ catalogStore: fakeStore(), eventSearch: fakeEventSearch() });

    const sources = provider.createSourcesForFixture(fixture(), { now: NOW });

    expect(sources.map((s) => s.matchMode)).toEqual(['event', 'label', 'team']);
    expect(sources.map((s) => s.id)).toEqual(['trex:event', 'trex:csn', 'trex:bulls']);
    for (const source of sources) {
      expect(source.source).toBe('kafka');
      expect(source.catalogId).toBe('flix-live-tv-v2-trex');
    }
    expect(sources[2].channelName).toBe('CHICAGO BULLS');
    expect(sources[1].channelName).toBe('CHICAGO SPORTS NETWORK');
  });

  test('passes the source country as label context', () => {
    const store = fakeStore();
    const provider = new KafkaProvider({ catalogStore: store, eventSearch: fakeEventSearch() });

    provider.createSourcesForFixture(fixture(), { now: NOW });

    expect(store.findChannel).toHaveBeenCalledWith('Chicago Sports Network', {
      country: 'United States',
      countryCode: 'US'
    });
  });

  test('has no event source outside the window or with an empty cache', () => {
    const provider = new KafkaProvider({ catalogStore: fakeStore(), eventSearch: fakeEventSearch() });

    expect(provider.createSourcesForFixture(fixture({ date: TOO_LATE }), { now: NOW }).map((s) => s.matchMode)).toEqual(['label', 'team']);

    const emptyCache = fakeEventSearch({ cachedFor: jest.fn(() => []) });
    const second = new KafkaProvider({ catalogStore: fakeStore(), eventSearch: emptyCache });
    expect(second.createSourcesForFixture(fixture(), { now: NOW }).map((s) => s.matchMode)).toEqual(['label', 'team']);
  });

  test('returns only the label source for a title-only fixture and never throws', () => {
    const provider = new KafkaProvider({ catalogStore: fakeStore(), eventSearch: fakeEventSearch() });
    const store = provider.catalogStore;
    store.findTeam.mockReturnValue([]);
    const eventSearch = provider.eventSearch;
    eventSearch.cachedFor.mockReturnValue([]);

    const sources = provider.createSourcesForFixture(fixture({ team1: null, team2: null }), { now: NOW });

    expect(sources.map((s) => s.matchMode)).toEqual(['label']);
    expect(provider.teamNamesOf({ team1: null, team2: { name: '  ' } })).toEqual([]);
  });

  test('attaches every matching source, with no fixed cap', () => {
    const store = fakeStore({
      findChannel: jest.fn((label) => [{
        id: `trex:${String(label).toLowerCase().replace(/\s+/g, '-')}`,
        name: `US| ${String(label).toUpperCase()}`,
        group: 'US',
        score: 2000
      }])
    });
    const provider = new KafkaProvider({ catalogStore: store, eventSearch: fakeEventSearch() });

    const sources = provider.createSourcesForFixture(fixture({
      sources: [
        { source: 'daddylive', id: 'd1', channelName: 'NBA TV', countryCode: 'US' },
        { source: 'daddylive', id: 'd2', channelName: 'ESPN', countryCode: 'US' },
        { source: 'daddylive', id: 'd3', channelName: 'TNT', countryCode: 'US' }
      ]
    }), { now: NOW });

    expect(sources.map((s) => s.matchMode)).toEqual(['event', 'label', 'label', 'label', 'team']);
    expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
  });

  test('an empty catalog match still adds nothing', () => {
    const provider = new KafkaProvider({
      catalogStore: fakeStore({ findChannel: jest.fn(() => []), findTeam: jest.fn(() => []) }),
      eventSearch: fakeEventSearch({ cachedFor: jest.fn(() => []) })
    });

    expect(provider.createSourcesForFixture(fixture(), { now: NOW })).toEqual([]);
  });

  test('dedupes a channel id shared by the label and team paths, keeping label', () => {
    const store = fakeStore({
      findTeam: jest.fn(() => [{ id: 'trex:same', name: 'NBA TEAM| CHICAGO BULLS', group: 'NBA TEAM', league: 'nba', score: 3000 }]),
      findChannel: jest.fn(() => [{ id: 'trex:same', name: 'US| CHICAGO BULLS', group: 'US', score: 2000 }])
    });
    const provider = new KafkaProvider({ catalogStore: store, eventSearch: fakeEventSearch({ cachedFor: jest.fn(() => []) }) });

    const sources = provider.createSourcesForFixture(fixture(), { now: NOW });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: 'trex:same', matchMode: 'label' });
  });

  test('reports not ready and injects nothing when the store is unavailable', () => {
    const store = fakeStore({ isReady: jest.fn(() => false) });
    const provider = new KafkaProvider({ catalogStore: store, eventSearch: fakeEventSearch() });

    expect(provider.isCoverageReady()).toBe(false);
    expect(provider.createSourcesForFixture(fixture(), { now: NOW })).toEqual([]);

    const none = new KafkaProvider({});
    expect(none.isCoverageReady()).toBe(false);
    expect(none.createSourcesForFixture(fixture(), { now: NOW })).toEqual([]);
  });

  test('teamNamesOf reads objects and strings', () => {
    const provider = new KafkaProvider({});
    expect(provider.teamNamesOf({ team1: { name: ' Chicago Bulls ' }, team2: 'Cleveland Cavaliers' })).toEqual([
      'Chicago Bulls',
      'Cleveland Cavaliers'
    ]);
    expect(provider.teamNamesOf(null)).toEqual([]);
  });

  test('sweepEvents is inert when event search is disabled', async () => {
    process.env.KAFKA_EVENT_SEARCH_ENABLED = 'false';
    const eventSearch = fakeEventSearch();
    const provider = new KafkaProvider({ catalogStore: fakeStore(), eventSearch });

    await expect(provider.sweepEvents([fixture()], { maxSearches: 5 })).resolves.toBe(0);
    expect(eventSearch.sweep).not.toHaveBeenCalled();
  });

  test('sweepEvents counts the fixtures that gained candidates', async () => {
    const eventSearch = fakeEventSearch({
      sweep: jest.fn(async () => new Map([['f1', [{ id: 'a' }, { id: 'b' }]], ['f2', []]]))
    });
    const provider = new KafkaProvider({ catalogStore: fakeStore(), eventSearch });

    await expect(provider.sweepEvents([fixture(), fixture({ id: 'f2' })], { maxSearches: 5 })).resolves.toBe(1);
    expect(eventSearch.sweep).toHaveBeenCalledWith(expect.any(Array), { maxSearches: 5 });
  });

  test('resolveEventStreams resolves the cached candidate through resolveStream', async () => {
    const provider = new KafkaProvider({ catalogStore: fakeStore(), eventSearch: fakeEventSearch() });
    provider.resolveStream = jest.fn(async () => [{ name: 'Kafka', url: 'https://cdn.example.invalid/e.m3u8' }]);

    const streams = await provider.resolveEventStreams(fixture(), { now: NOW });

    expect(provider.resolveStream).toHaveBeenCalledTimes(1);
    expect(provider.resolveStream).toHaveBeenCalledWith('trex:event', 'basketball', 'Chicago Bulls vs Cleveland Cavaliers', expect.objectContaining({ channelName: 'LIVE | BULLS VS CAVALIERS 8K' }), { now: NOW });
    expect(streams).toEqual([{ name: 'Kafka', url: 'https://cdn.example.invalid/e.m3u8' }]);
  });

  test('matches 24/7 channel cards by match.title and attaches all matching feeds', () => {
    const store = {
      isReady: () => true,
      findTeam: () => [],
      findChannel: jest.fn((label) => {
        if (label === 'TNT Sports 1') {
          return [
            { id: 'trex:tnt1-fhd', name: 'UK| TNT SPORTS 1 FHD', group: 'UK', score: 3000 },
            { id: 'trex:tnt1-4k', name: 'UK| TNT SPORTS 1 4K', group: 'UK', score: 4000 }
          ];
        }
        return [];
      })
    };

    const provider = new KafkaProvider({ catalogStore: store });
    const channelCard = {
      id: 'cdn_ch_xx_tnt-sports-1',
      title: 'TNT Sports 1',
      category: 'networks',
      sources: [
        { source: 'cdnlive', channelName: 'Stream 1' } // Source label doesn't match
      ]
    };

    const sources = provider.createSourcesForFixture(channelCard, { now: NOW });
    expect(sources.length).toBe(2);
    expect(sources.map((s) => s.id)).toEqual(['trex:tnt1-fhd', 'trex:tnt1-4k']);
    expect(sources[0].matchMode).toBe('label');
    expect(sources[0].channelName).toBe('TNT SPORTS 1 FHD');
    expect(store.findChannel).toHaveBeenCalledWith('TNT Sports 1', expect.any(Object));
  });

  test('uncaps feeds on source channelName for 24/7 channels but caps at 1 for match fixtures', () => {
    const store = {
      isReady: () => true,
      findTeam: () => [],
      findChannel: jest.fn((label) => {
        if (label === 'Sky Sports F1') {
          return [
            { id: 'trex:f1-uhd', name: 'UK| SKY SPORTS F1 UHD', group: 'UK', score: 4000 },
            { id: 'trex:f1-hd', name: 'UK| SKY SPORTS F1 HD', group: 'UK', score: 3000 }
          ];
        }
        return [];
      })
    };

    const provider = new KafkaProvider({ catalogStore: store });

    // 24/7 Channel card with source labeled Sky Sports F1
    const channelCard = {
      id: 'cdn_ch_xx_sky-sports-f1',
      title: 'Sky Sports F1',
      category: 'networks',
      sources: [{ source: 'cdnlive', channelName: 'Sky Sports F1' }]
    };
    const channelSources = provider.createSourcesForFixture(channelCard, { now: NOW });
    expect(channelSources.length).toBe(2);
    expect(channelSources.map((s) => s.id)).toEqual(['trex:f1-uhd', 'trex:f1-hd']);

    // Regular match fixture with source labeled Sky Sports F1
    const matchFixture = {
      id: 'live_match_123',
      title: 'Monaco GP Practice',
      category: 'formula1',
      sources: [{ source: 'cdnlive', channelName: 'Sky Sports F1' }]
    };
    const fixtureSources = provider.createSourcesForFixture(matchFixture, { now: NOW });
    expect(fixtureSources.length).toBe(1);
    expect(fixtureSources[0].id).toBe('trex:f1-uhd');
  });

  test('resolveEventStreams stays empty outside the window and when disabled', async () => {
    const provider = new KafkaProvider({ catalogStore: fakeStore(), eventSearch: fakeEventSearch() });
    provider.resolveStream = jest.fn(async () => [{ name: 'Kafka' }]);

    await expect(provider.resolveEventStreams(fixture({ date: TOO_LATE }), { now: NOW })).resolves.toEqual([]);
    expect(provider.resolveStream).not.toHaveBeenCalled();

    process.env.KAFKA_EVENT_SEARCH_ENABLED = 'false';
    await expect(provider.resolveEventStreams(fixture(), { now: NOW })).resolves.toEqual([]);
    expect(provider.resolveStream).not.toHaveBeenCalled();
  });

  test('resolveEventStreams never throws when the search fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const eventSearch = fakeEventSearch({ findForFixture: jest.fn(async () => { throw new Error('boom'); }) });
      const provider = new KafkaProvider({ catalogStore: fakeStore(), eventSearch });

      await expect(provider.resolveEventStreams(fixture(), { now: NOW })).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[KafkaProvider] event search failed:'));
    } finally {
      warn.mockRestore();
    }
  });

  describe('event-first rollout', () => {
    beforeEach(() => {
      process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = 'https://trex.invalid/manifest.json';
    });

    test('discovers local candidates for a mid-game fixture with no attached sources, then supplements on demand', async () => {
      const game = fixture({ date: new Date(Date.now() - 57 * 60000).toISOString(), sources: [] });
      const eventSearch = fakeEventSearch({ cachedFor: jest.fn(() => []) });
      const local = { id: 'trex:local', name: 'Live | Bulls vs Cavaliers' };
      const provider = new KafkaProvider({ eventSearch, catalogStore: fakeStore({ findEvents: jest.fn(() => [local]) }) });
      expect(provider.isEventFixtureEligible(game)).toBe(true);
      expect(await provider.eventCandidates(game)).toEqual([local]);
      expect(eventSearch.findForFixture).not.toHaveBeenCalled();
      eventSearch.findForFixture.mockResolvedValue([local, { id: 'trex:extra', name: 'Bulls vs Cavaliers' }]);
      expect((await provider.eventCandidates(game, { upstream: true })).map(hit => hit.id)).toEqual(['trex:local', 'trex:extra']);
      expect(provider.createSourcesForFixture(game)[0]).toMatchObject({ id: 'trex:local', matchMode: 'event' });
    });

    test('merges more than six SQLite and upstream candidates without truncation and deduplicates shared IDs', async () => {
      const game = fixture({ date: new Date(Date.now() - 20 * 60000).toISOString(), sources: [] });
      const localRows = Array.from({ length: 7 }, (_, i) => ({
        id: `trex:ev-${i + 1}`,
        name: `Live | Bulls vs. Cavaliers | Feed ${i + 1}`
      }));
      const upstreamRows = [
        localRows[2],
        { id: 'trex:ev-8', name: 'Next | Cavaliers vs. Bulls | Feed 8' },
        { id: 'trex:ev-9', name: 'Next | Bulls vs. Cavaliers | Feed 9' }
      ];
      const eventSearch = fakeEventSearch({
        cachedFor: jest.fn(() => []),
        findForFixture: jest.fn(async () => upstreamRows)
      });
      const provider = new KafkaProvider({
        eventSearch,
        catalogStore: fakeStore({ findEvents: jest.fn(() => localRows) })
      });

      const merged = await provider.eventCandidates(game, { upstream: true });
      expect(merged.map((hit) => hit.id)).toEqual([
        'trex:ev-1', 'trex:ev-2', 'trex:ev-3', 'trex:ev-4', 'trex:ev-5',
        'trex:ev-6', 'trex:ev-7', 'trex:ev-8', 'trex:ev-9'
      ]);
    });

    test('spends sweep budget only on fixtures short of event candidates', async () => {
      const game = fixture({ date: Date.now() });
      const eventSearch = fakeEventSearch({ cachedFor: jest.fn(() => []) });
      const store = fakeStore({ findEvents: jest.fn(m => m.id === 'f1' ? [{ id: 'a' }, { id: 'b' }] : []) });
      const provider = new KafkaProvider({ eventSearch, catalogStore: store });
      const pending = { ...game, id: 'f2' };
      await provider.sweepEvents([game, pending], { maxSearches: 20 });
      expect(eventSearch.sweep).toHaveBeenCalledWith([pending], { maxSearches: 20 });
      process.env.KAFKA_ENABLED = 'false';
      await expect(provider.eventCandidates(pending, { upstream: true })).resolves.toEqual([]);
      expect(eventSearch.findForFixture).not.toHaveBeenCalled();
    });

    test('shares two probe slots, removes canceled waiters and releases slots on exceptions', async () => {
      const provider = new KafkaProvider();
      const release = [];
      const hold = () => new Promise(done => release.push(done));
      const first = provider.withEventProbe(hold);
      const second = provider.withEventProbe(hold);
      const controller = new AbortController();
      const unused = jest.fn();
      const canceled = provider.withEventProbe(unused, controller.signal);
      const third = provider.withEventProbe(() => { throw new Error('upstream down'); });
      controller.abort();
      await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
      expect(unused).not.toHaveBeenCalled();
      release[0]();
      await expect(third).rejects.toThrow('upstream down');
      expect(await provider.withEventProbe(() => 'available')).toBe('available');
      release[1]();
      await Promise.all([first, second]);
    });
  });
});
