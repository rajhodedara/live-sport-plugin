'use strict';

const container = require('../src/container');
const {
  selectSources,
  resolveSource,
  KNOWN_LIVE_SOURCES,
  KNOWN_FALLBACKS,
  NICE_NAMES,
  CHANNEL_TITLE_NICE_NAMES,
  SOURCE_PRIORITY
} = require('../src/streams');

describe('Kafka Stream Dispatch and Selection', () => {
  test('kafka is present in KNOWN_LIVE_SOURCES and KNOWN_FALLBACKS', () => {
    expect(KNOWN_LIVE_SOURCES).toContain('kafka');
    expect(KNOWN_FALLBACKS).toContain('kafka');
  });

  test('kafka has friendly nice names and channel title names', () => {
    expect(NICE_NAMES.kafka).toBe('Kafka');
    expect(CHANNEL_TITLE_NICE_NAMES.kafka).toBe('Kafka');
  });

  test('kafka has top-tier priority 1 in SOURCE_PRIORITY', () => {
    expect(SOURCE_PRIORITY.kafka).toBeDefined();
    expect(SOURCE_PRIORITY.kafka).toBe(1);
  });

  test('selectSources includes kafka in default fallback list and filters by liveSources config', () => {
    const matchSources = [
      { source: 'vavoo', id: 'v1' },
      { source: 'kafka', id: 'k1' },
      { source: 'daddylive', id: 'd1' }
    ];

    // Default configuration: kafka is included
    const defaultSelected = selectSources(matchSources, null);
    expect(defaultSelected.map((s) => s.source)).toContain('kafka');

    // Filtered configuration: only kafka allowed
    const kafkaOnly = selectSources(matchSources, { liveSources: 'kafka' });
    expect(kafkaOnly).toHaveLength(1);
    expect(kafkaOnly[0].source).toBe('kafka');

    // Filtered configuration: kafka excluded
    const noKafka = selectSources(matchSources, { liveSources: 'daddylive' });
    expect(noKafka.map((s) => s.source)).not.toContain('kafka');
  });

  test('dispatchToProvider routes kafka sources to kafkaProvider.resolveStream', async () => {
    const mockResolveStream = jest.fn().mockResolvedValue([
      { name: 'Kafka', title: 'Sky Sports Cricket', url: 'https://cdn.example.invalid/live.m3u8' }
    ]);

    const fakeKafkaProvider = {
      resolveStream: mockResolveStream
    };

    const originalResolve = container.resolve;
    container.resolve = jest.fn((name) => {
      if (name === 'kafkaProvider') return fakeKafkaProvider;
      return originalResolve.call(container, name);
    });

    try {
      const src = {
        source: 'kafka',
        id: 'flix:sky-cricket',
        channelName: 'Sky Sports Cricket'
      };
      const match = { id: 'm1', category: 'cricket', title: 'India vs England' };
      const controller = new AbortController();
      const opts = { signal: controller.signal };

      const res = await resolveSource(src, match, null, opts);
      expect(mockResolveStream).toHaveBeenCalledWith(
        'flix:sky-cricket',
        'cricket',
        'India vs England',
        src,
        opts
      );
      expect(res).toHaveLength(1);
      expect(res[0].url).toBe('https://cdn.example.invalid/live.m3u8');
    } finally {
      container.resolve = originalResolve;
    }
  });

  test('prepends event feeds for non-event Kafka sources and skips them for event sources', async () => {
    const eventStream = {
      name: 'Kafka',
      title: 'Event feed',
      url: 'https://cdn.example.invalid/e.m3u8',
      _source: 'kafka'
    };
    const mockResolveStream = jest.fn().mockResolvedValue([
      { name: 'Kafka', title: 'Team feed', url: 'https://cdn.example.invalid/team.m3u8' }
    ]);
    const mockResolveEventStreams = jest.fn().mockResolvedValue([eventStream]);

    const fakeKafkaProvider = {
      resolveStream: mockResolveStream,
      resolveEventStreams: mockResolveEventStreams
    };

    const originalResolve = container.resolve;
    container.resolve = jest.fn((name) => {
      if (name === 'kafkaProvider') return fakeKafkaProvider;
      return originalResolve.call(container, name);
    });

    try {
      const match = { id: 'm1', category: 'basketball', title: 'Bulls vs Cavaliers' };
      const opts = {};

      const teamRes = await resolveSource(
        { source: 'kafka', id: 'flix:team-feed', channelName: 'NBA TEAM| CHICAGO BULLS', matchMode: 'team' },
        match,
        null,
        opts
      );
      expect(mockResolveEventStreams).toHaveBeenCalledWith(match, opts);
      expect(teamRes.map((s) => s.url)).toEqual([
        'https://cdn.example.invalid/e.m3u8',
        'https://cdn.example.invalid/team.m3u8'
      ]);

      mockResolveEventStreams.mockClear();
      const eventRes = await resolveSource(
        { source: 'kafka', id: 'fx:ev', channelName: 'NEXT | Bulls vs Cavaliers', matchMode: 'event' },
        match,
        null,
        opts
      );
      expect(mockResolveEventStreams).not.toHaveBeenCalled();
      expect(eventRes.map((s) => s.url)).toEqual(['https://cdn.example.invalid/team.m3u8']);

      mockResolveEventStreams.mockClear();
      const secondRes = await resolveSource(
        { source: 'kafka', id: 'flix:team-feed-2', channelName: 'NBA TEAM| CLEVELAND CAVALIERS', matchMode: 'team' },
        match,
        null,
        opts
      );
      expect(mockResolveEventStreams).toHaveBeenCalledTimes(1);
      expect(secondRes[0].url).toBe('https://cdn.example.invalid/e.m3u8');
    } finally {
      container.resolve = originalResolve;
    }
  });

  test('compareStreams places kafka streams at the top of the list for the language tier', () => {
    const { compareStreams, parseLanguagePriority, DIRECT_STREAM_NAME } = require('../src/services/LanguagePriorityService');
    const priorities = parseLanguagePriority({});

    const daddyliveStream = {
      name: DIRECT_STREAM_NAME,
      _source: 'daddylive',
      language: 'English',
      resolution: '1080p',
      score: 110,
      speedScore: 90
    };

    const kafkaStream = {
      name: DIRECT_STREAM_NAME,
      _source: 'kafka',
      language: 'English',
      resolution: '1080p',
      score: 90,
      speedScore: 80
    };

    // Kafka stream must outrank non-Kafka stream in same language
    expect(compareStreams(kafkaStream, daddyliveStream, priorities)).toBeLessThan(0);
    expect(compareStreams(daddyliveStream, kafkaStream, priorities)).toBeGreaterThan(0);

    const sorted = [daddyliveStream, kafkaStream].sort((a, b) => compareStreams(a, b, priorities));
    expect(sorted[0]._source).toBe('kafka');
    expect(sorted[1]._source).toBe('daddylive');
  });
});
