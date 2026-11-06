'use strict';

// Only the pure probe and in-memory transports are exercised here.
const HlsQualityProbe = require('../src/services/HlsQualityProbe');

const media = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n';
const master = () => ({ ok: true, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8\n' });
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
function segment() {
  const packet = Buffer.alloc(188); packet[0] = 0x47;
  const sps = Buffer.from('0000016764002aacd900780227e5c05a808080a0000003002a83a68001e30632c000000168eaef2c', 'hex');
  const bytes = Buffer.concat([packet, packet, packet, sps]);
  return { ok: true, status: 206, headers: { 'content-range': `bytes 0-${bytes.length - 1}/1000000` },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

describe('HlsQualityProbe total deadline and physical admission', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(100000); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  test('26 simultaneous calls finish within one budget, without starting expired queued work', async () => {
    const probe = new HlsQualityProbe();
    const fetch = jest.fn((_url, options) => untilAbort(options.signal));
    const completions = [];
    const start = Date.now();
    const jobs = Array.from({ length: 26 }, (_, index) =>
      probe.probe(`https://quality.fixture.test/feed-${index}.m3u8`, { fetch })
        .then(value => { completions.push(Date.now() - start); return value; }));
    await jest.advanceTimersByTimeAsync(0);
    expect(probe.active).toBe(4);
    expect(probe.waiters).toHaveLength(22);
    expect(fetch).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(3500);
    expect(await Promise.all(jobs)).toEqual(Array(26).fill(null));
    expect(Math.max(...completions)).toBe(3500);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(probe.active).toBe(0);
    expect(probe.waiters).toHaveLength(0);
    expect(probe.inFlight.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('queued transport receives only the remaining deadline, not a fresh budget', async () => {
    const probe = new HlsQualityProbe({ maxConcurrentProbes: 1 });
    const first = held();
    const fetch = jest.fn((url, options) => url.endsWith('first.m3u8') ? first.promise : untilAbort(options.signal));
    const a = probe.probe('https://quality.fixture.test/first.m3u8', { fetch });
    const b = probe.probe('https://quality.fixture.test/second.m3u8', { fetch });
    await jest.advanceTimersByTimeAsync(2500);
    first.resolve(master());
    await jest.advanceTimersByTimeAsync(0);
    expect(await a).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1]).toMatchObject({ timeoutMs: 1000, attempts: 1 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(await b).toBeNull();
    expect(probe.active).toBe(0);
    expect(probe.waiters).toHaveLength(0);
  });

  test('both fetch hops and their bodies share the original remaining budget', async () => {
    const probe = new HlsQualityProbe();
    const fetch = jest.fn((_url, options) => {
      if (fetch.mock.calls.length === 1) {
        return new Promise(resolve => setTimeout(() => resolve({ ok: true,
          text: () => new Promise(done => setTimeout(() => done(media), 500)) }), 1000));
      }
      return Promise.resolve({ ok: true, status: 206, arrayBuffer: () => untilAbort(options.signal) });
    });
    const job = probe.probe('https://quality.fixture.test/both-hops.m3u8', { fetch });
    await jest.advanceTimersByTimeAsync(1500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1]).toMatchObject({ timeoutMs: 3500, attempts: 1, maxBodyBytes: 256 * 1024 });
    expect(fetch.mock.calls[1][1]).toMatchObject({ timeoutMs: 2000, attempts: 1, maxBodyBytes: 576 * 1024 });
    expect(fetch.mock.calls[1][1].headers.Range).toBe('bytes=0-524287');
    expect(fetch.mock.calls[0][1].signal).toBe(fetch.mock.calls[1][1].signal);
    await jest.advanceTimersByTimeAsync(2000);
    expect(await job).toBeNull();
    expect(fetch.mock.calls[1][1].signal.reason.name).toBe('TimeoutError');
    expect(probe.active).toBe(0);
  });

  test('an uncooperative fetch cannot hold callers or free its physical lease early', async () => {
    const probe = new HlsQualityProbe({ maxConcurrentProbes: 1, negativeTtlMs: 1000 });
    const pending = held();
    const fetch = jest.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(master());
    const first = probe.probe('https://quality.fixture.test/stalled.m3u8', { fetch });
    const queued = probe.probe('https://quality.fixture.test/queued.m3u8', { fetch });
    await jest.advanceTimersByTimeAsync(3500);
    expect(await first).toBeNull();
    expect(await queued).toBeNull();
    expect(probe.active).toBe(1);
    expect(probe.waiters).toHaveLength(0);
    expect(probe.inFlight.size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1001); // Let the negative cache expire.
    await expect(probe.probe('https://quality.fixture.test/stalled.m3u8', { fetch })).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1); // Same-key work is still physically active.
    pending.resolve({ ok: false });
    await jest.advanceTimersByTimeAsync(0);
    expect(probe.active).toBe(0);
    expect(probe.inFlight.size).toBe(0);
    await expect(probe.probe('https://quality.fixture.test/stalled.m3u8', { fetch })).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('an uncooperative playlist body retains admission and never starts a late segment', async () => {
    const probe = new HlsQualityProbe({ maxConcurrentProbes: 1 });
    const body = held();
    const fetch = jest.fn(async () => ({ ok: true, text: () => body.promise }));
    const first = probe.probe('https://quality.fixture.test/body.m3u8', { fetch });
    const second = probe.probe('https://quality.fixture.test/body-queued.m3u8', { fetch });
    await jest.advanceTimersByTimeAsync(3500);
    expect(await first).toBeNull(); expect(await second).toBeNull();
    expect(probe.active).toBe(1);
    expect(probe.waiters).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    body.resolve(media);
    await jest.advanceTimersByTimeAsync(0);
    expect(probe.active).toBe(0);
    expect(probe.inFlight.size).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('late response-body cancellation must finish before admission is released', async () => {
    const probe = new HlsQualityProbe({ maxConcurrentProbes: 1 });
    const response = held(), canceled = held();
    const cancel = jest.fn(() => canceled.promise);
    const fetch = jest.fn(() => response.promise);
    const job = probe.probe('https://quality.fixture.test/late-response.m3u8', { fetch });
    await jest.advanceTimersByTimeAsync(3500);
    expect(await job).toBeNull();
    response.resolve({ ok: true, body: { cancel }, text: jest.fn(() => { throw Error('Must not read after deadline'); }) });
    await jest.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(probe.active).toBe(1);
    canceled.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(probe.active).toBe(0);
    expect(probe.inFlight.size).toBe(0);
  });

  test('an uncooperative segment body keeps its lease and cannot overwrite the timeout cache', async () => {
    const probe = new HlsQualityProbe({ maxConcurrentProbes: 1 });
    const body = held();
    const url = 'https://quality.fixture.test/segment-body.m3u8';
    const fetch = jest.fn().mockResolvedValueOnce({ ok: true, text: async () => media })
      .mockResolvedValueOnce({ ...segment(), arrayBuffer: () => body.promise });
    const job = probe.probe(url, { fetch });
    await jest.advanceTimersByTimeAsync(3500);
    expect(await job).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(probe.active).toBe(1);
    expect(probe.inFlight.size).toBe(1);
    body.resolve(await segment().arrayBuffer());
    await jest.advanceTimersByTimeAsync(0);
    expect(probe.active).toBe(0);
    expect(probe.inFlight.size).toBe(0);
    await expect(probe.probe(url, { fetch })).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('reservation transfers directly to the oldest queued probe during a racing arrival', async () => {
    const probe = new HlsQualityProbe({ maxConcurrentProbes: 1 });
    const gates = [held(), held(), held()];
    const starts = [];
    const fetch = jest.fn(url => { starts.push(url); return gates[starts.length - 1].promise; });
    const a = probe.probe('https://quality.fixture.test/fifo-a.m3u8', { fetch });
    const b = probe.probe('https://quality.fixture.test/fifo-b.m3u8', { fetch });
    let c;
    const release = probe._release.bind(probe);
    jest.spyOn(probe, '_release').mockImplementation(() => {
      release();
      if (!c) c = probe.probe('https://quality.fixture.test/fifo-c.m3u8', { fetch });
    });
    await jest.advanceTimersByTimeAsync(0);
    gates[0].resolve(master());
    await jest.advanceTimersByTimeAsync(0);
    expect(starts).toEqual(['https://quality.fixture.test/fifo-a.m3u8', 'https://quality.fixture.test/fifo-b.m3u8']);
    expect(probe.active).toBe(1);
    gates[1].resolve(master()); await jest.advanceTimersByTimeAsync(0);
    expect(starts[2]).toBe('https://quality.fixture.test/fifo-c.m3u8');
    expect(probe.active).toBe(1);
    gates[2].resolve(master()); await jest.advanceTimersByTimeAsync(0);
    expect(await Promise.all([a, b, c])).toEqual([null, null, null]);
    expect(probe.active).toBe(0);
  });

  test('a queued probe can still measure quality and reuse its normal cache', async () => {
    const probe = new HlsQualityProbe({ maxConcurrentProbes: 1 });
    const first = held();
    const fetch = jest.fn((url) => {
      if (url.endsWith('cache-first.m3u8')) return first.promise;
      return Promise.resolve(url.endsWith('.ts') ? segment() : { ok: true, text: async () => media });
    });
    const a = probe.probe('https://quality.fixture.test/cache-first.m3u8', { fetch });
    const b = probe.probe('https://quality.fixture.test/cache-second.m3u8?token=one', { fetch, referer: 'https://embed.fixture.test' });
    await jest.advanceTimersByTimeAsync(1000);
    first.resolve(master()); await jest.advanceTimersByTimeAsync(0);
    expect(await a).toBeNull();
    expect(await b).toMatchObject({ resolution: '1080p', quality: 'FHD', bitrate: '2.0 Mbps', cached: false });
    expect(fetch.mock.calls[1][1].timeoutMs).toBe(2500);
    const reused = await probe.probe('https://quality.fixture.test/cache-second.m3u8?token=two', { fetch, referer: 'https://embed.fixture.test' });
    expect(reused).toMatchObject({ quality: 'FHD', cached: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(probe.active).toBe(0);
    expect(probe.waiters).toHaveLength(0);
    expect(probe.inFlight.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
