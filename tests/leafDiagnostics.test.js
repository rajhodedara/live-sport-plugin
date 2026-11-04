'use strict';

// Pure diagnostic runner with injected responses. No script, provider, native
// transport, worker or listener is started by this suite.
const {
  safeOrigin, tokenExpiry, diagnosticErrorCode, classifyPlaylist, runLeafDiagnostics
} = require('../src/services/LeafDiagnostics');

const install = 'private-install-blob';
const uid = 'private-user-identity';
const ip = '198.51.100.83';
const token = 'header.' + Buffer.from(JSON.stringify({ exp: 1900000000, uid, ip })).toString('base64url') + '.private-signature';
const playlistUrl = 'https://w2.papacito.cfd/leaf/private-session/index.m3u8?ft=' + token;
const base = 'https://api-user:api-password@sports.highfly.to/' + install;
const segmentAuth = 'private-segment-signature';
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n../segments/seg_1.ts?a=' + segmentAuth + '\n';
const config = {
  installConfigured: install,
  apiOverrideConfigured: base,
  leafProxyEnvPresent: 'socks5://proxy-user:proxy-password@proxy.example:1080',
  warpProxyEnvPresent: true,
  damiProxyEnvPresent: false
};
const jsonResponse = body => ({ status: 200, ok: true, json: async () => body });

function preparedFetch({ text = media, head = { status: 200, ok: true }, headError, finalUrl } = {}) {
  const safeFetch = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ metas: [{ id: 'private-probe-id', status: 'live' }, { id: 'leaf:channel' }] }))
    .mockResolvedValueOnce(jsonResponse({ streams: [{ url: playlistUrl }] }))
    .mockResolvedValueOnce({ status: 200, ok: true, url: finalUrl, text: async () => text });
  if (headError) safeFetch.mockRejectedValueOnce(headError); else safeFetch.mockResolvedValueOnce(head);
  return safeFetch;
}

function expectPrivateValuesAbsent(result) {
  const output = JSON.stringify(result);
  for (const value of [install, uid, ip, token, segmentAuth, 'private-session', 'private-probe-id', 'api-user', 'api-password', 'proxy-user', 'proxy-password']) {
    expect(output).not.toContain(value);
  }
}

test('reports only a safe HTTP origin, never URL credentials, base path, query or fragment', () => {
  expect(safeOrigin(base + '?secret=private#fragment')).toBe('https://sports.highfly.to');
  expect(safeOrigin('file:///private/config')).toBeNull();
  expect(safeOrigin('not a URL')).toBeNull();
});

test('extracts only an unverified numeric expiry and never exposes JWT identity claims', () => {
  expect(tokenExpiry(playlistUrl)).toBe(1900000000);
  const invalid = 'https://w2.papacito.cfd/x?ft=x.' + Buffer.from(JSON.stringify({ exp: uid, ip })).toString('base64url') + '.y';
  expect(tokenExpiry(invalid)).toBeNull();
  expect(tokenExpiry('https://w2.papacito.cfd/x?ft=malformed')).toBeNull();
});

test('only fixed diagnostic error codes can escape, never arbitrary codes or messages', () => {
  expect(diagnosticErrorCode(Object.assign(new Error(base), { code: 'SECRET_PROXY_PASSWORD' }))).toBe('ERR_LEAF_DIAGNOSTIC_REQUEST');
  expect(diagnosticErrorCode({ code: 'ERR_OUTBOUND_BLOCKED', message: playlistUrl })).toBe('ERR_OUTBOUND_BLOCKED');
  expect(diagnosticErrorCode({ code: 'ERR_NATIVE_POOL_BUSY' })).toBe('ERR_OUTBOUND_CAPACITY');
  expect(diagnosticErrorCode({ name: 'TimeoutError' })).toBe('ERR_LEAF_DIAGNOSTIC_TIMEOUT');
});

test('successful HEAD reports metadata reachability with playback explicitly NOT_RUN and no private values', async () => {
  const safeFetch = preparedFetch();
  const result = await runLeafDiagnostics({ base, config, safeFetch });
  expect(result).toMatchObject({
    ok: true, scope: 'metadata-only', playback: 'NOT_RUN',
    apiOrigin: 'https://sports.highfly.to', unverifiedTokenExpiry: 1900000000,
    verdict: 'METADATA_REACHABLE_PLAYBACK_NOT_RUN',
    config: { installConfigured: true, leafProxyEnvPresent: true },
    segment: { status: 200 }
  });
  expect(result.verdict).not.toContain('PASS');
  expectPrivateValuesAbsent(result);
  expect(safeFetch).toHaveBeenCalledTimes(4);
  expect(safeFetch.mock.calls.every(([, options]) => options.guardExternal === true)).toBe(true);
  expect(safeFetch.mock.calls[3][1]).toMatchObject({ method: 'HEAD' });
});

