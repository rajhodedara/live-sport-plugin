'use strict';

// Real retry/verifier/mint/cache code; provider and transport are in-memory
// seams. No app entrypoint, native client, socket, worker or provider is run.
jest.mock('../src/container', () => ({ resolve: jest.fn(), hasRegistration: () => false }));
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn(), getImpit: () => null, isImpitAvailable: () => false }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
jest.mock('../src/catalog', () => ({ isReplayMatch: () => false }));

const container = require('../src/container');
const { safeFetch } = require('../src/services/ProviderOutbound');
const { verifyStreams, mintVerifiedSources, handleStream } = require('../src/streams');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const { isDeferredResolution, createDeferredResolution } = require('../src/services/StreamResolutionOutcome');

const PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:4,\nsegment.ts\n';
const ok = () => ({ status: 200, text: async () => PLAYLIST });
const http = status => ({ status, text: async () => 'refused' });
const live = (suffix = 'live') => ({
  name: '⚡ Direct Stream', url: `https://edge.fixture.test/${suffix}/index.m3u8`,
  behaviorHints: { proxyHeaders: { request: { Referer: 'https://wrong-family.fixture.test/' } } }
});
const source = { source: 'timstreams', id: 'feed-1' };
const match = { id: 'fixture', title: 'Home vs Away', category: 'football', sources: [source] };
let cache, provider, warn, log, random, handlerMatch, previousEnvironment;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-11-05T09:00:00Z'));
  random = jest.spyOn(Math, 'random').mockReturnValue(0);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  safeFetch.mockReset();
  previousEnvironment = Object.fromEntries(['DONATION_URL', 'STREAM_SOFT_DEADLINE_MS', 'STREAM_HARD_DEADLINE_MS']
    .map(name => [name, process.env[name]]));
  process.env.DONATION_URL = 'disabled';
  process.env.STREAM_SOFT_DEADLINE_MS = '6000';
  process.env.STREAM_HARD_DEADLINE_MS = '15000';
  cache = new StreamResolveCache();
  cache._sharedAvailable = () => false;
  provider = { resolveStream: jest.fn(async () => [live()]) };
  handlerMatch = { ...match, sources: [{ ...source }] };
  container.resolve.mockImplementation(name => {
    if (name === 'cacheService') return { findMatch: id => id === handlerMatch.id ? handlerMatch : null };
    if (name === 'streamResolveCache') return cache;
    if (name === 'streamScorer') return { calculateScore: () => 0 };
    if (name === 'm3u8Parser') return null;
    if (name === 'timStreamsProvider') return provider;
    throw new Error(`Unexpected fixture service: ${name}`);
  });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  random.mockRestore(); warn.mockRestore(); log.mockRestore();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function observe() {
  return { noteFailure: jest.fn(), noteSuccess: jest.fn() };
}

async function verify(options = {}) {
  const state = observe();
  const onInconclusive = jest.fn();
  const streams = await verifyStreams([live()], 'timstreams:fixture:feed-1', null, state, {
    skipSpeedProbe: true, onInconclusive, ...options
  });
  return { streams, state, onInconclusive };
}

test('an owned attempt timeout retries within the original remaining budget', async () => {
  safeFetch.mockImplementationOnce((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })).mockResolvedValue(ok());
  const pending = verify();
  await jest.advanceTimersByTimeAsync(5001);
  const result = await pending;
  expect(result.streams).toHaveLength(1);
  expect(result.state.noteFailure).not.toHaveBeenCalled();
  expect(result.onInconclusive).not.toHaveBeenCalled();
  expect(safeFetch).toHaveBeenCalledTimes(2);
  const first = safeFetch.mock.calls[0][1];
  const second = safeFetch.mock.calls[1][1];
  expect(first.timeoutMs).toBe(5000);
  expect(first.signal.reason).toMatchObject({ name: 'TimeoutError', code: 'ETIMEDOUT' });
  expect(second.timeoutMs).toBeGreaterThan(0);
  expect(second.timeoutMs).toBeLessThanOrEqual(4000);
  expect(second.attempts).toBe(1);
});

