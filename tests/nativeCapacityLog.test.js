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

  test('the printed line reports who asked and for which host across the whole interval', () => {
    _resetCapacityLogForTests();
    const make = (owner, host) => ({ code: 'ERR_NATIVE_POOL_BUSY', capacityDiagnostic: { limit: 4, requested: { owner, host } } });
    const lines = captureWarnings(() => {
      logNativeCapacity(make('verify', 'cdn.example'), 1000);    // printed
      logNativeCapacity(make('verify', 'cdn.example'), 2000);    // suppressed, still counted
      logNativeCapacity(make('provider', 'api.example'), 3000);  // suppressed, still counted
      logNativeCapacity(make('verify', 'cdn.example'), 40000);   // printed, reports the interval
    });
    expect(lines.length).toBe(2);
    const second = JSON.parse(lines[1].replace('[GuardedOutbound] Native capacity ', ''));
    expect(second.suppressed).toBe(2);
    expect(second.window.total).toBe(3);
    expect(second.window.byOwner.verify).toBe(2);
    expect(second.window.byOwner.provider).toBe(1);
    expect(second.window.byHost['cdn.example']).toBe(2);
  });

  test('keeps exactly one "suppressed":N field so the ops measurement command still parses it', () => {
    _resetCapacityLogForTests();
    const failure = { code: 'ERR_NATIVE_POOL_BUSY', capacityDiagnostic: { limit: 4, requested: { owner: 'other', host: 'x.example' } } };
    const lines = captureWarnings(() => {
      logNativeCapacity(failure, 1000);
      logNativeCapacity(failure, 2000);
      logNativeCapacity(failure, 40000);
    });
    const matches = lines[1].match(/"suppressed":[0-9]*/g) || [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe('"suppressed":1');
  });
});
