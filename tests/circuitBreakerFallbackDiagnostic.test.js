'use strict';

const CircuitBreakerService = require('../src/services/CircuitBreakerService');

describe('circuit breaker fallback diagnostics with real opossum', () => {
  let service, warn;

  beforeEach(() => {
    service = new CircuitBreakerService();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const breaker of service.breakers.values()) breaker.shutdown();
    warn.mockRestore();
  });

  test.each([
    { args: [] },
    { args: ['https://provider.test/page?token=original-secret', { fixture: true }] },
  ])(
    'logs the actual error and preserves the null fallback with action arguments $args',
    async ({ args }) => {
      const breaker = service.wrapSync('Fixture_fetchPage', async () => {
        throw new Error('Fixture upstream rejected https://provider.test/error?signature=error-secret');
      });

      await expect(breaker.fire(...args)).resolves.toBeNull();

      expect(warn).toHaveBeenCalledWith(
        '[CircuitBreaker] Fixture_fetchPage Fallback triggered. Reason: Fixture upstream rejected https://provider.test/error?[redacted]'
      );
      const output = warn.mock.calls.flat().join(' ');
      expect(output).not.toContain('original-secret');
      expect(output).not.toContain('error-secret');
      expect(output).not.toContain('undefined');
    }
  );

  test('keeps filtered local capacity rejected without a fallback or breaker failure', async () => {
    const capacity = Object.assign(new Error('local capacity'), { code: 'ERR_OUTBOUND_CAPACITY' });
    const breaker = service.wrapSync('Fixture_capacity', async () => { throw capacity; }, {
      errorFilter: error => error.code === 'ERR_OUTBOUND_CAPACITY',
    });

    await expect(breaker.fire('https://provider.test/page?token=original-secret')).rejects.toBe(capacity);
    expect(breaker.stats.failures).toBe(0);
    expect(breaker.stats.fallbacks).toBe(0);
    expect(breaker.opened).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
