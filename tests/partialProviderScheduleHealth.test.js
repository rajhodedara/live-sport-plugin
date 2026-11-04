'use strict';

jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(async () => { throw new Error('Unexpected outbound I/O in schedule health fixture'); }),
}));
jest.mock('../src/config', () => ({ BASE_URL: 'http://fixture.test' }));

const Ak47LiveProvider = require('../src/providers/Ak47LiveProvider');
const MlbLiveProvider = require('../src/providers/MlbLiveProvider');
const ProviderHealthService = require('../src/services/ProviderHealthService');

function healthFor(provider, matches) {
  const health = new ProviderHealthService();
  health.recordResult(provider, { matches });
  return health.snapshot().providers[0];
}

describe('partial provider schedules retain rows and report degradation', () => {
  let warn, log;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  function ak47Provider() {
    const provider = new Ak47LiveProvider({ cacheTtlMs: 60000 });
    provider._decryptAk47Payload = jest.fn(() => []);
    provider.proxyFetch = jest.fn(async url => {
      if (url.endsWith('/events.txt')) throw Object.assign(new Error('local capacity'), { code: 'ERR_OUTBOUND_CAPACITY' });
      return { status: 200, text: async () => '#EXTM3U\n#EXTINF:-1 group-title="Football",Home FC vs Away FC\nhttps://cdn.test/live.m3u8\n' };
    });
    return provider;
  }

  test('AK47 playlist rows do not mask an events failure, including cache reuse and recovery', async () => {
    const provider = ak47Provider();
    const partial = await provider.getMatches();

    expect(partial).toHaveLength(1);
    expect(healthFor(provider, partial)).toMatchObject({ state: 'degraded', scheduleOk: false, matchCount: 1 });
    const fetchCount = provider.proxyFetch.mock.calls.length;
    expect(await provider.getMatches()).toBe(partial);
    expect(provider.proxyFetch).toHaveBeenCalledTimes(fetchCount);
    expect(healthFor(provider, partial).state).toBe('degraded');

    provider._lastFetchTime = 0;
    provider.proxyFetch.mockImplementation(async () => ({ status: 200, text: async () => 'fixture' }));
    provider._parseM3u = jest.fn(() => [{ rawTitle: 'Home FC vs Away FC', groupTitle: 'Football', streamUrl: 'https://cdn.test/live.m3u8' }]);
    const recovered = await provider.getMatches();
    expect(healthFor(provider, recovered)).toMatchObject({ state: 'healthy', scheduleOk: true });
  });

  test.each([
    ['non-200 response', { status: 503, text: async () => 'unavailable' }, []],
    ['invalid events payload', { status: 200, text: async () => 'fixture' }, null],
  ])('AK47 marks a %s degraded while retaining playlist rows', async (_name, eventResponse, events) => {
    const provider = ak47Provider();
    const playlistFetch = provider.proxyFetch.getMockImplementation();
    provider.proxyFetch.mockImplementation(url => url.endsWith('/events.txt') ? eventResponse : playlistFetch(url));
    provider._decryptAk47Payload.mockReturnValue(events);

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);
    expect(healthFor(provider, matches)).toMatchObject({ state: 'degraded', scheduleOk: false });
  });

  test('AK47 accepts a valid empty events schedule as successful', async () => {
    const provider = new Ak47LiveProvider();
    provider.proxyFetch = jest.fn(async () => ({ status: 200, text: async () => '' }));
    provider._decryptAk47Payload = jest.fn(() => []);

    const matches = await provider.getMatches();
    expect(matches).toEqual([]);
    expect(healthFor(provider, matches)).toMatchObject({ state: 'empty', scheduleOk: true });
  });

  test.each([
    ['fallback', 0], ['fallback', 1], ['rejection', 0], ['rejection', 1],
  ])('MLB retains successful endpoint rows with a %s at endpoint %i', async (failure, failedIndex) => {
    const provider = new MlbLiveProvider();
    provider.fetchPage.fire = jest.fn();
    for (let index = 0; index < 2; index++) {
      if (index !== failedIndex) provider.fetchPage.fire.mockResolvedValueOnce('<p>Fixture page</p>');
      else if (failure === 'fallback') provider.fetchPage.fire.mockResolvedValueOnce(null);
      else provider.fetchPage.fire.mockRejectedValueOnce(new Error('fixture upstream failure'));
    }
    provider._parseMatchCards = jest.fn(() => [{ id: 'mlb_fixture', sources: [{ source: 'mlblive' }] }]);

    const partial = await provider.getMatches();
    expect(partial).toHaveLength(1);
    expect(healthFor(provider, partial)).toMatchObject({ state: 'degraded', scheduleOk: false, matchCount: 1 });

    provider.fetchPage.fire.mockResolvedValue('<p>Fixture page</p>');
    const recovered = await provider.getMatches();
    expect(healthFor(provider, recovered)).toMatchObject({ state: 'healthy', scheduleOk: true });
  });

  test('MLB accepts valid pages with no replay cards as an empty successful schedule', async () => {
    const provider = new MlbLiveProvider();
    provider.fetchPage.fire = jest.fn().mockResolvedValue('<p>No games available</p>');
    provider._parseMatchCards = jest.fn(() => []);

    const matches = await provider.getMatches();
    expect(matches).toEqual([]);
    expect(healthFor(provider, matches)).toMatchObject({ state: 'empty', scheduleOk: true });
  });
});
