'use strict';

process.env.NODE_ENV = 'test';

const SportsBiteProvider = require('../src/providers/SportsBiteProvider');
const MatchEntity = require('../src/domain/MatchEntity');

describe('SportsBiteProvider - Catalog Ingestion', () => {
  let provider;

  beforeEach(() => {
    provider = new SportsBiteProvider();
  });

  test('parses matches from ForestGump API and excludes non-selfhost steganography streams', async () => {
    const mockApiResponse = {
      days: [
        {
          date: '2026-11-21',
          events: [
            {
              id: 'ev-1',
              title: 'Athletic Club vs. Espanyol',
              sport: 'football',
              start_time: '2026-11-21T20:00:00.000Z',
              streams: [
                {
                  id: 'fg-sh-1',
                  name: 'Athletic Club vs Espanyol HD',
                  manifest_url: 'https://sportsbite.org/selfhost/embed/s-7da574195115de0a65f9',
                  source: 'selfhost',
                  status: 'online',
                  quality: 'HD',
                  language: 'English'
                },
                {
                  id: 'fg-beta247-1',
                  name: 'ESPN DEPORTES',
                  manifest_url: 'https://sportsbite.org/247-embed/embed/espndeportes?emb=101',
                  source: 'tv',
                  status: 'online'
                }
              ]
            }
          ]
        }
      ]
    };

    jest.spyOn(provider, 'proxyFetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockApiResponse
    });

    const matches = await provider.getMatches();

    expect(matches).toHaveLength(1);
    const match = matches[0];
    expect(match).toBeInstanceOf(MatchEntity);
    expect(match.id).toMatch(/^sb_/);
    expect(match.title).toBe('Athletic Club vs. Espanyol');
    expect(match.category).toBe('football');
    expect(match.team1).toEqual({ name: 'Athletic Club' });
    expect(match.team2).toEqual({ name: 'Espanyol' });

    // Only selfhost stream must be retained; 247-embed steganography dropped
    expect(match.sources).toHaveLength(1);
    expect(match.sources[0].source).toBe('sportsbite');
    expect(match.sources[0].id).toBe('s-7da574195115de0a65f9');
    expect(match.sources[0].embedUrl).toBe('https://sportsbite.org/selfhost/embed/s-7da574195115de0a65f9');
  });

  test('handles empty or error response gracefully without throwing', async () => {
    jest.spyOn(provider, 'proxyFetch').mockRejectedValueOnce(new Error('Network timeout'));
    const matches = await provider.getMatches();
    expect(matches).toEqual([]);
  });
});
