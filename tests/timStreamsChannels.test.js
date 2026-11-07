'use strict';

process.env.NODE_ENV = 'test';

const TimStreamsProvider = require('../src/providers/TimStreamsProvider');

describe('TimStreamsProvider 24/7 Live TV Channels', () => {
  let provider;

  beforeEach(() => {
    provider = new TimStreamsProvider({
      circuitBreaker: {
        wrap: (name, fn) => ({ fire: fn }),
        wrapSync: (name, fn) => ({ fire: fn })
      }
    });
  });

  test('ingests 24/7 channels into networks category with canonical identity keys', async () => {
    provider.fetchData = {
      fire: async () => ({ events: [] })
    };
    provider.fetchChannels = {
      fire: async () => ({
        channels: [
          {
            url: 'abc-usa',
            name: 'ABC',
            logo: 'https://cdn.test/abc.png',
            genre: 1,
            flag: 'us',
            vip: false,
            streams: [
              {
                name: 'TimStreams',
                url: 'https://ehgembxe.cfd/nhmzkzez-3028',
                vip: false
              }
            ]
          },
          {
            url: 'vip-only-channel',
            name: 'VIP Channel',
            genre: 2,
            vip: true,
            streams: [{ name: 'Stream', url: 'https://embed.test/vip', vip: true }]
          }
        ],
        genres: [{ id: 1, name: 'Entertainment' }, { id: 2, name: 'Sports' }]
      })
    };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);
    const abc = matches[0];
    expect(abc.id).toBe('ts_ch_abc-usa');
    expect(abc.category).toBe('networks');
    expect(abc.isChannel).toBe(true);
    expect(abc.is247).toBe(true);
    expect(abc.channelIdentityKey).toBe('abc');
    expect(abc.sources[0].source).toBe('timstreams');
    expect(abc.sources[0].type).toBe('channel');
    expect(abc.sources[0].url).toBe('https://ehgembxe.cfd/nhmzkzez-3028');
  });

  test('channels API failure does not break live fixtures ingestion', async () => {
    provider.fetchData = {
      fire: async () => ({
        events: [
          {
            url: 'live-game',
            name: 'Arsenal vs Chelsea',
            genre: 'football',
            time: new Date().toISOString(),
            streams: [{ name: 'TNT Sports 1', url: 'https://embed.test/game' }]
          }
        ]
      })
    };
    provider.fetchChannels = {
      fire: async () => { throw new Error('HTTP 500 Upstream Down'); }
    };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('Arsenal vs Chelsea');
    expect(matches[0].category).toBe('football');
  });

  test('formats clean stream title on 24/7 channel cards', async () => {
    const embedUrl = 'https://ehgembxe.cfd/nhmzkzez-3028';
    const sourceId = Buffer.from(embedUrl).toString('hex');
    const src = {
      source: 'timstreams',
      id: sourceId,
      name: 'ABC',
      channelName: 'ABC',
      url: embedUrl,
      type: 'channel'
    };

    provider.extractM3u8 = jest.fn().mockResolvedValue({
      m3u8: 'https://tims-001.sytes.net/main/secure/abc.m3u8',
      referer: 'https://ehgembxe.cfd'
    });

    const streams = await provider.resolveStream(sourceId, 'networks', 'ABC', src);
    expect(streams).toHaveLength(2);
    const direct = streams[0];
    expect(direct.name).toBe('TimStreams');
    // On networks cards, title must be (ABC), not (ABC) ABC
    expect(direct.title).toBe('(ABC)');
    expect(direct.channelName).toBe('ABC');
    expect(direct._source).toBe('timstreams');

    const web = streams[1];
    expect(web.title).toBe('TimStreams (ABC) (Web)');
  });
});
