'use strict';

jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
jest.mock('../src/services/DaddyLiveMediaCheck', () => ({ checkDaddyLiveMedia: jest.fn() }));

const Provider = require('../src/providers/DaddyLiveProvider');
const { checkDaddyLiveMedia } = require('../src/services/DaddyLiveMediaCheck');
const { inconclusiveStreamsReason } = require('../src/services/StreamResolutionOutcome');
const Cache = require('../src/services/StreamResolveCache');
const container = require('../src/container');
const { mintVerifiedSources } = require('../src/streams');

const BASE = 'https://daddy.fixture.test';
const target = rows => new URL(rows.find(row => row.url).url, BASE).searchParams.get('url');
const rejected = () => ({ status: 'rejected', reason: 'http404' });
const ok = () => ({ status: 'ok' });
const never = () => new Promise(() => {});

function fixture() {
  const provider = new Provider({
    circuitBreaker: { wrapSync: (_name, run) => ({ fire: run }) },
    iframeDomainRegistry: { terminalRefererFor: () => 'https://terminal.fixture.test/' }
  });
  provider.baseDomains = [BASE];
  provider.proxyFetch = jest.fn(async url => {
    const u = new URL(url);
    if (u.origin === BASE) {
      const folder = u.pathname.split('/')[1];
      return { ok: true, text: async () => `<iframe src="https://${folder}.embed.fixture.test/live"></iframe>` };
    }
    const folder = u.hostname.split('.')[0];
    return { ok: true, text: async () => `<script>let stream = "https://${folder}.cdn.fixture.test/live.m3u8?token=${folder}";</script>` };
  });
  return provider;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-06T05:00:00Z'));
  checkDaddyLiveMedia.mockReset().mockResolvedValue(ok());
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

test('a decoded player candidate with dead media falls through to a checked cast feed', async () => {
  const provider = fixture();
  checkDaddyLiveMedia.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(ok());
  const rows = await provider.resolveStream('38', 'american_football', 'NFL');
  expect(target(rows)).toContain('cast.cdn.fixture.test');
  expect(checkDaddyLiveMedia.mock.calls.map(([url]) => new URL(url).hostname)).toEqual([
    'player.cdn.fixture.test', 'cast.cdn.fixture.test'
  ]);
  expect(inconclusiveStreamsReason(rows)).toBeNull();
  expect(provider._decoded.get('38').expiresAt - Date.now()).toBe(150000);
});

test('plus remains reachable after two definitive misses', async () => {
  const provider = fixture();
  checkDaddyLiveMedia.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(rejected()).mockResolvedValueOnce(ok());
  const rows = await provider.resolveStream('38', 'american_football', 'NFL');
  expect(target(rows)).toContain('plus.cdn.fixture.test');
  expect(checkDaddyLiveMedia).toHaveBeenCalledTimes(3);
});

test('a checked unknown-host direct feed retains normal caching after a later iframe capacity miss', async () => {
  const provider = fixture();
  provider.domainRegistry = { terminalRefererFor: () => null, rankCandidates: hosts => hosts };
  provider.proxyFetch.mockImplementation(async url => {
    if (url.startsWith(BASE)) return { ok: true, text: async () =>
      '<iframe src="https://first.embed.fixture.test/live"></iframe><iframe src="https://second.embed.fixture.test/live"></iframe>' };
    const tag = new URL(url).hostname.split('.')[0];
    return { ok: true, text: async () => `<script>let url="https://${tag}.cdn.fixture.test/live.m3u8";</script>` };
  });
  checkDaddyLiveMedia.mockResolvedValueOnce(ok()).mockResolvedValueOnce({ status: 'inconclusive', reason: 'capacity' });
  const rows = await provider.resolveStream('38', 'football', 'Fixture');
  expect(target(rows)).toContain('first.cdn.fixture.test');
  expect(inconclusiveStreamsReason(rows)).toBeNull();
  expect(provider._decoded.get('38').expiresAt - Date.now()).toBe(150000);
});

test('the real media checker detects playlist200/segment404 before selecting cast', async () => {
  const { createDaddyLiveMediaCheck } = jest.requireActual('../src/services/DaddyLiveMediaCheck');
  const provider = fixture();
  const text = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nold.ts\n#EXTINF:5,\ncurrent.ts\n#EXTINF:5,\nnext.ts\n';
  const bytes = Buffer.alloc(512); bytes[0] = 0x47; bytes[188] = 0x47; bytes[376] = 0x47;
  const request = jest.fn(async (url, options) => {
    const segment = new URL(url).pathname.endsWith('.ts');
    const status = segment && url.includes('player.cdn') ? 404 : segment ? 206 : 200;
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(segment ? bytes : Buffer.from(text)); controller.close();
    } });
    if (segment) expect(options.headers.Range).toBe('bytes=0-511');
    return { status, url, body };
  });
  const checker = createDaddyLiveMediaCheck({ request });
  checkDaddyLiveMedia.mockImplementation(checker.check);
  const rows = await provider.resolveStream('38', 'football', 'Fixture');
  expect(target(rows)).toContain('cast.cdn.fixture.test');
  expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    '/live.m3u8', '/current.ts', '/live.m3u8', '/current.ts'
  ]);
  expect(request.mock.calls[1][0]).toContain('token=player');
  expect(request.mock.calls[3][0]).toContain('token=cast');
});

