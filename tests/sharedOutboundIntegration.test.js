'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('the actual guarded safeFetch entry uses native pinning, profiles, provider hints and bounded bodies', () => {
  const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'fixtures/shared-outbound-integration.cjs')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
  }));
  expect(result).toEqual({ actualSafeFetch: true, guardedNative: true, providerDefaults: true,
    boundedBody: true, privateRedirectBlocked: true, profiles: ['vanilla', 'chrome142'], pinned: 4 });
}, 12000);
