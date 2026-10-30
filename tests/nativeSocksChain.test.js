'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('native laboratory tunnel preserves guarded SOCKS pinning, TLS identity and cancellation', () => {
  const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'fixtures/native-socks-chain.cjs')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 12000,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
  expect(result).toEqual({ numericDestination: '93.184.216.34:443',
    preservedSni: 'cdn.example.org', certificateRejected: true, originBytes: 0,
    rebindingBlocked: true, isolatedAbort: true, handshakeDeadline: true, remainingProxySockets: 0 });
}, 15000);