test.each(['capacity', 'timeout', 'cancelled', 'unavailable'])('keeps a %s result briefly retryable through the provider cache', async reason => {
  const provider = fixture();
  checkDaddyLiveMedia.mockResolvedValueOnce({ status: 'inconclusive', reason });
  const rows = await provider.resolveStream('38', 'american_football', 'NFL');
  expect(rows).toHaveLength(1);
  expect(rows[0].externalUrl).toBeDefined();
  expect(inconclusiveStreamsReason(rows)).toBe(reason);
  expect(provider._decoded.get('38').expiresAt - Date.now()).toBe(2000);
  expect(await provider.resolveStream('38', 'american_football', 'NFL')).toBe(rows);
  expect(checkDaddyLiveMedia).toHaveBeenCalledTimes(1);
  expect(provider.proxyFetch).toHaveBeenCalledTimes(2);
});

test('the actual mint and resolve cache retain a two-second web retry and then recover', async () => {
  const provider = fixture();
  const cache = new Cache({ sharedResolver: { available: () => false, request: () => { throw Error('Unexpected L2 I/O'); } } });
  const source = { source: 'daddylive', id: '38' };
  const match = { id: 'nfl', title: 'NFL', category: 'american_football', sources: [source] };
  const key = Cache.resolveKey(source, match.id);
  const services = { daddyLiveProvider: provider, streamResolveCache: cache,
    streamScorer: { calculateScore: () => 1 }, m3u8Parser: null };
  container.resolve.mockImplementation(name => services[name]);
  checkDaddyLiveMedia.mockResolvedValueOnce({ status: 'inconclusive', reason: 'capacity' }).mockResolvedValue(ok());
  const mint = () => mintVerifiedSources(source, match, null, key, { skipSpeedProbe: true });
  const rows = await cache.getOrCreate(key, mint);
  expect(rows[0].externalUrl).toBeDefined();
  expect(rows[0]._nuvioDirectRetry).toBeUndefined();
  expect(cache.isDeferred(key)).toBe(true);
  expect(cache.getRemainingTtl(key)).toBe(2000);
  await jest.advanceTimersByTimeAsync(2000);
  const recovered = await cache.getOrCreate(key, mint);
  expect(target(recovered)).toContain('player.cdn.fixture.test');
  expect(cache.isDeferred(key)).toBe(false);
  expect(cache.getRemainingTtl(key)).toBeGreaterThan(2000);
  expect(checkDaddyLiveMedia).toHaveBeenCalledTimes(2);
});

