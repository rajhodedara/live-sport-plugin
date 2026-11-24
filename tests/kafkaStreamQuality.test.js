'use strict';

const { probeBitrate, resolutionFromBitrate, resolutionFromTag, firstSegment } =
  require('../src/services/StreamBitrateProbe');
const KafkaProvider = require('../src/providers/KafkaProvider');

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:11',
  '#EXTINF:10.0,',
  'https://cdn.example.com/live/segment/1?t=abc',
  '#EXT-X-ENDLIST',
  ''
].join('\n');

function fakeFetch({ bytes = 7239316, status = 200, cancel = true } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get(name) {
          if (String(name).toLowerCase() === 'content-length') return String(bytes);
          return null;
        }
      },
      body: { cancel: async () => { calls.push('cancelled'); return cancel; } }
    };
  };
  impl.calls = calls;
  return impl;
}

describe('resolutionFromTag', () => {
  test.each([
    ['NZ| SKY SPORT 4 HD · HD', null],
    ['TR| NBA TV 4K · UHD', '2160p'],
    ['US| ESPN · FHD', '1080p'],
    ['AR| TYC SPORTS · 1080P', '1080p'],
    ['CA| NBA TV · LIVE', null],
    ['NBA TV HD', null]
  ])('%s -> %s', (text, expected) => {
    expect(resolutionFromTag(text)).toBe(expected);
  });
});

describe('resolutionFromBitrate', () => {
  test('uses the same ladder the speed probe uses', () => {
    expect(resolutionFromBitrate(5800000)).toBe('1080p60');
    expect(resolutionFromBitrate(4200000)).toBe('1080p');
    expect(resolutionFromBitrate(2500000)).toBe('720p');
    expect(resolutionFromBitrate(900000)).toBe('SD');
    expect(resolutionFromBitrate(0)).toBe(null);
  });
});

describe('probeBitrate', () => {
  test('reads the segment length without downloading the segment', async () => {
    const fetchImpl = fakeFetch({ bytes: 7239316 });
    const result = await probeBitrate({ playlistText: PLAYLIST, playlistUrl: 'https://cdn.example.com/live/index.m3u8', fetchImpl });

    expect(result.bitrate).toBe('5.8 Mbps');
    expect(result.resolution).toBe('1080p60');
    expect(fetchImpl.calls).toEqual([
      'https://cdn.example.com/live/segment/1?t=abc',
      'cancelled'
    ]);
  });

  test('gives nothing back when the segment cannot be read', async () => {
    const fetchImpl = async () => ({ ok: false, status: 502, headers: { get: () => null }, body: { cancel: async () => {} } });
    await expect(probeBitrate({ playlistText: PLAYLIST, playlistUrl: 'https://cdn.example.com/x.m3u8', fetchImpl }))
      .resolves.toEqual({ bitrate: '', resolution: null });
  });

  test('ignores a playlist without EXTINF', async () => {
    const fetchImpl = fakeFetch();
    const result = await probeBitrate({ playlistText: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n', playlistUrl: 'https://cdn.example.com/x.m3u8', fetchImpl });
    expect(result).toEqual({ bitrate: '', resolution: null });
    expect(fetchImpl.calls).toEqual([]);
  });

  test('resolves a relative segment against the playlist URL', () => {
    const playlist = '#EXTM3U\n#EXTINF:6.0,\nseg/1.ts\n';
    expect(firstSegment(playlist, 'https://cdn.example.com/live/index.m3u8'))
      .toEqual({ url: 'https://cdn.example.com/live/seg/1.ts', duration: 6 });
  });
});

describe('Kafka stream quality', () => {
  function providerServing(streams) {
    const provider = new KafkaProvider({});
    provider.manifestUrl = 'https://upstream.invalid/manifest.json';
    Object.defineProperty(provider, 'configured', { get: () => true });
    provider.proxyFetch = async () => ({ ok: true, json: async () => ({ streams }) });
    return provider;
  }

  const upstreamStream = {
    name: '▶ Watch Live',
    title: 'TR| NBA TV 4K · UHD',
    url: 'https://cdn.example.com/live/index.m3u8',
    behaviorHints: { notWebReady: true }
  };

  test('publishes the declared tier, not the player label', async () => {
    const [entity] = await providerServing([upstreamStream]).resolveStream('trex:1', 'basketball', 'Lakers vs Jazz', { channelName: 'NBA TV 4K' });

    expect(entity.quality).toBeUndefined();
    expect(entity.resolution).toBe('2160p');
    expect(entity.measureBitrate).toBe(true);
  });

  test('falls back to the app-wide HD stand-in when nothing declares a tier', async () => {
    const [entity] = await providerServing([{ ...upstreamStream, title: 'CA| NBA TV · LIVE' }])
      .resolveStream('trex:2', 'basketball', 'Lakers vs Jazz', { channelName: 'NBA TV' });

    expect(entity.quality).toBeUndefined();
    expect(entity.resolution).toBe('HD');
  });
});
