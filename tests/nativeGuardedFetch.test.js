'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('buffered native laboratory fetch bounds bodies, redirects, deadlines and client admission', () => {
  const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'fixtures/native-guarded-fetch.cjs')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 18000, stdio: ['ignore', 'pipe', 'pipe']
  }));
  expect(result).toEqual({ realNativeMetadata: true, crossOriginPolicy: true, methodsAndBodies: true,
    boundedBody: true, privateRedirectBlocked: true, redirectLimit: true, totalDeadline: true,
    boundedAdmission: true, isolatedAbort: true, creationDeadline: true, profilesAndProxySelection: true,
    validSocksProxy: true, shutdownCleanup: true, nativeClients: 2 });
}, 21000);