test('resolves relative segments against the final playlist URL without copying its token', async () => {
  const safeFetch = preparedFetch({ finalUrl: 'https://w3.papacito.cfd/redirected/session/index.m3u8?ft=redirect-token' });
  await runLeafDiagnostics({ base, config, safeFetch });
  expect(safeFetch.mock.calls[3][0]).toBe('https://w3.papacito.cfd/redirected/segments/seg_1.ts?a=' + segmentAuth);
  expect(safeFetch.mock.calls[3][0]).not.toContain('ft=');
});

test.each([
  { status: 403, ok: false }, { status: 503, ok: false },
  { status: 500, ok: true }, { status: 200, ok: false }, null
])('segment HEAD %j cannot claim successful metadata or playback', async head => {
  const safeFetch = preparedFetch({ head });
  const result = await runLeafDiagnostics({ base, config, safeFetch });
  expect(result.ok).toBe(false);
  expect(result.playback).toBe('NOT_RUN');
  expect(result.verdict).toBe('ERR_LEAF_DIAGNOSTIC_SEGMENT_STATUS');
  expectPrivateValuesAbsent(result);
});

test('a failed HEAD retains only its fixed error code and cannot pass from playlist lines', async () => {
  const safeFetch = preparedFetch({ headError: Object.assign(new Error('refused ' + playlistUrl + ' via proxy-password'), { code: 'ERR_OUTBOUND_BLOCKED' }) });
  const result = await runLeafDiagnostics({ base, config, safeFetch });
  expect(result).toMatchObject({ ok: false, playback: 'NOT_RUN', segment: { error: 'ERR_OUTBOUND_BLOCKED' } });
  expectPrivateValuesAbsent(result);
});

test.each([
  ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nchild.m3u8\n', 'MASTER_PLAYLIST_NOT_PROBED'],
  ['#EXTM3U\n#EXTINF:6,\nstream_notice/seg_1.ts?a=private-segment-signature\n', 'NOTICE_PLAYLIST'],
  ['#EXTM3U\n#EXTINF:6,\n_antipiracy/seg_1.ts\n', 'NOTICE_PLAYLIST'],
  ['#EXTM3U\n#EXTINF:6,\nsegment.m4s\n', 'NO_TS_SEGMENTS'],
  ['#EXTM3U\n', 'EMPTY_PLAYLIST'],
  ['<html>\nseg_1.ts\n</html>', 'INVALID_PLAYLIST']
])('playlist classification does not infer playback or expand fetching: %s', async (text, verdict) => {
  const safeFetch = preparedFetch({ text });
  const result = await runLeafDiagnostics({ base, config, safeFetch });
  expect(result).toMatchObject({ ok: false, playback: 'NOT_RUN', segment: null, verdict });
  expect(safeFetch).toHaveBeenCalledTimes(3);
  expectPrivateValuesAbsent(result);
});

test('playlist summary contains counts and classification without segment URLs', () => {
  expect(classifyPlaylist(media)).toMatchObject({ valid: true, kind: 'media', segments: 1, notice: false });
  expect(JSON.stringify(classifyPlaylist(media))).not.toContain(segmentAuth);
});

test('catalog failures retain a generic code without raw target, install or proxy details', async () => {
  const safeFetch = jest.fn().mockRejectedValue(new Error('failure for ' + base + ' via proxy-password'));
  const result = await runLeafDiagnostics({ base, config, safeFetch });
  expect(result).toMatchObject({ ok: false, catalogError: 'ERR_LEAF_DIAGNOSTIC_REQUEST', verdict: 'ERR_LEAF_DIAGNOSTIC_REQUEST' });
  expectPrivateValuesAbsent(result);
});

test('hostnames mentioned in query text are not admitted as Leaf manifest URLs', async () => {
  const safeFetch = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ metas: [{ id: 'private-probe-id' }] }))
    .mockResolvedValueOnce(jsonResponse({ streams: [{ url: 'https://unrelated.example/media.m3u8?next=papacito.cfd' }] }));
  const result = await runLeafDiagnostics({ base, config, safeFetch });
  expect(result).toMatchObject({ ok: false, papacitoUrls: 0, verdict: 'NO_MEDIA_URLS' });
  expect(safeFetch).toHaveBeenCalledTimes(2);
});


test.each([0, 1, 2])('truncated metadata at phase %i never becomes successful reachability', async phase => {
  const responses = [
    jsonResponse({ metas: [{ id: 'private-probe-id' }] }),
    jsonResponse({ streams: [{ url: playlistUrl }] }),
    { status: 200, ok: true, text: async () => media }
  ];
  responses[phase].bodyTruncated = true;
  const safeFetch = jest.fn();
  for (const response of responses) safeFetch.mockResolvedValueOnce(response);
  const result = await runLeafDiagnostics({ base, config, safeFetch });
  expect(result.ok).toBe(false);
  expect(result.segment).toBeNull();
  expect(result.playback).toBe('NOT_RUN');
  expect(safeFetch).toHaveBeenCalledTimes(phase + 1);
  expect(safeFetch.mock.calls.every(([, options]) => options.maxBodyBytes === 256 * 1024)).toBe(true);
  expectPrivateValuesAbsent(result);
});
