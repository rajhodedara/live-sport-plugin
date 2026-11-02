'use strict';

// Actual route/cache logic with an in-memory router and guarded-I/O seam.
// No Express server, provider/native module, network or worker is started.
const mockGet = jest.fn();
const mockSafeFetch = jest.fn();
jest.mock('express', () => ({ Router: () => ({ get: mockGet }) }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: mockSafeFetch }));

const target = 'https://papacito.cfd/m3u/fixture/live.m3u8?ft=fixture%2Ftoken&x=one%2btwo';
const body = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://w1.papacito.cfd/leaf/fixture/seg.ts?a=original%2Fhash&exp=123\n';
const response = (overrides = {}) => ({ ok: true, status: 200, url: target,
  bodyTruncated: false, text: jest.fn().mockResolvedValue(body), ...overrides });

describe('new stable Leaf route retains guarded metadata delivery', () => {
  let route, handler;
  beforeEach(() => {
    jest.resetModules();
    mockGet.mockReset();
    mockSafeFetch.mockReset();
    route = require('../src/routes/leafManifest');
    handler = mockGet.mock.calls[0][1];
  });

  test.each([
    ['loopback', 'https://127.0.0.1/fixture.m3u8'],
    ['private IP', 'https://10.0.0.1/fixture.m3u8'],
    ['plain HTTP', 'http://papacito.cfd/m3u/fixture/live.m3u8'],
    ['credentials', 'https://user:secret@papacito.cfd/m3u/fixture/live.m3u8'],
    ['hostname suffix spoof', 'https://papacito.cfd.example.test/fixture.m3u8'],
    ['hostname in query only', 'https://example.test/?url=https://papacito.cfd/fixture.m3u8'],
    ['nonstandard port', 'https://papacito.cfd:8443/m3u/fixture/live.m3u8'],
    ['array query', [target, target]],
    ['missing value', undefined],
    ['control character', 'https://papacito.cfd/m3u/fixture/\nlive.m3u8'],
    ['oversized target', target + 'x'.repeat(16384)],
  ])('rejects %s before guarded I/O', async (_label, value) => {
    await expect(route.getOrFetchLiveManifest(value)).rejects.toMatchObject({ code: 'ERR_LEAF_MANIFEST_URL' });
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  test('preserves signed query and direct segment bytes while bounding metadata I/O', async () => {
    mockSafeFetch.mockResolvedValue(response());
    await expect(route.getOrFetchLiveManifest(target)).resolves.toBe(body);
    expect(mockSafeFetch).toHaveBeenCalledWith(target, expect.objectContaining({
      timeoutMs: 6000, maxBodyBytes: 256 * 1024, diagnosticOwner: 'manifest'
    }));
    expect(route.manifestCache.get(target).body).not.toContain('/api/leaf/manifest.m3u8?url=https%3A%2F%2Fw1');
  });

  test('allows intended subdomain playlists without rewriting their signed input', async () => {
    const subdomain = 'https://edge.papacito.cfd/m3u/fixture/child.m3u8?ft=fixture%2Ftoken';
    mockSafeFetch.mockResolvedValue(response({ url: subdomain }));
    await expect(route.getOrFetchLiveManifest(subdomain)).resolves.toBe(body);
    expect(mockSafeFetch.mock.calls[0][0]).toBe(subdomain);
  });

  test('uses the validated final manifest URL as the relative child base', async () => {
    const redirected = 'https://papacito.cfd/relocated/master.m3u8?ft=fixture';
    mockSafeFetch.mockResolvedValue(response({ url: redirected,
      text: jest.fn().mockResolvedValue('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8?ft=original%2Fquery\n') }));
    const output = await route.getOrFetchLiveManifest(target);
    expect(output).toContain('/api/leaf/manifest.m3u8?url=' + encodeURIComponent('https://papacito.cfd/relocated/child.m3u8?ft=original%2Fquery'));
  });

  test.each([
    ['outside Leaf', 'https://other.example.test/manifest.m3u8'],
    ['private', 'http://127.0.0.1/manifest.m3u8'],
  ])('rejects a mocked final redirect %s before reading its body', async (_label, url) => {
    const upstream = response({ url });
    mockSafeFetch.mockResolvedValue(upstream);
    await expect(route.getOrFetchLiveManifest(target)).rejects.toMatchObject({ code: 'ERR_LEAF_MANIFEST_REDIRECT' });
    expect(upstream.text).not.toHaveBeenCalled();
    expect(route.manifestCache.size).toBe(0);
  });

  test('truncated metadata is rejected before parsing or caching', async () => {
    const upstream = response({ bodyTruncated: true });
    mockSafeFetch.mockResolvedValue(upstream);
    await expect(route.getOrFetchLiveManifest(target)).rejects.toMatchObject({ code: 'ERR_LEAF_BODY_LIMIT' });
    expect(upstream.text).not.toHaveBeenCalled();
    expect(route.manifestCache.size).toBe(0);
  });

  test('coalesces concurrent fetches and reuses the short cache', async () => {
    let finish;
    mockSafeFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = route.getOrFetchLiveManifest(target);
    const second = route.getOrFetchLiveManifest(target);
    await Promise.resolve();
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    finish(response());
    await expect(Promise.all([first, second])).resolves.toEqual([body, body]);
    await expect(route.getOrFetchLiveManifest(target)).resolves.toBe(body);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  test('a transient HTTP503 may reuse stale data with a short backoff', async () => {
    mockSafeFetch.mockResolvedValueOnce(response());
    await route.getOrFetchLiveManifest(target);
    const cached = route.manifestCache.get(target);
    cached.expiresAt = Date.now() - 1;
    mockSafeFetch.mockResolvedValueOnce(response({ ok: false, status: 503 }));
    await expect(route.getOrFetchLiveManifest(target)).resolves.toBe(body);
    expect(cached.expiresAt).toBeGreaterThan(Date.now());
  });

  test.each([401, 403, 404])('HTTP%s stays a failure despite a stale manifest', async status => {
    mockSafeFetch.mockResolvedValueOnce(response());
    await route.getOrFetchLiveManifest(target);
    route.manifestCache.get(target).expiresAt = Date.now() - 1;
    mockSafeFetch.mockResolvedValueOnce(response({ ok: false, status }));
    await expect(route.getOrFetchLiveManifest(target)).rejects.toMatchObject({ code: 'ERR_LEAF_UPSTREAM_STATUS' });
    expect(route.manifestCache.has(target)).toBe(false);
  });

  test.each([
    ['guard rejection', Object.assign(new Error('fixture-only'), { code: 'ERR_OUTBOUND_BLOCKED' })],
    ['body limit', Object.assign(new Error('fixture-only'), { code: 'ERR_OUTBOUND_BODY_LIMIT' })],
    ['unknown error', new Error('fixture-only')],
  ])('%s does not become a stale success', async (_label, error) => {
    mockSafeFetch.mockResolvedValueOnce(response());
    await route.getOrFetchLiveManifest(target);
    route.manifestCache.get(target).expiresAt = Date.now() - 1;
    mockSafeFetch.mockRejectedValueOnce(error);
    await expect(route.getOrFetchLiveManifest(target)).rejects.toBe(error);
    expect(route.manifestCache.has(target)).toBe(false);
  });

  test('invalid upstream body does not become a stale success', async () => {
    mockSafeFetch.mockResolvedValueOnce(response());
    await route.getOrFetchLiveManifest(target);
    route.manifestCache.get(target).expiresAt = Date.now() - 1;
    mockSafeFetch.mockResolvedValueOnce(response({ text: jest.fn().mockResolvedValue('<html>#EXT not a manifest</html>') }));
    await expect(route.getOrFetchLiveManifest(target)).rejects.toMatchObject({ code: 'ERR_LEAF_MANIFEST_BODY' });
    expect(route.manifestCache.has(target)).toBe(false);
  });

  test('a synchronous guarded dependency failure cannot poison later requests', async () => {
    mockSafeFetch.mockImplementationOnce(() => { throw new Error('fixture-only synchronous failure'); });
    await expect(route.getOrFetchLiveManifest(target)).rejects.toThrow('fixture-only synchronous failure');
    mockSafeFetch.mockResolvedValueOnce(response());
    await expect(route.getOrFetchLiveManifest(target)).resolves.toBe(body);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  test('handler rejects invalid input without exposing target or fetch credentials', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const req = { query: { url: 'https://secret:credential@papacito.cfd/fixture.m3u8' }, url: '/api/leaf/manifest.m3u8' };
      const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockSafeFetch).not.toHaveBeenCalled();
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('credential');
      expect(JSON.stringify(res.send.mock.calls)).not.toContain('credential');
    } finally { errorSpy.mockRestore(); }
  });
});
