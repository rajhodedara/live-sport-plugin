'use strict';

// The behaviour under test: a verification ping is a single sample of a flaky
// path, so a transient answer must not be treated as proof that a stream is
// dead. Before the retry policy, one ECONNRESET or one 503 dropped a working
// stream AND negative-cached it, leaving the user with no source for minutes.

jest.mock('../src/impitClient', () => ({
  safeFetch: jest.fn(),
  isImpitAvailable: () => false,
  getImpit: () => null,
}));

const { safeFetch } = require('../src/impitClient');
const { verifyStreams } = require('../src/streams');

const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg0.ts\n';

const ok = (body = PLAYLIST) => ({ status: 200, text: async () => body });
const status = (code) => ({ status: code, text: async () => 'error' });
const netFail = (code) => Object.assign(new Error('socket failure'), { code });

const stream = (url = 'https://edge.example/live.m3u8') => ({
  url,
  name: '⚡ Direct Stream',
  behaviorHints: { proxyHeaders: { request: { Referer: 'https://embed.st/' } } },
});

// Minimal collaborators: the parser only enriches quality metadata, and the
// cache just records the verdict.
const parser = { parseManifestText: () => null };
function makeCache() {
  return {
    failures: 0,
    successes: 0,
    noteFailure() { this.failures++; },
    noteSuccess() { this.successes++; },
  };
}

// VERIFY_ATTEMPTS and friends are read when streams.js loads, so these tests
// run against the defaults (3 attempts, 9s total budget).
beforeEach(() => {
  jest.clearAllMocks();
});

describe('verifyStreams retry policy', () => {
  it('keeps a stream that fails once with a connection reset then succeeds', async () => {
    safeFetch
      .mockRejectedValueOnce(netFail('ECONNRESET'))
      .mockResolvedValue(ok());

    const cache = makeCache();
    const out = await verifyStreams([stream()], 'watchfooty:m1:s1', parser, cache);

    expect(out).toHaveLength(1);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(cache.failures).toBe(0);
    expect(cache.successes).toBe(1);
  });

  it('keeps a stream that answers 503 once then serves the playlist', async () => {
    safeFetch
      .mockResolvedValueOnce(status(503))
      .mockResolvedValue(ok());

    const cache = makeCache();
    const out = await verifyStreams([stream()], 'watchfooty:m1:s1', parser, cache);

    expect(out).toHaveLength(1);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(cache.failures).toBe(0);
  });

  it('drops and negative-caches a stream that stays unreachable', async () => {
    safeFetch.mockRejectedValue(netFail('ECONNRESET'));

    const cache = makeCache();
    const out = await verifyStreams([stream()], 'watchfooty:m1:s1', parser, cache);

    expect(out).toHaveLength(0);
    expect(safeFetch).toHaveBeenCalledTimes(3); // attempts exhausted
    expect(cache.failures).toBe(1);
  });

  it('does not retry a 404 — a working server said the stream is gone', async () => {
    safeFetch.mockResolvedValue(status(404));

    const cache = makeCache();
    const out = await verifyStreams([stream()], 'watchfooty:m1:s1', parser, cache);

    expect(out).toHaveLength(0);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(cache.failures).toBe(1);
  });

  it('passes web player links through without pinging anything', async () => {
    const web = { url: 'http://host/watch?u=abc', name: '🌐 Web Stream' };
    const out = await verifyStreams([web], 'x:y:z', parser, makeCache());

    expect(out).toHaveLength(1);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('drops a 200 response whose body is not a playlist', async () => {
    // Some CDNs answer 200 with "Not found" once the token expires.
    safeFetch.mockResolvedValue(ok('Not found'));

    const cache = makeCache();
    const out = await verifyStreams([stream()], 'watchfooty:m1:s1', parser, cache);

    expect(out).toHaveLength(0);
    expect(cache.failures).toBe(1);
  });

  it('lets each stream in a batch fail or survive independently', async () => {
    safeFetch.mockImplementation(async (url) => {
      if (url.includes('dead')) throw netFail('ECONNRESET');
      return ok();
    });

    const out = await verifyStreams(
      [stream('https://edge.example/good.m3u8'), stream('https://edge.example/dead.m3u8')],
      null,
      parser,
      makeCache()
    );

    expect(out).toHaveLength(1);
    expect(out[0].url).toContain('good');
  });

  it('asks safeFetch not to run its own retry loop, so the two do not compound', async () => {
    safeFetch.mockResolvedValue(ok());
    await verifyStreams([stream()], null, parser, makeCache());

    expect(safeFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ attempts: 1 })
    );
  });
});
