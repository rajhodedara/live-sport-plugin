'use strict';

// Offline transport fixtures; no remote PitSport, watch resolver or media I/O.
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(), streamingFetch: jest.fn(), request: jest.fn()
}));
const container = require('../src/container');
const { safeFetch } = require('../src/services/ProviderOutbound');
const PitSportProvider = require('../src/providers/PitSportProvider');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const { inconclusiveStreamsReason } = require('../src/services/StreamResolutionOutcome');
const { mintVerifiedSources } = require('../src/streams');

const EMBED = 'https://embdlol.st/embed/uuid-main';
const EMBED2 = 'https://embdlol.st/embed/uuid-backup';
const MEDIA = 'https://cdn.fixture.test/live.m3u8';
const SOURCE = { source: 'pitsport', id: '102750', programId: 102750 };
const MATCH = { id: 'pitsport_102750_fixture', category: 'football', title: 'Fixture', sources: [SOURCE] };
const KEY = StreamResolveCache.resolveKey(SOURCE, MATCH.id);
const play = (videos = [{ embedUrl: EMBED, label: 'Main' }]) =>
  ({ ok: true, status: 200, json: async () => ({ data: { videos } }) });
const watch = (url = MEDIA) => ({ ok: true, status: 200, json: async () => ({ url }) });
const busy = () => Object.assign(new Error('native slots busy'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true });
const fail = status => ({ ok: false, status });

function makeCache(provider) {
  const cache = new StreamResolveCache({ sharedResolver: { available: () => false } });
  container.resolve.mockImplementation(name => ({
    pitSportProvider: provider, streamResolveCache: cache,
    streamScorer: { calculateScore: () => 1 }, m3u8Parser: null
  })[name]);
  return cache;
}

