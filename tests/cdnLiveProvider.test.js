'use strict';

process.env.NODE_ENV = 'test';

const CdnLiveProvider = require('../src/providers/CdnLiveProvider');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');

describe('CdnLiveProvider — Resolution & Event Title Parsing', () => {
  let provider;

  beforeEach(() => {
    provider = new CdnLiveProvider({ circuitBreaker: new CircuitBreakerService() });
  });

  describe('_detectResolution', () => {
    test('detects FHD resolutions', () => {
      expect(provider._detectResolution('Sky Sports Premier League FHD UK')).toBe('FHD');
      expect(provider._detectResolution('TNT Sports 1 1080p')).toBe('FHD');
    });

    test('detects 4K UHD resolutions', () => {
      expect(provider._detectResolution('Sky Sports Main Event 4K UHD UK')).toBe('4K');
      expect(provider._detectResolution('Main Event 4K')).toBe('4K');
      expect(provider._detectResolution('Event UHD')).toBe('4K');
    });

    test('detects HD resolutions', () => {
      expect(provider._detectResolution('Canal 9 HD DK')).toBe('HD');
      expect(provider._detectResolution('Sports 720p')).toBe('HD');
    });

    test('defaults to HD for unstated resolution', () => {
      expect(provider._detectResolution('ESPN US')).toBe('HD');
      expect(provider._detectResolution('')).toBe('HD');
      expect(provider._detectResolution(null)).toBe('HD');
    });
  });

  describe('_parseEventTitle', () => {
    test('extracts title when item.name is present', () => {
      const item = { name: 'Super Bowl LX', homeTeam: 'Patriots', awayTeam: 'Eagles' };
      expect(provider._parseEventTitle(item)).toBe('Super Bowl LX');
    });

    test('extracts title from item.event when homeTeam is blank (combat/motorsport)', () => {
      const item = {
        event: 'UFC 334 Gane vs Hokit',
        homeTeam: '',
        awayTeam: '',
        gameID: '2601528'
      };
      expect(provider._parseEventTitle(item)).toBe('UFC 334 Gane vs Hokit');
    });

    test('formats homeTeam vs awayTeam when name and event are missing', () => {
      const item = {
        homeTeam: 'Arsenal',
        awayTeam: 'Chelsea'
      };
      expect(provider._parseEventTitle(item)).toBe('Arsenal vs Chelsea');
    });

    test('returns empty string when title evaluates to vs or empty', () => {
      expect(provider._parseEventTitle({ homeTeam: '', awayTeam: '' })).toBe('');
      expect(provider._parseEventTitle(null)).toBe('');
    });
  });

  describe('resolvePlayer resolution propagation', () => {
    test('sets resolution to FHD when channel name indicates FHD', async () => {
      jest.spyOn(provider, 'decodePlayer').mockResolvedValue('https://cdnlive.tv/secure/test.m3u8?token=123');

      const streams = await provider.resolvePlayer('https://cdnlive.tv/player', 'Sky Sports Premier League FHD UK');
      const directStream = streams.find(s => !s._cdnWeb);
      expect(directStream).toBeDefined();
      expect(directStream.resolution).toBe('FHD');
    });
  });
});
