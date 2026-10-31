'use strict';
// Actual aggregation -> disk-backed catalog cache -> stream publication. All
// provider catalogs/media responses below are synthetic; no player or network.
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const container = require('../src/container');
const { safeFetch } = require('../src/services/ProviderOutbound');
const CacheService = require('../src/services/CacheService');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const MatchAggregator = require('../src/services/MatchAggregator');
const BroadcasterMatchService = require('../src/services/BroadcasterMatchService');
const Parser = require('../src/services/M3U8ParserService');
const { handleStream } = require('../src/streams');

let dir, cache, services, oldEnv, log, warn;
const row = (id, title, sourceId, extra = {}) => ({
  id, title, category: 'football', date: String(Date.now()),
  sources: [{ source: 'daddylive', id: sourceId }], ...extra
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-pipeline-'));
  oldEnv = { DONATION_URL: process.env.DONATION_URL, RESOLVE_CACHE_SHARED: process.env.RESOLVE_CACHE_SHARED };
  process.env.DONATION_URL = 'disabled'; process.env.RESOLVE_CACHE_SHARED = 'false';
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  cache = new CacheService(path.join(dir, 'matches.json'));
  const streamFor = async id => [{
    name: '⚡ Direct Stream', url: `https://media.example.test/${encodeURIComponent(id)}.m3u8`
  }];
  services = {
    cacheService: cache, streamResolveCache: new StreamResolveCache(),
    streamScorer: { calculateScore: () => 0 }, m3u8Parser: new Parser(),
    daddyLiveProvider: { resolveStream: jest.fn(streamFor) },
    vavooProvider: { isEnabled: () => true, resolveStream: jest.fn(streamFor) }
  };
  container.resolve.mockImplementation(name => services[name]);
  safeFetch.mockReset();
  safeFetch.mockResolvedValue({ status: 200, text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n' });
});
afterEach(() => {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  log.mockRestore(); warn.mockRestore(); fs.rmSync(dir, { recursive: true, force: true });
});
async function sync(rows, broadcasterMatchService) {
  const aggregator = new MatchAggregator({
    cacheService: cache, broadcasterMatchService, vavooProvider: services.vavooProvider,
    yamlProviders: rows.map((entry, i) => ({ sourceName: `synthetic-${i}`, getMatches: async () => [entry] }))
  });
  await aggregator.syncMatches();
}
const request = (id, config = {}) => handleStream('tv', `nuvio_sport_${id}`, config);

test('clicking each separated squad dispatches only its own source', async () => {
  await sync([row('open-event', 'Arsenal vs Chelsea', 'open-feed'), row('youth-event', 'Arsenal U21 vs Chelsea U21', 'youth-feed')]);
  expect(cache.getMatches()).toHaveLength(2);
  expect((await request('open-event')).streams).toHaveLength(1);
  expect(services.daddyLiveProvider.resolveStream.mock.calls.map(args => args[0])).toEqual(['open-feed']);
  services.daddyLiveProvider.resolveStream.mockClear();
  expect((await request('youth-event')).streams).toHaveLength(1);
  expect(services.daddyLiveProvider.resolveStream.mock.calls.map(args => args[0])).toEqual(['youth-feed']);
});

test('compatible fixture aliases publish both sources after canonical or alias lookup', async () => {
  await sync([row('women-a', 'Arsenal Women vs Chelsea Women', 'feed-a'), row('women-b', "Arsenal Women's vs Chelsea Women's", 'feed-b')]);
  expect(cache.getMatches()).toHaveLength(1);
  expect((await request('women-b')).streams).toHaveLength(2);
  expect(services.daddyLiveProvider.resolveStream.mock.calls.map(args => args[0]).sort()).toEqual(['feed-a', 'feed-b']);
});

test('ambiguous legacy source and slug requests never dispatch a guessed event', async () => {
  await sync([row('event-a', 'Arsenal vs Chelsea', 'shared-feed'), row('event-b', 'Liverpool vs Everton', 'shared-feed')]);
  expect((await request('shared-feed')).streams).toEqual([]);
  expect(services.daddyLiveProvider.resolveStream).not.toHaveBeenCalled();
  expect((await request('event-a')).streams).toHaveLength(1);
});

function regionalCatalog() {
  const catalogPath = path.join(dir, 'channels.json');
  fs.writeFileSync(catalogPath, JSON.stringify([
    { name: 'SKY SPORTS F1', group: 'United Kingdom', vavooUrl: 'https://channel.example.test/uk' },
    { name: 'SKY SPORT F1', group: 'Italy', vavooUrl: 'https://channel.example.test/it' }
  ]));
  return new BroadcasterMatchService({ catalogPath });
}

test('source country survives enrichment, cache cloning and final provider dispatch', async () => {
  const event = row('regional', 'Example vs Other', 'schedule');
  event.sources[0].channelName = 'Sky Sport F1'; event.sources[0].group = 'Italy';
  await sync([event], regionalCatalog());
  const published = await request('regional', { sources: 'vavoo' });
  expect(published.streams).toHaveLength(1);
  expect(services.vavooProvider.resolveStream).toHaveBeenCalledWith('https://channel.example.test/it', expect.anything(), expect.anything(), expect.objectContaining({ group: 'Italy' }));
  expect(services.daddyLiveProvider.resolveStream).not.toHaveBeenCalled();
  expect(services.vavooProvider.resolveStream.mock.calls[0][0]).not.toContain('/uk');
});

test('a missing requested region does not add a source from another country', async () => {
  const event = row('missing-region', 'Example vs Other', 'schedule');
  event.sources[0].channelName = 'Sky Sport F1'; event.sources[0].countryCode = 'DE';
  await sync([event], regionalCatalog());
  expect((await request('missing-region', { sources: 'vavoo' })).streams).toEqual([]);
  expect(services.vavooProvider.resolveStream).not.toHaveBeenCalled();
});
