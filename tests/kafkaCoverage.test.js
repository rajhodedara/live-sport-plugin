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

  test('honors KAFKA_INJECTION_CAP', () => {
    process.env.KAFKA_INJECTION_CAP = '1';
    const provider = new KafkaProvider({ catalogStore: fakeStore(), eventSearch: fakeEventSearch() });

    const sources = provider.createSourcesForFixture(fixture(), { now: NOW });

    expect(sources).toHaveLength(1);
    expect(sources[0].matchMode).toBe('event');
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
});
