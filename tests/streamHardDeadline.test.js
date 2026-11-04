jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/TimingRuntime', () => ({ relations: { stream: jest.fn(() => ({})), endWindow: jest.fn() } }));
const container = require('../src/container');
const { relations } = require('../src/services/TimingRuntime');
const { handleStream } = require('../src/streams');

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const playable = url => ({ url, _source: 'watchfooty', title: 'Main feed' });

describe('handleStream hard response deadline', () => {
  const env = {
    soft: process.env.STREAM_SOFT_DEADLINE_MS,
    hard: process.env.STREAM_HARD_DEADLINE_MS,
    donation: process.env.DONATION_URL
  };
  let pending;
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.STREAM_SOFT_DEADLINE_MS = '100';
    process.env.STREAM_HARD_DEADLINE_MS = '200';
    process.env.DONATION_URL = 'disabled';
    pending = [deferred(), deferred()];
    const match = { id: 'deadline', title: 'Team A vs Team B', category: 'football',
      sources: [{ source: 'watchfooty', id: 'a' }, { source: 'timstreams', id: 'b' }] };
    const services = {
      cacheService: { findMatch: () => match },
      streamResolveCache: { getOrCreate: jest.fn(key => pending[key.endsWith(':a') ? 0 : 1].promise) },
      streamScorer: { calculateScore: () => 1 },
    };
    container.resolve.mockImplementation(name => services[name]);
  });
  afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of [
      ['STREAM_SOFT_DEADLINE_MS', env.soft],
      ['STREAM_HARD_DEADLINE_MS', env.hard],
      ['DONATION_URL', env.donation]
    ]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    jest.clearAllMocks();
  });

  test('returns at the hard deadline even if every provider stays pending', async () => {
    let response;
    handleStream('tv', 'nuvio_sport_deadline').then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(200);
    expect(response).toBeDefined();
    expect(response.streams).toEqual([]);
    expect(relations.endWindow).toHaveBeenCalledWith(expect.anything(), 2, 2, 'hard_wait_expired');
  });

  test('keeps a stream arriving between soft and hard deadlines without awaiting a stalled peer', async () => {
    let response;
    handleStream('tv', 'nuvio_sport_deadline').then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(150);
    pending[0].resolve([playable('https://cdn.example/live.mp4')]);
    await jest.advanceTimersByTimeAsync(50);
    expect(response).toBeDefined();
    expect(response.streams.map(s => s.url)).toEqual(['https://cdn.example/live.mp4']);
  });

  test('late fulfillment does not mutate an already returned response', async () => {
    let response;
    handleStream('tv', 'nuvio_sport_deadline').then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(200);
    expect(response).toBeDefined();
    pending[0].resolve([playable('https://cdn.example/late.mp4')]);
    pending[1].reject(new Error('late failure'));
    await jest.advanceTimersByTimeAsync(0);
    expect(response.streams).toEqual([]);
  });

  test('clears response-wait timers when all providers resolve immediately', async () => {
    pending[0].resolve([playable('https://cdn.example/fast.mp4')]);
    pending[1].resolve([]);
    const response = await handleStream('tv', 'nuvio_sport_deadline');
    expect(response.streams).toHaveLength(1);
    expect(relations.endWindow).toHaveBeenCalledWith(expect.anything(), 2, 0, 'all_settled');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a soft deadline larger than the hard deadline cannot extend the response wait', async () => {
    process.env.STREAM_SOFT_DEADLINE_MS = '500';
    let response;
    handleStream('tv', 'nuvio_sport_deadline').then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(200);
    expect(response).toBeDefined();
    expect(relations.endWindow).toHaveBeenCalledWith(expect.anything(), 2, 2, 'budget_exhausted');
  });

  test('labels an early return while another source continues in the background', async () => {
    let response;
    handleStream('tv', 'nuvio_sport_deadline').then(value => { response = value; });
    pending[0].resolve([playable('https://cdn.example/fast.mp4')]);
    await jest.advanceTimersByTimeAsync(100);
    expect(response.streams).toHaveLength(1);
    expect(relations.endWindow).toHaveBeenCalledWith(expect.anything(), 2, 1, 'early_return');
  });

  test('late provider completion still warms the real cache for the next request', async () => {
    const shared = process.env.RESOLVE_CACHE_SHARED;
    process.env.RESOLVE_CACHE_SHARED = 'false';
    try {
      const Cache = require('../src/services/StreamResolveCache');
      const cache = new Cache();
      const findMatch = () => ({ id: 'deadline', title: 'Team A vs Team B', category: 'football',
        sources: [{ source: 'timstreams', id: 'a' }] });
      const provider = { resolveStream: jest.fn(() => pending[0].promise) };
      const services = {
        cacheService: { findMatch }, streamResolveCache: cache,
        streamScorer: { calculateScore: () => 1 }, m3u8Parser: {}, timStreamsProvider: provider,
      };
      container.resolve.mockImplementation(name => services[name]);
      let first;
      handleStream('tv', 'nuvio_sport_deadline').then(value => { first = value; });
      await jest.advanceTimersByTimeAsync(200);
      expect(first.streams).toEqual([]);
      pending[0].resolve([{ url: 'https://cdn.example/late.mp4', title: 'Main feed' }]);
      await jest.advanceTimersByTimeAsync(0);
      expect(cache.get('timstreams:deadline:a')).toHaveLength(1);
      const second = await handleStream('tv', 'nuvio_sport_deadline');
      expect(second.streams.map(s => s.url)).toEqual(['https://cdn.example/late.mp4']);
      expect(first.streams).toEqual([]);
      expect(provider.resolveStream).toHaveBeenCalledTimes(1);
    } finally {
      if (shared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
      else process.env.RESOLVE_CACHE_SHARED = shared;
    }
  });
});
