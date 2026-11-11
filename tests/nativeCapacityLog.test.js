'use strict';

const { logNativeCapacity, _resetCapacityLogForTests } = require('../src/services/SharedOutboundFetch');

function captureWarnings(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.warn = original; }
  return lines;
}

describe('logNativeCapacity', () => {
  test('prints the first rejection and suppresses the rest of the interval', () => {
    _resetCapacityLogForTests();
    const failure = { code: 'ERR_OUTBOUND_CAPACITY', capacityDiagnostic: { limit: 4, admission: 'expired' } };
    const lines = captureWarnings(() => {
      logNativeCapacity(failure, 1000);
      logNativeCapacity(failure, 2000);
      logNativeCapacity(failure, 3000);
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('"limit":4');
  });

  test('after the interval it prints again and reports how many were suppressed', () => {
    _resetCapacityLogForTests();
    const failure = { code: 'ERR_OUTBOUND_CAPACITY', capacityDiagnostic: { limit: 4 } };
    const lines = captureWarnings(() => {
      logNativeCapacity(failure, 1000);
      logNativeCapacity(failure, 2000);
      logNativeCapacity(failure, 3000);
      logNativeCapacity(failure, 40000);
    });
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('"suppressed":2');
  });

  test('falls back to the error code when there is no diagnostic', () => {
    _resetCapacityLogForTests();
    const lines = captureWarnings(() => logNativeCapacity({ code: 'ERR_NATIVE_POOL_BUSY' }, 5000));
    expect(lines[0]).toContain('ERR_NATIVE_POOL_BUSY');
  });
});
