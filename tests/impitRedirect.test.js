'use strict';

// The regression being pinned: undici's request() does NOT follow redirects, so
// the fallback path in impitClient used to hand callers `{ ok: false, status: 301 }`
// whenever an upstream bounced its primary host to a mirror (dlstreams.st ->
// dlive.sx is the observed case). The caller then recorded a healthy primary
// domain as a failure. Path B now follows 301/302/303/307/308 with a bounded hop
// count, and the timeoutMs budget covers the WHOLE chain.
//
// Path A (impit) is forced to fail here: the native addon does load on this
// platform, so the failure has to be injected to reach the undici code at all.
// The transport is stubbed through the undici module, so no socket is opened.

jest.mock('impit', () => ({
  // getImpit() constructs this and catches the throw, which is exactly how a
  // missing/broken native binary presents itself at runtime.
  Impit: class {
    constructor() {
      throw new Error('simulated native addon failure');
    }
  },
}));

jest.mock('undici', () => ({
  request: jest.fn(),
  Agent: class {
    constructor() {}
    close() { return Promise.resolve(); }
  },
}));

const { request } = require('undici');
const { safeFetch } = require('../src/impitClient');

const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXTINF:4.0,\nseg0.ts\n';
const PRIMARY = 'https://dlstreams.st/schedule/schedule-generated.json';

// MAX_REDIRECT_HOPS in src/impitClient.js: the initial request plus this many
// followed hops is the most that can ever be sent for one safeFetch call.
const MAX_REDIRECT_HOPS = 5;

function redirectResponse(statusCode, location) {
  return {
    statusCode,
    headers: location === undefined ? {} : { location },
    body: { dump: jest.fn().mockResolvedValue(undefined), text: async () => '' },
  };
}

function bodyResponse(statusCode, body) {
  return {
    statusCode,
    headers: {},
    body: { dump: jest.fn().mockResolvedValue(undefined), text: async () => body },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('impitClient.safeFetch — undici fallback follows redirects', () => {
  test('follows a 301 to the redirect target and resolves with the final response', async () => {
    const hop1 = redirectResponse(301, 'https://mirror.example/live.m3u8');
    request
      .mockResolvedValueOnce(hop1)
      .mockResolvedValueOnce(bodyResponse(200, PLAYLIST));

    const res = await safeFetch(PRIMARY, { attempts: 1 });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe(PRIMARY);
    expect(request.mock.calls[1][0]).toBe('https://mirror.example/live.m3u8');

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PLAYLIST);
    // The redirect's own body is drained so its keep-alive socket is released.
    expect(hop1.body.dump).toHaveBeenCalledTimes(1);
  });

  test('resolves a relative Location against the hop it came from', async () => {
    request
      .mockResolvedValueOnce(redirectResponse(302, '/mirror/live.m3u8'))
      .mockResolvedValueOnce(bodyResponse(200, PLAYLIST));

    const res = await safeFetch('https://dlstreams.st/a/b.json', { attempts: 1 });

    expect(request.mock.calls[1][0]).toBe('https://dlstreams.st/mirror/live.m3u8');
    expect(res.ok).toBe(true);
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
  ])('returns a redirect with a %s Location as-is instead of looping', async (_label, location) => {
    request.mockResolvedValueOnce(redirectResponse(302, location));

    const res = await safeFetch(PRIMARY, { attempts: 1 });

    expect(request).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(302);
    expect(await res.text()).toBe('');
  });

  test('bounds the hop count so a redirect loop terminates instead of hanging', async () => {
    const hops = [];
    request.mockImplementation(async () => {
      const r = redirectResponse(302, 'https://loop.example/a');
      hops.push(r);
      return r;
    });

    const res = await safeFetch('https://loop.example/a', { attempts: 1, timeoutMs: 60000 });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(302);
    // Initial request + MAX_REDIRECT_HOPS followed hops, then it stops.
    expect(request).toHaveBeenCalledTimes(MAX_REDIRECT_HOPS + 1);
    // Every followed redirect was drained; the terminal one was not followed.
    expect(hops.filter((h) => h.body.dump.mock.calls.length > 0)).toHaveLength(MAX_REDIRECT_HOPS);
  });

  test('drops the body and switches to GET when a 301 redirects a POST', async () => {
    request
      .mockResolvedValueOnce(redirectResponse(301, 'https://mirror.example/submit'))
      .mockResolvedValueOnce(bodyResponse(200, 'done'));

    const res = await safeFetch('https://primary.example/submit', {
      method: 'POST',
      body: 'payload',
      headers: { 'content-length': '7', 'content-type': 'text/plain' },
      attempts: 1,
    });

    expect(request.mock.calls[0][1].method).toBe('POST');
    expect(request.mock.calls[0][1].body).toBe('payload');

    // 301 makes the request bodyless, so a framing header describing it must go.
    expect(request.mock.calls[1][1].method).toBe('GET');
    expect(request.mock.calls[1][1].body).toBeUndefined();
    expect(request.mock.calls[1][1].headers['content-length']).toBeUndefined();
    expect(request.mock.calls[1][1].headers['content-type']).toBe('text/plain');
    expect(res.status).toBe(200);
  });
});
