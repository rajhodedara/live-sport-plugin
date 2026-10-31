# PR59 locked-run evidence reconciliation

This report records the fixture-only follow-up from local PR59 f240afd and
historical published test target27f35629. STABLE_A71_INTEGRATION.md describes the
current integration. No production process or dependency is changed here.

## Received evidence

The complete PR JSON reports207 suites,17 failed;1,867 test cases contain1,792
passes,74 failures and1 TODO. Runtime/suite-load errors are0. The reduced file
contains the same17 failed suites and74 failed case names/messages, with its
declared4,000-character message truncation. These are failed test cases, not
74 independently established runtime defects.

Raj's text identifies27f35629, Node22.23.2, locked Jest29.7.0 and
`./node_modules/.bin/jest --silent --json`. The JSON format does not itself attest
to its commit, runner or command. The11 suites labelled PR-only total61 failed
cases; the other6 total13. The reported new stable138/10/23 result and cross-tree
classification cannot be independently checked without that run's stable JSON.
The older Jest30 data is not used as the locked baseline.

## Specific findings

| Suite | Evidence and local disposition | Scope limit |
| --- | --- | --- |
| redirectCredentialIsolation (24) | Every stack points to beforeAll `isImpitAvailable() === false`, not a header assertion. Direct Jest29 resolver probing reproduces virtual/installed mock-ID contamination. Normalize installed Impit mock identity in3 suites and harden unavailable-native constructor model. | Exact preceding suite in Raj's worker is unknown; the report has no worker assignments. |
| redirectCredentialHttp (6) | Failure expects X-Fixture to be retained cross-origin. Local fixture already follows the reviewed allowlist. | Corrected real-HTTP suite still awaits execution. |
| manifestRecoveryIdentity (16) | Report receives403 before the loopback upstream or cache assertions. Existing local handler-level replacement preserves recovery/identity/concurrency checks using mocked public upstream I/O. | Does not establish HTTP middleware or real upstream integration. |
| resolverBindHost (4) | Full stack identifies the VM linker's unexpected node:https import. Local fixture already provides explicit dependencies for plaintext mode. | Seven pure HOST cases passed previously; four real-listener cases remain pending. |
| guardedPublicEntries (4) | Original public-redirect cases time out/parse a non-JSON error body. Mocking Impit in Jest does not prevent native-slot allocation. Local fixture invokes real registered handlers, preflight and fallback guard, injecting native unavailability before slot allocation. | Original timeout is not reproduced under a real listener here; no claim of a runtime guard fix. |
| resolverUndiciMemoryTls (2) | Reproduced identical removeAbortListener TypeError on Node22.23.2/Jest29.7:2 fail/2 pass. The VM/host Symbol.dispose identity is aligned before Undici loads and restored afterward. New abort-disposal interoperability test passes. | A test-realm fix, not a resolver TLS runtime change. |
| skTechDashDrmProxy (1) | Guard blocks the fixture's private upstream. Existing local actual-handler/mock-I/O correction passes21 tests. | No real DRM/device/player acceptance claim. |
| nativeGuardedFetch (1) | Exact failure expects custom-retained cross-origin; fixture already corrected to header removal and explicit admission budget. | Actual native fixture remains unexecuted here. |
| cacheTimingRelations (1), pendingMintPruning (1) | Existing mocked shared-cache fixtures lacked explicit legacy-TCP trust. Local tests opt in only for their simulated compatibility scenario. | Runtime default trust policy stays unchanged. |
| streamTimingWindow (1) | Local observer assertion includes the existing fourth hard_wait_expired reason. | Controlled clock/model coverage. |

The six other failed suites are liveSectionAndLogoHosts(2),streamVerifyRetry(2),
ak47LiveProvider(1),beforeAndAfterBenchmark(2),safeFetchDeadlineHttp(3) and
dembedImpitHeaders(3). Raj classifies them as shared with stable; that classification
is not independently verified by the delivered PR JSON. Known local observations
include environment-dependent base URL expectations, speed-probe setup, an expired
AK47 clock fixture (corrected in PR61), and timing thresholds. No threshold was
relaxed. Network cancellation and native/header integration are not declared
passing based on this reconciliation.

## Reproducible local validation

```sh
node scripts/test-pr59-offline.cjs
```

Result on both Node22.23.2 and Node24.19.0 with installed Jest29.7.0:
The original locked-fixture selection passed54 suites/515 tests and1 TODO.
The stable-integration selection then included8 existing TimStreams cases:
55 suites/523 tests and1 TODO on both Node versions. After the received
Windows full-run fixture audit, the current command passes60 suites/583 tests
and1 TODO on both versions; see PR59_MESSAGE39_RECONCILIATION.md.
No full Jest-suite pass is claimed.
The Node22 binary came from the official distribution with SHA256 checked against
its official SHASUMS; existing local dependency versions were retained. This was
not a fresh installation on Raj's host.

The TLS fixture uses real TLS memory streams with installed Undici and HTTPS
proxy agent. Positive controls succeed; wrong pins produce the exact identity
verification error before any HTTP application data. Its injected trusted fixture
CA ensures the pin callback is reached: this does not prove a deployed socket's
wrong-CA behavior. Worker creation and socket connect/listen stay blocked by the
offline preload. No actual native/WASM extractors run.

Two independent read-only reviews found no blocking issue in these fixture
changes and confirmed the distinction between failed setup and header evidence.
The six test files and runner were the only executable-code changes in that
fixture follow-up. The subsequent stable integration changes TimStreams' host
and adds fresh build evidence in STABLE_A71_INTEGRATION.md; dependency files
remain unchanged.

## Other reported catalogue observation

The missing ts_atletico-madrid-v-levante card needs its actual kickoff/category,
request configuration and complete catalogue/search request to diagnose.
TimStreams labels events live for4 hours after kickoff; the football catalogue
window is2.5 hours, with expiry filtering before search. That can explain an
ID-resolvable record absent from listings, but does not establish this case.
Category/configuration filters and pagination are additional possibilities.
Do not extend live windows merely to retain an unverified stale event.

## Remaining acceptance

An agreed new test SHA still needs corrected real HTTP/native fixtures and the
operator's isolated pinned-transport matrix, including positive controls,
explicit wrong-certificate failure, both workers and rotation/restart/fail-closed
behavior. Full repository results and real playback remain separate. Published
test targets must be identified by their exact SHA; earlier target results do
not automatically validate a later update.
