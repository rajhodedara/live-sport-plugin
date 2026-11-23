// tests/movieboxCrypto.test.js
'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(() => { throw new Error('Unexpected I/O'); }),
}));

const crypto = require('../src/providers/movieboxCrypto');

describe('buildHeaders', () => {
  test('returns all five required header keys', () => {
    const h = crypto.buildHeaders('GET', '/wefeed-tv-bff/sport/aggregate-v1');
    expect(Object.keys(h)).toEqual(expect.arrayContaining([
      'X-Client-Build', 'x-client-token', 'x-client-info', 'x-tr-signature', 'Content-Type'
    ]));
  });

  test('x-client-token format is "<ms>,<32-char-hex>"', () => {
    const h = crypto.buildHeaders('GET', '/test');
    const [ms, hash] = h['x-client-token'].split(',');
    expect(Number(ms)).toBeGreaterThan(0);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  test('x-tr-signature format is "<ms>|2|<base64>"', () => {
    const h = crypto.buildHeaders('GET', '/test');
    const parts = h['x-tr-signature'].split('|');
    expect(parts[1]).toBe('2');
    expect(Buffer.from(parts[2], 'base64').length).toBeGreaterThan(0);
  });

  test('X-Client-Build format is "<part1>.<32-char-hex>"', () => {
    const h = crypto.buildHeaders('GET', '/test');
    const [part1, hash] = h['X-Client-Build'].split('.');
    expect(part1).toMatch(/^\d+$/);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('getVisitorToken', () => {
  test('calls fetchFn once and caches the token for subsequent calls', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ code: 0, data: { token: 'jwt-abc' } })
    });
    // Clear module cache to reset singleton state
    jest.resetModules();
    const freshCrypto = require('../src/providers/movieboxCrypto');
    const t1 = await freshCrypto.getVisitorToken(mockFetch);
    const t2 = await freshCrypto.getVisitorToken(mockFetch);
    expect(t1).toBe('jwt-abc');
    expect(t2).toBe('jwt-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('re-fetches after TTL expires', async () => {
    jest.useFakeTimers();
    jest.resetModules();
    const freshCrypto = require('../src/providers/movieboxCrypto');
    const mockFetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { token: 'first' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { token: 'second' } }) });
    await freshCrypto.getVisitorToken(mockFetch);
    jest.advanceTimersByTime(301_000); // past the 300s TTL
    const t2 = await freshCrypto.getVisitorToken(mockFetch);
    expect(t2).toBe('second');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