describe('PitSport: recover temporary play/watch failures without hiding web fallback', () => {
  let provider, warn;
  beforeEach(() => {
    jest.clearAllMocks();
    provider = new PitSportProvider();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    safeFetch.mockResolvedValue({
      status: 200, ok: true,
      text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:4,\nsegment.ts\n'
    });
  });
  afterEach(() => { warn.mockRestore(); });

  test.each(['ERR_OUTBOUND_CAPACITY', 'ERR_NATIVE_POOL_BUSY', 'ERR_NATIVE_SLOT_CAPACITY'])(
    'temporary watch failure %s keeps web and requests a short capacity retry', async code => {
      const error = Object.assign(new Error('congested'), { code, isFatal: true });
      provider.proxyFetch = jest.fn().mockResolvedValueOnce(play()).mockRejectedValueOnce(error);
      const streams = await provider.resolveStream(SOURCE.id, 'football', MATCH.title, SOURCE);
      expect(streams).toHaveLength(1);
      expect(streams[0].externalUrl).toContain('/watch?url=');
      expect(inconclusiveStreamsReason(streams)).toBe('capacity');
    }
  );

  test('a wrapped token-hop timeout is marked for a short retry', async () => {
    const error = Object.assign(new Error('wrapped'), {
      cause: Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    });
    provider.proxyFetch = jest.fn().mockResolvedValueOnce(play()).mockRejectedValueOnce(error);
    const rows = await provider.resolveStream(SOURCE.id, 'football', MATCH.title, SOURCE);
    expect(rows).toHaveLength(1);
    expect(inconclusiveStreamsReason(rows)).toBe('timeout');
  });

  test.each([408, 429, 500, 502, 503, 504])(
    'watch endpoint HTTP %i keeps web and marks the direct answer inconclusive', async status => {
      provider.proxyFetch = jest.fn().mockResolvedValueOnce(play()).mockResolvedValueOnce(fail(status));
      const rows = await provider.resolveStream(SOURCE.id, 'football', MATCH.title, SOURCE);
      expect(rows).toHaveLength(1);
      expect(inconclusiveStreamsReason(rows)).toBe('unavailable');
    }
  );

  test('definitive watch 404 does not incorrectly trigger a short retry', async () => {
    provider.proxyFetch = jest.fn(async url => url.includes('/play') ? play() : fail(404));
    const rows = await provider.resolveStream(SOURCE.id, 'football', MATCH.title, SOURCE);
    expect(rows).toHaveLength(1);
    expect(inconclusiveStreamsReason(rows)).toBeNull();
    const cache = makeCache(provider), mint = () => mintVerifiedSources(SOURCE, MATCH, null, KEY);
    const persisted = await cache.getOrCreate(KEY, mint);
    expect(persisted).toHaveLength(1);
    expect(cache.entries.get(KEY).status).toBe('ok');
    expect(cache.entries.get(KEY).expiresAt - cache.entries.get(KEY).resolvedAt).toBeGreaterThanOrEqual(60000);
  });

  test.each([429, 503])('transient play API HTTP %i produces a deferred cache result', async status => {
    provider.proxyFetch = jest.fn().mockResolvedValue(fail(status));
    const cache = makeCache(provider);
    const rows = await cache.getOrCreate(KEY, () => mintVerifiedSources(SOURCE, MATCH, null, KEY));
    expect(rows).toEqual([]);
    expect(cache.entries.get(KEY)).toMatchObject({ status: 'deferred', reason: 'unavailable' });
    expect(cache.entries.get(KEY).expiresAt - cache.entries.get(KEY).resolvedAt).toBe(2000);
  });

  test('play API capacity error is deferred rather than negative-cached', async () => {
    provider.proxyFetch = jest.fn().mockRejectedValue(busy());
    const cache = makeCache(provider);
    const rows = await cache.getOrCreate(KEY, () => mintVerifiedSources(SOURCE, MATCH, null, KEY));
    expect(rows).toEqual([]);
    expect(cache.entries.get(KEY)).toMatchObject({ status: 'deferred', reason: 'capacity' });
  });

  test('an explicit upstream play 404 remains a genuine negative-cache result', async () => {
    provider.proxyFetch = jest.fn().mockResolvedValue(fail(404));
    const cache = makeCache(provider);
    expect(await cache.getOrCreate(KEY, () => mintVerifiedSources(SOURCE, MATCH, null, KEY))).toEqual([]);
    expect(cache.entries.get(KEY).status).toBe('failed');
  });

  test('guard refusal cannot be misclassified as a temporary transport error', async () => {
    const security = Object.assign(new Error('forbidden destination'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true });
    provider.proxyFetch = jest.fn().mockResolvedValueOnce(play()).mockRejectedValueOnce(security);
    const rows = await provider.resolveStream(SOURCE.id, 'football', MATCH.title, SOURCE);
    expect(rows).toHaveLength(1);
    expect(inconclusiveStreamsReason(rows)).toBeNull();
  });

  test('one successful direct feed is retained even if another encounters capacity', async () => {
    provider.proxyFetch = jest.fn(async url => {
      if (url.includes('/play')) return play([
        { embedUrl: EMBED, label: 'Main' }, { embedUrl: EMBED2, label: 'Backup' }
      ]);
      if (url.includes('/watch')) return url.includes('/watch') &&
        JSON.parse(provider.proxyFetch.mock.calls.at(-1)[1].body).watchId === 'uuid-main'
        ? watch() : Promise.reject(busy());
      throw new Error('unexpected URL');
    });
    const cache = makeCache(provider);
    const rows = await cache.getOrCreate(KEY, () => mintVerifiedSources(SOURCE, MATCH, null, KEY));
    expect(rows.some(row => row.url)).toBe(true);
    expect(rows.filter(row => row.externalUrl)).toHaveLength(2);
    expect(cache.entries.get(KEY).status).toBe('ok');
    expect(cache.entries.get(KEY).expiresAt - cache.entries.get(KEY).resolvedAt).toBeGreaterThanOrEqual(60000);
  });

  test('web-only capacity fallback refreshes in 2s, then becomes a direct stream', async () => {
    provider.proxyFetch = jest.fn()
      .mockResolvedValueOnce(play()).mockRejectedValueOnce(busy())
      .mockResolvedValueOnce(play()).mockResolvedValueOnce(watch());
    const cache = makeCache(provider);
    const mint = () => mintVerifiedSources(SOURCE, MATCH, null, KEY, { skipSpeedProbe: true });

    const first = await cache.getOrCreate(KEY, mint);
    expect(first).toHaveLength(1);
    expect(first[0].externalUrl).toContain('/watch?url=');
    const entry = cache.entries.get(KEY);
    expect(entry).toMatchObject({ status: 'ok', retryReason: 'capacity' });
    expect(entry.expiresAt - entry.resolvedAt).toBe(2000);
    expect(provider.proxyFetch).toHaveBeenCalledTimes(2);

    // No wall-clock wait or network I/O; advance only the in-memory expiry.
    entry.expiresAt = Date.now() - 1;
    const next = await cache.getOrCreate(KEY, mint);
    expect(next.some(row => row.url && row.url.includes('/api/manifest?'))).toBe(true);
    expect(cache.entries.get(KEY).status).toBe('ok');
    expect(provider.proxyFetch).toHaveBeenCalledTimes(4);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
});
