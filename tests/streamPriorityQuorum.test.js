'use strict';

// No outbound requests: verifies the real handleStream response-window logic.
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/TimingRuntime', () => ({
  relations: { stream: jest.fn(() => null), endWindow: jest.fn() }
}));
const container = require('../src/container');
const { handleStream } = require('../src/streams');
const StreamResolveCache = require('../src/services/StreamResolveCache');

const feed = id => ({ url: `https://cdn.fixture.test/${id}.mp4`, title: `Feed ${id}`, _source: 'daddylive' });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('verified Priority-1 quorum response window', () => {
  const previous = Object.fromEntries(
    ['STREAM_SOFT_DEADLINE_MS', 'STREAM_HARD_DEADLINE_MS', 'DONATION_URL'].map(key => [key, process.env[key]])
  );
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.STREAM_SOFT_DEADLINE_MS = '100';
    process.env.STREAM_HARD_DEADLINE_MS = '200';
    process.env.DONATION_URL = 'disabled';
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    jest.clearAllMocks();
  });

  function fixture({ warm = [], ready = [], channel = false } = {}) {
    const match = {
      id: channel ? 'dlv_ch_339_demo' : 'priority_quorum',
      title: 'Fixture A vs Fixture B',
      category: channel ? 'networks' : 'football',
      sources: ['a', 'b', 'c', 'd'].map(id => ({
        source: channel && id === 'd' ? 'vavoo' : 'daddylive', id
      }))
    };
    const controls = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, deferred()]));
    const cache = {
      has: jest.fn(key => warm.includes(key.split(':').at(-1))),
      getOrCreate: jest.fn(key => {
        const id = key.split(':').at(-1);
        return ready.includes(id) ? Promise.resolve([feed(id)]) : controls[id].promise;
      })
    };
    container.resolve.mockImplementation(name => ({
      cacheService: { findMatch: () => match },
      streamResolveCache: cache,
      streamScorer: { calculateScore: () => 1 }
    })[name]);
    return { id: `nuvio_sport_${match.id}`, controls, cache, match };
  }

  function cachedFixture(rows, { ttl = {}, sources, match: extra = {} } = {}) {
    const list = sources || ['a', 'b', 'c', 'd'].map(id => ({ source: 'daddylive', id }));
    const match = { id: 'cached_quorum', title: 'Fixture A vs Fixture B', category: 'football', sources: list, ...extra };
    const controls = Object.fromEntries(list.map(src => [src.id, deferred()]));
    const cache = new StreamResolveCache({ sharedResolver: {
      available: () => false, request: () => { throw Error('Unexpected resolver request'); }
    } });
    for (const [id, row] of Object.entries(rows)) {
      const src = list.find(candidate => candidate.id === id);
      cache._set(StreamResolveCache.resolveKey(src, match.id), src.source, match.id, [row], 'ok', ttl[id] || 60000);
    }
    const provider = { resolveStream: jest.fn(id => controls[id].promise) };
    container.resolve.mockImplementation(name => ({
      cacheService: { findMatch: () => match }, streamResolveCache: cache,
      streamScorer: { calculateScore: () => 1 }, m3u8Parser: null,
      daddyLiveProvider: provider, timStreamsProvider: provider
    })[name]);
    return { id: `nuvio_sport_${match.id}`, match, controls, cache, provider };
  }

  test('warm re-click returns three cached feeds without waiting for a stalled mirror or soft timer', async () => {
    const { id, controls } = fixture({ warm: ['a', 'b', 'c'], ready: ['a', 'b', 'c'] });
    let response;
    handleStream('tv', id).then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(0);
    expect(response.streams.map(stream => stream.url)).toEqual(
      expect.arrayContaining(['https://cdn.fixture.test/a.mp4', 'https://cdn.fixture.test/b.mp4', 'https://cdn.fixture.test/c.mp4'])
    );
    expect(response.streams).toHaveLength(3);
    expect(jest.getTimerCount()).toBe(0);
    controls.d.resolve([feed('d')]);
    await jest.advanceTimersByTimeAsync(0);
    expect(response.streams).toHaveLength(3); // late results never mutate the response
  });

  test('cold first click waits the soft window but not the hard deadline once three sources work', async () => {
    const { id } = fixture({ ready: ['a', 'b', 'c'] });
    let response;
    handleStream('tv', id).then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(99);
    expect(response).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(response.streams).toHaveLength(3);
  });

  test('after soft deadline returns as soon as the third distinct source resolves', async () => {
    const { id, controls } = fixture({ ready: ['a', 'b'] });
    let response;
    handleStream('tv', id).then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(110);
    expect(response).toBeUndefined();
    controls.c.resolve([feed('c')]);
    await jest.advanceTimersByTimeAsync(0);
    expect(response.streams).toHaveLength(3);
  });

  test('multiple quality variants from one source do not satisfy quorum', async () => {
    const { id, controls } = fixture();
    controls.a.resolve([feed('a1'), feed('a2'), feed('a3')]);
    let response;
    handleStream('tv', id).then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(110);
    expect(response).toBeUndefined();
    await jest.advanceTimersByTimeAsync(90);
    expect(response.streams).toHaveLength(3);
  });

  test('duplicate rows with the same cache key never count as three working sources', async () => {
    const { id, match } = fixture({ warm: ['a'], ready: ['a'] });
    match.sources = [
      { source: 'daddylive', id: 'a' },
      { source: 'daddylive', id: 'a' },
      { source: 'daddylive', id: 'a' },
      { source: 'daddylive', id: 'd' }
    ];
    let response;
    handleStream('tv', id).then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(110);
    expect(response).toBeUndefined();
    await jest.advanceTimersByTimeAsync(90);
    expect(response).toBeDefined();
  });

  test('TV channel still waits for the existing five-stream channel quorum', async () => {
    const { id, controls } = fixture({ warm: ['a', 'b', 'c'], ready: ['a', 'b', 'c'], channel: true });
    let response;
    handleStream('tv', id).then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(110);
    expect(response).toBeUndefined();
    controls.d.resolve([feed('d1'), feed('d2')]);
    await jest.advanceTimersByTimeAsync(0);
    expect(response.streams).toHaveLength(5);
  });

  test('three cached web fallbacks cannot cut off a pending direct when web streams are disabled', async () => {
    const web = id => ({ title: id, externalUrl: `/watch?url=https%3A%2F%2Fplayer.fixture.test%2F${id}` });
    const { id, controls, cache } = cachedFixture({ a: web('a'), b: web('b'), c: web('c') });
    let response;
    const pending = handleStream('tv', id, { webStreams: 'disabled' }).then(value => { response = value; return value; });
    await jest.advanceTimersByTimeAsync(110);
    expect(response).toBeUndefined();
    controls.d.resolve([feed('d')]);
    await jest.advanceTimersByTimeAsync(0);
    expect((await pending).streams.map(row => row.url)).toEqual(['https://cdn.fixture.test/d.mp4']);
    expect(cache.get('daddylive:cached_quorum:a')[0].externalUrl).toContain('/watch?');
  });

  test('a cache entry expiring between has and getOrCreate cannot bypass the hard deadline', async () => {
    const { id, controls, cache } = cachedFixture({ a: feed('a'), b: feed('b'), c: feed('c'), d: feed('old-d') }, { ttl: { d: 1 } });
    const getOrCreate = cache.getOrCreate.bind(cache);
    const get = jest.spyOn(cache, 'getOrCreate').mockImplementation((key, ...args) => {
      if (key.endsWith(':d')) jest.setSystemTime(Date.now() + 2);
      return getOrCreate(key, ...args);
    });
    let response;
    const pending = handleStream('tv', id).then(value => { response = value; return value; });
    await jest.advanceTimersByTimeAsync(200);
    expect(response).toBeDefined();
    expect(response.streams).toHaveLength(3);
    expect(cache.inFlight.has('daddylive:cached_quorum:d')).toBe(true);
    controls.d.resolve([feed('new-d')]);
    await jest.advanceTimersByTimeAsync(0);
    expect((await pending).streams).toHaveLength(3);
    expect(cache.get('daddylive:cached_quorum:d')[0].url).toBe('https://cdn.fixture.test/new-d.mp4');
    get.mockRestore();
  });

  test('DASH and PNG/cloaked cached rows do not satisfy a direct quorum', async () => {
    const { id, controls } = cachedFixture({
      a: { title: 'DASH', url: 'https://cdn.fixture.test/live.mpd' },
      b: { title: 'PNG', url: '/api/manifest?url=https%3A%2F%2Fcdn.fixture.test%2Fchunk.png' },
      c: { title: 'Cloaked', url: 'https://edge.wedd48c.top/live.m3u8' }
    });
    let response;
    const pending = handleStream('tv', id).then(value => { response = value; return value; });
    await jest.advanceTimersByTimeAsync(110);
    expect(response).toBeUndefined();
    controls.d.resolve([feed('plain-ts')]);
    await jest.advanceTimersByTimeAsync(0);
    expect((await pending).streams.map(row => row.url)).toEqual(['https://cdn.fixture.test/plain-ts.mp4']);
  });

  test('identical playback URLs from distinct source keys count only once', async () => {
    const same = feed('same');
    const { id, controls } = cachedFixture({ a: same, b: same, c: same });
    let response;
    const pending = handleStream('tv', id).then(value => { response = value; return value; });
    await jest.advanceTimersByTimeAsync(110);
    expect(response).toBeUndefined();
    await jest.advanceTimersByTimeAsync(90);
    expect(response.streams.map(row => row.url)).toEqual(['https://cdn.fixture.test/same.mp4']);
    controls.d.resolve([feed('late')]);
    await jest.advanceTimersByTimeAsync(0);
    expect((await pending).streams).toHaveLength(1);
  });

  test('cached YouTube feeds remain eligible even when web streams are disabled', async () => {
    const youtube = id => ({ title: id, ytId: id.repeat(11), _source: 'daddylive' });
    const { id, controls } = cachedFixture({ a: youtube('a'), b: youtube('b'), c: youtube('c') });
    let response;
    const pending = handleStream('tv', id, { webStreams: 'disabled' }).then(value => { response = value; return value; });
    await jest.advanceTimersByTimeAsync(0);
    expect(response.streams).toHaveLength(3);
    expect(response.streams.every(row => row.name === '▶️ YouTube')).toBe(true);
    controls.d.resolve([]);
    await jest.advanceTimersByTimeAsync(0);
    await pending;
  });

  test('team-channel rows withheld before kickoff do not certify a direct quorum', async () => {
    const web = { title: 'Fixture player', externalUrl: '/watch?url=https%3A%2F%2Fplayer.fixture.test%2Flive' };
    const sources = ['a', 'b', 'c', 'd', 'e'].map(id => ({ source: 'daddylive', id }));
    const { id, controls } = cachedFixture({
      a: { ...feed('team-a'), title: 'MLB | Team A' },
      b: { ...feed('team-b'), title: 'MLB | Team B' },
      c: { ...feed('team-c'), title: 'MLB | Team C' }, d: web
    }, { sources, match: { category: 'baseball', date: Date.now() + 30 * 60 * 1000 } });
    let response;
    const pending = handleStream('tv', id).then(value => { response = value; return value; });
    await jest.advanceTimersByTimeAsync(110);
    expect(response).toBeUndefined();
    controls.e.resolve([feed('fixture')]);
    await jest.advanceTimersByTimeAsync(0);
    expect((await pending).streams.map(row => row.url)).toEqual(['https://cdn.fixture.test/fixture.mp4']);
  });

  test('hidden settled priority web options do not cut off a pending secondary direct', async () => {
    const web = id => ({ title: id, externalUrl: `/watch?url=https%3A%2F%2Fplayer.fixture.test%2F${id}` });
    const sources = ['a', 'b', 'c'].map(id => ({ source: 'daddylive', id })).concat({ source: 'timstreams', id: 'd' });
    const { id, controls } = cachedFixture({ a: web('a'), b: web('b'), c: web('c') }, { sources });
    let response;
    const pending = handleStream('tv', id, { webStreams: 'disabled' }).then(value => { response = value; return value; });
    await jest.advanceTimersByTimeAsync(110);
    expect(response).toBeUndefined();
    controls.d.resolve([feed('secondary')]);
    await jest.advanceTimersByTimeAsync(0);
    expect((await pending).streams.map(row => row.url)).toEqual(['https://cdn.fixture.test/secondary.mp4']);
  });

  test('cached web-only priority sources retain the soft window for an arriving secondary direct', async () => {
    const web = id => ({ title: id, externalUrl: `/watch?url=https%3A%2F%2Fplayer.fixture.test%2F${id}` });
    const sources = ['a', 'b', 'c'].map(id => ({ source: 'daddylive', id })).concat({ source: 'timstreams', id: 'd' });
    const { id, controls } = cachedFixture({ a: web('a'), b: web('b'), c: web('c') }, { sources });
    let response;
    const pending = handleStream('tv', id).then(value => { response = value; return value; });
    await jest.advanceTimersByTimeAsync(0);
    expect(response).toBeUndefined();
    await jest.advanceTimersByTimeAsync(50);
    controls.d.resolve([feed('secondary')]);
    await jest.advanceTimersByTimeAsync(0);
    expect((await pending).streams.map(row => row.url)).toEqual(['https://cdn.fixture.test/secondary.mp4']);
  });
});
