'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root=path.resolve(__dirname,'..');
const boundary=path.join(root,'tests/fixtures/pr59-offline-boundary.cjs');
const env={...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --require=${JSON.stringify(boundary)}`.trim()};
function run(args){const r=spawnSync(process.execPath,args,{cwd:root,env,stdio:'inherit'});if(r.error)console.error(r.error.message);if(r.status!==0)process.exit(r.status||1);}
run(['scripts/test-pr59-offline.cjs']);
const names=[
'ak47ManifestUaExperiment','ak47PlaylistHeaderOrder','ak47PlayerHeaderChain',
'basketballVideoRelativeLinks','bridgeIframe','cdnFeedIsolation','daddyLiveIframeIsolation','damiFeedIsolation',
'embedIndiaInputValidation','embedStInputValidation','fullRacesMalformedCard','hockeyReplayCardUrls',
'leafMalformedIsolation','leafSourceHostValidation.audit','liveTVRelativeIframe',
'manifestCacheBaseUrl','manifestHlsTagUris','mlbGuardedRelativeLinks','mlbLiveRelativeLinks',
'nativeQueueFairness','nativeRedirectHeaderPolicy','nflVideoRelativeLinks','ppvAlternateOnly','ppvStProvider',
'replayProviderHostValidation','replayZoneLineEndings','skTechHeaderParsing','soccerFullCardUrls',
'streamExternalFallback','streamPlaybackHeaders','streamSports99FeedIsolation','streamedPkMalformedEntries',
'timFeedIsolation','vavooSourceHostValidation','yamlProviderLinkHandling',
'pr61ManifestScenarios','pr61PlaybackScenarios',
'broadcasterMatchService','broadcasterMappingIdentity','matchMappingIdentity',
'cacheMatchIdentity','pr61MappingScenarios','cacheServiceFindMatch',
'circuitBreakerFallbackDiagnostic','partialProviderScheduleHealth',
'daddyFixtureCanonicalIdentity','realCatalogCountryIdentity','replayFixtureIdentity',
'matchAggregatorDates','matchAggregatorDiacritics','matchAggregatorFootballAliases',
'motorsportSessionIsolation','adversarialMotorsportVerification','replayNormalizationAndMerge',
'matchCacheFileIdentity','emptyMatchCachePolling'
].map(n=>`tests/${n}.test.js`);
run([require.resolve('jest/bin/jest'),'--runInBand','--silent','--runTestsByPath',...names]);
// This Node-runner file also contains a separate real-HTTP integration case;
// the offline command explicitly skips that case instead of opening a socket.
run(['--test','--test-skip-pattern=real HTTP','tests/manifestPlaybackUrl.node.test.cjs']);
