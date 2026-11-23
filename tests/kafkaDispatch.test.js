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

  test('kafka has an explicit priority in SOURCE_PRIORITY near Vavoo', () => {
    expect(SOURCE_PRIORITY.kafka).toBeDefined();
    expect(SOURCE_PRIORITY.kafka).toBe(6);
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
});
