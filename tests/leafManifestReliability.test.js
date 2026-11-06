'use strict';

// Actual route/cache logic; the in-memory router and outbound seam never listen
// or load a provider, native transport, worker, or external resource.
const mockGet = jest.fn();
const mockSafeFetch = jest.fn();
const mockMint = { mintUrl: jest.fn(), invalidate: jest.fn(), noteFailure: jest.fn() };
jest.mock('express', () => ({ Router: () => ({ get: mockGet }) }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: mockSafeFetch }));
jest.mock('../src/services/LeafMint', () => mockMint);

const originalEnv = { ...process.env };
const initialNow = 1800000000000;
const target = 'https://papacito.cfd/m3u/fixture/live.m3u8?ft=original%2Ftoken';
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://w1.papacito.cfd/leaf/fixture/seg.ts?a=hash%2Fone&t=two\n';
const upstream = (overrides = {}) => ({ ok: true, status: 200, url: target,
  text: jest.fn(async () => media), ...overrides });
const reply = () => ({ setHeader: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() });

let route, state, clock;
beforeEach(() => {
  jest.resetModules();
  process.env = { ...originalEnv, APP_SECRET: 'fixture-manifest-private-key' };
  for (const key of ['LEAF_API_URL', 'LEAF_API_ORIGIN', 'LEAF_INSTALL_CONFIG', 'LEAF_FREE_USER_ID',
    'LEAF_PREMIUM_TOKEN', 'LEAF_PREMIUM_PROFILE', 'LEAF_STATE_SECRET']) delete process.env[key];
  mockGet.mockReset();
  mockSafeFetch.mockReset();
  Object.values(mockMint).forEach(mock => mock.mockReset());
  mockMint.mintUrl.mockResolvedValue(target);
  clock = jest.spyOn(Date, 'now').mockReturnValue(initialNow);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  state = require('../src/services/LeafState');
  route = require('../src/routes/leafManifest');
});
afterEach(() => { process.env = { ...originalEnv }; jest.restoreAllMocks(); });

function handler(kind = 'state') {
  return mockGet.mock.calls[kind === 'state' ? 1 : 0][1];
}
function signedRequest(extra = {}) {
  return { params: { state: state.sign({ m: 'fixture', s: 'fixture' }) }, query: {}, ...extra };
}
function childRequest(output, params) {
  const link = output.split('\n').find(line => line.startsWith('/api/leaf/'));
  return { params, query: Object.fromEntries(new URL(link, 'https://fixture.invalid').searchParams) };
}
async function seedStale() {
  mockSafeFetch.mockResolvedValueOnce(upstream());
  await route.getOrFetchLiveManifest(target);
  const cached = route.manifestCache.get(target);
  cached.expiresAt = initialNow - 1;
  return cached;
}

