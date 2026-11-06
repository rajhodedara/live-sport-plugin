# Stream refresh reliability

This correction addresses direct streams disappearing between refreshes when extraction, verification or local transport capacity temporarily fails. A usable web fallback can remain visible while direct extraction is retried; a temporary failure must not become a long-lived successful direct verdict or a definitive dead-source verdict.

## Resulting behavior

| Area | Behavior |
| --- | --- |
| PPV.st child failures | Typed local capacity, timeout and cancellation cross the child boundary through private exit codes 75, 76 and 77. The parent restores typed errors. Ordinary extraction failures retain the existing fallback behavior. Classification validates the complete bounded cause chain and fails closed for fatal/guard errors, cycles, truncation and unreadable properties; stderr text is not a retry signal. |
| TimStreams partial extraction | Temporary extraction evidence stays associated with the returned array through final verification. If every extracted direct URL then fails verification, a surviving web fallback receives a short retry lifetime. A verified healthy direct URL keeps normal positive caching. |
| ScoreZone breaker | Only the existing `ScoreZone_fetchStreams` breaker filters typed inconclusive errors. These errors propagate without invoking its fallback or counting against breaker health. Ordinary provider failures keep existing behavior. |
| Response quorum | Readiness counts distinct source keys with publication-eligible direct media or YouTube rows, after the relevant policy, prematch and exact-URL checks. Web-only rows do not satisfy direct readiness. Warm cache hints remain bounded if their entries expire during the read. |
| Partial HTTP response | A response with pending or retryable sources uses `max-age=2, stale-while-revalidate=0, stale-if-error=0`, including when another provider already supplied media. Complete responses keep `30/30/60`. These headers permit an earlier retry; they do not make the client refresh automatically. |
| Optional HLS quality probe | The default 3.5-second deadline includes queue wait, manifest and segment work. Queued jobs that expire do not start transport. Each fetch gets only the remaining time and one attempt. Failure returns no measurement, preserving the existing fallback quality label. |
| Leaf overlay changes | Invalidation targets the exact match's canonical `leaf:` entries and retained publication references. PPV.st, TimStreams and other providers remain cached. Ended-match pruning still applies across providers. |

All selected providers still launch. A provider finishing after the response cutoff can warm the cache for a subsequent request, without changing the response already returned.

## Cache and concurrency safeguards

The local cache keeps trusted, verified web-only retry results positive for at most two seconds. A private retry hint carries that state through the existing shared `ok` payload; the resolver's `ok/failed/minting` vocabulary is unchanged. Provider-supplied hints are stripped before storage. Public stream clones remove the internal hint, and an adopted shared retry result is clamped to the same short lifetime. Ordinary successful direct results and definitive web fallbacks retain their existing cache lifetimes.

A slow shared-cache POST can outlast the provisional local retry entry. After publication completes, the same operation may rearm only that temporary web entry, for at most two seconds. Explicit failure, Leaf invalidation, pruning, a newer local result and cache eviction prevent rearming. A retained publication reference preserves this fence even if an expiry reader already removed the map entry. Expired media URLs are never rearmed, and success feedback cannot extend a temporary web retry entry or revive expired media. Shared invalidation remains revision-fenced.

Quality-probe caller deadlines do not pretend that a canceled transport has physically stopped. An uncooperative fetch or body retains its active slot and same-key single-flight until it actually settles. FIFO handoff therefore stays within the existing concurrency limit even after a caller has received `null`. This patch does not enlarge global native pools or cache limits.

## Selected offline validation

The final source/test snapshot passed **308/308 tests across 26 selected suites**, two independent reviews and 20 JavaScript syntax checks. The offline build passed, including all 65 timezone controls against IANA 2026f. The packaged PPV child helper is byte-identical to its source. These counts describe the selected regression set below, not the entire repository suite.

From the repository root, with dependencies already installed and Node 22, run the selected regression set below. The inherited boundary blocks actual sockets, listeners and workers; provider/native/child behavior in these suites is mocked or exercised in a VM/in-memory adapter.

```sh
NODE_OPTIONS="--require=$PWD/tests/fixtures/pr59-offline-boundary.cjs" \
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath \
  tests/streamPartialRecovery.test.js \
  tests/streamPartialRecoveryShared.test.js \
  tests/streamResolveDeferredOutcome.test.js \
  tests/streamVerifyDeadlineOutcomes.test.js \
  tests/streamPriorityQuorum.test.js \
  tests/streamHardDeadline.test.js \
  tests/streamExternalFallback.test.js \
  tests/streamPolicy.test.js \
  tests/timStreamsTransientRecovery.test.js \
  tests/timStreamsStreamDetails.test.js \
  tests/timStreamsProvider.test.js \
  tests/timFeedIsolation.test.js \
  tests/ppvStWasmCapacityOutcome.test.js \
  tests/ppvStWasmChildProtocol.test.js \
  tests/ppvChildCompletion.test.js \
  tests/ppvAlternateOnly.test.js \
  tests/scoreZoneIptvCapacityDeferral.test.js \
  tests/scoreZoneProductionDeferral.test.js \
  tests/scoreWiring.test.js \
  tests/circuitBreakerFallbackDiagnostic.test.js \
  tests/hlsQualityProbeDeadline.test.js \
  tests/liveOverlayService.test.js \
  tests/liveOverlayStreams.test.js \
  tests/leafOverlayCacheScope.test.js \
  tests/leafResolveCacheIntegration.test.js \
  tests/streamResolveConcurrency.test.js
```

The publication regressions cover slow POST completion, expiry reads, explicit failure after expiry, pruning, newer replacements, LRU eviction and Leaf invalidation. Shared-cache tests use the real pure resolver table through an in-memory adapter, including cross-cache retry recovery. The quality-probe tests use controlled transports and clocks; their bounded timings are not a production latency benchmark.

## Scope and remaining limits

These checks establish local behavior, not live provider availability, successful playback, server RAM usage or production speed. No VPS operation is part of this correction. Native capacity saturation can still prevent a request from resolving immediately; the change preserves its temporary classification and retry behavior.

The narrow Leaf invalidation does not redesign pre-existing stale shared Leaf adoption after a completed publication, or overlay changes while a provider is still minting. TV quorum admission still precedes the existing Vavoo/SKTech resolution-deduplication stage, so it does not guarantee five final distinct variants. The existing stale-owner vacant-claim retry can briefly publish an already invalidated payload before revision-fenced invalidation removes it; this patch does not redesign that protocol.
