'use strict';

// Real source dispatch, verification, cache, publication and remint lookup;
// only the provider and upstream I/O are simulated. No network or player.
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
const container = require('../src/container');
const { safeFetch } = require('../src/services/ProviderOutbound');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const Parser = require('../src/services/M3U8ParserService');
const { handleStream, prewarmMatch } = require('../src/streams');
const { attemptRemint } = require('../src/remint');

const held = 'https://cdn.example.test/live/index.m3u8?token=old';
const fresh = 'https://cdn.example.test/live/index.m3u8?token=fresh';
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
let cache, match, provider, savedEnv, log;

beforeEach(() => {
  jest.useFakeTimers();
  savedEnv = { donation: process.env.DONATION_URL, shared: process.env.RESOLVE_CACHE_SHARED, skip: process.env.PREWARM_SKIP_PROVIDERS };
  process.env.DONATION_URL = 'disabled';
  process.env.RESOLVE_CACHE_SHARED = 'false';
  process.env.PREWARM_SKIP_PROVIDERS = '';
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  safeFetch.mockReset();
  safeFetch.mockResolvedValue({ status: 200, text: async () => media });
  cache = new StreamResolveCache();
  match = { id: 'canonical-match', title: 'Example vs Other', category: 'football', sources: [{ source: 'embedst', id: 'source-1' }] };
  provider = { resolveStream: jest.fn(async (_id, _category, _title, source) => [{
    name: 'Direct', url: '/api/manifest?url=' + encodeURIComponent(source.forceRefresh ? fresh : held)
  }]) };
  const services = {
    cacheService: {
      findMatch: id => ['canonical-match', 'old-slug'].includes(id) ? match : null,
      getMatchesReadOnly: () => [match]
    },
    streamScorer: { calculateScore: () => 0 },
    streamResolveCache: cache,
    m3u8Parser: new Parser(),
    embedStProvider: provider
  };
  container.resolve.mockImplementation(name => services[name]);
});

afterEach(() => {
  for (const [name, value] of Object.entries({ DONATION_URL: savedEnv.donation, RESOLVE_CACHE_SHARED: savedEnv.shared, PREWARM_SKIP_PROVIDERS: savedEnv.skip })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  jest.clearAllTimers();
  jest.useRealTimers();
  log.mockRestore();
});

const request = id => handleStream('tv', 'nuvio_sport_' + id, {});
function recoveryKey(result) {
  expect(result.streams).toHaveLength(1);
  const published = new URL(result.streams[0].url, 'https://addon.example.test');
  expect(published.pathname).toBe('/api/manifest.m3u8');
  return published.searchParams.get('rck');
}

test('alias and canonical requests publish one canonical recovery key that remint can resolve', async () => {
  const aliasKey = recoveryKey(await request('old-slug'));
  const canonicalKey = recoveryKey(await request('canonical-match'));
  expect(aliasKey).toBe('embedst:canonical-match:source-1');
  expect(canonicalKey).toBe(aliasKey);
  expect([...cache.entries.keys()]).toEqual([aliasKey]);
  expect(provider.resolveStream).toHaveBeenCalledTimes(1);

  expect(await attemptRemint(aliasKey, held)).toBe(fresh);
  expect(provider.resolveStream).toHaveBeenCalledTimes(2);
  expect(provider.resolveStream.mock.calls[1][3]).toMatchObject({ id: 'source-1', forceRefresh: true, skipCache: true });
});

test('prewarm and an interactive alias share the canonical cache entry', async () => {
  await prewarmMatch(match, {});
  expect(recoveryKey(await request('old-slug'))).toBe('embedst:canonical-match:source-1');
  expect(provider.resolveStream).toHaveBeenCalledTimes(1);
  expect(safeFetch).toHaveBeenCalledTimes(1);
});
