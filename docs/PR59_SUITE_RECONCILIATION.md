# PR59 suite reconciliation (local follow-up to 27f35629)

The 414 tests/42 suites were the selected offline run:

```sh
node scripts/test-pr59-offline.cjs
```

The exact list and Jest invocation are in that script, with worker construction
and socket connect/listen blocked by tests/fixtures/pr59-offline-boundary.cjs.
There was no claim of a full-suite or CI pass; existing workflows do not run
this offline selection as a test job. Raj's full-suite comparison is additional
evidence and its failures must be reconciled, including the three new suites.
The published SHA stays 27f35629 while this follow-up is reviewed locally.

| Reported suite | Current evidence / local correction | Validation limit |
| --- | --- | --- |
| cacheTimingRelations | Reproduced: shared adoption test lacks explicit legacy TCP trust after the default changed. Test now opts into mocked TCP and restores env. | 9 offline tests pass with other related cases; default-denial tests remain intact. |
| streamTimingWindow | Reproduced: observer now receives a fourth reason argument; fixture expected old signature. Updated to hard_wait_expired. | Controlled clock, no real stream provider. |
| pendingMintPruning | Reproduced: shared lookup scenario ran local mint because legacy TCP was disabled. Shared fixtures now opt in explicitly. | Mocked I/O; pruning assertions retained. |
| redirectCredentialHttp | Fixture explicitly expected custom X-Api-Key, X-Fixture and Referer to survive cross-origin redirects, contrary to the reviewed allowlist. Expectations updated to removal. | Real HTTP suite not run here; equivalent offline redirect models already pass. |
| resolverBindHost | VM linker knew only node:http and cannot load the updated TLS-capable entrypoint. Added explicit plaintext-mode fixture dependencies. | Seven pure HOST tests pass; four real listener cases await execution. |
| skTechDashDrmProxy | Formatting test used a private upstream and stubbed guardedFetch, but native guard can reject before that fallback. Test now drives real handler with public synthetic URL and mocked upstream I/O. | All 21 formatting/license tests pass offline. Does not prove external playback. |
| manifestRecoveryIdentity | Real-loopback upstream conflicts with guarded external transport. Actual handler/remint/cache tests now use mocked public upstream responses and preserve concurrency/recovery assertions. | All 16 tests pass offline; HTTP-stack integration not claimed. |
| nativeGuardedFetch | Native fixture still expected custom header retention and immediate rejection at slot saturation. Updated to stripping and an explicit short admission wait. | Actual native fixture remains unexecuted locally; Raj's result is required. |
| beforeAndAfterBenchmark | Original unmodified 11-test suite passed in this environment. No threshold relaxed. Locked-run timings for tests10/11 are now received. | Paired samples reproduce variation; they do not establish statistical performance equivalence. |

Local reproduction before fixes: cache timing, pending prune and timing-window
failed; the benchmark passed. After fixes those three suites pass (17 tests),
plus the 21 DASH formatting tests and 16 recovery tests. The real network/native
cases remain pending; this table does not mean the full suite is green.

## Historical evidence before the locked rerun

The attached stable-jest-results.json records **8 failed suites / 8 failed tests**
(three suite-load errors), rather than the earlier summary's 7/7. Benchmark 10
fails in that baseline as well as the PR report. The native guarded fixture's
reported failure is exactly its old `X-Api-Key: custom-retained` expectation;
the allowlist now correctly removes it. These points reconcile the specific
assertions, not every full-suite failure.

Jest is already present in package.json devDependencies (`^29.7.0`) and pinned
in package-lock.json at 29.7.0. The provided stack traces use an npx temporary
installation; its exact version is not in the received JSON. Use
`npm ci --include=dev` and record `node --version` and `npm ls jest --depth=0`
before comparing. The offline runner now fails with a clear install instruction
if the local dependency is missing, and checks the expected Jest major.
Jest's testMatch is explicit for Jest JS/TS files; .test.mjs and Node .cjs tests
belong to their Node runner, not Jest. They are not counted as passing by being
excluded from the wrong runner.

