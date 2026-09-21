'use strict';

// The regression being pinned: verifyStreams repaired a 403/401 only when the
// Referer was ABSENT. DaddyLive always populates a Referer, so the case that
// actually happens in production — a Referer present but from the wrong family,
// because the iframe that served the manifest is not on the segment CDN's
// allow-list — fell straight through to "dropped dead stream" and
// negative-cached a source that plays fine.
//
// The repair is now driven by the TERMINAL host of the upstream URL (the
// iframe-domain registry first, the hard-coded host-regex chain second) and
// still runs at most ONCE, so a genuinely dead stream costs one extra ping
// rather than a retry loop.
//
// The pre-existing rule is pinned too: a 403 with no Referer available at all
// is not proof of a dead stream, so the stream is KEPT.

jest.mock('../src/impitClient', () => ({
  safeFetch: jest.fn(),
  isImpitAvailable: () => false,
  getImpit: () => null,
}));

const { safeFetch } = require('../src/impitClient');
const { verifyStreams } = require('../src/streams');
const M3U8ParserService = require('../src/services/M3U8ParserService');
const container = require('../src/container');

const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXTINF:4.0,\nseg0.ts\n';

// Recorded Referer for the 7odxv0l067ka.net terminal family.
const REGISTRY_REFERER = 'https://assetrage.net/';
// A Referer that is present but from a family the CDN refuses.
const WRONG_FAMILY_REFERER = 'https://wrong-family.example/';
// The manifest's terminal host: a rotating node prefix on the known family.
const TERMINAL_TARGET = 'https://c2807p.7odxv0l067ka.net/hls/live/302.m3u8?token=t&e=1770000000';

const ok = (body = PLAYLIST) => ({ status: 200, text: async () => body });
const status = (code) => ({ status: code, text: async () => 'error' });

const parser = new M3U8ParserService();

function makeCache() {
  return {
    failures: 0,
    successes: 0,
    noteFailure() { this.failures++; },
    noteSuccess() { this.successes++; },
  };
}

// A successful ranged segment response for the speed probe.
const segmentResponse = () => ({
  ok: true,
  arrayBuffer: async () => Buffer.alloc(200000).buffer,
  headers: { get: () => 'bytes 0-199999/4084906' },
});

// A stream exactly as DaddyLiveProvider emits it: the upstream URL, the Referer
// and the Origin ride on the proxy URL, and the same Referer is repeated in the
// behaviour hints.
function proxiedStream(targetUrl, referer) {
  const origin = referer ? referer.replace(/\/$/, '') : '';
  const url = 'http://addon.local/api/manifest'
    + `?url=${encodeURIComponent(targetUrl)}`
    + `&referer=${encodeURIComponent(referer)}`
    + `&origin=${encodeURIComponent(origin)}`;
  return {
    url,
    name: 'DaddyLive',
    title: 'DaddyLive (Test Channel)',
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: { request: { Referer: referer, Origin: origin } },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue(segmentResponse());
});

describe('verifyStreams — 403/401 repair with a Referer already present', () => {
  test('retries once with the terminal-host Referer and keeps a stream that then serves 200', async () => {
    safeFetch.mockImplementation(async (url, opts) => (
      opts.headers.Referer === REGISTRY_REFERER ? ok() : status(403)
    ));

    const cache = makeCache();
    const s = proxiedStream(TERMINAL_TARGET, WRONG_FAMILY_REFERER);
    const out = await verifyStreams([s], 'daddylive:m1:s1', parser, cache);

    expect(out).toHaveLength(1);
    expect(out[0]).toBe(s);

    // One ping, one repair — not a loop.
    expect(safeFetch).toHaveBeenCalledTimes(2);
    // The first ping sent the Referer the stream came with...
    expect(safeFetch.mock.calls[0][1].headers.Referer).toBe(WRONG_FAMILY_REFERER);
    // ...and the repair used the terminal host's own Referer instead.
    expect(safeFetch.mock.calls[1][1].headers.Referer).toBe(REGISTRY_REFERER);
    expect(safeFetch.mock.calls[1][1].headers.Origin).toBe('https://assetrage.net');
    // A repaired stream is a success, not a failure to negative-cache.
    expect(cache.failures).toBe(0);
    expect(cache.successes).toBe(1);
  });

  test('consults the registry for the repair, not just the host-regex chain', async () => {
    // A terminal host that only the registry knows about: the hard-coded chain
    // would fall back to `https://<host>/`, which is a different answer.
    const registry = container.resolve('iframeDomainRegistry');
    const host = 'registry-only.example';
    const registryReferer = 'https://registry-only-referer.example/';
    registry.terminalHosts.set(host, { referer: registryReferer });

    try {
      safeFetch.mockImplementation(async (url, opts) => (
        opts.headers.Referer === registryReferer ? ok() : status(403)
      ));

      const cache = makeCache();
      const out = await verifyStreams(
        [proxiedStream(`https://${host}/live/302.m3u8`, WRONG_FAMILY_REFERER)],
        'daddylive:m1:s2',
        parser,
        cache
      );

      expect(out).toHaveLength(1);
      expect(safeFetch).toHaveBeenCalledTimes(2);
      expect(safeFetch.mock.calls[1][1].headers.Referer).toBe(registryReferer);
      expect(cache.failures).toBe(0);
    } finally {
      registry.terminalHosts.delete(host);
    }
  });

  test('retries at most once — a stream that keeps refusing is dropped, not re-pinged', async () => {
    safeFetch.mockResolvedValue(status(403));

    const cache = makeCache();
    const out = await verifyStreams(
      [proxiedStream('https://cdn.unknown-family.example/live/302.m3u8', WRONG_FAMILY_REFERER)],
      'daddylive:m1:s3',
      parser,
      cache
    );

    expect(out).toHaveLength(0);
    // Initial ping + exactly one repair attempt, never a third.
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls[0][1].headers.Referer).toBe(WRONG_FAMILY_REFERER);
    // An unknown host falls through to the regex chain's generic self-origin.
    expect(safeFetch.mock.calls[1][1].headers.Referer).toBe('https://cdn.unknown-family.example/');
    expect(cache.failures).toBe(1);
  });

  test('keeps a 403 stream when no Referer is available at all', async () => {
    safeFetch.mockResolvedValue(status(403));

    const cache = makeCache();
    const bare = { url: 'https://edge.example/live.m3u8', name: '⚡ Direct Stream' };
    const out = await verifyStreams([bare], 'daddylive:m1:s4', parser, cache);

    expect(out).toHaveLength(1);
    expect(out[0]).toBe(bare);
    expect(safeFetch.mock.calls[0][1].headers.Referer).toBe('');
    expect(cache.failures).toBe(0);
  });
});
