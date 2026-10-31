'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
const PpvStProvider = require('../src/providers/PpvStProvider');
const { safeFetch } = require('../src/services/ProviderOutbound');

test('PPV catalog fetch identifies itself for bounded startup admission', async () => {
  const provider = new PpvStProvider({ circuitBreaker: {} });
  provider.proxyFetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, streams: [] }) }));
  await expect(provider.getMatches()).resolves.toEqual([]);
  expect(provider.proxyFetch).toHaveBeenCalledWith('https://api.ppv.st/api/streams', expect.objectContaining({ diagnosticOwner: 'catalog' }));
});

test('catalog admission reaches the guarded transport through the real provider wrapper', async () => {
  const provider = new PpvStProvider({ circuitBreaker: {} });
  safeFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, streams: [] }) });
  await expect(provider.getMatches()).resolves.toEqual([]);
  expect(safeFetch).toHaveBeenCalledWith('https://api.ppv.st/api/streams', expect.objectContaining({ diagnosticOwner: 'catalog' }));
});

test('retries one local capacity failure within the same bounded signal', async () => {
  const provider = new PpvStProvider({ circuitBreaker: {} });
  provider.proxyFetch = jest.fn().mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'ERR_OUTBOUND_CAPACITY' }))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, streams: [] }) });
  await expect(provider.getMatches()).resolves.toEqual([]);
  expect(provider.proxyFetch).toHaveBeenCalledTimes(2);
  expect(provider.proxyFetch.mock.calls[0][1].signal).toBe(provider.proxyFetch.mock.calls[1][1].signal);
});

test('does not retry unrelated errors', async () => {
  const provider = new PpvStProvider({ circuitBreaker: {} });
  provider.proxyFetch = jest.fn().mockRejectedValue(new Error('unavailable'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { await expect(provider.getMatches()).resolves.toEqual([]); expect(provider.proxyFetch).toHaveBeenCalledTimes(1); }
  finally { log.mockRestore(); }
});