The expanded offline command now covers 54 suites, **515 passing tests** and
one existing TODO. Seven pure resolver HOST tests pass separately; actual
HTTP/native cases still need the corrected fixtures run in Raj's environment.
The fixture reconciliation does not change runtime logic. This candidate also
includes the separate runtime correction described below.

## Shared invalidation correction

A controlled two-worker reproduction confirmed that a delayed, ownerless DELETE
from `noteFailure()` could erase a newer L2 publication. Each resolver publication
now has a revision; workers invalidate only the revision they observed, through
conditional PATCH. A mismatched revision leaves the current entry intact, and an
invalidation cannot release another mint's active claim. If failure or pruning
happens while a publication is in flight, its eventual response supplies the
revision needed to retract that exact result.

Nine offline scenarios cover delayed invalidation, missing revisions, active
claims, failure/pruning during publication, completion after local eviction,
later invalidation of a local publication, rollback to an older resolver, and
the actual router's conditional operation. Existing lease ownership, claim
bounds/cleanup and slow-mint recovery tests also run in the expanded command.

An older resolver rejects PATCH instead of ignoring a revision query on DELETE.
Without a usable revision, the worker keeps the bounded L2 entry until expiry
rather than sending an unconditional invalidation. Upgrade both addon workers
and the resolver together: old workers still use the former DELETE behavior.
This protects against delayed operations for the entry observed by noteFailure;
it does not identify the publication behind an older manifest URL. Such a late
reader can still report failure against the cache key's current entry.

Two interleaved focused benchmark runs per tree used identical Node24.19/Jest29.7
and dependencies, with the original tests and thresholds unchanged. Both PR
runs passed. Stable passed once and failed benchmark11 once (20.93ms against
its 2x threshold, despite the same 98% comparison-count reduction). This
reproduces threshold instability on stable too. It is not a statistical proof
of equal performance. The benchmark file and ChannelLogoService.js are identical
between the two published heads; benchmark11 implements its measured loops
inside the test. Keep full-run host timings separate from these focused samples.

## Locked evidence received in message38

The full PR JSON and reduced failing-only JSON have now arrived. They agree on
207 suites,17 failed, and74 failed test cases, with1,792 passed and1 TODO; there
are no reported suite-load errors. The earlier38-failure figure from the
temporary Jest30 runner is superseded. Raj reports Node22.23.2/Jest29.7.0 on
27f35629. The new stable10-suite/23-test result was supplied as text, without
its raw locked-run JSON; the claimed PR-only classification is not independently
verified by the PR JSON alone.

All24 redirectCredentialIsolation failures stop at the same beforeAll native
availability precondition, before redirect assertions run. A direct Jest29
resolver probe reproduced an ordering-dependent mismatch between virtual and
installed Impit mock identities. The fixture now uses a constructor-throw mock,
and three suites no longer declare the installed Impit dependency virtual.
The six HTTP redirect failures are the obsolete custom-header expectation
already corrected above. This report does not show30 credential-leak defects.

The two Undici memory-TLS failures were reproduced on official Node22.23.2:
Jest29's VM lacks the host Symbol.dispose used by native abort listeners. Aligning
that symbol inside the fixture fixes cleanup without changing runtime TLS code.
Both transports now require the exact wrong-pin identity error and no HTTP
application data, alongside successful controls. guardedPublicEntries now
exercises actual handlers and guards in memory, mocking native allocation at its
factory boundary. It does not claim full HTTP-stack/native verification or a
proven explanation of the original timeout.

The expanded54-suite command passes515 tests plus1 TODO on both Node22.23.2 and
Node24.19.0 with installed Jest29.7.0. Detailed evidence and remaining limits are
in PR59_LOCKED_RECONCILIATION.md. The published head remains27f35629 pending
coordination and the isolated transport acceptance test.