describe('Leaf manifest transient outcomes and immutable fallback limits', () => {
  test.each([
    ['native pool capacity', { code: 'ERR_NATIVE_POOL_BUSY', isFatal: true }],
    ['outbound capacity', { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }],
    ['cancellation', { name: 'AbortError' }],
    ['nested timeout', { cause: Object.assign(new Error('private upstream URL'), { code: 'ETIMEDOUT' }) }],
    ['connection reset', { code: 'ECONNRESET' }],
  ])('%s returns retryable 503 and retains the minted credential', async (_label, fields) => {
    mockSafeFetch.mockRejectedValue(Object.assign(new Error('private upstream credential'), fields));
    const res = reply();
    await handler()(signedRequest(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '2');
    expect(mockMint.invalidate).not.toHaveBeenCalled();
    expect(mockMint.noteFailure).not.toHaveBeenCalled();
    expect(mockMint.mintUrl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res.send.mock.calls)).not.toMatch(/credential|upstream URL/);
  });

  test.each([500, 501, 502, 503, 504, 599])('HTTP%s does not become a permanent mint failure', async status => {
    mockSafeFetch.mockResolvedValue(upstream({ ok: false, status }));
    const res = reply();
    await handler()(signedRequest(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockMint.invalidate).not.toHaveBeenCalled();
    expect(mockMint.noteFailure).not.toHaveBeenCalled();
  });

  test.each([
    ['guard refusal', { code: 'ERR_OUTBOUND_BLOCKED' }],
    ['fatal transport refusal', { code: 'ERR_FIXTURE_FATAL', isFatal: true }],
    ['authorization denial', { upstreamStatus: 403 }],
    ['invalid body', { code: 'ERR_LEAF_MANIFEST_BODY' }],
  ])('a %s cause overrides a leafTransient timeout wrapper', async (_label, causeFields) => {
    await seedStale();
    const cause = Object.assign(new Error('private failure'), causeFields);
    const error = Object.assign(new Error('private wrapper'), { leafTransient: true, name: 'TimeoutError', cause });
    mockSafeFetch.mockRejectedValueOnce(error);
    await expect(route.getOrFetchLiveManifest(target)).rejects.toBe(error);
    expect(route.manifestCache.has(target)).toBe(false);
    mockSafeFetch.mockRejectedValueOnce(error);
    await handler()(signedRequest(), reply());
    expect(mockMint.invalidate).toHaveBeenCalledTimes(1);
    expect(mockMint.noteFailure).toHaveBeenCalledTimes(1);
  });

  test('capacity can use valid stale metadata without extending its original hard deadline', async () => {
    const cached = await seedStale();
    const hardDeadline = cached.staleUntil;
    clock.mockReturnValue(hardDeadline - 100);
    mockSafeFetch.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }));
    await expect(route.getOrFetchLiveManifest(target)).resolves.toBe(media);
    expect(cached.staleUntil).toBe(hardDeadline);
    expect(cached.expiresAt).toBe(hardDeadline);
    clock.mockReturnValue(hardDeadline + 1);
    mockSafeFetch.mockRejectedValueOnce(Object.assign(new Error('busy again'), { code: 'ERR_OUTBOUND_CAPACITY' }));
    await expect(route.getOrFetchLiveManifest(target)).rejects.toMatchObject({ code: 'ERR_OUTBOUND_CAPACITY' });
    expect(route.manifestCache.get(target).staleUntil).toBe(hardDeadline);
    expect(route.manifestCache.get(target).expiresAt).toBeLessThanOrEqual(hardDeadline);
  });

  test.each([
    ['invalid final URL', { url: 'https://private.example.test/playlist.m3u8' }, 'ERR_LEAF_MANIFEST_REDIRECT'],
    ['truncated body', { bodyTruncated: true }, 'ERR_LEAF_BODY_LIMIT'],
  ])('HTTP503 with %s stays hard despite available stale data', async (_label, fields, code) => {
    await seedStale();
    mockSafeFetch.mockResolvedValueOnce(upstream({ ok: false, status: 503, ...fields }));
    await expect(route.getOrFetchLiveManifest(target)).rejects.toMatchObject({ code });
    expect(route.manifestCache.has(target)).toBe(false);
  });

  test.each([['positive', 1000], ['fallback', 20000]])('%s cache cannot outlive the known ft JWT expiry', async (_label, ttl) => {
    const exp = (initialNow + ttl) / 1000;
    const jwt = `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
    const url = `https://papacito.cfd/m3u/fixture/live.m3u8?ft=${jwt}`;
    mockSafeFetch.mockResolvedValueOnce(upstream({ url }));
    await route.getOrFetchLiveManifest(url);
    const cached = route.manifestCache.get(url);
    expect(cached.expiresAt).toBeLessThanOrEqual(initialNow + ttl);
    expect(cached.staleUntil).toBe(initialNow + ttl);
    clock.mockReturnValue(initialNow + ttl);
    await expect(route.getOrFetchLiveManifest(url)).rejects.toMatchObject({ code: 'ERR_LEAF_TOKEN_EXPIRED' });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(route.manifestCache.has(url)).toBe(false);
  });

  test('a credential expiring during metadata fetch never becomes a success', async () => {
    const jwt = `header.${Buffer.from(JSON.stringify({ exp: (initialNow + 1000) / 1000 })).toString('base64url')}.signature`;
    const url = `https://papacito.cfd/m3u/fixture/live.m3u8?ft=${jwt}`;
    mockSafeFetch.mockImplementationOnce(async () => {
      clock.mockReturnValue(initialNow + 1000);
      return upstream({ url });
    });
    await expect(route.getOrFetchLiveManifest(url)).rejects.toMatchObject({ code: 'ERR_LEAF_TOKEN_EXPIRED' });
    expect(route.manifestCache.size).toBe(0);
  });

  test.each([
    ['seconds', '7', '7'],
    ['large value', '99999999', '600'],
    ['invalid', 'invalid', '30'],
    ['HTTP date', new Date(initialNow + 11000).toUTCString(), '11'],
  ])('HTTP429 exposes bounded Retry-After for %s through the legacy route', async (_label, value, expected) => {
    mockSafeFetch.mockResolvedValue(upstream({ ok: false, status: 429, headers: { get: () => value } }));
    const res = reply();
    await handler('legacy')({ query: { url: target }, url: '/api/leaf/manifest.m3u8' }, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expected);
    expect(mockMint.noteFailure).not.toHaveBeenCalled();
  });

  test('actual HTTP429 retains the valid mint and blocks manifest refetch until its Retry-After window', async () => {
    mockSafeFetch.mockResolvedValueOnce(upstream({ ok: false, status: 429, headers: { get: () => '120' } }));
    await handler()(signedRequest(), reply());
    clock.mockReturnValue(initialNow + 1000);
    const second = reply();
    await handler()(signedRequest(), second);
    expect(second.status).toHaveBeenCalledWith(503);
    expect(second.setHeader).toHaveBeenCalledWith('Retry-After', '119');
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockMint.invalidate).not.toHaveBeenCalled();
    expect(mockMint.noteFailure).not.toHaveBeenCalled();
    clock.mockReturnValue(initialNow + 120001);
    mockSafeFetch.mockResolvedValueOnce(upstream());
    const recovered = reply();
    await handler()(signedRequest(), recovered);
    expect(recovered.status).toHaveBeenCalledWith(200);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  test('HTTP429 cooldown outlasts stale eligibility without serving the expired fallback or renewing its hard deadline', async () => {
    const cached = await seedStale();
    const hardDeadline = cached.staleUntil;
    clock.mockReturnValue(hardDeadline - 100);
    mockSafeFetch.mockResolvedValueOnce(upstream({ ok: false, status: 429, headers: { get: () => '120' } }));
    await expect(route.getOrFetchLiveManifest(target)).resolves.toBe(media);
    expect(cached.staleUntil).toBe(hardDeadline);
    clock.mockReturnValue(hardDeadline + 1);
    await expect(route.getOrFetchLiveManifest(target)).rejects.toMatchObject({ upstreamStatus: 429, statusCode: 503 });
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    expect(cached.staleUntil).toBe(hardDeadline);
  });

  test('local capacity uses only a fixed two-second retry window', async () => {
    mockSafeFetch.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'ERR_OUTBOUND_CAPACITY', isFatal: true }));
    await expect(route.getOrFetchLiveManifest(target)).rejects.toMatchObject({ code: 'ERR_OUTBOUND_CAPACITY' });
    clock.mockReturnValue(initialNow + 1000);
    await expect(route.getOrFetchLiveManifest(target)).rejects.toMatchObject({ retryAfterMs: 1000 });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(initialNow + 2000);
    mockSafeFetch.mockResolvedValueOnce(upstream());
    await expect(route.getOrFetchLiveManifest(target)).resolves.toBe(media);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  test('an arbitrary upstream error code cannot print credentials in route logs', async () => {
    mockSafeFetch.mockRejectedValueOnce(Object.assign(new Error('private message'), {
      code: 'https://papacito.cfd/?ft=private-signed-credential'
    }));
    await handler()(signedRequest(), reply());
    expect(JSON.stringify(console.warn.mock.calls)).not.toMatch(/private|signed-credential/);
    expect(JSON.stringify(console.error.mock.calls)).not.toMatch(/private|signed-credential/);
  });
});

