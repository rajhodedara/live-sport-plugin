'use strict';

// In-memory response readers only: no provider/native execution or sockets.
const { createDaddyLiveMediaCheck } = require('../src/services/DaddyLiveMediaCheck');

const URL = 'https://cdn.fixture.test/live/index.m3u8?token=secret';
const media = segments => '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' + segments.map(uri => `#EXTINF:4,\n${uri}\n`).join('');
const ts = size => {
  const bytes = Buffer.alloc(size, 0);
  for (let offset = 0; offset < size; offset += 188) bytes[offset] = 0x47;
  return bytes;
};
function held() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(data, { status = 200, url, exactThenStall = false, cancel } = {}) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  let emitted = false;
  const reader = {
    read: jest.fn(() => {
      if (!emitted) { emitted = true; return Promise.resolve({ value: bytes, done: false }); }
      return exactThenStall ? new Promise(() => {}) : Promise.resolve({ done: true });
    }),
    cancel: jest.fn(cancel || (async () => {})),
    releaseLock: jest.fn()
  };
  return { status, ok: status >= 200 && status < 300, url, body: { getReader: () => reader }, reader };
}
function untilAbort(signal) {
  return new Promise((_resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}
const flush = async () => { await jest.advanceTimersByTimeAsync(0); };

describe('DaddyLive bounded media check', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  test.each([404, 410])('rejects a %s media segment behind a successful playlist', async status => {
    const segment = response('missing', { status });
    const request = jest.fn().mockResolvedValueOnce(response(media(['a.ts', 'b.ts', 'c.ts'])))
      .mockResolvedValueOnce(segment);
    const check = createDaddyLiveMediaCheck({ request });
    await expect(check.check(URL)).resolves.toEqual({ status: 'rejected', reason: 'http' + status });
    expect(request.mock.calls[1][0]).toBe('https://cdn.fixture.test/live/b.ts?token=secret');
    expect(segment.reader.cancel).toHaveBeenCalledTimes(1);
    expect(segment.reader.read).not.toHaveBeenCalled();
  });

  test('follows one master rendition and uses its penultimate complete segment', async () => {
    const request = jest.fn().mockResolvedValueOnce(response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmedia/one.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200\nmedia/two.m3u8\n'))
      .mockResolvedValueOnce(response(media(['1.ts', '2.ts', '3.ts'])))
      .mockResolvedValueOnce(response(ts(512), { status: 206 }));
    await expect(createDaddyLiveMediaCheck({ request }).check(URL, {
      referer: 'https://embed.fixture.test/', origin: 'https://embed.fixture.test', userAgent: 'fixture-ua'
    })).resolves.toEqual({ status: 'ok' });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      URL, 'https://cdn.fixture.test/live/media/one.m3u8?token=secret', 'https://cdn.fixture.test/live/media/2.ts?token=secret'
    ]);
    expect(request.mock.calls[2][1]).toMatchObject({ attempts: 1, maxBodyBytes: 512,
      headers: { Range: 'bytes=0-511', Referer: 'https://embed.fixture.test/', Origin: 'https://embed.fixture.test', 'User-Agent': 'fixture-ua' } });
    expect(request.mock.calls[0][1].signal).toBe(request.mock.calls[2][1].signal);
  });

  test('ignores GAP entries and partial/preload hints when selecting complete media', async () => {
    const text = '#EXTM3U\n#EXTINF:4,\nold.ts\n#EXT-X-GAP\n#EXTINF:4,\ngap.ts\n#EXTINF:4,\nrecent.ts\n#EXT-X-PART:DURATION=0.2,URI="partial.ts"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="future.ts"\n';
    const request = jest.fn().mockResolvedValueOnce(response(text)).mockResolvedValueOnce(response(ts(512)));
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'ok' });
    expect(request.mock.calls[1][0]).toContain('/old.ts?');
  });

  test('uses the sole complete segment when there is no penultimate one', async () => {
    const request = jest.fn().mockResolvedValueOnce(response(media(['single.ts']))).mockResolvedValueOnce(response(ts(512)));
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'ok' });
    expect(request.mock.calls[1][0]).toBe('https://cdn.fixture.test/live/single.ts?token=secret');
  });

  test.each([
    '#EXTM3U\n#EXT-X-TARGETDURATION:4\n',
    '#EXTM3U\n#EXT-X-PART:DURATION=0.2,URI="part.ts"\n',
    '#EXTM3U\n#EXT-X-GAP\n#EXTINF:4,\ngap.ts\n',
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:4,\na.ts\n',
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\na.m4s\n',
    '#EXTM3U\n#EXTINF:4,\n#EXT-X-BYTERANGE:2000@4096\na.ts\n'
  ])('keeps an unsupported/empty media window inconclusive (%s)', async text => {
    const request = jest.fn().mockResolvedValue(response(text));
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'inconclusive', reason: 'unavailable' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('METHOD=NONE does not make an otherwise ordinary TS playlist unsupported', async () => {
    const request = jest.fn().mockResolvedValueOnce(response('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts\n'))
      .mockResolvedValueOnce(response(ts(512)));
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'ok' });
  });

  test('uses the redirect base without leaking query tokens into an absolute foreign segment', async () => {
    const request = jest.fn().mockResolvedValueOnce(response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nrelative.m3u8\n', { url: 'https://redirect.fixture.test/path/index.m3u8?new=token' }))
      .mockResolvedValueOnce(response(media(['https://other.fixture.test/segment.ts'])))
      .mockResolvedValueOnce(response(ts(512)));
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'ok' });
    expect(request.mock.calls[1][0]).toBe('https://redirect.fixture.test/path/relative.m3u8?new=token');
    expect(request.mock.calls[2][0]).toBe('https://other.fixture.test/segment.ts');
  });

  test.each([512, 1024 * 1024])('cancels immediately after a %s-byte transport chunk without another read', async size => {
    const segment = response(ts(size), { exactThenStall: true });
    const request = jest.fn().mockResolvedValueOnce(response(media(['a.ts']))).mockResolvedValueOnce(segment);
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'ok' });
    expect(segment.reader.read).toHaveBeenCalledTimes(1);
    expect(segment.reader.cancel).toHaveBeenCalledTimes(1);
    expect(segment.reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  test('caps a playlist body instead of parsing a truncated prefix as healthy metadata', async () => {
    const huge = response(Buffer.alloc(64 * 1024, 65), { exactThenStall: true });
    const request = jest.fn().mockResolvedValue(huge);
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'inconclusive', reason: 'unavailable' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(huge.reader.read).toHaveBeenCalledTimes(1);
    expect(huge.reader.cancel).toHaveBeenCalledTimes(1);
  });

  test('supports the node-readable async-iterator shape and stops after its prefix', async () => {
    const iterator = { next: jest.fn(async () => ({ value: ts(512), done: false })), return: jest.fn(async () => ({ done: true })) };
    const segment = { status: 206, body: { [Symbol.asyncIterator]: () => iterator, destroy: jest.fn() } };
    const request = jest.fn().mockResolvedValueOnce(response(media(['a.ts']))).mockResolvedValueOnce(segment);
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'ok' });
    expect(iterator.next).toHaveBeenCalledTimes(1);
    expect(segment.body.destroy).toHaveBeenCalledTimes(1);
    expect(iterator.return).toHaveBeenCalledTimes(1);
  });

  test('cancels a readable after a body-read failure instead of leaking its transport', async () => {
    const failed = response('');
    failed.reader.read.mockRejectedValue(new Error('connection reset'));
    await expect(createDaddyLiveMediaCheck({ request: async () => failed }).check(URL))
      .resolves.toEqual({ status: 'inconclusive', reason: 'unavailable' });
    expect(failed.reader.cancel).toHaveBeenCalledTimes(1);
    expect(failed.reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  test.each([403, 429, 500, 503])('keeps HTTP %s temporary rather than declaring the candidate dead', async status => {
    const request = jest.fn().mockResolvedValue(response('error', { status }));
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'inconclusive', reason: 'unavailable' });
  });

  test.each([
    Object.assign(new Error('capacity'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }),
    Object.assign(new Error('pool'), { code: 'ERR_NATIVE_POOL_BUSY' }),
    Object.assign(new Error('slot'), { code: 'ERR_NATIVE_SLOT_CAPACITY' })
  ])('preserves local capacity classification for %s', async error => {
    const request = jest.fn().mockRejectedValue(error);
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'inconclusive', reason: 'capacity' });
  });

  test('guard rejection in a cause chain wins over its timeout wrapper', async () => {
    const error = Object.assign(new Error('wrapper'), { name: 'TimeoutError',
      cause: Object.assign(new Error('blocked'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true }) });
    await expect(createDaddyLiveMediaCheck({ request: jest.fn().mockRejectedValue(error) }).check(URL)).rejects.toBe(error);
  });

  test('an unreadable error cause fails closed without leaving an unhandled rejection', async () => {
    const error = new Error('opaque');
    Object.defineProperty(error, 'cause', { get() { throw new Error('unreadable cause'); } });
    const checker = createDaddyLiveMediaCheck({ request: jest.fn().mockRejectedValue(error) });
    await expect(checker.check(URL)).rejects.toBe(error);
    await flush();
    expect(checker.active).toBe(0);
    expect(checker.inFlightSize).toBe(0);
  });

  test('invalid segment schemes are blocked before the next request', async () => {
    const request = jest.fn().mockResolvedValue(response(media(['file:///private.ts'])));
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('rejects non-playlist metadata but treats an unexpected successful segment body as inconclusive', async () => {
    await expect(createDaddyLiveMediaCheck({ request: async () => response('<html>gone</html>') }).check(URL))
      .resolves.toEqual({ status: 'rejected', reason: 'invalidPlaylist' });
    const request = jest.fn().mockResolvedValueOnce(response(media(['a.ts']))).mockResolvedValueOnce(response('<html>error</html>'));
    await expect(createDaddyLiveMediaCheck({ request }).check(URL)).resolves.toEqual({ status: 'inconclusive', reason: 'unavailable' });
  });

  test('bounds two active checks and queued admission, coalescing only matching auth context', async () => {
    jest.useFakeTimers();
    const request = jest.fn((_url, opts) => untilAbort(opts.signal));
    const checker = createDaddyLiveMediaCheck({ request, maxWaiters: 1 });
    const a = checker.check(URL, { referer: 'https://first.test/' });
    const duplicate = checker.check(URL, { referer: 'https://first.test/' });
    const b = checker.check(URL, { referer: 'https://second.test/' });
    const queued = checker.check(URL + '&other=1');
    const full = checker.check(URL + '&other=2');
    expect(a).toBe(duplicate);
    await flush();
    expect(checker.active).toBe(2); expect(checker.queued).toBe(1);
    await expect(full).resolves.toEqual({ status: 'inconclusive', reason: 'capacity' });
    await jest.advanceTimersByTimeAsync(1200);
    expect(await Promise.all([a, b, queued])).toEqual(Array(3).fill({ status: 'inconclusive', reason: 'timeout' }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(checker.active).toBe(0); expect(checker.queued).toBe(0); expect(checker.inFlightSize).toBe(0);
  });

  test('a queued check gets only its remaining deadline after admission', async () => {
    jest.useFakeTimers();
    const first = held();
    const request = jest.fn().mockImplementationOnce(() => first.promise)
      .mockImplementation((_url, opts) => untilAbort(opts.signal));
    const checker = createDaddyLiveMediaCheck({ request, maxConcurrent: 1 });
    const a = checker.check(URL); const b = checker.check(URL + '&other=1');
    await jest.advanceTimersByTimeAsync(900);
    first.resolve(response('gone', { status: 404 }));
    await flush();
    expect(await a).toEqual({ status: 'rejected', reason: 'http404' });
    expect(request.mock.calls[1][1].timeoutMs).toBe(300);
    await jest.advanceTimersByTimeAsync(300);
    expect(await b).toEqual({ status: 'inconclusive', reason: 'timeout' });
  });

  test('master, media and segment share one deadline including body read time', async () => {
    jest.useFakeTimers();
    const request = jest.fn((_url, opts) => {
      if (request.mock.calls.length === 1) return new Promise(resolve => setTimeout(() => resolve(response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n')), 400));
      if (request.mock.calls.length === 2) return new Promise(resolve => setTimeout(() => resolve(response(media(['a.ts']))), 400));
      return untilAbort(opts.signal);
    });
    const job = createDaddyLiveMediaCheck({ request }).check(URL);
    await jest.advanceTimersByTimeAsync(800);
    expect(request.mock.calls.map(([, opts]) => opts.timeoutMs)).toEqual([1200, 800, 400]);
    await jest.advanceTimersByTimeAsync(400);
    expect(await job).toEqual({ status: 'inconclusive', reason: 'timeout' });
  });

  test('per-call remaining budgets are independent single-flight keys and are never enlarged', async () => {
    jest.useFakeTimers();
    const request = jest.fn((_url, opts) => untilAbort(opts.signal));
    const checker = createDaddyLiveMediaCheck({ request });
    const short = checker.check(URL, { timeoutMs: 200 }); const long = checker.check(URL, { timeoutMs: 1200 });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([, opts]) => opts.timeoutMs)).toEqual([200, 1200]);
    await jest.advanceTimersByTimeAsync(200);
    expect(await short).toEqual({ status: 'inconclusive', reason: 'timeout' });
    expect(checker.active).toBe(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await long).toEqual({ status: 'inconclusive', reason: 'timeout' });
    await expect(checker.check(URL, { timeoutMs: 0 })).resolves.toEqual({ status: 'inconclusive', reason: 'timeout' });
  });

  test('an uncooperative fetch retains its physical slot and same-key single-flight after public timeout', async () => {
    jest.useFakeTimers();
    const physical = held();
    const request = jest.fn().mockImplementationOnce(() => physical.promise).mockResolvedValue(response('', { status: 404 }));
    const checker = createDaddyLiveMediaCheck({ request, maxConcurrent: 1 });
    const a = checker.check(URL); const queued = checker.check(URL + '&queued=1');
    await jest.advanceTimersByTimeAsync(1200);
    expect(await a).toEqual({ status: 'inconclusive', reason: 'timeout' });
    expect(await queued).toEqual({ status: 'inconclusive', reason: 'timeout' });
    expect(checker.active).toBe(1); expect(checker.queued).toBe(0); expect(checker.inFlightSize).toBe(1);
    expect(checker.check(URL)).toBe(a);
    expect(request).toHaveBeenCalledTimes(1);
    physical.resolve(response('', { status: 404 }));
    await flush();
    expect(checker.active).toBe(0); expect(checker.inFlightSize).toBe(0);
    await expect(checker.check(URL)).resolves.toEqual({ status: 'rejected', reason: 'http404' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('a stalled cancellation retains the lease even after an exact segment prefix was read', async () => {
    jest.useFakeTimers();
    const cancellation = held();
    const segment = response(ts(512), { cancel: () => cancellation.promise });
    const request = jest.fn().mockResolvedValueOnce(response(media(['a.ts']))).mockResolvedValueOnce(segment);
    const checker = createDaddyLiveMediaCheck({ request, maxConcurrent: 1 });
    const job = checker.check(URL);
    await flush();
    expect(segment.reader.read).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1200);
    expect(await job).toEqual({ status: 'inconclusive', reason: 'timeout' });
    expect(checker.active).toBe(1);
    cancellation.resolve(); await flush();
    expect(checker.active).toBe(0);
  });

  test('a stalled body read retains admission until it actually settles after timeout', async () => {
    const pendingRead = held();
    const segment = response('');
    segment.reader.read.mockImplementation(() => pendingRead.promise);
    const request = jest.fn().mockResolvedValueOnce(response(media(['a.ts']))).mockResolvedValueOnce(segment);
    const checker = createDaddyLiveMediaCheck({ request, maxConcurrent: 1 });
    const job = checker.check(URL);
    await flush();
    await jest.advanceTimersByTimeAsync(1200);
    expect(await job).toEqual({ status: 'inconclusive', reason: 'timeout' });
    expect(segment.reader.cancel).toHaveBeenCalledTimes(1);
    expect(checker.active).toBe(1); expect(checker.inFlightSize).toBe(1);
    pendingRead.resolve({ done: true }); await flush();
    expect(checker.active).toBe(0); expect(checker.inFlightSize).toBe(0);
  });

  test('caller cancellation is separate from another matching caller and never starts an already-aborted request', async () => {
    jest.useFakeTimers();
    const request = jest.fn((_url, opts) => untilAbort(opts.signal));
    const checker = createDaddyLiveMediaCheck({ request });
    const controller = new AbortController();
    const a = checker.check(URL, { signal: controller.signal }); const b = checker.check(URL);
    await flush(); controller.abort(); await flush();
    expect(await a).toEqual({ status: 'inconclusive', reason: 'cancelled' });
    expect(checker.active).toBe(1);
    await expect(checker.check(URL, { signal: controller.signal })).resolves.toEqual({ status: 'inconclusive', reason: 'cancelled' });
    expect(request).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1200);
    expect(await b).toEqual({ status: 'inconclusive', reason: 'timeout' });
  });

  test('a parent phase timeout remains timeout rather than being relabeled as cancellation', async () => {
    const controller = new AbortController();
    const request = jest.fn((_url, opts) => untilAbort(opts.signal));
    const checker = createDaddyLiveMediaCheck({ request });
    const job = checker.check(URL, { signal: controller.signal });
    await flush();
    controller.abort(new DOMException('parent budget exhausted', 'TimeoutError'));
    await expect(job).resolves.toEqual({ status: 'inconclusive', reason: 'timeout' });
    await expect(checker.check(URL, { signal: controller.signal })).resolves.toEqual({ status: 'inconclusive', reason: 'timeout' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
