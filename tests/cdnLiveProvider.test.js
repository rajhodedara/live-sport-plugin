'use strict';

process.env.NODE_ENV = 'test';

jest.mock('../src/impitClient', () => ({
  safeFetch: jest.fn(),
}));

const { safeFetch } = require('../src/impitClient');
const CdnLiveProvider = require('../src/providers/CdnLiveProvider');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');

describe('CdnLiveProvider — Resolution & Event Title Parsing', () => {
  let provider;

  beforeEach(() => {
    jest.clearAllMocks();
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

  describe('_verifyManifest', () => {
    test('returns true when manifest contains #EXT', async () => {
      safeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nsegment.ts'
      });

      const isValid = await provider._verifyManifest('https://cdnlive.tv/secure/live.m3u8');
      expect(isValid).toBe(true);
    });

    test('returns false when manifest contains provider-cap', async () => {
      safeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'provider-cap'
      });

      const isValid = await provider._verifyManifest('https://cdnlive.tv/secure/live.m3u8');
      expect(isValid).toBe(false);
    });

    test('returns false when manifest returns HTTP 503', async () => {
      safeFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable'
      });

      const isValid = await provider._verifyManifest('https://cdnlive.tv/secure/live.m3u8');
      expect(isValid).toBe(false);
    });
  });

  describe('decodePlayer health verification and anti-poison caching', () => {
    test('discards candidate manifest and does not cache if manifest verification fails', async () => {
      // Mock player page HTML with atob concatenation
      const b64 = Buffer.from('https://cdnlive.tv/secure/cap.m3u8?token=user:1794243000:cdn:hash').toString('base64');
      const html = `<script>var stream = atob("${b64}");</script>`;

      safeFetch
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => html }) // player page
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'provider-cap' }); // manifest check

      const result = await provider.decodePlayer('https://cdnlive.tv/player/cap');
      expect(result).toBe('');
      expect(provider._decoded.size).toBe(0);
    });

    test('caches and returns manifest URL if verification succeeds', async () => {
      const m3u8Url = 'https://cdnlive.tv/secure/valid.m3u8?token=user:1794243000:cdn:hash';
      const b64 = Buffer.from(m3u8Url).toString('base64');
      const html = `<script>var stream = atob("${b64}");</script>`;

      safeFetch
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => html }) // player page
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '#EXTM3U\nsegment.ts' }); // manifest check

      const result = await provider.decodePlayer('https://cdnlive.tv/player/valid');
      expect(result).toBe(m3u8Url);
      expect(provider._decoded.has('https://cdnlive.tv/player/valid')).toBe(true);
    });
  });
});
