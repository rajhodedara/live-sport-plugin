'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
const DamiTvProvider = require('../src/providers/DamiTvProvider');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');

test.each(['fetchData', 'fetchAllMatches'])('%s ignores local capacity for breaker health and permits a later success', async property => {
  const service = new CircuitBreakerService(), provider = new DamiTvProvider({ circuitBreaker: service });
  const capacity = Object.assign(new Error('local saturation'), { code: 'ERR_OUTBOUND_CAPACITY' });
  provider.proxyFetch = jest.fn().mockRejectedValueOnce(capacity).mockRejectedValueOnce(capacity).mockRejectedValueOnce(capacity)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ fixture: true }) });
  try {
    for (let i = 0; i < 3; i++) await expect(provider[property].fire()).rejects.toMatchObject({ code: 'ERR_OUTBOUND_CAPACITY' });
    expect(provider[property].opened).toBe(false);
    expect(provider[property].stats.failures).toBe(0);
    await expect(provider[property].fire()).resolves.toEqual({ fixture: true });
  } finally { for (const breaker of service.breakers.values()) breaker.shutdown(); }
});

test('real upstream failures still open the DamiTV circuit', async () => {
  const service = new CircuitBreakerService(), provider = new DamiTvProvider({ circuitBreaker: service });
  provider.proxyFetch = jest.fn(async () => { throw new Error('upstream failure'); });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (let i = 0; i < 3; i++) await provider.fetchData.fire();
    expect(provider.fetchData.opened).toBe(true);
    expect(provider.fetchData.stats.failures).toBe(3);
  } finally { warn.mockRestore(); for (const breaker of service.breakers.values()) breaker.shutdown(); }
});
