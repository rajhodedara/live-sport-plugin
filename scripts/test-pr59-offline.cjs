'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const boundary = path.join(root, 'tests/fixtures/pr59-offline-boundary.cjs');
const suites = [
  'ssrfGuard', 'guardedOutboundTransport', 'nativeGuardedRotation', 'nativeLeaseCleanup',
  'nativeAdmissionQueue', 'nativeAdmissionReview', 'nativeAdmissionShared',
  'providerOutboundCompatibility', 'providerGuardRouting', 'providerSyncTimeout', 'providerHealth',
  'guardedPublicEntries', 'redirectHeaderPolicy', 'redirectCredentialIsolation',
  'impitRedirect', 'impitResponseUrl', 'sharedOutboundPolicy',
  'segmentLengthService', 'streamSpeedProbeGuard', 'streamVerifyRetry',
  'soccerFullProvider', 'soccerFullSegmentLength', 'soccerFullGuardIntegration', 'soccerFullPublishedUrl',
  'leafProvider', 'providerChildBuildImports', 'gasmIndiaPlayerCompletion', 'ppvChildCompletion',
  'resolverTransportConfig', 'resolverUnixClients', 'resolverPinnedClients', 'resolverPinnedIdentity',
  'resolverPublicIdentity', 'resolverProxyEvents', 'resolverConflictGate', 'resolverShutdownRace',
  'resolverUndiciMemoryTls',
  'resolverPortSafetyCharacterization', 'resolverTrustPolicy', 'resolverRequestUrl',
  'resolverStaticErrors', 'isolatedNativePackaging', 'checkResolverRuntime', 'sharedCacheExpiry',
  'sharedLeaseProtocol', 'sharedLeaseOwnership', 'sharedSlowMintRecovery',
  'sharedClaimBounds', 'sharedClaimCleanup', 'sharedInvalidationRevision',
  'streamResolveConcurrency', 'resolverTlsHandshake',
  'daddyLiveProvider', 'timStreamsProvider', 'universalChannelIdentity',
  'cacheTimingRelations', 'streamTimingWindow', 'pendingMintPruning',
  'skTechDashDrmProxy', 'manifestRecoveryIdentity'
].map(name => `tests/${name}.test.js`);
let jestEntry;
try { jestEntry = require.resolve('jest/bin/jest'); }
catch (_) {
  console.error('Local Jest is missing. Install the locked development dependencies with: npm ci --include=dev');
  process.exit(1);
}
const jestVersion = require('jest/package.json').version;
if (!jestVersion.startsWith('29.')) {
  console.error(`Expected the project Jest 29 dependency, received ${jestVersion}. Run: npm ci --include=dev`);
  process.exit(1);
}
console.info(`PR59 offline selection: Node ${process.version}, Jest ${jestVersion}`);
const result = spawnSync(process.execPath, [jestEntry, '--runInBand', '--silent', '--runTestsByPath', ...suites], {
  cwd: root, stdio: 'inherit', env: { ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(boundary)}`.trim() }
});
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status === null ? 1 : result.status;
