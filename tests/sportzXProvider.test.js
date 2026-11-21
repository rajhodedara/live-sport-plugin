'use strict';

const SportzXProvider = require('../src/providers/SportzXProvider');
const MatchEntity = require('../src/domain/MatchEntity');
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
