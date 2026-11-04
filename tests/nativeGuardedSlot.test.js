'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('persistent guarded native slots retain per-lease authority during reuse and SOCKS cancellation', () => {
  const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'fixtures/native-guarded-slot.cjs')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']
  }));
  expect(result).toEqual({ repeatedNativeReuse: true, privateAndRebindingBlocked: true,
    originAndAuthRestricted: true, cancellationIsolated: true, lateDnsIsolated: true,
    socksNumericPinning: true, socksTimeoutRecovered: true, capacityRecovered: true });
}, 18000);
