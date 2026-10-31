'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const boundary = path.join(root, 'tests/fixtures/pr59-offline-boundary.cjs');
const suites = [
  'ssrfGuard', 'guardedOutboundTransport', 'nativeGuardedRotation', 'nativeLeaseCleanup',
  'nativeAdmissionQueue', 'nativeAdmissionReview', 'nativeAdmissionShared',
  'providerOutboundCompatibility', 'providerGuardRouting', 'providerSyncTimeout', 'providerHealth',
  'redirectHeaderPolicy', 'redirectCredentialIsolation', 'impitRedirect', 'sharedOutboundPolicy',
  'segmentLengthService', 'streamSpeedProbeGuard',
  'soccerFullProvider', 'soccerFullSegmentLength', 'soccerFullGuardIntegration', 'soccerFullPublishedUrl',
  'leafProvider', 'providerChildBuildImports', 'gasmIndiaPlayerCompletion', 'ppvChildCompletion',
  'resolverTransportConfig', 'resolverUnixClients', 'resolverPinnedClients', 'resolverPinnedIdentity',
  'resolverPublicIdentity', 'resolverProxyEvents', 'resolverConflictGate', 'resolverShutdownRace',
  'resolverPortSafetyCharacterization', 'resolverTrustPolicy', 'sharedCacheExpiry',
  'sharedLeaseProtocol', 'sharedSlowMintRecovery', 'streamResolveConcurrency', 'resolverTlsHandshake',
  'daddyLiveProvider', 'universalChannelIdentity'
].map(name => `tests/${name}.test.js`);
const result = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', '--silent', '--runTestsByPath', ...suites], {
  cwd: root, stdio: 'inherit', env: { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(boundary)}`.trim() }
});
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status === null ? 1 : result.status;
