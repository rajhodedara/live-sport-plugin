'use strict';

// The regression being pinned: when a decoded manifest lives on a host the
// iframe-domain registry knows as a TERMINAL host, the Referer emitted for it
// must be the registry's — not one derived from whichever iframe happened to
// embed the decoder.
//
// Why it matters: resolveStream probes several folders per mirror domain and
// they do NOT reach the same iframe host. Only some of those families are on the
// segment CDN's Referer allow-list, so when the manifest came back through an
// unauthorised family (the classic "watch" fallback) every segment request was
// refused with 403 even though the manifest itself decoded fine. The registry
// holds the terminal host -> Referer mapping and is consulted first; the
// iframe-derived Referer stays as the fallback for hosts it has never seen.

const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');

// 7odxv0l067ka.net is a terminal host family in src/data/iframe_domains.json and
// its recorded Referer is assetrage.net. A rotating node prefix must still
// collapse onto that family.
const TERMINAL_MANIFEST = 'https://c2807p.7odxv0l067ka.net/hls/live/302.m3u8?token=live123&e=1770000000';
const REGISTRY_REFERER = 'https://assetrage.net/';

// A host no family in the knowledge base covers, so the registry has no opinion.
const UNKNOWN_MANIFEST = 'https://cdn.nobody-knows.example/hls/live/302.m3u8?token=live123';

const IFRAME_URL = 'https://tiestep.top/e/abc123xyz';
const IFRAME_REFERER = 'https://tiestep.top/';

// A known wrapper family that is still NOT the manifest's terminal family.
const KNOWN_WRAPPER_URL = 'https://streame.center/embed/302';
const KNOWN_WRAPPER_REFERER = 'https://streame.center/';

const playerHtml = (iframeUrl) => `<html><body><iframe src="${iframeUrl}"></iframe></body></html>`;
const EMBED_HTML = `<html><script>window._econfig='MOCK_ECONFIG_STRING';</script></html>`;

// Both carriers of the Referer must be readable to prove they agree.
function manifestQuery(url) {
  const u = new URL(url, 'http://localhost');
  return {
    target: u.searchParams.get('url'),
    referer: u.searchParams.get('referer'),
    origin: u.searchParams.get('origin'),
  };
}

describe('DaddyLiveProvider — Referer comes from the iframe-domain registry', () => {
  let provider;

  // Stub the network entirely: probe -> player page, embed fetch -> embed page.
  const stubNetwork = (iframeUrl) => {
    provider.proxyFetch = jest.fn(async (url) => {
      if (url.includes('/stream-')) return { ok: true, text: async () => playerHtml(iframeUrl) };
      return { ok: true, text: async () => EMBED_HTML };
    });
  };

  beforeEach(() => {
    provider = new DaddyLiveProvider({ circuitBreaker: new CircuitBreakerService() });
    // decodeEconfig has its own tests; here it only has to yield a manifest URL
    // so the Referer decision can be observed in isolation.
    provider.decodeEconfig = jest.fn().mockReturnValue({ stream_url: null });
    stubNetwork(IFRAME_URL);
  });

  test('emits the registry Referer, not the iframe-origin one, for a known terminal host', async () => {
    provider.decodeEconfig.mockReturnValue({ stream_url: TERMINAL_MANIFEST });

    const streams = await provider.resolveStream('302', 'football', 'Arsenal vs Chelsea', { channelName: 'A&E USA' });

    expect(streams).toHaveLength(1);
    const stream = streams[0];
    const q = manifestQuery(stream.url);

    expect(stream.url).toContain('/api/manifest?');
    expect(q.target).toBe(TERMINAL_MANIFEST);
    expect(q.referer).toBe(REGISTRY_REFERER);
    expect(q.origin).toBe('https://assetrage.net');
    expect(q.referer).not.toBe(IFRAME_REFERER);

    // The query string and the behaviour hints carry the same pair: the CDN sees
    // the query on the manifest request and the header on every segment request.
    expect(stream.behaviorHints.proxyHeaders.request.Referer).toBe(REGISTRY_REFERER);
    expect(stream.behaviorHints.proxyHeaders.request.Origin).toBe('https://assetrage.net');
    expect(q.referer).toBe(stream.behaviorHints.proxyHeaders.request.Referer);
    expect(q.origin).toBe(stream.behaviorHints.proxyHeaders.request.Origin);

    // A registry-known terminal host is taken as final, so the folder scan stops
    // there instead of walking the rest of the matrix (one player + one embed).
    expect(provider.proxyFetch).toHaveBeenCalledTimes(2);
  });

  test('prefers the terminal-host Referer even when the serving iframe is a known family', async () => {
    stubNetwork(KNOWN_WRAPPER_URL);
    provider.decodeEconfig.mockReturnValue({ stream_url: TERMINAL_MANIFEST });

    const streams = await provider.resolveStream('304', 'football', 'Arsenal vs Chelsea');

    expect(streams).toHaveLength(1);
    const q = manifestQuery(streams[0].url);

    // The wrapper is known, but the manifest is not served from it - so its
    // Referer would still be the wrong family.
    expect(q.referer).toBe(REGISTRY_REFERER);
    expect(q.referer).not.toBe(KNOWN_WRAPPER_REFERER);
    expect(streams[0].behaviorHints.proxyHeaders.request.Referer).toBe(REGISTRY_REFERER);
  });

  test('falls back to the iframe-origin Referer when the registry does not know the terminal host', async () => {
    provider.decodeEconfig.mockReturnValue({ stream_url: UNKNOWN_MANIFEST });

    const streams = await provider.resolveStream('303', 'basketball', 'Lakers vs Warriors', { channelName: 'NBA TV' });

    expect(streams).toHaveLength(1);
    const stream = streams[0];
    const q = manifestQuery(stream.url);

    expect(q.target).toBe(UNKNOWN_MANIFEST);
    expect(q.referer).toBe(IFRAME_REFERER);
    expect(q.origin).toBe('https://tiestep.top');
    expect(stream.behaviorHints.proxyHeaders.request.Referer).toBe(IFRAME_REFERER);
    expect(q.referer).toBe(stream.behaviorHints.proxyHeaders.request.Referer);

    // The unknown case is held as a fallback rather than scanning every
    // remaining folder/mirror, so resolution stays bounded.
    expect(provider.proxyFetch).toHaveBeenCalledTimes(2);
  });
});