test('an already-aborted caller cannot read a positive provider cache entry', async () => {
  const provider = fixture();
  const rows = await provider.resolveStream('38', 'football', 'Fixture');
  const controller = new AbortController();
  const error = new DOMException('Caller stopped', 'AbortError');
  controller.abort(error);
  await expect(provider.resolveStream('38', 'football', 'Fixture', {}, { signal: controller.signal })).rejects.toBe(error);
  expect(provider._decoded.get('38').streams).toBe(rows);
  expect(checkDaddyLiveMedia).toHaveBeenCalledTimes(1);
});

test('caller cancellation during discovery stops without writing a provider entry', async () => {
  const provider = fixture();
  provider.proxyFetch.mockImplementation(never);
  const controller = new AbortController();
  const pending = provider.resolveStream('38', 'football', 'Fixture', {}, { signal: controller.signal });
  await jest.advanceTimersByTimeAsync(0);
  const error = new DOMException('Caller stopped', 'AbortError');
  const rejectedCall = expect(pending).rejects.toBe(error);
  controller.abort(error);
  await rejectedCall;
  expect(provider._decoded.has('38')).toBe(false);
  expect(checkDaddyLiveMedia).not.toHaveBeenCalled();
});

test.each(['folder', 'nested'])('the remaining phase deadline bounds uncooperative %s discovery', async stalled => {
  const provider = fixture();
  const normal = provider.proxyFetch.getMockImplementation();
  provider.proxyFetch.mockImplementation((url, opts) => {
    if (stalled === 'folder' && url.includes('/cast/')) return never();
    if (stalled === 'nested' && url.includes('cast.embed')) {
      return { ok: true, text: async () => '<iframe src="https://nested.fixture.test/live"></iframe>' };
    }
    if (url.includes('nested.fixture.test')) return never();
    return normal(url, opts);
  });
  checkDaddyLiveMedia.mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 500));
    return rejected();
  });
  let result;
  const pending = provider.resolveStream('38', 'football', 'Fixture').then(rows => { result = rows; });
  await jest.advanceTimersByTimeAsync(1199);
  expect(result).toBeUndefined();
  await jest.advanceTimersByTimeAsync(1);
  await pending;
  expect(result[0].externalUrl).toBeDefined();
  expect(inconclusiveStreamsReason(result)).toBe('timeout');
  expect(checkDaddyLiveMedia).toHaveBeenCalledTimes(1);
  expect(provider.proxyFetch.mock.calls.some(([url]) => url.includes('/cast/'))).toBe(true);
});

test('a guard rejection hidden under a timeout remains hard and is never cached', async () => {
  const provider = fixture();
  const error = Object.assign(new DOMException('Wrapped', 'TimeoutError'), {
    cause: Object.assign(Error('Blocked'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true })
  });
  checkDaddyLiveMedia.mockRejectedValueOnce(error);
  await expect(provider.resolveStream('38', 'football', 'Fixture')).rejects.toBe(error);
  expect(provider._decoded.has('38')).toBe(false);
});

test('nested embed capacity survives extraction catches and retains the short retry', async () => {
  const provider = fixture();
  provider.proxyFetch.mockImplementation(async url => {
    if (url.startsWith(BASE)) return { ok: true, text: async () => '<iframe src="https://wrapper.fixture.test/live"></iframe>' };
    if (url.includes('wrapper.fixture.test')) return { ok: true, text: async () => '<iframe src="https://nested.fixture.test/live"></iframe>' };
    throw Object.assign(Error('Busy'), { code: 'ERR_NATIVE_POOL_BUSY', isFatal: true });
  });
  const rows = await provider.resolveStream('38', 'football', 'Fixture');
  expect(inconclusiveStreamsReason(rows)).toBe('capacity');
  expect(provider._decoded.get('38').expiresAt - Date.now()).toBe(2000);
  expect(checkDaddyLiveMedia).not.toHaveBeenCalled();
});
