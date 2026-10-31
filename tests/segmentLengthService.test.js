'use strict';

jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));

const segmentLengthService = require('../src/services/SegmentLengthService');
const { safeFetch } = require('../src/impitClient');
const { SegmentLengthService } = segmentLengthService;

function fakeHeaders(map = {}) {
  return { get: (k) => (map[String(k).toLowerCase()] !== undefined ? map[String(k).toLowerCase()] : null) };
}

function headerNames(call) {
  return Object.keys(call[1].headers).map(k => k.toLowerCase());
}

describe('SegmentLengthService', () => {
  let service;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new SegmentLengthService({ maxSize: 10, autoProbe: false });
  });

  afterEach(() => {
    service.clear();
  });

  test('alignToTsPacket aligns bytes down to multiple of 188', () => {
    expect(service.alignToTsPacket(1000)).toBe(940); // 188 * 5 = 940
    expect(service.alignToTsPacket(188)).toBe(188);
    expect(service.alignToTsPacket(100)).toBe(188); // floor guard
  });

  test('local guarded capacity denial releases the probe without recording a CDN failure', async () => {
    safeFetch.mockRejectedValueOnce(Object.assign(new Error('Local capacity'), { code: 'ERR_OUTBOUND_CAPACITY' }));
    const svc = new SegmentLengthService({ maxSize: 10 });
    const url = 'https://cdn.example.com/capacity.image';
    expect(await svc.probeContentLength(url)).toBeNull();
    expect(svc.probeFailures.has(url)).toBe(false);
    expect(svc.activeProbes).toBe(0); expect(svc.inFlightProbes.size).toBe(0);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    svc.clear();
  });

  test.each([
    ['bare GET', []],
    ['gated GET', [403]],
    ['gated HEAD after refused GET', [403, 200]],
    ['bare HEAD', [200]],
    ['gated HEAD after refused HEAD', [200, 403]],
  ])('capacity denial on %s does not mark the CDN as failed', async (_label, statuses) => {
    for (const status of statuses) safeFetch.mockResolvedValueOnce({ status, headers: fakeHeaders() });
    safeFetch.mockRejectedValueOnce(Object.assign(new Error('Local capacity'), { code: 'ERR_OUTBOUND_CAPACITY' }));
    const url = 'https://cdn.example.com/capacity-attempt.image';
    expect(await service.probeContentLength(url)).toBeNull();
    expect(safeFetch).toHaveBeenCalledTimes(statuses.length + 1);
    for (const [, options] of safeFetch.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ guardExternal: true, attempts: 1, maxBodyBytes: 1024 }));
    }
    expect(service.probeFailures.has(url)).toBe(false);
    expect(service.cache.has(url)).toBe(false);
    expect(service.activeProbes).toBe(0);
    expect(service.inFlightProbes.size).toBe(0);
  });

  test('HEAD refusal retries guarded HEAD with provider headers', async () => {
    safeFetch.mockResolvedValueOnce({ status: 200, headers: fakeHeaders() })
      .mockResolvedValueOnce({ status: 403, headers: fakeHeaders() })
      .mockResolvedValueOnce({ status: 200, headers: fakeHeaders({ 'content-length': '1000042' }) });
    const url = 'https://cdn.example.com/head-gated.image';
    expect(await service.probeContentLength(url, { referer: 'https://provider.example/' })).toBe(1000000);
    expect(safeFetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'HEAD', 'HEAD']);
    expect(headerNames(safeFetch.mock.calls[1])).not.toContain('referer');
    expect(safeFetch.mock.calls[2][1].headers.Referer).toBe('https://provider.example/');
    expect(safeFetch.mock.calls.every(([, options]) => options.guardExternal === true)).toBe(true);
  });

  test('returns cached length if available and not expired', () => {
    const url = 'https://cdn.example.com/chunk_1.image';
    service.setCachedLength(url, 500000);

    const length = service.getSegmentLength(url);
    expect(length).toBe(500000);
  });

  test('returns an over-declared estimate based on duration and bitrate when not cached', () => {
    const url = 'https://cdn.example.com/chunk_uncached.image';
    // 6 seconds @ 4,000,000 bps = 3,000,000 bytes of payload.
    // Padded by 1.5 => 4,500,000; minus 42 = 4,499,958; aligned: 23935 * 188.
    const length = service.getSegmentLength(url, { duration: 6.0, bitrate: 4000000 });
    expect(length).toBe(4499780);
    expect(length % 188).toBe(0);
    // An estimate must never land below the un-padded size: a short range
    // truncates the chunk tail mid-GOP and the decoder cuts the last frame.
    expect(length).toBeGreaterThanOrEqual(3000000);
  });

  test('returns an over-declared default fallback when duration is not provided', () => {
    const url = 'https://cdn.example.com/chunk_unknown.image';
    // 1,022,720 * 1.5 = 1,534,080 minus 42 = 1,534,038, aligned: 8159 * 188.
    const length = service.getSegmentLength(url);
    expect(length).toBe(1533892);
    expect(length % 188).toBe(0);
  });

  test('probed true length replaces the estimate once cached', async () => {
    const url = 'https://cdn.example.com/chunk_probed.image';
    safeFetch.mockResolvedValueOnce({
      status: 206,
      headers: fakeHeaders({ 'content-range': 'bytes 0-0/3535338' })
    });

    const svc = new SegmentLengthService({ maxSize: 10 }); // autoProbe on
    const estimate = svc.getSegmentLength(url, { duration: 3.84 });
    expect(estimate % 188).toBe(0);

    const probed = await svc.inFlightProbes.get(url);
    expect(probed).toBe(3535338 - 42); // true payload excluding the 42-byte cloak

    expect(svc.getSegmentLength(url, { duration: 3.84 })).toBe(3535338 - 42);
    expect(svc.cache.get(url).length).toBe(3535338 - 42);
  });

  test('probes the way the player does: no Referer on the first request', async () => {
    const url = 'https://cdn.example.com/chunk_bare.image';
    safeFetch.mockResolvedValueOnce({
      status: 206,
      headers: fakeHeaders({ 'content-range': 'bytes 0-0/2135338' })
    });

    await service.probeContentLength(url, {
      referer: 'https://embedindia.st/',
      origin: 'https://embedindia.st'
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(headerNames(safeFetch.mock.calls[0])).not.toContain('referer');
    expect(safeFetch.mock.calls[0][1].headers.Range).toBe('bytes=0-0');
  });

  test('retries with the provider Referer only when the bare probe is refused', async () => {
    const url = 'https://cdn.example.com/chunk_gated.image';
    safeFetch
      .mockResolvedValueOnce({ status: 403, headers: fakeHeaders({}) })
      .mockResolvedValueOnce({
        status: 206,
        headers: fakeHeaders({ 'content-range': 'bytes 0-0/3000042' })
      });

    const probed = await service.probeContentLength(url, {
      referer: 'https://embedindia.st/',
      origin: 'https://embedindia.st'
    });

    expect(probed).toBe(3000000);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(headerNames(safeFetch.mock.calls[0])).not.toContain('referer');
    expect(safeFetch.mock.calls[1][1].headers.Referer).toBe('https://embedindia.st/');
    expect(safeFetch.mock.calls[1][1].method).toBe('GET');
  });

  test('falls back to HEAD when the ranged GET carries no Content-Range', async () => {
    const url = 'https://cdn.example.com/chunk_head.image';
    safeFetch
      .mockResolvedValueOnce({ status: 200, headers: fakeHeaders({}) })
      .mockResolvedValueOnce({ status: 200, headers: fakeHeaders({ 'content-length': '2000042' }) });

    const svc = new SegmentLengthService({ maxSize: 10 });
    const probed = await svc.probeContentLength(url, { duration: 3.84 });

    expect(probed).toBe(2000042 - 42);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls[0][1].method).toBe('GET');
    expect(safeFetch.mock.calls[0][1].headers.Range).toBe('bytes=0-0');
    expect(safeFetch.mock.calls[1][1].method).toBe('HEAD');
  });

  test('full 200 range fallback reads at most 1 KiB and still uses full object metadata', async () => {
    const url = 'https://cdn.example.com/ignores-range.image';
    safeFetch.mockResolvedValueOnce({
      status: 200,
      bodyTruncated: true,
      headers: fakeHeaders({ 'content-length': '5000042' }),
    });
    const size = await service.probeContentLength(url);
    expect(size).toBe(5000000);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'GET',
      maxBodyBytes: 1024,
      attempts: 1,
    }));
  });

  test('206 Content-Range total is accepted with the capped ranged body', async () => {
    const url = 'https://cdn.example.com/ranged.image';
    safeFetch.mockResolvedValueOnce({
      status: 206,
      headers: fakeHeaders({ 'content-range': 'bytes 0-0/6000042', 'content-length': '1' }),
    });
    expect(await service.probeContentLength(url)).toBe(6000000);
    expect(safeFetch.mock.calls[0][1].maxBodyBytes).toBe(1024);
  });

  test('a rejected ranged probe never treats an error-page length as segment size', async () => {
    const url = 'https://cdn.example.com/access-denied.image';
    safeFetch
      .mockResolvedValueOnce({ status: 403, headers: fakeHeaders({ 'content-length': '9990042' }) })
      .mockResolvedValueOnce({ status: 200, headers: fakeHeaders({ 'content-length': '2000042' }) });
    expect(await service.probeContentLength(url)).toBe(2000000);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: 'GET',
      maxBodyBytes: 1024,
    }));
    expect(service.getSegmentLength(url)).toBe(2000000);
  });

  test('partial 206 Content-Length without Content-Range is not a full object length', async () => {
    const url = 'https://cdn.example.com/partial-without-total.image';
    safeFetch
      .mockResolvedValueOnce({ status: 206, headers: fakeHeaders({ 'content-length': '65536' }) })
      .mockResolvedValueOnce({ status: 200, headers: fakeHeaders({ 'content-length': '3333042' }) });
    expect(await service.probeContentLength(url)).toBe(3333000);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  test('a failed HEAD error page cannot poison the segment length cache', async () => {
    const url = 'https://cdn.example.com/head-denied.image';
    safeFetch
      .mockResolvedValueOnce({ status: 403, headers: fakeHeaders({ 'content-length': '5000042' }) })
      .mockResolvedValueOnce({ status: 403, headers: fakeHeaders({ 'content-length': '6000042' }) })
      .mockResolvedValueOnce({ status: 403, headers: fakeHeaders({ 'content-length': '7000042' }) })
      .mockResolvedValueOnce({ status: 403, headers: fakeHeaders({ 'content-length': '8000042' }) });
    expect(await service.probeContentLength(url)).toBeNull();
    expect(service.hasValidLength(url)).toBe(false);
    expect(service.probeFailures.has(url)).toBe(true);
    // bare GET -> gated GET -> gated HEAD, all refused.
    expect(safeFetch).toHaveBeenCalledTimes(3);
  });

  test('a failed probe caches NOTHING and suppresses re-probing briefly', async () => {
    const url = 'https://cdn.example.com/chunk_dead.image';
    safeFetch.mockRejectedValue(new Error('cdn blocked'));

    const svc = new SegmentLengthService({ maxSize: 10 });
    const estimate = svc.getSegmentLength(url, { duration: 3.84 });
    await svc.inFlightProbes.get(url);

    expect(estimate % 188).toBe(0);
    expect(svc.cache.size).toBe(0); // estimate must NOT be cached as truth
    expect(svc.probeFailures.has(url)).toBe(true);

    // Next call within the retry window reuses the estimate without probing.
    safeFetch.mockClear();
    svc.getSegmentLength(url, { duration: 3.84 });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('evicts oldest entries when cache reaches capacity', () => {
    for (let i = 0; i < 12; i++) {
      service.setCachedLength(`https://cdn.example.com/chunk_${i}.image`, 100000 + i);
    }
    expect(service.cache.size).toBeLessThanOrEqual(10);
  });

  test('caps concurrent probes and releases slots when a probe resolves', async () => {
    const svc = new SegmentLengthService({ maxSize: 10, maxConcurrentProbes: 2 });
    const pending = [];
    safeFetch.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));

    const firstUrl = 'https://cdn.example.com/chunk_limit_1.image';
    const secondUrl = 'https://cdn.example.com/chunk_limit_2.image';
    const rejectedUrl = 'https://cdn.example.com/chunk_limit_3.image';
    const nextUrl = 'https://cdn.example.com/chunk_limit_4.image';
    const okResponse = {
      status: 206,
      headers: fakeHeaders({ 'content-range': 'bytes 0-0/500042' })
    };

    const first = svc.probeContentLength(firstUrl);
    const second = svc.probeContentLength(secondUrl);
    expect(svc.activeProbes).toBe(2);
    expect(pending).toHaveLength(2);

    await expect(svc.probeContentLength(rejectedUrl)).resolves.toBeNull();
    expect(svc.activeProbes).toBe(2);
    expect(pending).toHaveLength(2);
    expect(svc.inFlightProbes.has(rejectedUrl)).toBe(false);
    expect(svc.probeFailures.has(rejectedUrl)).toBe(false);

    pending[0](okResponse);
    await expect(first).resolves.toBe(500000);
    expect(svc.activeProbes).toBe(1);

    const next = svc.probeContentLength(nextUrl);
    expect(svc.activeProbes).toBe(2);
    expect(pending).toHaveLength(3);

    pending[1](okResponse);
    pending[2](okResponse);
    await expect(Promise.all([second, next])).resolves.toEqual([500000, 500000]);
    expect(svc.activeProbes).toBe(0);
  });

  test('releases the active probe slot when safeFetch fails', async () => {
    const svc = new SegmentLengthService({ maxSize: 10, maxConcurrentProbes: 1 });
    safeFetch.mockRejectedValue(new Error('network failure'));

    await expect(svc.probeContentLength('https://cdn.example.com/chunk_error.image')).resolves.toBeNull();
    expect(svc.activeProbes).toBe(0);
  });
});
