'use strict';

jest.mock('../src/impitClient', () => ({
  safeFetch: jest.fn(),
  isImpitAvailable: () => false,
  getImpit: () => null,
}));

const { safeFetch } = require('../src/impitClient');
const { verifyStreams, evaluatePlaylistLiveness } = require('../src/streams');
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

  describe('requireLivePlaylist event verification mode', () => {
    test('drops 502, ended sequence-0, and ended advancing playlists while keeping live and master playlists', async () => {
      const stream = makeStream('kafka');
      const cache = makeCache();

      safeFetch.mockResolvedValue({ status: 502, text: async () => 'Bad Gateway' });
      await expect(verifyStreams([stream], null, parser, cache, { requireLivePlaylist: true })).resolves.toEqual([]);

      safeFetch.mockResolvedValue({
        status: 200,
        text: async () => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n'
      });
      await expect(verifyStreams([stream], null, parser, cache, { requireLivePlaylist: true })).resolves.toEqual([]);

      safeFetch.mockResolvedValue({
        status: 200,
        text: async () => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:4,\nseg12.ts\n#EXT-X-ENDLIST\n'
      });
      await expect(verifyStreams([stream], null, parser, cache, { requireLivePlaylist: true })).resolves.toEqual([]);

      safeFetch.mockResolvedValue({ status: 403, text: async () => 'Forbidden' });
      await expect(verifyStreams([stream], null, parser, cache, { requireLivePlaylist: true })).resolves.toEqual([]);

      safeFetch.mockResolvedValue({
        status: 200,
        text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\n720p.m3u8\n'
      });
      const master = await verifyStreams([stream], null, parser, cache, { requireLivePlaylist: true });
      expect(master).toHaveLength(1);

      safeFetch.mockResolvedValue({
        status: 200,
        text: async () => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9\n#EXTINF:4,\nseg9.ts\n'
      });
      const live = await verifyStreams([makeStream('kafka')], null, parser, cache, { requireLivePlaylist: true });
      expect(live).toHaveLength(1);
    });
  });

  describe('evaluatePlaylistLiveness sequence-window rules', () => {
    test('treats a nonzero sequence that stays flat for less than one target duration as inconclusive, then flat once exceeded', () => {
      const base = 1_700_000_000_000;
      expect(evaluatePlaylistLiveness({
        prevSequence: 12,
        prevObservedAt: base,
        currentSequence: 12,
        now: base + 3500,
        targetDurationSec: 4
      })).toBe('inconclusive');

      expect(evaluatePlaylistLiveness({
        prevSequence: 12,
        prevObservedAt: base,
        currentSequence: 12,
        now: base + 4000,
        targetDurationSec: 4
      })).toBe('flat');

      expect(evaluatePlaylistLiveness({
        prevSequence: 12,
        prevObservedAt: base,
        currentSequence: 13,
        now: base + 2000,
        targetDurationSec: 4
      })).toBe('advancing');

      expect(evaluatePlaylistLiveness({
        prevSequence: 0,
        prevObservedAt: base,
        currentSequence: 0,
        now: base + 1000,
        targetDurationSec: 4
      })).toBe('frozen');
    });
  });
});
