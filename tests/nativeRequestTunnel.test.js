'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('experimental native tunnel bounds connections and isolates cancellation using loopback fixtures', () => {
  const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'fixtures/native-request-tunnel.cjs')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
  expect(result).toEqual({ checks: ['private', 'proxy', 'rebinding', 'authorization', 'origin', 'deadline', 'capacity', 'isolation', 'native-abort'], nativeConnectionsAfterAbort: 0 });
}, 18000);
