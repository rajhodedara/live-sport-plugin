'use strict';
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/TimingRuntime', () => ({ relations: { stream: jest.fn(), endWindow: jest.fn() } }));
const container = require('../src/container');
const { relations } = require('../src/services/TimingRuntime');
const { handleStream } = require('../src/streams');

test('stream window records unresolved sources at cutoff and passes its handle to cache', async () => {
  jest.useFakeTimers();
  const previous = { soft: process.env.STREAM_SOFT_DEADLINE_MS, hard: process.env.STREAM_HARD_DEADLINE_MS,
    donation: process.env.DONATION_URL };
  process.env.STREAM_SOFT_DEADLINE_MS = '100';
  process.env.STREAM_HARD_DEADLINE_MS = '200';
  process.env.DONATION_URL = 'disabled';
  const handle = {};
  relations.stream.mockReturnValue(handle);
  const cache = { getOrCreate: jest.fn(() => new Promise(() => {})) };
  const match = { id: 'fixture', title: 'A vs B', category: 'football', sources: [{ source: 'watchfooty', id: 'a' }] };
  const services = { cacheService: { findMatch: () => match }, streamResolveCache: cache,
    streamScorer: { calculateScore: () => 1 } };
  container.resolve.mockImplementation(name => services[name]);
  try {
    const pending = handleStream('tv', 'nuvio_sport_fixture');
    await jest.advanceTimersByTimeAsync(200);
    expect((await pending).streams).toEqual([]);
    expect(cache.getOrCreate).toHaveBeenCalledWith(expect.any(String), expect.any(Function), handle);
    expect(relations.endWindow).toHaveBeenCalledWith(handle, 1, 1);
  } finally {
    jest.useRealTimers();
    for (const [key, value] of [['STREAM_SOFT_DEADLINE_MS', previous.soft], ['STREAM_HARD_DEADLINE_MS', previous.hard], ['DONATION_URL', previous.donation]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
