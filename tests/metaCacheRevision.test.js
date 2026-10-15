const fs = require('fs');
const os = require('os');
const path = require('path');
const CacheService = require('../src/services/CacheService');

let mockCacheService;
const mockCron = { ensureFresh: jest.fn() };
const mockAggregator = { syncMatches: jest.fn(async () => []) };
jest.mock('../src/container', () => ({
  resolve: (name) => {
    if (name === 'cacheService') return mockCacheService;
    if (name === 'cronService') return mockCron;
    if (name === 'matchAggregator') return mockAggregator;
    throw new Error(`Unexpected service: ${name}`);
  }
}));
jest.mock('../src/streams', () => ({ prewarmMatch: jest.fn() }));

const replay = (id = 'revision-fixture', title = 'Arsenal vs Chelsea') => ({
  id, title, category: 'football', league: 'Premier League',
  status: 'finished', date: '2026-09-18T19:00:00Z',
  sources: [{ source: 'replayzone', name: 'Full Match', url: 'https://example.com/replay' }]
});

describe('meta cache snapshot invalidation', () => {
  let dir, handleMeta, now;
  beforeEach(() => {
    jest.resetModules();
    mockCron.ensureFresh.mockClear();
    mockAggregator.syncMatches.mockReset().mockResolvedValue([]);
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-revision-'));
    mockCacheService = new CacheService();
    mockCacheService.cacheFilePath = path.join(dir, 'matches.json');
    mockCacheService.setMatches([replay()]);
    ({ handleMeta } = require('../src/catalog'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('updates individual details immediately after setMatches', async () => {
    const id = 'nuvio_sport_revision-fixture';
    const before = await handleMeta('tv', id, {});
    mockCacheService.setMatches([replay(undefined, 'Liverpool vs Everton')]);
    const after = await handleMeta('tv', id, {});
    expect(before.meta.name).toContain('Arsenal');
    expect(after.meta.name).toContain('Liverpool');
  });

  test('does not retain the metadata of a removed match', async () => {
    const id = 'nuvio_sport_revision-fixture';
    await handleMeta('tv', id, {});
    mockCacheService.setMatches([]);
    const result = await handleMeta('tv', id, {});
    expect(result.meta.description).toContain('This event may have ended');
  });

  test.each(['nuvio_sport_replay_football', 'nuvio_sport_replay_date_2026-09-18'])(
    'refreshes the videos in %s after a snapshot update', async (id) => {
      expect((await handleMeta('series', id, {})).meta.videos).toHaveLength(1);
      mockCacheService.setMatches([replay(), replay('second-fixture', 'Liverpool vs Everton')]);
      expect((await handleMeta('series', id, {})).meta.videos).toHaveLength(2);
    }
  );

  test('checks cross-worker disk updates before returning a cached response', async () => {
    const id = 'nuvio_sport_revision-fixture';
    await handleMeta('tv', id, {});
    const oldRevision = mockCacheService.rev;
    fs.writeFileSync(mockCacheService.cacheFilePath, JSON.stringify({
      timestamp: now, matches: [replay(undefined, 'Liverpool vs Everton')]
    }));
    const newerMtime = (mockCacheService.lastDiskMtime + 5000) / 1000;
    fs.utimesSync(mockCacheService.cacheFilePath, newerMtime, newerMtime);
    now += 1001;
    const result = await handleMeta('tv', id, {});
    expect(result.meta.name).toContain('Liverpool');
    expect(mockCacheService.rev).toBeGreaterThan(oldRevision);
  });

  test('cache hits still trigger the background freshness check', async () => {
    const id = 'nuvio_sport_revision-fixture';
    const first = await handleMeta('tv', id, {});
    const second = await handleMeta('tv', id, {});
    expect(second).toBe(first);
    expect(mockCron.ensureFresh).toHaveBeenCalledTimes(2);
  });

  test('a delayed sync result is not tagged as a newer snapshot', async () => {
    mockCacheService.setMatches([]);
    mockAggregator.syncMatches.mockImplementationOnce(async () => {
      const synced = [replay()];
      // Another update is already visible when this older sync result arrives.
      mockCacheService.setMatches([replay(), replay('second-fixture')]);
      return synced;
    });
    const id = 'nuvio_sport_replay_football';
    expect((await handleMeta('series', id, {})).meta.videos).toHaveLength(1);
    expect((await handleMeta('series', id, {})).meta.videos).toHaveLength(2);
  });
});
