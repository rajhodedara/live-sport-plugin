'use strict';

// All tests use a mocked child_process; no WASM, provider I/O or subprocess runs.
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn()
}));
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(), streamingFetch: jest.fn()
}));
jest.mock('../src/catalog', () => ({ isReplayMatch: () => false }));

const { execFile } = require('child_process');
const container = require('../src/container');
const { safeFetch } = require('../src/services/ProviderOutbound');
const { LOCAL_CAPACITY_EXIT_CODE, isLocalCapacityFailure } = require('../src/providers/PpvStWasmExit');
const { isInconclusiveResolutionError } = require('../src/services/StreamResolutionOutcome');
const PpvStProvider = require('../src/providers/PpvStProvider');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const { mintVerifiedSources } = require('../src/streams');

const MEDIA = 'https://cdn.fixture.test/ppv/live.m3u8';
const src = { source: 'ppvst', id: 'channel', embedUrl: 'https://taifood-blog.asia/embed/channel' };
const match = { id: 'fixture', title: 'Demo event', category: 'football', sources: [src] };
const key = StreamResolveCache.resolveKey(src, match.id);
const childError = (code, extras = {}) => Object.assign(new Error('child failed'), { code, ...extras });
const callback = (err, stdout = '', stderr = '') => execFile.mockImplementation((_bin, _args, _opts, done) => done(err, stdout, stderr));
const goodStdout = JSON.stringify({ file: MEDIA });

describe('PPV.st WASM private exit protocol', () => {
  test('uses a dedicated capacity status distinct from generic exit 1', () => {
    expect(LOCAL_CAPACITY_EXIT_CODE).toBe(75);
    expect(isLocalCapacityFailure({ code: 'ERR_OUTBOUND_CAPACITY', isFatal: true })).toBe(true);
    expect(isLocalCapacityFailure({ code: 'ERR_NATIVE_POOL_BUSY' })).toBe(true);
    expect(isLocalCapacityFailure({ cause: { code: 'ERR_NATIVE_SLOT_CAPACITY' } })).toBe(true);
  });

  test('never classifies guard refusals or unrelated failures as capacity', () => {
    expect(isLocalCapacityFailure({ code: 'ERR_OUTBOUND_BLOCKED', isFatal: true })).toBe(false);
    expect(isLocalCapacityFailure({ code: 'ERR_NATIVE_POOL_BUSY', cause: { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true } })).toBe(false);
    expect(isLocalCapacityFailure({ code: 'ERR_NATIVE_POOL_CLOSED', isFatal: true })).toBe(false);
    expect(isLocalCapacityFailure({ code: 'ETIMEDOUT' })).toBe(false);
    expect(isLocalCapacityFailure({ message: 'native pool capacity', code: 'UNKNOWN' })).toBe(false);
  });
});

describe('PPV.st extractor preserves local transient failures', () => {
  let provider, warn;
  beforeEach(() => {
    provider = new PpvStProvider();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.clearAllMocks();
  });
  afterEach(() => { warn.mockRestore(); });

  test('exit 75 becomes a typed inconclusive capacity error', async () => {
    callback(childError(LOCAL_CAPACITY_EXIT_CODE));
    await expect(provider.resolveStream(src.id, 'football', match.title, src)).rejects.toMatchObject({
      code: 'ERR_OUTBOUND_CAPACITY', isFatal: true
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    const args = execFile.mock.calls[0];
    expect(args[0]).toBe('node');
    expect(args[2]).toEqual({ timeout: 15000 });
  });

  test('timeout-killed child becomes a typed inconclusive timeout', async () => {
    callback(childError(null, { killed: true, signal: 'SIGTERM' }));
    await expect(provider.resolveStream(src.id, 'football', match.title, src)).rejects.toMatchObject({
      name: 'TimeoutError', code: 'ETIMEDOUT'
    });
  });

  test('ordinary WASM failure retains the web fallback, not a capacity deferral', async () => {
    callback(childError(1), '', 'WASM failed');
    const rows = await provider.resolveStream(src.id, 'football', match.title, src);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBeUndefined();
    expect(rows[0].externalUrl).toContain('/watch?url=');
  });

  test('a genuine extracted M3U8 keeps its direct feed and web fallback', async () => {
    callback(null, goodStdout);
    const rows = await provider.resolveStream(src.id, 'football', match.title, src);
    expect(rows).toHaveLength(2);
    expect(rows.some(row => row.url && row.url.includes('/api/manifest?'))).toBe(true);
    expect(rows.some(row => row.externalUrl)).toBe(true);
  });

  test('invalid embed credentials are rejected before launching the WASM child', async () => {
    const rows = await provider.resolveStream(src.id, 'football', match.title, {
      ...src, embedUrl: 'https://username:password@taifood-blog.asia/embed/channel'
    });
    expect(rows).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('cache defers local capacity for 2s then publishes the recovered direct stream', async () => {
    const busy = childError(LOCAL_CAPACITY_EXIT_CODE);
    execFile.mockImplementationOnce((_cmd, _args, _opts, done) => done(busy, '', ''))
      .mockImplementationOnce((_cmd, _args, _opts, done) => done(null, goodStdout, ''));
    safeFetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:4,\nsegment.ts\n'
    });
    const cache = new StreamResolveCache();
    cache._sharedAvailable = () => false;
    container.resolve.mockImplementation(name => ({
      ppvStProvider: provider, streamResolveCache: cache,
      streamScorer: { calculateScore: () => 1 }, m3u8Parser: null
    })[name]);
    const mint = () => mintVerifiedSources(src, match, null, key, { skipSpeedProbe: true });

    expect(await cache.getOrCreate(key, mint)).toEqual([]);
    const entry = cache.entries.get(key);
    expect(entry).toMatchObject({ status: 'deferred', reason: 'capacity', streams: [] });
    expect(entry.expiresAt - entry.resolvedAt).toBe(2000);
    expect(await cache.getOrCreate(key, mint)).toEqual([]);
    expect(execFile).toHaveBeenCalledTimes(1);

    entry.expiresAt = Date.now() - 1;
    const results = await cache.getOrCreate(key, mint);
    expect(results.some(item => item.url && item.url.includes('/api/manifest?'))).toBe(true);
    expect(cache.entries.get(key).status).toBe('ok');
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
});
