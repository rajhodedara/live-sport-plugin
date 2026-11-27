'use strict';

jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

const CronService = require('../src/services/CronService');

describe('CronService.start() startup sync gating', () => {
  test('skips startup match sync when cacheService reports fresh cache', async () => {
    const mockCacheService = {
      isStale: jest.fn().mockReturnValue(false),
    };
    const cronService = new CronService({
      matchAggregator: {},
      streamResolveCache: {},
      cacheService: mockCacheService,
    });
    cronService.runSync = jest.fn().mockResolvedValue(true);

    cronService.start();
    await new Promise((r) => setImmediate(r));

    expect(mockCacheService.isStale).toHaveBeenCalledTimes(1);
    expect(cronService.runSync).not.toHaveBeenCalled();
  });

  test('runs startup match sync once when cacheService reports stale cache', async () => {
    const mockCacheService = {
      isStale: jest.fn().mockReturnValue(true),
    };
    const cronService = new CronService({
      matchAggregator: {},
      streamResolveCache: {},
      cacheService: mockCacheService,
    });
    cronService.runSync = jest.fn().mockResolvedValue(true);

    cronService.start();
    await new Promise((r) => setImmediate(r));

    expect(mockCacheService.isStale).toHaveBeenCalledTimes(1);
    expect(cronService.runSync).toHaveBeenCalledTimes(1);
  });
});
