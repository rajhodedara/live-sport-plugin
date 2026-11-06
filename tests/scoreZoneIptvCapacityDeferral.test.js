'use strict';

// Offline regressions: ScoreZone transport, resolver and cache are in-memory.
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
const container = require('../src/container');
const ScoreZoneProvider = require('../src/providers/ScoreZoneProvider');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const { mintVerifiedSources } = require('../src/streams');

const channel = { id: 'demo', name: 'Demo Channel', country: 'US', url: 'https://cdn.fixture.test/demo.m3u8' };
const key = 'scorezone:fixture:sz_iptv_demo';
const match = { id: 'fixture', title: 'Demo Channel', category: 'networks', sources: [{ source: 'scorezone', id: 'sz_iptv_demo' }] };
const capacity = code => Object.assign(new Error('pool busy'), { code, isFatal: true });

describe('ScoreZone IPTV: inconclusive metadata refresh', () => {
  let provider, warn;
  beforeEach(() => {
    provider = new ScoreZoneProvider();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); jest.clearAllMocks(); });

  test.each(['ERR_NATIVE_POOL_BUSY', 'ERR_NATIVE_SLOT_CAPACITY', 'ERR_OUTBOUND_CAPACITY'])(
    'no snapshot: %s must propagate rather than appear as zero channels', async code => {
      provider.proxyFetch = jest.fn().mockRejectedValue(capacity(code));
      await expect(provider._getIptvChannels(true)).rejects.toMatchObject({ code });
      expect(provider._iptvInFlight).toBeNull();
      expect(provider._cachedIptvChannels).toBeNull();
    }
  );

  test('genuine missing upstream response retains the empty-channel behavior', async () => {
    provider.proxyFetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(provider._getIptvChannels(true)).resolves.toEqual([]);
  });

  test('a valid stale IPTV snapshot survives an inconclusive refresh', async () => {
    provider._cachedIptvChannels = [channel];
    provider._cachedIptvChannelsTime = Date.now() - 60 * 60 * 1000;
    provider.proxyFetch = jest.fn().mockRejectedValue(capacity('ERR_NATIVE_POOL_BUSY'));
    await expect(provider._getIptvChannels(true)).resolves.toEqual([channel]);
    expect(provider._cachedIptvChannels).toEqual([channel]);
  });

  test('a catalog-provided stream URL remains usable when optional refresh is busy', async () => {
    provider.proxyFetch = jest.fn().mockRejectedValue(capacity('ERR_NATIVE_POOL_BUSY'));
    const rows = await provider.resolveStream('sz_iptv_demo', 'networks', 'Demo Channel', {
      id: 'sz_iptv_demo', source: 'scorezone', streamUrl: channel.url, name: channel.name
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe(channel.url);
    expect(rows[0].behaviorHints.notWebReady).toBe(false);
  });

  test('no cached channel or catalog URL: busy refresh defers and retries in 2s', async () => {
    const unavailable = capacity('ERR_NATIVE_POOL_BUSY');
    provider.proxyFetch = jest.fn()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ channels: [channel] }) });
    const cache = new StreamResolveCache();
    cache._sharedAvailable = () => false;
    container.resolve.mockImplementation(name => ({
      scorezoneProvider: provider, streamResolveCache: cache,
      streamScorer: { calculateScore: () => 1 }, m3u8Parser: null
    })[name]);
    const src = match.sources[0];
    const mint = () => mintVerifiedSources(src, match, null, key, { skipSpeedProbe: true });

    expect(await cache.getOrCreate(key, mint)).toEqual([]);
    const deferred = cache.entries.get(key);
    expect(deferred).toMatchObject({ status: 'deferred', reason: 'capacity', streams: [] });
    expect(deferred.expiresAt - deferred.resolvedAt).toBe(2000);
    expect(await cache.getOrCreate(key, mint)).toEqual([]);
    expect(provider.proxyFetch).toHaveBeenCalledTimes(1);

    deferred.expiresAt = Date.now() - 1;
    const recovered = await cache.getOrCreate(key, mint);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].url).toBe(channel.url);
    expect(cache.entries.get(key).status).toBe('ok');
    expect(provider.proxyFetch).toHaveBeenCalledTimes(2);
  });
});