test('even uncooperative fetches stop at the total budget and defer without a dead verdict', async () => {
  safeFetch.mockImplementation(() => new Promise(() => {}));
  const failure = jest.spyOn(cache, 'noteFailure');
  const pending = mintVerifiedSources(source, match, null, 'timstreams:fixture:feed-1', { skipSpeedProbe: true });
  const start = Date.now();
  await jest.advanceTimersByTimeAsync(9000);
  const result = await pending;
  expect(isDeferredResolution(result)).toBe(true);
  expect(result).toMatchObject({ reason: 'timeout', retryAfterMs: 2000, streams: [] });
  expect(Date.now() - start).toBe(9000);
  expect(safeFetch).toHaveBeenCalledTimes(2);
  expect(failure).not.toHaveBeenCalled();
});

test('a stalled response body also consumes only the attempt budget', async () => {
  safeFetch.mockResolvedValueOnce({ status: 200, text: () => new Promise(() => {}) }).mockResolvedValue(ok());
  const pending = verify();
  await jest.advanceTimersByTimeAsync(5001);
  const result = await pending;
  expect(result.streams).toHaveLength(1);
  expect(safeFetch).toHaveBeenCalledTimes(2);
  expect(result.onInconclusive).not.toHaveBeenCalled();
});

test('a caller cancellation is not retried, even with a public deadline flag', async () => {
  safeFetch.mockRejectedValue(Object.assign(new Error('caller stopped'), {
    name: 'AbortError', deadlineExceeded: true, code: 'ETIMEDOUT'
  }));
  const result = await verify();
  expect(result.streams).toEqual([]);
  expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(result.onInconclusive).toHaveBeenCalledWith('cancelled');
  expect(result.state.noteFailure).not.toHaveBeenCalled();
});

test('a wrapped caller cancellation keeps its cancellation classification', async () => {
  const cause = new DOMException('caller stopped', 'AbortError');
  safeFetch.mockRejectedValue(Object.assign(new Error('wrapped fetch'), { code: 'ERR_FETCH_FAILED', cause }));
  const result = await verify();
  expect(result.streams).toEqual([]);
  expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(result.onInconclusive).toHaveBeenCalledWith('cancelled');
  expect(result.state.noteFailure).not.toHaveBeenCalled();
});

test('an active caller signal stops an attempt without retrying its custom timeout reason', async () => {
  const controller = new AbortController();
  safeFetch.mockImplementation(() => new Promise(() => {}));
  const pending = verify({ signal: controller.signal });
  await jest.advanceTimersByTimeAsync(0);
  controller.abort(Object.assign(new Error('caller deadline'), { name: 'TimeoutError' }));
  const result = await pending;
  expect(result.streams).toEqual([]);
  expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(result.onInconclusive).toHaveBeenCalledWith('cancelled');
  expect(result.state.noteFailure).not.toHaveBeenCalled();
});

test.each(['ERR_OUTBOUND_CAPACITY', 'ERR_NATIVE_POOL_BUSY', 'ERR_NATIVE_SLOT_CAPACITY'])(
  '%s is temporarily omitted without retrying local capacity', async code => {
    safeFetch.mockRejectedValue(Object.assign(new Error('native capacity reached'), { code, isFatal: true, statusCode: 503 }));
    const result = await verify();
    expect(result.streams).toEqual([]);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result.onInconclusive).toHaveBeenCalledWith('capacity');
    expect(result.state.noteFailure).not.toHaveBeenCalled();
  }
);

test('a fatal guard refusal stays non-retryable and never becomes deferred', async () => {
  safeFetch.mockRejectedValue(Object.assign(new Error('network timeout temporarily blocked'), {
    code: 'ERR_OUTBOUND_BLOCKED', isFatal: true, name: 'TimeoutError'
  }));
  const result = await verify();
  expect(result.streams).toEqual([]);
  expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(result.onInconclusive).not.toHaveBeenCalled();
  expect(result.state.noteFailure).toHaveBeenCalledTimes(1);
});

