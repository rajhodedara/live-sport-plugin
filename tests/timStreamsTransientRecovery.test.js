'use strict';

// In-memory provider and cache fixtures: no live feeds, sockets or native pool.
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('WASM must not run in this test'); }),
  destroy: jest.fn(async () => {})
}));
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
jest.mock('../src/catalog', () => ({ isReplayMatch: () => false }));

const container = require('../src/container');
const { safeFetch } = require('../src/services/ProviderOutbound');
const TimStreamsProvider = require('../src/providers/TimStreamsProvider');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const { mintVerifiedSources } = require('../src/streams');

const EMBED = 'https://embed.fixture.test/tnt';
const MEDIA = 'https://cdn.fixture.test/live.m3u8';
const source = { source: 'timstreams', id: 'tnt', name: 'TNT Sports 1', url: EMBED };
const match = { id: 'fixture', title: 'Home vs Away', category: 'football', sources: [source] };
const key = StreamResolveCache.resolveKey(source, match.id);
const breaker = { wrap: (_name, fn) => ({ fire: fn }), wrapSync: (_name, fn) => ({ fire: fn }) };

function failure(code) {
  return Object.assign(new Error(code), { code, isFatal: true });
}
function makeProvider() {
  return new TimStreamsProvider({ circuitBreaker: breaker });
}
function configureServices(provider, cache) {
  container.resolve.mockImplementation(name => ({
    timStreamsProvider: provider,
    streamResolveCache: cache,
    streamScorer: { calculateScore: () => 1 },
    m3u8Parser: null
  })[name]);
}
function liveResponse() {
  return { ok: true, status: 200, text: async () => '<html>encoded fixture</html>' };
}

describe('TimStreams: inconclusive extraction must not become a long positive web cache', () => {
  let warn, errorLog;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.clearAllMocks();
  });
  afterEach(() => {
    warn.mockRestore();
    errorLog.mockRestore();
  });

  test.each(['ERR_OUTBOUND_CAPACITY', 'ERR_NATIVE_POOL_BUSY', 'ERR_NATIVE_SLOT_CAPACITY'])(
    '%s propagates from initial embed fetch rather than producing a web-only success', async code => {
      const provider = makeProvider();
      const transient = failure(code);
      provider.proxyFetch = jest.fn().mockRejectedValue(transient);
      await expect(provider.extractM3u8(EMBED)).rejects.toBe(transient);
      await expect(provider.resolveStream(source.id, 'football', match.title, source)).rejects.toBe(transient);
    }
  );

  test('a wrapped timeout on the token hop is kept inconclusive', async () => {
    const provider = makeProvider();
    provider.decodeObfuscatedScript = jest.fn(() => 'loadStreamUrl("https://tokens.fixture.test/a", function(){})');
    const timeout = Object.assign(new Error('token fetch failed'), {
      cause: Object.assign(new Error('deadline'), { name: 'TimeoutError' })
    });
    provider.proxyFetch = jest.fn().mockResolvedValueOnce(liveResponse()).mockRejectedValueOnce(timeout);
    await expect(provider.extractM3u8(EMBED)).rejects.toBe(timeout);
    expect(provider.proxyFetch).toHaveBeenCalledTimes(2);
  });

  test('definite HTTP failure still provides the existing web fallback', async () => {
    const provider = makeProvider();
    provider.proxyFetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    const rows = await provider.resolveStream(source.id, 'football', match.title, source);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBeUndefined();
    expect(rows[0].externalUrl).toContain('/watch?url=');
  });

  test('security-blocked errors must not be reclassified as capacity or timeout', async () => {
    const provider = makeProvider();
    provider.proxyFetch = jest.fn().mockRejectedValue(Object.assign(failure('ERR_OUTBOUND_BLOCKED'), {
      name: 'TimeoutError'
    }));
    const rows = await provider.resolveStream(source.id, 'football', match.title, source);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalUrl).toContain('/watch?url=');
  });

  test('quality-probe failure does not discard an already extracted direct URL', async () => {
    const provider = makeProvider();
    provider.extractM3u8 = jest.fn().mockResolvedValue({ m3u8: MEDIA, referer: new URL(EMBED).origin });
    provider.hlsQualityProbe = { probe: jest.fn().mockRejectedValue(failure('ERR_NATIVE_POOL_BUSY')) };
    const rows = await provider.resolveStream(source.id, 'football', match.title, source);
    const direct = rows.find(row => row.url);
    expect(direct).toBeDefined();
    expect(direct.resolution).toBe('HD');
    expect(rows.some(row => row.externalUrl)).toBe(true);
  });

  test('multiple embeds keep a playable direct feed despite a concurrent capacity failure', async () => {
    const provider = makeProvider();
    provider.getMatches = jest.fn().mockResolvedValue([{
      id: 'ts_group', sources: [
        { id: 'first', url: EMBED },
        { id: 'second', url: 'https://embed.fixture.test/busy' }
      ]
    }]);
    provider.extractM3u8 = jest.fn(async url => {
      if (url.endsWith('/busy')) throw failure('ERR_NATIVE_POOL_BUSY');
      return { m3u8: MEDIA, referer: new URL(EMBED).origin };
    });
    const rows = await provider.resolveStream('group', 'football', match.title);
    expect(rows.some(row => row.url)).toBe(true);
    expect(rows.some(row => row.externalUrl)).toBe(true);
    expect(provider.extractM3u8).toHaveBeenCalledTimes(2);
  });

  test('multiple embeds with no direct feed defer when one was blocked by capacity', async () => {
    const provider = makeProvider();
    provider.getMatches = jest.fn().mockResolvedValue([{
      id: 'ts_group', sources: [
        { id: 'first', url: EMBED },
        { id: 'second', url: 'https://embed.fixture.test/busy' }
      ]
    }]);
    const transient = failure('ERR_NATIVE_POOL_BUSY');
    provider.extractM3u8 = jest.fn(async url => {
      if (url.endsWith('/busy')) throw transient;
      return null; // web-only result from the other embed
    });
    await expect(provider.resolveStream('group', 'football', match.title)).rejects.toBe(transient);
  });

  test('full mint/cache chain defers for 2 seconds after capacity, then mints a playable direct URL', async () => {
    const provider = makeProvider();
    const transient = failure('ERR_NATIVE_POOL_BUSY');
    provider.proxyFetch = jest.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce(liveResponse());
    provider.decodeObfuscatedScript = jest.fn(() => `var stream = "${MEDIA}";`);
    safeFetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:4,\nsegment.ts\n'
    });
    const cache = new StreamResolveCache();
    cache._sharedAvailable = () => false;
    configureServices(provider, cache);
    const mint = () => mintVerifiedSources(source, match, null, key, { skipSpeedProbe: true });

    expect(await cache.getOrCreate(key, mint)).toEqual([]);
    const first = cache.entries.get(key);
    expect(first).toMatchObject({ status: 'deferred', reason: 'capacity', streams: [] });
    expect(first.expiresAt - first.resolvedAt).toBe(2000);
    expect(safeFetch).not.toHaveBeenCalled();

    // Controlled expiry; no wall-clock sleep or network calls in the test.
    first.expiresAt = Date.now() - 1;
    const recovered = await cache.getOrCreate(key, mint);
    expect(recovered.some(row => row.url && row.url.includes('/api/manifest?'))).toBe(true);
    expect(cache.entries.get(key).status).toBe('ok');
    expect(provider.proxyFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
});
