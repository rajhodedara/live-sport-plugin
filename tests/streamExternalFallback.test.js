'use strict';
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
const { verifyStreams } = require('../src/streams');
const { safeFetch } = require('../src/services/ProviderOutbound');
const run = streams => verifyStreams(streams, '', null, {}, { skipSpeedProbe: true });

test('keeps a Web Player fallback without probing it', async () => {
  const stream = { name: 'PpvSt', externalUrl: '/watch?url=fixture' };
  expect(await run([stream])).toEqual([stream]);
  expect(safeFetch).not.toHaveBeenCalled();
});

test('drops entries without a usable media or external URL', async () => {
  expect(await run([null, {}, { externalUrl: '  ' }])).toEqual([]);
});

test('a media URL still requires verification even with an external URL', async () => {
  safeFetch.mockResolvedValue({status: 403, text: async () => 'denied'});
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const stream = { url: 'https://cdn.example.test/live.m3u8', externalUrl: '/watch?url=fixture', behaviorHints: {proxyHeaders: {request: {Referer:'https://cdn.example.test/'}}} };
    expect(await run([stream])).toEqual([]);
    expect(safeFetch).toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

test.each(['javascript:alert(1)', '//evil.example/x', '/\\evil.example/x', 'https://user:pass@example.test/', 'https://x.test/a b'])('drops invalid external URL %s', async externalUrl => {
  expect(await run([{ externalUrl }])).toEqual([]);
});

test.each(['/watch?url=fixture', 'https://video.example.test/watch'])('accepts supported external URL %s', async externalUrl => {
  const stream = { externalUrl };
  expect(await run([stream])).toEqual([stream]);
});

test('a PPV fallback passes through resolution and the cache into the stream response', async () => {
  const container = require('../src/container');
  const StreamResolveCache = require('../src/services/StreamResolveCache');
  const { handleStream } = require('../src/streams');
  const match = { id: 'fixture', title: 'Fixture match', category: 'football', sources: [{ source: 'ppvst', id: 's1', embedUrl: 'https://embed.example.test/embed/s1' }] };
  const provider = { resolveStream: jest.fn(async () => [{ name: 'PpvSt', title: 'Fixture (Web Player)', externalUrl: '/watch?url=fixture' }]) };
  const cache = new StreamResolveCache();
  const services = { cacheService: { findMatch: () => match }, streamResolveCache: cache, ppvStProvider: provider, streamScorer: { calculateScore: () => 0 }, m3u8Parser: null };
  container.resolve.mockImplementation(name => services[name]);
  const previous = process.env.DONATION_URL;
  process.env.DONATION_URL = 'disabled';
  try {
    const first = await handleStream('tv', 'nuvio_sport_fixture', {});
    const second = await handleStream('tv', 'nuvio_sport_fixture', {});
    expect(first.streams.some(s => s.externalUrl === '/watch?url=fixture')).toBe(true);
    expect(second.streams.some(s => s.externalUrl === '/watch?url=fixture')).toBe(true);
    expect(provider.resolveStream).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBeGreaterThan(0);
  } finally {
    if (previous === undefined) delete process.env.DONATION_URL; else process.env.DONATION_URL = previous;
    container.resolve.mockReset();
  }
});
