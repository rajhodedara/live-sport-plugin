'use strict';

// Metadata responses are injected in memory. The locked runner also prohibits
// native workers, network connections and listeners for this suite.
const mockOutboundLoaded = jest.fn();
const mockSafeFetch = jest.fn();
jest.mock('../src/services/ProviderOutbound', () => {
  mockOutboundLoaded();
  return { safeFetch: mockSafeFetch };
});
const { createLeafStreamProbe } = require('../src/services/LeafStreamProbe');

const TARGET = 'https://papacito.cfd/m3u/fixture/live.m3u8?ft=fixture%2Ftoken&x=one%2btwo';
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://w1.papacito.cfd/leaf/fixture/seg_1.ts?a=original%2Fhash\n';
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8?ft=child%2Ftoken\n';
const response = (overrides = {}) => ({ status: 200, url: TARGET, bodyTruncated: false,
  text: jest.fn().mockResolvedValue(MEDIA), ...overrides });
function held() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function untilAbort(signal) {
  return new Promise((_resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}
const flush = async () => { await jest.advanceTimersByTimeAsync(0); };

describe('Leaf bounded metadata probe', () => {
  beforeEach(() => { jest.useFakeTimers(); mockSafeFetch.mockReset(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  test.each([MEDIA, MASTER, '\uFEFF' + MEDIA])('accepts a real playlist without following its media or variant URI', async text => {
    const fetch = jest.fn().mockResolvedValue(response({ text: jest.fn().mockResolvedValue(text) }));
    await expect(createLeafStreamProbe({ fetch }).check(TARGET)).resolves.toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(TARGET, expect.objectContaining({
      timeoutMs: 1500, attempts: 1, maxBodyBytes: 16384, signal: expect.any(AbortSignal)
    }));
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('transport');
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Range');
  });

  test('passes the exact official URL and supplied auth context', async () => {
    const fetch = jest.fn().mockResolvedValue(response());
    await createLeafStreamProbe({ fetch }).check(TARGET, {
      referer: 'https://premium.highfly.to/', origin: 'https://premium.highfly.to', userAgent: 'fixture-browser'
    });
    expect(fetch.mock.calls[0][0]).toBe(TARGET);
    expect(fetch.mock.calls[0][1].headers).toEqual({
      Referer: 'https://premium.highfly.to/', Origin: 'https://premium.highfly.to',
      'User-Agent': 'fixture-browser', Accept: '*/*'
    });
  });

  test.each([
    ['plain HTTP', 'http://papacito.cfd/manifest.m3u8'],
    ['loopback', 'https://127.0.0.1/manifest.m3u8'],
    ['unrelated host', 'https://fixture.test/papacito.cfd/manifest.m3u8'],
    ['suffix spoof', 'https://papacito.cfd.fixture.test/manifest.m3u8'],
    ['userinfo', 'https://user:secret@papacito.cfd/manifest.m3u8'],
    ['nonstandard port', 'https://papacito.cfd:8443/manifest.m3u8'],
    ['control character', 'https://papacito.cfd/a\nb.m3u8'],
    ['oversized input', TARGET + 'x'.repeat(16384)],
    ['missing URL', undefined], ['array URL', [TARGET]], ['leading whitespace', ' ' + TARGET]
  ])('rejects %s before the fetch dependency', async (_label, target) => {
    const fetch = jest.fn();
    await expect(createLeafStreamProbe({ fetch }).check(target)).rejects.toMatchObject({ code: 'ERR_LEAF_MANIFEST_URL' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([200, 403, 404, 503])('validates the final redirect before HTTP %s classification or body reads', async status => {
    const upstream = response({ status, url: 'https://outside.fixture.test/manifest.m3u8' });
    await expect(createLeafStreamProbe({ fetch: async () => upstream }).check(TARGET))
      .rejects.toMatchObject({ code: 'ERR_LEAF_MANIFEST_REDIRECT', isFatal: true });
    expect(upstream.text).not.toHaveBeenCalled();
  });

  test('accepts an intended HTTPS Papacito subdomain final URL', async () => {
    const fetch = jest.fn().mockResolvedValue(response({ url: 'https://edge.papacito.cfd/relocated/live.m3u8?ft=original' }));
    await expect(createLeafStreamProbe({ fetch }).check(TARGET)).resolves.toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([401, 403, 404, 410])('rejects an actual HTTP %s answer', async status => {
    const upstream = response({ status });
    await expect(createLeafStreamProbe({ fetch: async () => upstream }).check(TARGET)).resolves.toEqual({ status: 'rejected' });
    expect(upstream.text).not.toHaveBeenCalled();
  });

  test.each([undefined, null, response({ status: 204 }), response({ status: 429 }), response({ status: 500 }), response({ status: 503 })])
  ('keeps missing or temporary responses inconclusive', async upstream => {
    await expect(createLeafStreamProbe({ fetch: async () => upstream }).check(TARGET))
      .resolves.toEqual({ status: 'inconclusive', reason: 'unavailable' });
  });

  test.each([
    '', '<html>#EXTM3U</html>', ' #EXTM3U\n#EXTINF:6,\na.ts\n',
    '#EXTM3U\n', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n',
    '#EXTM3U\n#EXTINF:6,\n', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n',
    '#EXTM3U\n#EXTINF:NaN,\na.ts\n', '#EXTM3U\n#EXTINF:6,\nfile:///private.ts\n',
    '#EXTM3U\n#EXTINF:6,\nhttps://user:pass@fixture.test/a.ts\n',
    '#EXTM3U\n#EXTINF:6,\nsegment with spaces.ts\n'
  ])('rejects a successful body without a valid media or variant URI: %s', async text => {
    await expect(createLeafStreamProbe({ fetch: async () => response({ text: async () => text }) }).check(TARGET))
      .resolves.toEqual({ status: 'rejected' });
  });

  test.each([
    'stream_notice/seg.ts', '_antipiracy/seg.ts', 'anti-piracy/seg.ts', '%73tream_notice/seg.ts'
  ])('rejects a known notice playlist: %s', async uri => {
    const text = '#EXTM3U\n#EXTINF:6,\n' + uri + '\n';
    const fetch = jest.fn().mockResolvedValue(response({ text: async () => text }));
    await expect(createLeafStreamProbe({ fetch }).check(TARGET)).resolves.toEqual({ status: 'rejected' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    '#EXT-X-CUE-OUT:30\n', '#EXT-X-CUE-OUT-CONT:ElapsedTime=6,Duration=30\n',
    '#EXT-X-SCTE35:fixture\n', '#EXT-X-DATERANGE:ID="break",CLASS="ad",START-DATE="2026-11-06T12:00:00Z"\n',
    '# advertisement break\n'
  ])('ordinary ad insertion metadata does not prove a sports feed is dead: %s', async marker => {
    const text = '#EXTM3U\n' + marker + '#EXTINF:6,\nads/advertisement-segment.ts\n';
    await expect(createLeafStreamProbe({ fetch: async () => response({ text: async () => text }) }).check(TARGET))
      .resolves.toEqual({ status: 'ok' });
  });

  test('checks later segment URIs for encoded notices and ignores ad-like signed query bytes', async () => {
    const withNotice = MEDIA + '#EXTINF:6,\n%73tream_notice/seg.ts\n';
    await expect(createLeafStreamProbe({ fetch: async () => response({ text: async () => withNotice }) }).check(TARGET))
      .resolves.toEqual({ status: 'rejected' });
    const signed = MEDIA.replace('original%2Fhash', 'signed_ad_bytes');
    await expect(createLeafStreamProbe({ fetch: async () => response({ text: async () => signed }) }).check(TARGET))
      .resolves.toEqual({ status: 'ok' });
  });

  test('treats truncation and an oversized injected body as inconclusive', async () => {
    const truncated = response({ bodyTruncated: true });
    await expect(createLeafStreamProbe({ fetch: async () => truncated }).check(TARGET))
      .resolves.toEqual({ status: 'inconclusive', reason: 'unavailable' });
    expect(truncated.text).not.toHaveBeenCalled();
    await expect(createLeafStreamProbe({ fetch: async () => response({ text: async () => MEDIA + '#'.repeat(16384) }) }).check(TARGET))
      .resolves.toEqual({ status: 'inconclusive', reason: 'unavailable' });
    await expect(createLeafStreamProbe({ fetch: async () => response({ text: async () => MEDIA + 'é'.repeat(8192) }) }).check(TARGET))
      .resolves.toEqual({ status: 'inconclusive', reason: 'unavailable' });
  });

  test.each([
    [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'timeout'],
    [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'timeout'],
    [Object.assign(new Error('cancelled'), { name: 'AbortError' }), 'cancelled'],
    [Object.assign(new Error('capacity'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }), 'capacity'],
    [Object.assign(new Error('native capacity'), { code: 'ERR_NATIVE_POOL_BUSY', isFatal: true }), 'capacity'],
    [Object.assign(new Error('slot capacity'), { code: 'ERR_NATIVE_SLOT_CAPACITY' }), 'capacity'],
    [Object.assign(new Error('network reset'), { code: 'ECONNRESET' }), 'unavailable']
  ])('preserves the shared inconclusive classification for %s', async (error, reason) => {
    await expect(createLeafStreamProbe({ fetch: async () => { throw error; } }).check(TARGET))
      .resolves.toEqual({ status: 'inconclusive', reason });
  });

  test.each(['fetch', 'text'])('throws a guard refusal hidden under a timeout from %s', async stage => {
    const error = Object.assign(new Error('wrapper'), { name: 'TimeoutError', cause:
      Object.assign(new Error('blocked'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true }) });
    const fetch = stage === 'fetch' ? async () => { throw error; } : async () => response({ text: async () => { throw error; } });
    await expect(createLeafStreamProbe({ fetch }).check(TARGET)).rejects.toBe(error);
  });

  test('fails closed on fatal, cyclic, deep and unreadable causes', async () => {
    const fatal = Object.assign(new Error('fatal'), { isFatal: true });
    const cyclic = Object.assign(new Error('cyclic'), { name: 'TimeoutError' }); cyclic.cause = cyclic;
    let deep = Object.assign(new Error('blocked'), { code: 'ERR_OUTBOUND_BLOCKED' });
    for (let i = 0; i < 10; i++) deep = Object.assign(new Error('wrapper'), { name: 'TimeoutError', cause: deep });
    const unreadable = new Error('opaque');
    Object.defineProperty(unreadable, 'cause', { get() { throw new Error('unreadable cause'); } });
    for (const error of [fatal, cyclic, deep, unreadable]) {
      await expect(createLeafStreamProbe({ fetch: async () => { throw error; } }).check(TARGET)).rejects.toBe(error);
    }
    await flush();
  });

  test('bounds default admission at two active requests and thirty-two queued requests', async () => {
    const fetch = jest.fn((_url, opts) => untilAbort(opts.signal));
    const checker = createLeafStreamProbe({ fetch });
    const jobs = Array.from({ length: 34 }, (_, i) => checker.check(TARGET + '&candidate=' + i));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(checker.check(TARGET + '&candidate=overflow')).resolves.toEqual({ status: 'inconclusive', reason: 'capacity' });
    await jest.advanceTimersByTimeAsync(1500);
    expect(await Promise.all(jobs)).toEqual(Array(34).fill({ status: 'inconclusive', reason: 'timeout' }));
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(checker.check(TARGET, { timeoutMs: 0 })).resolves.toEqual({ status: 'inconclusive', reason: 'timeout' });
  });

  test('coalesces only matching URL, effective budget and auth context without caller signals', async () => {
    const pending = held();
    const fetch = jest.fn(() => pending.promise);
    const checker = createLeafStreamProbe({ fetch });
    const first = checker.check(TARGET, { referer: 'https://first.fixture.test/' });
    expect(checker.check(TARGET, { referer: 'https://first.fixture.test/' })).toBe(first);
    const others = [
      checker.check(TARGET, { referer: 'https://second.fixture.test/' }),
      checker.check(TARGET, { origin: 'https://origin.fixture.test/' }),
      checker.check(TARGET, { userAgent: 'different browser' }),
      checker.check(TARGET, { timeoutMs: 200 }),
      checker.check(TARGET, { signal: new AbortController().signal }),
      checker.check(TARGET, { signal: new AbortController().signal })
    ];
    for (const other of others) expect(other).not.toBe(first);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    pending.resolve(response());
    await expect(first).resolves.toEqual({ status: 'ok' });
    expect(await Promise.all(others)).toEqual(Array(6).fill({ status: 'ok' }));
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  test('the caller deadline includes queue time and is passed as only the remaining fetch budget', async () => {
    const pending = held();
    const fetch = jest.fn().mockImplementationOnce(() => pending.promise)
      .mockImplementation((_url, opts) => untilAbort(opts.signal));
    const checker = createLeafStreamProbe({ fetch, maxConcurrent: 1 });
    const first = checker.check(TARGET); const queued = checker.check(TARGET + '&queued=1', { timeoutMs: 1000 });
    await jest.advanceTimersByTimeAsync(700);
    pending.resolve(response({ status: 404 }));
    await flush();
    expect(await first).toEqual({ status: 'rejected' });
    expect(fetch.mock.calls[1][1].timeoutMs).toBe(300);
    await jest.advanceTimersByTimeAsync(300);
    expect(await queued).toEqual({ status: 'inconclusive', reason: 'timeout' });
  });

  test('an uncooperative fetch retains admission and same-key coalescing until settlement', async () => {
    const pending = held();
    const fetch = jest.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(response());
    const checker = createLeafStreamProbe({ fetch, maxConcurrent: 1, maxWaiters: 1 });
    const first = checker.check(TARGET); const queued = checker.check(TARGET + '&queued=1');
    await jest.advanceTimersByTimeAsync(1500);
    expect(await first).toEqual({ status: 'inconclusive', reason: 'timeout' });
    expect(await queued).toEqual({ status: 'inconclusive', reason: 'timeout' });
    expect(checker.check(TARGET)).toBe(first);
    const next = checker.check(TARGET + '&next=1');
    await expect(checker.check(TARGET + '&overflow=1')).resolves.toEqual({ status: 'inconclusive', reason: 'capacity' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const lateResponse = response();
    pending.resolve(lateResponse);
    await flush();
    expect(lateResponse.text).not.toHaveBeenCalled();
    await expect(next).resolves.toEqual({ status: 'ok' });
    await expect(checker.check(TARGET)).resolves.toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('an uncooperative text promise retains admission through public timeout', async () => {
    const pendingText = held();
    const fetch = jest.fn().mockResolvedValueOnce(response({ text: () => pendingText.promise })).mockResolvedValue(response());
    const checker = createLeafStreamProbe({ fetch, maxConcurrent: 1, maxWaiters: 0 });
    const first = checker.check(TARGET);
    await jest.advanceTimersByTimeAsync(1500);
    expect(await first).toEqual({ status: 'inconclusive', reason: 'timeout' });
    await expect(checker.check(TARGET + '&other=1')).resolves.toEqual({ status: 'inconclusive', reason: 'capacity' });
    expect(checker.check(TARGET)).toBe(first);
    pendingText.resolve(MEDIA);
    await flush();
    await expect(checker.check(TARGET + '&other=1')).resolves.toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('caller cancellation does not cancel another matching request', async () => {
    const fetch = jest.fn((_url, opts) => untilAbort(opts.signal));
    const checker = createLeafStreamProbe({ fetch });
    const controller = new AbortController();
    const first = checker.check(TARGET, { signal: controller.signal }); const other = checker.check(TARGET);
    await flush();
    controller.abort();
    await expect(first).resolves.toEqual({ status: 'inconclusive', reason: 'cancelled' });
    await expect(checker.check(TARGET, { signal: controller.signal })).resolves.toEqual({ status: 'inconclusive', reason: 'cancelled' });
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1500);
    await expect(other).resolves.toEqual({ status: 'inconclusive', reason: 'timeout' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('parent timeout and fatal cancellation reasons retain their classifications', async () => {
    const checker = createLeafStreamProbe({ fetch: (_url, opts) => untilAbort(opts.signal) });
    const parent = new AbortController();
    const job = checker.check(TARGET, { signal: parent.signal });
    await flush();
    parent.abort(new DOMException('parent deadline', 'TimeoutError'));
    await expect(job).resolves.toEqual({ status: 'inconclusive', reason: 'timeout' });
    await expect(checker.check(TARGET, { signal: parent.signal })).resolves.toEqual({ status: 'inconclusive', reason: 'timeout' });
    const blocked = new AbortController();
    const error = Object.assign(new Error('timeout wrapper'), { name: 'TimeoutError', cause:
      Object.assign(new Error('blocked'), { code: 'ERR_OUTBOUND_BLOCKED' }) });
    blocked.abort(error);
    await expect(checker.check(TARGET, { signal: blocked.signal })).rejects.toBe(error);
  });

  test('factory configuration cannot exceed private hard limits', () => {
    for (const options of [{ timeoutMs: 1501 }, { timeoutMs: 0 }, { maxConcurrent: 3 }, { maxConcurrent: 0 },
      { maxWaiters: 33 }, { maxWaiters: -1 }, { fetch: null }]) {
      expect(() => createLeafStreamProbe(options)).toThrow(RangeError);
    }
  });

  test('the shared default lazily calls guarded safeFetch and coalesces process-wide calls', async () => {
    let probe;
    const before = mockOutboundLoaded.mock.calls.length;
    jest.isolateModules(() => { probe = require('../src/services/LeafStreamProbe'); });
    expect(mockOutboundLoaded).toHaveBeenCalledTimes(before);
    const pending = held();
    mockSafeFetch.mockImplementation(() => pending.promise);
    const first = probe.checkLeafStream(TARGET); const duplicate = probe.checkLeafStream(TARGET);
    expect(first).toBe(duplicate);
    await flush();
    expect(mockOutboundLoaded).toHaveBeenCalledTimes(before + 1);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockSafeFetch.mock.calls[0][1]).toEqual(expect.objectContaining({ attempts: 1, maxBodyBytes: 16384 }));
    expect(mockSafeFetch.mock.calls[0][1].headers['User-Agent']).toContain('Chrome/142.');
    pending.resolve(response());
    await expect(first).resolves.toEqual({ status: 'ok' });
  });
});