test.each([404, 403])('a real persistent upstream %i remains a hard failure', async status => {
  safeFetch.mockResolvedValue(http(status));
  const result = await verify();
  expect(result.streams).toEqual([]);
  expect(result.onInconclusive).not.toHaveBeenCalled();
  expect(result.state.noteFailure).toHaveBeenCalledTimes(1);
  expect(safeFetch.mock.calls.length).toBe(status === 403 ? 2 : 1);
});

test('a fake200 body remains a hard failure', async () => {
  safeFetch.mockResolvedValue({ status: 200, text: async () => '<html>not media</html>' });
  const result = await verify();
  expect(result.streams).toEqual([]);
  expect(result.onInconclusive).not.toHaveBeenCalled();
  expect(result.state.noteFailure).toHaveBeenCalledTimes(1);
});

test('Referer repair gets only the remaining total time and cannot create a new timeout tail', async () => {
  safeFetch
    .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(http(503)), 4800)))
    .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(http(403)), 500)))
    .mockImplementation(() => new Promise(() => {}));
  const pending = verify();
  const start = Date.now();
  await jest.advanceTimersByTimeAsync(9000);
  const result = await pending;
  expect(Date.now() - start).toBe(9000);
  expect(result.streams).toEqual([]);
  expect(safeFetch).toHaveBeenCalledTimes(3);
  expect(safeFetch.mock.calls[2][1].timeoutMs).toBeLessThanOrEqual(3700);
  expect(safeFetch.mock.calls[2][1].signal.aborted).toBe(true);
  expect(result.onInconclusive).toHaveBeenCalledWith('timeout');
  expect(result.state.noteFailure).not.toHaveBeenCalled();
});

test.each(['sync', 'async'])('a %s diagnostic callback failure cannot poison an inconclusive result', async mode => {
  safeFetch.mockRejectedValue(Object.assign(new Error('capacity'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }));
  const onInconclusive = mode === 'sync' ? () => { throw Error('diagnostic failed'); } : async () => { throw Error('diagnostic failed'); };
  const result = await verify({ onInconclusive });
  expect(result.streams).toEqual([]);
  expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(result.state.noteFailure).not.toHaveBeenCalled();
});

test('positive streams survive a mixed batch with local capacity', async () => {
  provider.resolveStream.mockResolvedValue([live('healthy'), live('busy')]);
  safeFetch.mockImplementation(async url => {
    if (url.includes('/busy/')) throw Object.assign(new Error('capacity'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true });
    return ok();
  });
  const result = await mintVerifiedSources(source, match, null, 'timstreams:fixture:feed-1', { skipSpeedProbe: true });
  expect(Array.isArray(result)).toBe(true);
  expect(result).toHaveLength(1);
  expect(result[0].url).toContain('/healthy/');
});

test('a source-resolution capacity error propagates to a short local cooldown and can recover', async () => {
  const capacity = Object.assign(new Error('pool busy'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true });
  provider.resolveStream.mockRejectedValueOnce(capacity).mockResolvedValue([live()]);
  safeFetch.mockResolvedValue(ok());
  const key = 'timstreams:fixture:feed-1';
  const mint = () => mintVerifiedSources(source, match, null, key, { skipSpeedProbe: true });
  const sourcesBefore = JSON.stringify(match.sources);
  expect(await cache.getOrCreate(key, mint)).toEqual([]);
  expect(provider.resolveStream).toHaveBeenCalledTimes(1);
  expect(safeFetch).not.toHaveBeenCalled();
  const entry = cache.entries.get(key);
  expect(entry.status).toBe('deferred');
  expect(entry.reason).toBe('capacity');
  expect(entry.expiresAt - entry.resolvedAt).toBe(2000);
  expect(cache.ttl.has('timstreams')).toBe(false);
  expect(await cache.getOrCreate(key, mint)).toEqual([]);
  expect(provider.resolveStream).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(2001);
  expect(await cache.getOrCreate(key, mint)).toHaveLength(1);
  expect(provider.resolveStream).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(match.sources)).toBe(sourcesBefore);
});

