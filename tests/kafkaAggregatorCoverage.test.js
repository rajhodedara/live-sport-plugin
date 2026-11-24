'use strict';

const MatchAggregator = require('../src/services/MatchAggregator');
const MatchEntity = require('../src/domain/MatchEntity');

function healthService() {
  return {
    registerProviders: jest.fn(),
    startSync: jest.fn(),
    recordResult: jest.fn(),
    recordCarryForward: jest.fn(),
    finishSync: jest.fn(),
    recordAuxiliaryResult: jest.fn(),
    recordEnrichment: jest.fn()
  };
}

function liveProvider(id = 'coverage-fixture') {
  return {
    name: 'DummyLive',
    sourceName: 'daddylive',
    getMatches: jest.fn().mockResolvedValue([
      new MatchEntity({
        id,
        title: 'Chicago Bulls vs Cleveland Cavaliers',
        category: 'basketball',
        date: String(Date.now() + 30 * 60000),
        team1: { name: 'Chicago Bulls' },
        team2: { name: 'Cleveland Cavaliers' },
        sources: [{ source: 'daddylive', id: '1', channelName: 'Sky Sports Cricket', countryCode: 'UK' }]
      })
    ])
  };
}

function labelProvider() {
  return {
    name: 'Kafka',
    sourceName: 'kafka',
    configured: true,
    lastRefreshSucceeded: true,
    lastRefreshErrorKind: null,
    lastIndexedChannelCount: 2,
    refreshIndex: jest.fn().mockResolvedValue(new Map()),
    createSource: jest.fn((name) =>
      name === 'Sky Sports Cricket'
        ? { source: 'kafka', id: 'flix:sky-cricket', channelName: 'Sky Sports Cricket', catalogId: 'cat-cricket', type: 'channel' }
        : null
    )
  };
}

function coverageProvider(overrides = {}) {
  return {
    ...labelProvider(),
    isCoverageReady: jest.fn(() => true),
    sweepEvents: jest.fn().mockResolvedValue(1),
    createSourcesForFixture: jest.fn(() => [
      { source: 'kafka', id: 'fx:ev', channelName: 'NEXT | BULLS VS CAVALIERS 8K', catalogId: 'flix-live-tv-v2-trex', matchMode: 'event' },
      { source: 'kafka', id: 'flix:sky-cricket', channelName: 'Sky Sports Cricket', catalogId: 'flix-live-tv-v2-trex', matchMode: 'label' },
      { source: 'kafka', id: 'fx:team', channelName: 'NBA TEAM| CHICAGO BULLS', catalogId: 'flix-live-tv-v2-trex', matchMode: 'team' }
    ]),
    ...overrides
  };
}

function cacheService() {
  return { getMatches: jest.fn().mockReturnValue([]), getMatchesReadOnly: jest.fn().mockReturnValue([]), setMatches: jest.fn() };
}

describe('MatchAggregator Kafka catalog coverage', () => {
  test('attaches event then label then team sources and passes the clock', async () => {
    const kafkaProvider = coverageProvider();
    const aggregator = new MatchAggregator({
      daddyLiveProvider: liveProvider(),
      kafkaProvider,
      cacheService: cacheService()
    });

    const results = await aggregator.syncMatches();
    const match = results.find((row) => row.id === 'coverage-fixture');

    const kafkaSources = match.sources.filter((source) => source.source === 'kafka');
    expect(kafkaSources.map((source) => source.id)).toEqual(['fx:ev', 'flix:sky-cricket', 'fx:team']);
    expect(kafkaProvider.createSourcesForFixture).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'coverage-fixture' }),
      { now: expect.any(Number) }
    );
  });

  test('sweeps the live window before enrichment', async () => {
    const kafkaProvider = coverageProvider();
    const providerHealthService = healthService();
    const aggregator = new MatchAggregator({
      daddyLiveProvider: liveProvider(),
      kafkaProvider,
      cacheService: cacheService(),
      providerHealthService
    });

    await aggregator.syncMatches();

    expect(kafkaProvider.sweepEvents).toHaveBeenCalledWith(expect.any(Array), { maxSearches: 20 });
    const sweepOrder = kafkaProvider.sweepEvents.mock.invocationCallOrder[0];
    const enrichmentOrder = providerHealthService.recordEnrichment.mock.invocationCallOrder[0];
    expect(sweepOrder).toBeLessThan(enrichmentOrder);
  });

  test('reports per-mode telemetry that sums to the total', async () => {
    const kafkaProvider = coverageProvider();
    const providerHealthService = healthService();
    const aggregator = new MatchAggregator({
      daddyLiveProvider: liveProvider(),
      kafkaProvider,
      cacheService: cacheService(),
      providerHealthService
    });

    await aggregator.syncMatches();

    expect(providerHealthService.recordEnrichment).toHaveBeenCalledWith(
      kafkaProvider,
      expect.objectContaining({
        enrichedFixtures: 1,
        totalSourcesAttached: 3,
        byMode: { event: 1, team: 1, label: 1 }
      })
    );
    const payload = providerHealthService.recordEnrichment.mock.calls[0][1];
    const sum = payload.byMode.event + payload.byMode.team + payload.byMode.label;
    expect(sum).toBe(payload.totalSourcesAttached);
  });

  test('falls back to the label path when coverage is not ready', async () => {
    const kafkaProvider = coverageProvider({ isCoverageReady: jest.fn(() => false) });
    const providerHealthService = healthService();
    const aggregator = new MatchAggregator({
      daddyLiveProvider: liveProvider(),
      kafkaProvider,
      cacheService: cacheService(),
      providerHealthService
    });

    const results = await aggregator.syncMatches();
    const match = results.find((row) => row.id === 'coverage-fixture');
    const kafkaSources = match.sources.filter((source) => source.source === 'kafka');

    expect(kafkaSources.map((source) => source.id)).toEqual(['flix:sky-cricket']);
    expect(kafkaProvider.createSourcesForFixture).not.toHaveBeenCalled();
    expect(kafkaProvider.sweepEvents).not.toHaveBeenCalled();
    expect(providerHealthService.recordEnrichment).toHaveBeenCalledWith(
      kafkaProvider,
      expect.objectContaining({ byMode: { event: 0, team: 0, label: 1 } })
    );
  });

  test('survives a failing sweep without losing the fixture', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const kafkaProvider = coverageProvider({ sweepEvents: jest.fn().mockRejectedValue(new Error('upstream down')) });
      const aggregator = new MatchAggregator({
        daddyLiveProvider: liveProvider(),
        kafkaProvider,
        cacheService: cacheService()
      });

      const results = await aggregator.syncMatches();

      expect(results.find((row) => row.id === 'coverage-fixture')).toBeDefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[MatchAggregator] kafkaProvider.sweepEvents failed:'), expect.any(String));
    } finally {
      warn.mockRestore();
    }
  });
});
