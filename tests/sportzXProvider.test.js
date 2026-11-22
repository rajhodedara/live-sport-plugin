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

  it('ingests production schema with eventInfo and registers lightweight source', async () => {
    const prodPayload = [
      {
        id: 50125,
        title: 'Barcelona',
        cat: 'Football',
        eventInfo: {
          eventName: 'FC Barcelona vs Villarreal',
          teamA: 'Barcelona',
          teamB: 'Villarreal',
          teamAFlag: 'https://img.sofascore.com/team1.png',
          teamBFlag: 'https://img.sofascore.com/team2.png',
          startTime: '2026/11/22 13:00:00 +0000',
          isHot: '1'
        }
      }
    ];

    provider.proxyFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: encodeV3(prodPayload)
      })
    });

    const matches = await provider.getMatches();
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe('sportzx_50125');
    expect(matches[0].title).toBe('FC Barcelona vs Villarreal');
    expect(matches[0].category).toBe('football');
    expect(matches[0].popular).toBe('1');
    expect(matches[0].team1).toBe('Barcelona');
    expect(matches[0].team2).toBe('Villarreal');
    expect(matches[0].thumbnail_url).toBe('');
    expect(matches[0].poster).toBe('');
    expect(matches[0].sources.length).toBe(1);
    expect(matches[0].sources[0].eventId).toBe('50125');
  });

  it('handles missing, 404, or malformed data gracefully without throwing', async () => {
    provider.proxyFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({})
    });
    provider._loadFallbackEvents = jest.fn().mockReturnValue([]);

    const matches = await provider.getMatches();
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBe(0);
  });

  it('handles network error in proxyFetch gracefully', async () => {
    provider.proxyFetch = jest.fn().mockRejectedValue(new Error('Network timeout'));
    provider._loadFallbackEvents = jest.fn().mockReturnValue([]);

    const matches = await provider.getMatches();
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBe(0);
  });

  it('falls back to bundled event seed when gateways fail', async () => {
    provider.proxyFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500
    });
    provider._loadFallbackEvents = jest.fn().mockReturnValue([
      {
        id: 50004,
        title: 'UFC',
        cat: 'UFC',
        eventInfo: {
          eventName: 'UFC Fight Night: Adesanya vs Magomedov',
          teamA: 'I. Adesanya',
          teamB: 'S. Magomedov',
          startTime: '2026/12/05 16:00:00 +0000'
        }
      }
    ]);

    const matches = await provider.getMatches();
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe('sportzx_50004');
    expect(matches[0].category).toBe('mma');
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

  it('fetches and resolves on-demand channels with pipe-delimited headers and drops DASH', async () => {
    const channelData = [
      {
        title: 'TAPMAD FHD',
        link: 'https://tencent-cdn.tapmad.com/live/main.m3u8|Referer=https://tapmad.com/&User-Agent=CustomUA',
        type: '1'
      },
      {
        title: 'DASH CHANNEL',
        link: 'https://cdn.example.com/live/manifest.mpd|User-Agent=CustomUA',
        type: '1'
      }
    ];

    provider.proxyFetch = jest.fn().mockImplementation(async (url) => {
      if (url.includes('channels/50125.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: encodeV3(channelData)
          })
        };
      }
      return { ok: false, status: 404 };
    });

    const src = { source: 'sportzx', eventId: '50125' };
    const streams = await provider.resolveStream('sportzx_50125', 'football', 'Barcelona vs Villarreal', src);

    // Only the HLS stream should be returned; the DASH stream must be dropped
    expect(streams.length).toBe(1);
    expect(streams[0].title).toBe('TAPMAD FHD');
    expect(streams[0].url).toBe('https://tencent-cdn.tapmad.com/live/main.m3u8');
    expect(streams[0].resolution).toBe('1080p');
    expect(streams[0].behaviorHints.proxyHeaders.request['Referer']).toBe('https://tapmad.com/');
    expect(streams[0].behaviorHints.proxyHeaders.request['User-Agent']).toBe('CustomUA');
  });
});