test('a real404 still creates the existing30-second failed cache entry', async () => {
  safeFetch.mockResolvedValue(http(404));
  const key = 'timstreams:fixture:feed-1';
  expect(await cache.getOrCreate(key, () => mintVerifiedSources(source, match, null, key, { skipSpeedProbe: true }))).toEqual([]);
  const entry = cache.entries.get(key);
  expect(entry.status).toBe('failed');
  expect(entry.expiresAt - entry.resolvedAt).toBe(30000);
});

test('an expired known-good signed URL is not served when refresh is inconclusive', async () => {
  const key = 'timstreams:fixture:feed-1';
  const expired = { url: 'https://edge.fixture.test/old/index.m3u8?token=expired' };
  cache._set(key, 'timstreams', match.id, [expired], 'ok', -1);
  safeFetch.mockRejectedValue(Object.assign(new Error('local deadline'), { name: 'TimeoutError', code: 'ETIMEDOUT' }));
  const pending = cache.getOrCreate(key, () => mintVerifiedSources(source, match, null, key, { skipSpeedProbe: true }));
  await jest.advanceTimersByTimeAsync(5);
  expect(await pending).toEqual([]);
  expect(cache.entries.get(key)).toMatchObject({ status: 'deferred', streams: [] });
});

describe('actual stream response cache hints', () => {
  const request = () => handleStream('tv', 'nuvio_sport_fixture');

  test('an inconclusive first mint cannot advertise a30-second empty client result', async () => {
    provider.resolveStream.mockRejectedValue(Object.assign(new Error('pool busy'), {
      code: 'ERR_OUTBOUND_CAPACITY', isFatal: true
    }));
    expect(await request()).toEqual({ streams: [], cacheMaxAge: 2, staleRevalidate: 0, staleError: 0 });
    expect(cache.entries.get('timstreams:fixture:feed-1').status).toBe('deferred');
    expect(provider.resolveStream).toHaveBeenCalledTimes(1);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('a deferred cache hit retains the short empty-response hints without reminting', async () => {
    const key = StreamResolveCache.resolveKey(source, match.id);
    await cache.getOrCreate(key, async () => createDeferredResolution('timeout'));
    expect(await request()).toEqual({ streams: [], cacheMaxAge: 2, staleRevalidate: 0, staleError: 0 });
    expect(provider.resolveStream).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('a definite upstream404 keeps the existing empty-response cache policy, including cache hits', async () => {
    safeFetch.mockResolvedValue(http(404));
    const expected = { streams: [], cacheMaxAge: 30, staleRevalidate: 30, staleError: 60 };
    expect(await request()).toEqual(expected);
    expect(await request()).toEqual(expected);
    expect(cache.entries.get('timstreams:fixture:feed-1').status).toBe('failed');
    expect(provider.resolveStream).toHaveBeenCalledTimes(1);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  test('a positive list keeps its cache policy when another source is deferred', async () => {
    handlerMatch.sources = [{ ...source, id: 'healthy' }, { ...source, id: 'busy' }];
    provider.resolveStream.mockImplementation(async id => {
      if (id === 'busy') throw Object.assign(new Error('pool busy'), {
        code: 'ERR_OUTBOUND_CAPACITY', isFatal: true, stack: 'fixture local capacity'
      });
      return [live('healthy')];
    });
    safeFetch.mockResolvedValue(ok());
    const response = await request();
    expect(response.streams).toHaveLength(1);
    expect(response.streams[0].url).toContain('/healthy/');
    expect(response).toMatchObject({ cacheMaxAge: 30, staleRevalidate: 30, staleError: 60 });
    expect(cache.entries.get('timstreams:fixture:busy').status).toBe('deferred');
  });

  test('an empty hard-cutoff response with a still-pending source uses short cache hints', async () => {
    jest.spyOn(cache, 'getOrCreate').mockImplementation(() => new Promise(() => {}));
    const pending = request();
    await jest.advanceTimersByTimeAsync(15000);
    expect(await pending).toEqual({ streams: [], cacheMaxAge: 2, staleRevalidate: 0, staleError: 0 });
    expect(provider.resolveStream).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
