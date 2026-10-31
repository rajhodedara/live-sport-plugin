'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
const DamiTvProvider = require('../src/providers/DamiTvProvider');

test.each([
  ['fetch', Object.assign(new Error('secret token'), { code: 'ERR_OUTBOUND_CAPACITY' }), 'fetch', 'ERR_OUTBOUND_CAPACITY'],
  ['parse', new SyntaxError('secret payload'), 'parse', 'SyntaxError']
])('reports sanitized %s extraction failures while retaining fallback', async (step, error, phase, expected) => {
  const breaker = { wrapSync: (_name, fn) => ({ fire: fn }) };
  const provider = new DamiTvProvider({ circuitBreaker: breaker });
  provider.proxyFetch = jest.fn().mockImplementationOnce(async () => {
    if (step === 'fetch') throw error;
    return { ok: true, json: async () => { throw error; } };
  }).mockResolvedValue({ ok: false });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const streams = await provider.resolveStream('https://damitv.st/embed/?id=fixture', 'basketball', 'Fixture');
    expect(streams.length).toBeGreaterThan(0);
    const log = warn.mock.calls.map(call => call.join(' ')).join('\n');
    expect(log).toContain(`"phase":"${phase}"`);
    expect(log).toContain(expected);
    expect(log).not.toContain('secret');
  } finally { warn.mockRestore(); }
});

test('DamiTV extraction has an explicit bounded WARP-compatible deadline', async () => {
  const breaker = { wrapSync: (_name, fn) => ({ fire: fn }) };
  const provider = new DamiTvProvider({ circuitBreaker: breaker });
  provider.proxyFetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, hlsUrl: 'https://cdn.example.org/master.m3u8' }) });
  const result = await provider.resolveStream('https://damitv.st/embed/?id=fixture', 'basketball', 'Fixture');
  expect(result.length).toBeGreaterThan(0);
  expect(provider.proxyFetch.mock.calls[0][1]).toMatchObject({ timeoutMs: 11000 });
  expect(provider.proxyFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});

test('logs a safe reason when extraction has no usable embed URL', async () => {
  const provider = new DamiTvProvider({ circuitBreaker: { wrapSync: (_name, fn) => ({ fire: fn }) } });
  const log = jest.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(await provider.resolveStream('invalid-secret', '', '')).toEqual([]);
    expect(log.mock.calls.flat().join(' ')).toContain('missing_embed_url');
    expect(log.mock.calls.flat().join(' ')).not.toContain('invalid-secret');
  } finally { log.mockRestore(); }
});
