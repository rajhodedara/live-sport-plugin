'use strict';
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
const container = require('../src/container');
const Provider = require('../src/providers/Ak47LiveProvider');
const { safeFetch } = require('../src/services/ProviderOutbound');
const { handleStream } = require('../src/streams');
const StreamResolveCache = require('../src/services/StreamResolveCache');

beforeEach(() => {
  safeFetch.mockReset();
  safeFetch.mockResolvedValue({ status: 200, bodyTruncated: false, text: async () => '#EXTM3U\n#EXTINF:4,\nsegment.ts\n' });
});

test('AK47 custom-UA context survives verification, cache and player publication without credentials', async () => {
  const provider = new Provider();
  const upstream = 'https://cdn.example.test/live.m3u8?token=fixture';
  const source = { source: 'ak47live', id: upstream, userAgent: 'FixtureClient/1.0', referer: 'https://provider.example.test/player', origin: 'https://provider.example.test' };
  const match = { id: 'fixture', title: 'Fixture match', category: 'football', sources: [source] };
  const resolveStream = jest.fn(async (...args) => {
    const streams = await provider.resolveStream(...args);
    Object.assign(streams[0].behaviorHints.proxyHeaders.request, { Authorization: 'Bearer fixture', Cookie: 'sid=fixture', 'X-Token': 'fixture' });
    return streams;
  });
  const cache = new StreamResolveCache();
  const services = { cacheService: { findMatch: () => match }, streamResolveCache: cache, ak47LiveProvider: { resolveStream }, streamScorer: { calculateScore: () => 0 }, m3u8Parser: null };
  container.resolve.mockImplementation(name => services[name]);
  const donation = process.env.DONATION_URL;
  process.env.DONATION_URL = 'disabled';
  try {
    for (let i=0; i<2; i++) {
      const out = await handleStream('tv', 'nuvio_sport_fixture', {});
      expect(out.streams).toHaveLength(1);
      const stream = out.streams[0];
      expect(new URL(stream.url).searchParams.get('hlsua')).toBe('FixtureClient/1.0');
      expect(stream.behaviorHints.proxyHeaders.request).toEqual({
        'User-Agent': 'FixtureClient/1.0', Referer: source.referer, Origin: source.origin
      });
      expect(stream.behaviorHints.notWebReady).toBe(false);
    }
    expect(resolveStream).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][1].headers['User-Agent']).toBe('FixtureClient/1.0');
  } finally {
    if (donation === undefined) delete process.env.DONATION_URL; else process.env.DONATION_URL = donation;
    container.resolve.mockReset();
  }
});