describe('Leaf HLS URI and signed-state context', () => {
  test('resolves segment, KEY, MAP, PART and protocol-relative URIs against the final playlist directory', () => {
    const input = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../keys/a.bin?k=one%2Ftwo"\n' +
      '#EXT-X-MAP:URI="init.mp4?a=one%2Btwo"\n#EXT-X-PART:URI="part.m4s?a=part"\n' +
      '#EXTINF:6,\nsegment.ts?a=signed%2Fhash&t=123\n#EXTINF:6,\n/root.ts?a=root\n' +
      '#EXTINF:6,\n//cdn.example.test/path.ts?a=direct\n';
    const output = route.sanitizeManifestBody(input, 'https://papacito.cfd/redirected/channel/live.m3u8?ft=private');
    expect(output).toContain('URI="https://papacito.cfd/redirected/keys/a.bin?k=one%2Ftwo"');
    expect(output).toContain('URI="https://papacito.cfd/redirected/channel/init.mp4?a=one%2Btwo"');
    expect(output).toContain('URI="https://papacito.cfd/redirected/channel/part.m4s?a=part"');
    expect(output).toContain('https://papacito.cfd/redirected/channel/segment.ts?a=signed%2Fhash&t=123');
    expect(output).toContain('https://papacito.cfd/root.ts?a=root');
    expect(output).toContain('https://cdn.example.test/path.ts?a=direct');
    expect(output).not.toContain('ft=private');
    expect(output).not.toContain('/api/leaf/');
  });

  test('preserves child queries, inherits ft only on the same origin, and does not treat I-FRAME URI as the next segment', () => {
    const base = 'https://papacito.cfd/m3u/channel/master.m3u8?ft=raw%2ftoken';
    const input = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8?lang=en"\n' +
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8?ft=child%2Ftoken"\n' +
      '#EXTINF:6,\nsegment.ts?a=direct\n#EXT-X-STREAM-INF:BANDWIDTH=2\nvideo.m3u8?x=one%2Btwo\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=3\nhttps://other.papacito.cfd/foreign.m3u8?x=one\n';
    const output = route.sanitizeManifestBody(input, base);
    const proxy = url => '/api/leaf/manifest.m3u8?url=' + encodeURIComponent(url);
    expect(output).toContain(proxy('https://papacito.cfd/m3u/channel/audio.m3u8?lang=en&ft=raw%2ftoken'));
    expect(output).toContain(proxy('https://papacito.cfd/m3u/channel/iframe.m3u8?ft=child%2Ftoken'));
    expect(output).toContain(proxy('https://papacito.cfd/m3u/channel/video.m3u8?x=one%2Btwo&ft=raw%2ftoken'));
    expect(output).toContain(proxy('https://other.papacito.cfd/foreign.m3u8?x=one'));
    expect(output).toContain('\nhttps://papacito.cfd/m3u/channel/segment.ts?a=direct\n');
  });

  test('child playlist proxies retain signed application state and direct media URLs', async () => {
    const req = signedRequest();
    mockSafeFetch.mockResolvedValueOnce(upstream({ text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n' }));
    const first = reply();
    await handler()(req, first);
    const output = first.send.mock.calls[0][0];
    const childUrl = `https://papacito.cfd/m3u/fixture/child.m3u8?ft=original%2Ftoken`;
    expect(output).toContain(`/api/leaf/m3u8/${req.params.state}/index.m3u8?url=${encodeURIComponent(childUrl)}`);
    mockSafeFetch.mockResolvedValueOnce(upstream({ url: childUrl }));
    const second = reply();
    await handler()(childRequest(output, req.params), second);
    expect(second.send).toHaveBeenCalledWith(media);
    expect(mockSafeFetch.mock.calls[1][0]).toBe(childUrl);
    expect(mockMint.mintUrl).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['CDN split', 'https://east.papacito.cfd/m3u/fixture/child.m3u8?ft=own%2Fcredential', target],
    ['another directory', 'https://papacito.cfd/variants/child.m3u8?ft=own%2Fcredential', target],
    ['redirected parent', 'https://papacito.cfd/redirected/child.m3u8?ft=own%2Fcredential', 'https://papacito.cfd/redirected/master.m3u8?ft=own%2Fcredential']
  ])('%s keeps the guarded legacy child route rather than an unusable state link', async (_kind, childUrl, finalUrl) => {
    mockSafeFetch.mockResolvedValueOnce(upstream({ url: finalUrl,
      text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n' + childUrl + '\n' }));
    const res = reply();
    await handler()(signedRequest(), res);
    const body = res.send.mock.calls[0][0];
    expect(body).toContain(`/api/leaf/manifest.m3u8?url=${encodeURIComponent(childUrl)}`);
    expect(body).not.toContain('/api/leaf/m3u8/');
    mockSafeFetch.mockResolvedValueOnce(upstream({ url: childUrl }));
    const childReply = reply();
    await handler('legacy')({ query: { url: childUrl } }, childReply);
    expect(childReply.status).toHaveBeenCalledWith(200);
    expect(mockSafeFetch.mock.calls[1][0]).toBe(childUrl);
  });

  test('state context rewrites rendition URI attributes while preserving absolute CDN segment bytes', async () => {
    const req = signedRequest();
    mockSafeFetch.mockResolvedValueOnce(upstream({ text: async () => '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n' }));
    const res = reply();
    await handler()(req, res);
    expect(res.send.mock.calls[0][0]).toContain(`URI="/api/leaf/m3u8/${req.params.state}/index.m3u8?url=`);
    const other = 'https://papacito.cfd/m3u/other/live.m3u8?ft=another';
    const absoluteMedia = '#EXTM3U\n#EXTINF:6,\nhttps://east.papacito.cfd/api/leaf/manifest.m3u8?url=unchanged%2Fsegment\n';
    mockSafeFetch.mockResolvedValueOnce(upstream({ url: other, text: async () => absoluteMedia }));
    await expect(route.getOrFetchLiveManifest(other, { stateToken: req.params.state })).resolves.toBe(absoluteMedia);
  });

  test('independently issued viewer states share one parent fetch and each keeps its own child context', async () => {
    const firstReq = signedRequest();
    clock.mockReturnValue(initialNow + 1);
    const secondReq = signedRequest();
    const firstRes = reply(), secondRes = reply();
    mockSafeFetch.mockResolvedValue(upstream({ text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n' }));
    await Promise.all([handler()(firstReq, firstRes), handler()(secondReq, secondRes)]);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(firstRes.send.mock.calls[0][0]).toContain(`/api/leaf/m3u8/${firstReq.params.state}/`);
    expect(secondRes.send.mock.calls[0][0]).toContain(`/api/leaf/m3u8/${secondReq.params.state}/`);
    expect(firstReq.params.state).not.toBe(secondReq.params.state);
  });

  test('an inherited child credential refreshes from the same channel mint without replacing child query bytes', async () => {
    const req = signedRequest();
    mockSafeFetch.mockResolvedValueOnce(upstream({ text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8?x=one%2Btwo\n' }));
    const res = reply();
    await handler()(req, res);
    const child = childRequest(res.send.mock.calls[0][0], req.params);
    expect(child.query.f).toBe('1');
    mockMint.mintUrl.mockResolvedValueOnce('https://papacito.cfd/m3u/fixture/live.m3u8?ft=fresh%2Ftoken');
    const freshChild = 'https://papacito.cfd/m3u/fixture/child.m3u8?x=one%2Btwo&ft=fresh%2Ftoken';
    mockSafeFetch.mockResolvedValueOnce(upstream({ url: freshChild }));
    await handler()(child, reply());
    expect(mockSafeFetch.mock.calls[1][0]).toBe(freshChild);
    expect(mockMint.mintUrl.mock.calls.every(args => args.length === 2)).toBe(true);
  });

  test('an independently signed child keeps its own ft when the root is minted again', async () => {
    const req = signedRequest();
    mockSafeFetch.mockResolvedValueOnce(upstream({ text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8?ft=independent%2Ftoken\n' }));
    const res = reply();
    await handler()(req, res);
    const child = childRequest(res.send.mock.calls[0][0], req.params);
    expect(child.query.f).toBeUndefined();
    mockMint.mintUrl.mockResolvedValueOnce('https://papacito.cfd/m3u/fixture/live.m3u8?ft=fresh%2Ftoken');
    mockSafeFetch.mockResolvedValueOnce(upstream({ url: child.query.url }));
    await handler()(child, reply());
    expect(mockSafeFetch.mock.calls[1][0]).toBe(child.query.url);
  });

  test('a child from an earlier install fails before mint or manifest I/O', async () => {
    process.env.LEAF_INSTALL_CONFIG = 'fixture-first-install';
    const req = signedRequest();
    mockSafeFetch.mockResolvedValueOnce(upstream({ text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n' }));
    const res = reply();
    await handler()(req, res);
    const child = childRequest(res.send.mock.calls[0][0], req.params);
    process.env.LEAF_INSTALL_CONFIG = 'fixture-second-install';
    const second = reply();
    await handler()(child, second);
    expect(second.status).toHaveBeenCalledWith(400);
    expect(mockMint.mintUrl).toHaveBeenCalledTimes(1);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['other channel', 'https://papacito.cfd/m3u/another-channel/child.m3u8?ft=own'],
    ['other origin', 'https://east.papacito.cfd/m3u/fixture/child.m3u8?ft=own'],
  ])('an unsupported %s child fails closed without fetching it', async (_label, url) => {
    const req = signedRequest();
    mockSafeFetch.mockResolvedValueOnce(upstream({ text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n' }));
    const res = reply();
    await handler()(req, res);
    const child = childRequest(res.send.mock.calls[0][0], req.params);
    child.query.url = url;
    const second = reply();
    await handler()(child, second);
    expect(second.status).toHaveBeenCalledWith(400);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockMint.invalidate).not.toHaveBeenCalled();
  });

  test('keeps the legacy synthetic route and parser exports compatible', async () => {
    const payload = { cdnBase: 'https://w1.papacito.cfd', slug: 'fixture', session: '123', edge: 4,
      targetDuration: 6, at: initialNow, discontinuitySeq: 1 };
    const res = reply();
    await handler('legacy')({ query: { d: Buffer.from(JSON.stringify(payload)).toString('base64url') } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send.mock.calls[0][0]).toContain('https://w1.papacito.cfd/leaf/fixture/123/seg_4.ts');
    expect(route.parseUpstreamManifest('#EXTM3U\nhttps://w1.papacito.cfd/leaf/fixture/123/seg_4.ts', target))
      .toMatchObject({ cdnBase: payload.cdnBase, slug: 'fixture', session: '123', edge: 4 });
    expect(route.parseUpstreamManifest('#EXTM3U\n/leaf/fixture/123/seg_4.ts', 'https://east.papacito.cfd/live.m3u8'))
      .toMatchObject({ slug: 'fixture', session: '123', edge: 4 });
    expect(route.sanitizeManifestBody('#EXTM3U\n#EXTINF:6,\nsegment.ts?a=original'))
      .toContain('https://w1.papacito.cfd/segment.ts?a=original');
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});

describe('Leaf manifest account scope and bounded concurrent work', () => {
  test('same URL is fetched independently after an account change and uses the selected premium origin', async () => {
    process.env.LEAF_PREMIUM_TOKEN = '11111111-1111-4111-8111-111111111111';
    process.env.LEAF_API_ORIGIN = 'https://premium-eu1.highfly.to';
    mockSafeFetch.mockResolvedValue(upstream());
    await route.getOrFetchLiveManifest(target);
    await route.getOrFetchLiveManifest(target);
    process.env.LEAF_PREMIUM_TOKEN = '22222222-2222-4222-8222-222222222222';
    await route.getOrFetchLiveManifest(target);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    for (const [, options] of mockSafeFetch.mock.calls) {
      expect(options.headers).toMatchObject({ Origin: 'https://premium-eu1.highfly.to', Referer: 'https://premium-eu1.highfly.to/' });
    }
  });

  test('changing only an unconfigured API origin also changes the manifest cache scope', async () => {
    mockSafeFetch.mockResolvedValue(upstream());
    await route.getOrFetchLiveManifest(target);
    process.env.LEAF_API_ORIGIN = 'https://sports.highfly.dev';
    await route.getOrFetchLiveManifest(target);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    expect(mockSafeFetch.mock.calls[1][1].headers.Origin).toBe('https://sports.highfly.dev');
  });

  test('a hard failure settles against its original account after configuration changes', async () => {
    process.env.LEAF_INSTALL_CONFIG = 'fixture-first-install';
    const originalBase = require('../src/services/LeafInstallConfig').resolveLeafInstallConfig().apiBase;
    mockSafeFetch.mockImplementationOnce(async () => {
      process.env.LEAF_INSTALL_CONFIG = 'fixture-second-install';
      return upstream({ ok: false, status: 403 });
    });
    await handler()(signedRequest(), reply());
    expect(mockMint.invalidate).toHaveBeenCalledWith('fixture', 'fixture', { base: originalBase });
    expect(mockMint.noteFailure).toHaveBeenCalledWith('fixture', 'fixture', expect.objectContaining({ base: originalBase }));
  });

  test('bounds distinct pending fetches while still coalescing a matching request and releasing all slots', async () => {
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    mockSafeFetch.mockImplementation(() => gate);
    const urls = Array.from({ length: 128 }, (_, i) => `https://papacito.cfd/m3u/fixture-${i}/live.m3u8`);
    const pending = urls.map(url => route.getOrFetchLiveManifest(url));
    const coalesced = route.getOrFetchLiveManifest(urls[0]);
    await expect(route.getOrFetchLiveManifest('https://papacito.cfd/m3u/overflow/live.m3u8'))
      .rejects.toMatchObject({ code: 'ERR_OUTBOUND_CAPACITY', statusCode: 503, retryAfterMs: 2000 });
    expect(mockSafeFetch).toHaveBeenCalledTimes(128);
    finish(upstream());
    await expect(Promise.all([...pending, coalesced])).resolves.toHaveLength(129);
    await expect(route.getOrFetchLiveManifest('https://papacito.cfd/m3u/after/live.m3u8')).resolves.toBe(media);
    expect(mockSafeFetch).toHaveBeenCalledTimes(129);
  });

  test('keeps at most 1000 successful metadata entries', async () => {
    mockSafeFetch.mockResolvedValue(upstream());
    for (let i = 0; i < 1001; i++) await route.getOrFetchLiveManifest(`https://papacito.cfd/m3u/cache-${i}/live.m3u8`);
    expect(route.manifestCache.size).toBe(1000);
    expect(route.manifestCache.has('https://papacito.cfd/m3u/cache-0/live.m3u8')).toBe(false);
  });

  test('rate-limit cooldown entries share the same 1000-entry bound', async () => {
    mockSafeFetch.mockResolvedValue(upstream({ ok: false, status: 429 }));
    for (let i = 0; i < 1001; i++) {
      await expect(route.getOrFetchLiveManifest(`https://papacito.cfd/m3u/limited-${i}/live.m3u8`))
        .rejects.toMatchObject({ upstreamStatus: 429 });
    }
    expect(route.manifestCache.size).toBe(1000);
    expect(route.manifestCache.has('https://papacito.cfd/m3u/limited-0/live.m3u8')).toBe(false);
  });
});
