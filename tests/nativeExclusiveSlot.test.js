'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('one native client is reused only after the prior operation actually settles', () => {
  const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'fixtures/native-exclusive-slot.cjs')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe']
  }));
  expect(result).toEqual({ constructs: 1, connects: 1, metadata: 3, retainedUntilSettlement: true,
    canceledDuringBody: true, busyAfterCompletion: false, remainingOriginSockets: 0 });
}, 10000);
