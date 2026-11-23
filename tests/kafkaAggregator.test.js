'use strict';

const MatchAggregator = require('../src/services/MatchAggregator');
const MatchEntity = require('../src/domain/MatchEntity');

describe('KafkaAggregator - Task 3: Scheduled Fixture Enrichment', () => {
  let mockKafkaProvider;
  let mockCacheService;

  beforeEach(() => {
    mockKafkaProvider = {
      name: 'Kafka',
      sourceName: 'kafka',
      configured: true,
      refreshIndex: jest.fn().mockResolvedValue(new Map()),
      createSource: jest.fn((name) => {
        if (name === 'Sky Sports Cricket') {
          return {
            source: 'kafka',
            id: 'flix:sky-cricket',
            channelName: 'Sky Sports Cricket',
            catalogId: 'cat-cricket',
            language: 'English',
            type: 'channel'
          };
        }
        if (name === 'TNT Sports 1') {
          return {
            source: 'kafka',
            id: 'flix:tnt-1',
            channelName: 'TNT Sports 1',
            catalogId: 'cat-football',
            language: 'English',
            type: 'channel'
          };
        }
        return null;
      })
    };

    mockCacheService = {
      getMatches: jest.fn().mockReturnValue([]),
      getMatchesReadOnly: jest.fn().mockReturnValue([]),
      setMatches: jest.fn()
    };
  });

  test('kafkaProvider is stored separately from normal providers list', () => {
    const aggregator = new MatchAggregator({
      kafkaProvider: mockKafkaProvider,
      cacheService: mockCacheService
    });

    expect(aggregator.kafkaProvider).toBe(mockKafkaProvider);
    expect(aggregator.providers).not.toContain(mockKafkaProvider);
  });

  test('syncMatches calls kafkaProvider.refreshIndex and enriches live fixtures carrying broadcaster labels', async () => {
    const mockProvider = {
      name: 'DummyLive',
      sourceName: 'daddylive',
      getMatches: jest.fn().mockResolvedValue([
        new MatchEntity({
          id: 'fixture-1',
          title: 'India vs England',
          category: 'cricket',
          date: String(Date.UTC(2100, 0, 1)),
          sources: [
            {
              source: 'daddylive',
              id: '101',
              channelName: 'Sky Sports Cricket'
            }
          ]
        })
      ])
    };

    const aggregator = new MatchAggregator({
      daddyLiveProvider: mockProvider,
      kafkaProvider: mockKafkaProvider,
      cacheService: mockCacheService
    });

    const results = await aggregator.syncMatches();
    expect(mockKafkaProvider.refreshIndex).toHaveBeenCalled();
    expect(results).toHaveLength(1);

    const match = results[0];
    expect(match.id).toBe('fixture-1');
    expect(match.sources).toHaveLength(2);
    expect(match.sources[1]).toEqual({
      source: 'kafka',
      id: 'flix:sky-cricket',
      channelName: 'Sky Sports Cricket',
      catalogId: 'cat-cricket',
      language: 'English',
      type: 'channel'
    });
  });

  test('never creates new fixture cards from Kafka and never enriches networks or replays', async () => {
    const mockProvider = {
      name: 'DummyLive',
      sourceName: 'daddylive',
      getMatches: jest.fn().mockResolvedValue([
        new MatchEntity({
          id: 'dlv_ch_101',
          title: 'Sky Sports Cricket',
          category: 'networks',
          date: '0',
          sources: [{ source: 'daddylive', id: '101', channelName: 'Sky Sports Cricket' }]
        }),
        new MatchEntity({
          id: 'rz_past_match',
          title: 'India vs England Highlights',
          category: 'cricket',
          isReplay: true,
          date: '2026-11-20',
          sources: [{ source: 'replayzone', id: 'rz1', channelName: 'Sky Sports Cricket' }]
        })
      ])
    };

    const aggregator = new MatchAggregator({
      daddyLiveProvider: mockProvider,
      kafkaProvider: mockKafkaProvider,
      cacheService: mockCacheService
    });

    const results = await aggregator.syncMatches();
    expect(results).toHaveLength(2);

    // Network row must not carry Kafka source
    const networkRow = results.find((r) => r.category === 'networks');
    expect(networkRow.sources.some((s) => s.source === 'kafka')).toBe(false);

    // Replay row must not carry Kafka source
    const replayRow = results.find((r) => r.isReplay);
    expect(replayRow.sources.some((s) => s.source === 'kafka')).toBe(false);
  });

  test('respects KAFKA_INJECTION_CAP on number of Kafka sources attached per fixture', async () => {
    const originalCap = process.env.KAFKA_INJECTION_CAP;
    process.env.KAFKA_INJECTION_CAP = '1';

    try {
      const mockProvider = {
        name: 'DummyLive',
        sourceName: 'daddylive',
        getMatches: jest.fn().mockResolvedValue([
          new MatchEntity({
            id: 'multi-broadcaster-1',
            title: 'Big Match',
            category: 'football',
            date: String(Date.UTC(2100, 0, 1)),
            sources: [
              { source: 'daddylive', id: '1', channelName: 'Sky Sports Cricket' },
              { source: 'daddylive', id: '2', channelName: 'TNT Sports 1' }
            ]
          })
        ])
      };

      const aggregator = new MatchAggregator({
        daddyLiveProvider: mockProvider,
        kafkaProvider: mockKafkaProvider,
        cacheService: mockCacheService
      });

      const results = await aggregator.syncMatches();
      const match = results[0];
      const kafkaSources = match.sources.filter((s) => s.source === 'kafka');
      expect(kafkaSources).toHaveLength(1);
    } finally {
      if (originalCap === undefined) delete process.env.KAFKA_INJECTION_CAP;
      else process.env.KAFKA_INJECTION_CAP = originalCap;
    }
  });

  test('handles Kafka refresh failure gracefully without aborting sync or corrupting fixtures', async () => {
    mockKafkaProvider.refreshIndex = jest.fn().mockRejectedValue(new Error('Network timeout'));

    const mockProvider = {
      name: 'DummyLive',
      sourceName: 'daddylive',
      getMatches: jest.fn().mockResolvedValue([
        new MatchEntity({
          id: 'fixture-safe',
          title: 'Safe Match',
          category: 'cricket',
          date: String(Date.UTC(2100, 0, 1)),
          sources: [{ source: 'daddylive', id: '1' }]
        })
      ])
    };

    const aggregator = new MatchAggregator({
      daddyLiveProvider: mockProvider,
      kafkaProvider: mockKafkaProvider,
      cacheService: mockCacheService
    });

    const results = await aggregator.syncMatches();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('fixture-safe');
  });

  test('does not enrich a fixture more than fourteen hours after kickoff', () => {
    const now = Date.UTC(2099, 0, 1, 20);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const aggregator = new MatchAggregator({
      kafkaProvider: mockKafkaProvider,
      cacheService: mockCacheService
    });
    const oldFixture = new MatchEntity({
      id: 'old-live-fixture',
      title: 'Old Match',
      category: 'cricket',
      date: String(now - (20 * 3600 * 1000)),
      sources: [{ source: 'daddylive', id: '1', channelName: 'Sky Sports Cricket' }]
    });

    try {
      aggregator._enrichMatchesWithKafka([oldFixture]);
      expect(oldFixture.sources.some(source => source.source === 'kafka')).toBe(false);
      expect(mockKafkaProvider.createSource).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('registers Kafka and records refresh and attachment health telemetry', async () => {
    const providerHealthService = {
      registerProviders: jest.fn(),
      startSync: jest.fn(),
      recordResult: jest.fn(),
      recordCarryForward: jest.fn(),
      finishSync: jest.fn(),
      recordAuxiliaryResult: jest.fn(),
      recordEnrichment: jest.fn()
    };
    mockKafkaProvider.lastRefreshSucceeded = true;
    mockKafkaProvider.lastRefreshErrorKind = null;
    mockKafkaProvider.lastIndexedChannelCount = 2;

    const aggregator = new MatchAggregator({
      daddyLiveProvider: {
        name: 'DummyLive',
        sourceName: 'daddylive',
        getMatches: jest.fn().mockResolvedValue([new MatchEntity({
          id: 'health-fixture',
          title: 'Health Match',
          category: 'cricket',
          date: String(Date.UTC(2100, 0, 1)),
          sources: [{ source: 'daddylive', id: '1' }]
        })])
      },
      kafkaProvider: mockKafkaProvider,
      cacheService: mockCacheService,
      providerHealthService
    });
    await aggregator.syncMatches();

    expect(providerHealthService.registerProviders.mock.calls[0][0]).toContain(mockKafkaProvider);
    expect(providerHealthService.recordAuxiliaryResult).toHaveBeenCalledWith(
      mockKafkaProvider,
      expect.objectContaining({ itemCount: 2, error: null })
    );
    expect(providerHealthService.recordEnrichment).toHaveBeenCalledWith(
      mockKafkaProvider,
      { enrichedFixtures: 0, totalSourcesAttached: 0 }
    );
  });
});
