'use strict';

// The regression being pinned: some CDNs intermittently refuse impit's browser
// TLS fingerprint with a 403 while accepting undici on the SAME token
// (observed on messi.damitv.st: impit 8/30 403, undici 0/30, interleaved in one
// process). safeFetch used to return that 403 as final, so verifyStreams in
// src/streams.js deleted every stream whose CDN behaved this way.
//
// Both transports are stubbed, so no socket is opened. Path A (impit) is made
// to succeed here — unlike impitRedirect.test.js, which injects a native-addon
// failure to reach the undici path at all — because the 403 has to come back as
// a real response for the new branch to be exercised.

jest.mock('impit', () => {
  const fetchMock = jest.fn();
  return {
    __fetchMock: fetchMock,
    Impit: class {
      fetch(...args) {
        return fetchMock(...args);
      }
    },
  };
});

jest.mock('undici', () => ({
  request: jest.fn(),
  Agent: class {
    constructor() {}
    close() { return Promise.resolve(); }
  },
}));

const impit = require('impit');
const { request } = require('undici');
const { safeFetch } = require('../src/impitClient');

const impitFetch = impit.__fetchMock;
const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:5.0,\nseg0.ts\n';
const TARGET = 'https://messi.damitv.st/live-hls/channel/nfl-network/playlist.m3u8?tk=abc&e=1';

const FORBIDDEN = '<html><head><title>403 Forbidden</title></head></html>';

/** What impit's fetch() resolves to. */
function impitResponse(status, body) {
  return { status, headers: {}, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
}

/** What undici's request() resolves to. */
function undiciResponse(statusCode, body) {
  return {
    statusCode,
    headers: {},
    body: {
      dump: jest.fn().mockResolvedValue(undefined),
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('impitClient.safeFetch — impit 403 falls back to undici', () => {
  test('retries the same request through undici and returns its response', async () => {
    impitFetch.mockResolvedValueOnce(impitResponse(403, FORBIDDEN));
    request.mockResolvedValueOnce(undiciResponse(200, PLAYLIST));

    const res = await safeFetch(TARGET, { attempts: 1 });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(TARGET);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe(PLAYLIST);
  });

  test('forwards method and headers to the undici retry', async () => {
    impitFetch.mockResolvedValueOnce(impitResponse(403, FORBIDDEN));
    request.mockResolvedValueOnce(undiciResponse(200, PLAYLIST));

    const headers = { 'User-Agent': 'UA', Referer: 'https://damitv.st/' };
    await safeFetch(TARGET, { method: 'GET', headers, attempts: 1 });

    const opts = request.mock.calls[0][1];
    expect(opts.method).toBe('GET');
    expect(opts.headers).toEqual(headers);
  });

  test('does not retry impit after a 403 (a different fingerprint is the point)', async () => {
    impitFetch.mockResolvedValueOnce(impitResponse(403, FORBIDDEN));
    request.mockResolvedValueOnce(undiciResponse(200, PLAYLIST));

    await safeFetch(TARGET, { attempts: 3 });

    // One impit call, not three: retrying the same fingerprint cannot help.
    expect(impitFetch).toHaveBeenCalledTimes(1);
  });

  test('surfaces the original 403 when undici also fails', async () => {
    impitFetch.mockResolvedValueOnce(impitResponse(403, FORBIDDEN));
    request.mockRejectedValueOnce(new Error('ECONNRESET'));

    const res = await safeFetch(TARGET, { attempts: 1 });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(FORBIDDEN);
  });

  test('surfaces the original 403 when undici also returns 403', async () => {
    impitFetch.mockResolvedValueOnce(impitResponse(403, FORBIDDEN));
    request.mockResolvedValueOnce(undiciResponse(403, FORBIDDEN));

    const res = await safeFetch(TARGET, { attempts: 1 });

    expect(res.status).toBe(403);
    expect(res.ok).toBe(false);
  });

  test('a successful impit response never touches undici', async () => {
    impitFetch.mockResolvedValueOnce(impitResponse(200, PLAYLIST));

    const res = await safeFetch(TARGET, { attempts: 1 });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PLAYLIST);
    expect(request).not.toHaveBeenCalled();
  });

  test('other non-2xx statuses are still returned as-is', async () => {
    // 404 is a verdict, not a fingerprint problem: no fallback, no retry.
    impitFetch.mockResolvedValueOnce(impitResponse(404, 'nope'));

    const res = await safeFetch(TARGET, { attempts: 1 });

    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(impitFetch).toHaveBeenCalledTimes(1);
  });
});
