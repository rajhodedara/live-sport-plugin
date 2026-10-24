# Fence shared-cache publications and releases by lease owner

Branch: fix/shared-cache-lease-ownership
Base branch / dependency: fix/shared-cache-claim-cleanup (PR #20).
Review additional changes against that base. This branch does not include the
other pending expiry, pending-prune, or response-deadline branches.

## Reproduced race

Worker A acquires a reservation and starts resolving. Its reservation expires,
then worker B acquires a new reservation for the same key and publishes a result.
Previously A could later overwrite B with an old positive/negative answer, or
its failure handler could unconditionally DELETE B's result or active claim.

Six of seven new cache-module tests failed before the fix. The legacy-protocol
compatibility control passed and remains supported.

## Change

- Opt into fenced reservations with GET ?claim=1&fenced=1.
- Return a fresh ownerToken for each fenced acquisition.
- Require the current unexpired owner token for token-bearing POST/DELETE.
- Reject missing tokens while a fenced reservation is active.
- Include the token in worker publications and provider-exception releases.
- Preserve expired-reservation cleanup from PR #20.

A worker using an older resolver that grants claims without owner tokens keeps
local resolution/caching but skips unsafe shared publication/release. Legacy
unfenced API calls remain supported for compatibility.

The owner identifier is a correctness mechanism, not an authentication system.

## Scope and rollout

Deploy the updated worker and resolver together to enable ownership protection.
Old workers remain unfenced; legacy operations without an active fenced claim
retain their prior behavior, so a mixed-version rollout does not provide universal
protection. An old resolver may retain a claim until its normal TTL while updated
workers use local-only results.

The protection applies to shared L2 publication and claim release by updated
workers. Local L1 caches are not globally invalidated: a late worker can still
cache its own locally resolved stream even if L2 rejects its publication.
This does not implement provider cancellation, claim renewal, distributed prune
cancellation, or ownership-aware health invalidations of already published entries.

## Validation

- Seven controlled-clock tests run the real ESM cache module, covering stale
  positive/negative publication, stale deletion of a result/claim, required
  ownership, valid owner operations, and legacy compatibility.
- Four worker-protocol tests cover fenced requests, token-bearing POST/DELETE,
  and local-only fallback to older resolvers.
- Two added real-HTTP integration tests replace A's reservation with B's and
  confirm late A publication/failure does not alter B's shared result. Natural
  expiry is covered by the controlled-clock tests; the HTTP tests explicitly
  release/reacquire to reproduce ownership replacement without a real TTL wait.
- Focused suite including claim cleanup and shared integration: 4 suites,
  23 tests passed.
- Full suite: 46 suites passed, 1 failed; 629 tests passed, 1 failed (630 total).
  The failure was existing Benchmark 9's relative timing assertion (2.087 ms
  versus 1.849 ms). On an isolated rerun Benchmark 9 passed, while Benchmark 4
  and Benchmark 10 timing assertions failed (8/10 passed). No benchmark assertions
  or production code for those measured algorithms were changed. Full suite is
  not green; the timing variability needs separate investigation.
- git diff --check passed. No live-provider playback or deployment was tested.

Workspace command:

```sh
npx jest --runInBand --silent --testPathIgnorePatterns='/node_modules/|/test-scripts/|/nuvio-proxy-2/|/tests/load/'
```

## Suggested PR title

Fence shared-cache writes and releases by lease owner
