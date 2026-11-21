'use strict';

const SportzXProvider = require('../src/providers/SportzXProvider');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const { encodeV3 } = require('../src/resolver/sportzx/SportzXCrypto');

describe('SportzXProvider - Ingestion', () => {
  let provider;

  beforeEach(() => {
    provider = new SportzXProvider();
  });

  it('instantiates correctly with name SportzX', () => {
    expect(provider.name).toBe('SportzX');
  });

  it('ingests live matches and maps to MatchEntity instances', async () => {
    const samplePayload = [
      {
        id: '50043',
        eventName: 'Charlotte Hornets vs Atlanta Hawks',
        teamA: 'Charlotte Hornets',
        teamB: 'Atlanta Hawks',
        startTime: 1732147800,
        endTime: 1732160000,
        eventType: 'basketball',
        channels: [
          {
            cat: 'NBA PASS FHD',
            formatsNew: [
              {
                title: '1080p',
                streamUrl: 'https://fernfiber.s3.ca-central-1.amazonaws.com/hornets.m3u8'
              }
            ]
          }
        ]
      }
    ];

    provider.proxyFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: encodeV3(samplePayload)
      })
    });

    const matches = await provider.getMatches();
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBe(1);
    expect(matches[0]).toBeInstanceOf(MatchEntity);
    expect(matches[0].id).toBe('sportzx_50043');
    expect(matches[0].title).toBe('Charlotte Hornets vs Atlanta Hawks');
    expect(matches[0].category).toBe('basketball');
    expect(matches[0].sources.length).toBe(1);
    expect(matches[0].sources[0].source).toBe('sportzx');
  });

  it('handles missing, 404, or malformed data gracefully without throwing', async () => {
    provider.proxyFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({})
    });

    const matches = await provider.getMatches();
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBe(0);
  });

  it('handles network error in proxyFetch gracefully', async () => {
    provider.proxyFetch = jest.fn().mockRejectedValue(new Error('Network timeout'));

    const matches = await provider.getMatches();
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBe(0);
  });
});

describe('SportzXProvider - Stream Resolution & Policy Filtering', () => {
  let provider;

  beforeEach(() => {
    provider = new SportzXProvider();
  });

  it('resolves direct HLS streams and attaches required headers', async () => {
    const src = {
      source: 'sportzx',
      channelName: 'SportzX Live',
      formats: [
        {
          title: 'Auto',
          streamUrl: 'https://chatgpt.hereisman.net/playlist/60545/load-playlist-multi?&.m3u8',
          headers: {
            'Referer': 'https://gooz.aapmains.net'
          }
        }
      ]
    };

    const streams = await provider.resolveStream('50043_live', 'basketball', 'Hornets vs Hawks', src);
    expect(streams.length).toBe(1);
    expect(streams[0]).toBeInstanceOf(StreamEntity);
    expect(streams[0].url).toContain('chatgpt.hereisman.net');
    expect(streams[0].behaviorHints.proxyHeaders.request['User-Agent']).toContain('Dalvik');
    expect(streams[0].behaviorHints.proxyHeaders.request['Referer']).toBe('https://gooz.aapmains.net');
  });

  it('drops DASH (.mpd) and ClearKey streams to protect server bandwidth (Invariant I8 / D2)', async () => {
    const src = {
      source: 'sportzx',
      channelName: 'ICC Cricket',
      formats: [
        {
          title: 'HD',
          streamUrl: 'https://live-d-01-icc-we.akamaized.net/manifest.mpd',
          drmType: 'clearkey'
        }
      ]
    };

    const streams = await provider.resolveStream('50043_cricket', 'cricket', 'India vs Australia', src);
    expect(streams.length).toBe(0);
  });

  it('resolves S3 direct HLS streams with Dalvik user agent', async () => {
    const src = {
      source: 'sportzx',
      channelName: 'NBA PASS FHD',
      formats: [
        {
          title: '1080p',
          streamUrl: 'https://fernfiber.s3.ca-central-1.amazonaws.com/hornets.m3u8'
        }
      ]
    };

    const streams = await provider.resolveStream('50043_nba', 'basketball', 'Hornets vs Hawks', src);
    expect(streams.length).toBe(1);
    expect(streams[0].url).toBe('https://fernfiber.s3.ca-central-1.amazonaws.com/hornets.m3u8');
    expect(streams[0].behaviorHints.proxyHeaders.request['User-Agent']).toContain('Dalvik/2.1.0');
    expect(streams[0].resolution).toBe('1080p');
  });
});
