'use strict';
const MatchAggregator = require('../src/services/MatchAggregator');
const ProviderHealthService = require('../src/services/ProviderHealthService');

const row = (id, source) => ({ id, title: id, category: 'basketball', date: String(Date.now() + 3600000), sources: [{ source, id, url: 'https://example.invalid/' }] });

describe('provider sync timeout health', () => {
  let oldTimeout, warn, log, error;
  beforeEach(() => {
    jest.useFakeTimers(); oldTimeout = process.env.PROVIDER_SYNC_TIMEOUT_MS; process.env.PROVIDER_SYNC_TIMEOUT_MS = '5000';
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    if (oldTimeout === undefined) delete process.env.PROVIDER_SYNC_TIMEOUT_MS; else process.env.PROVIDER_SYNC_TIMEOUT_MS = oldTimeout;
    warn.mockRestore(); log.mockRestore(); error.mockRestore(); jest.useRealTimers();
  });
  test.each(['invalid', 'Infinity', '2147483648'])('timeout configuration %s does not prematurely discard a provider', async value => {
    process.env.PROVIDER_SYNC_TIMEOUT_MS = value;
    const slow = { sourceName: 'slow', getMatches: () => new Promise(resolve => setTimeout(() => resolve([row('valid-event', 'slow')]), 25)) };
    let saved = [];
    const cache = { getMatchesReadOnly: () => [], setMatches: matches => { saved = matches; } };
    const health = new ProviderHealthService();
    const agg = new MatchAggregator({ yamlProviders: [slow], cacheService: cache, providerHealthService: health });
    const sync = agg.syncMatches();
    await jest.advanceTimersByTimeAsync(25); await sync;
    expect(saved.some(m => m.id === 'valid-event')).toBe(true);
    expect(health.snapshot().providers.find(p => p.id === 'slow').state).toBe('healthy');
  });
  test.each(['resolve', 'reject'])('late %s cannot replace the next sync health or add stale rows', async action => {
    let settle;
    const delayed = new Promise((resolve, reject) => { settle = action === 'resolve' ? () => resolve([row('old-event', 'slow')]) : () => reject(new Error('late old failure')); });
    const slow = { sourceName: 'slow', getMatches: jest.fn().mockReturnValueOnce(delayed).mockResolvedValueOnce([row('new-event', 'slow')]) };
    const fast = { sourceName: 'fast', getMatches: async () => [row('fast-event', 'fast')] };
    let saved = [];
    const cache = { getMatchesReadOnly: () => [], setMatches: matches => { saved = matches; } };
    const health = new ProviderHealthService();
    const agg = new MatchAggregator({ yamlProviders: [slow, fast], cacheService: cache, providerHealthService: health });
    const first = agg.syncMatches();
    await jest.advanceTimersByTimeAsync(5000);
    await first;
    expect(health.snapshot().providers.find(p => p.id === 'slow')).toMatchObject({ state: 'error', matchCount: 0, error: 'provider sync timeout' });
    expect(warn.mock.calls.some(([line]) => line.includes('provider slow exceeded'))).toBe(true);
    expect(saved.some(m => m.id === 'old-event')).toBe(false);
    await agg.syncMatches();
    const afterSecond = health.snapshot().providers.find(p => p.id === 'slow');
    expect(afterSecond.state).toBe('healthy');
    expect(saved.some(m => m.id === 'new-event')).toBe(true);
    settle(); await jest.advanceTimersByTimeAsync(0);
    expect(health.snapshot().providers.find(p => p.id === 'slow')).toEqual(afterSecond);
    expect(saved.some(m => m.id === 'old-event')).toBe(false);
  });
});
