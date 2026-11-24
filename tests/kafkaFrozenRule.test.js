'use strict';

jest.mock('../src/impitClient', () => ({
  safeFetch: jest.fn(),
  isImpitAvailable: () => false,
  getImpit: () => null,
}));

const { safeFetch } = require('../src/impitClient');
const { verifyStreams } = require('../src/streams');
const StreamEntity = require('../src/domain/StreamEntity');
const M3U8ParserService = require('../src/services/M3U8ParserService');

const FROZEN_BODY = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n';

describe('Kafka frozen-playlist rule in verifyStreams', () => {
  const parser = new M3U8ParserService();
  const makeCache = () => ({
    failures: 0,
    successes: 0,
    noteFailure() { this.failures++; },
    noteSuccess() { this.successes++; }
  });
  const makeStream = (source) => {
    const stream = new StreamEntity({
      name: 'Kafka',
      title: 'Kafka (Event feed)',
      url: 'https://cdn.example.invalid/live/media.m3u8'
    });
    stream._source = source;
    return stream;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('drops a Kafka media playlist stuck at media sequence 0', async () => {
    safeFetch.mockResolvedValue({ status: 200, text: async () => FROZEN_BODY });

    const cache = makeCache();
    const verified = await verifyStreams([makeStream('kafka')], 'cacheKey', parser, cache);

    expect(verified).toHaveLength(0);
    expect(cache.failures).toBe(1);
  });

  test('keeps a Kafka media playlist whose sequence has advanced', async () => {
    safeFetch.mockResolvedValue({
      status: 200,
      text: async () => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n'
    });

    const cache = makeCache();
    const verified = await verifyStreams([makeStream('kafka')], 'cacheKey', parser, cache);

    expect(verified).toHaveLength(1);
    expect(verified[0].url).toBe('https://cdn.example.invalid/live/media.m3u8');
    expect(cache.failures).toBe(0);
  });

  test('leaves other sources untouched even at media sequence 0', async () => {
    safeFetch.mockResolvedValue({ status: 200, text: async () => FROZEN_BODY });

    const cache = makeCache();
    const verified = await verifyStreams([makeStream('vavoo')], 'cacheKey', parser, cache);

    expect(verified).toHaveLength(1);
    expect(verified[0].url).toBe('https://cdn.example.invalid/live/media.m3u8');
    expect(cache.failures).toBe(0);
  });

  test('honors KAFKA_LIVENESS_GUARD_ENABLED=false', async () => {
    const previous = process.env.KAFKA_LIVENESS_GUARD_ENABLED;
    process.env.KAFKA_LIVENESS_GUARD_ENABLED = 'false';
    safeFetch.mockResolvedValue({ status: 200, text: async () => FROZEN_BODY });

    try {
      const cache = makeCache();
      const verified = await verifyStreams([makeStream('kafka')], 'cacheKey', parser, cache);

      expect(verified).toHaveLength(1);
      expect(verified[0].url).toBe('https://cdn.example.invalid/live/media.m3u8');
      expect(cache.failures).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.KAFKA_LIVENESS_GUARD_ENABLED;
      else process.env.KAFKA_LIVENESS_GUARD_ENABLED = previous;
    }
  });
});
