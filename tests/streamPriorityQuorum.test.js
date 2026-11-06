'use strict';

// No outbound requests: verifies the real handleStream response-window logic.
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/TimingRuntime', () => ({
  relations: { stream: jest.fn(() => null), endWindow: jest.fn() }
}));
const container = require('../src/container');
const { handleStream } = require('../src/streams');

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
});
