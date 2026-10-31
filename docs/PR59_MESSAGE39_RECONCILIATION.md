# Received full-run evidence and fixture follow-up

This records the initial received comparison and its fixture follow-up. For
the subsequently received updated Windows and Linux reports, current runner
totals and remaining focused acceptance, see PR59_WINDOWS_UPDATED_REVIEW.md.

The supplied `full-stable.json`, `full-pr59.json`, `full-pr61.json`, and
`comparison.json` have been audited independently. The narrative associates them
with stable a71e49f, PR59 89745b0 and PR61 90a2e55. All recorded suite paths are
Windows review checkouts. The Jest JSONs do not themselves embed a source SHA,
version or command line; the Linux/socket runs are separate narrative claims.
Raw machine-specific paths and stacks are not committed here.

## Verified comparison of the received runs

| Run | Suites | Passed | Failed | Pending | TODO | Total tests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| stable | 138 | 1421 | 76 | 1 | 0 | 1498 |
| PR59 | 208 | 1816 | 59 | 1 | 1 | 1877 |
| PR61 | 246 | 2026 | 61 | 1 | 1 | 2089 |

All totals reconcile with the assertion records. One pending case was omitted
from the narrative's table. Its existing match-cache concurrent-replacement
case remains pending in both PRs; neither PR changes a shared passing/failing
case to pending. Both add the same resolver ownership/replacement TODO.

The supplied comparison is correct for unique `suite :: fullName` identities.
Duplicate parameterized titles explain the apparent count discrepancies; no
duplicate in these files mixes statuses. In particular, two failed POST cases
have the same fullName in all three runs. Occurrence-preserving equations are:

- PR59: 59 failures = 51 shared failing assertions + 8 added failures.
- PR61: 61 failures = 50 shared failing assertions + 11 added failures.

There are zero shared identities changing from passed on stable to failed in
either PR, and 25/26 shared identities change from failed to passed. Those latter
results include fixture/timing differences; they do not prove 25/26 runtime fixes.
The 13 absent passing identities were reviewed separately: four redirect
representation cases have replacements under the stricter cross-origin header
allowlist, while nine speed-probe identities reflect a shared-guard refactor,
manual redirect handling and bounded reading. Their absence is not, by itself,
proof that all old behavior/coverage is equivalent.

## Findings and repairs

- Seven added failures common to both PRs are native-path fixture or Unix
  permission-contract mismatches on Windows. Mocked identity/socket tests now
  use canonical native absolute paths while preserving raw traversal rejection.
  Packaging expectations use native paths. The real UID/mode/symlink test skips
  Windows explicitly and keeps its Unix assertions.
- PR61's other four added failures come from a slash-sensitive YAML fixture
  returning no provider. Its follow-up uses the exact native input path and
  asserts provider creation before testing parsing/resolution.
- PR59's eighth added failure is the 150ms redirect/body deadline case in
  `guardedOutboundDeadlineHttp`. The redirect was observed, but the final body
  request was not. It passes in the PR61 raw run. This is timing-sensitive
  evidence, not proof of harmless flakiness or a production regression. The
  claimed separate 80/80 serial run is not included in these four JSONs.
- Forty-one shared failures occur while VM fixture helpers initialize, before
  their router/static assertions. Their LF-only import stripping is incompatible
  with CRLF source. The adapters now handle both line endings. Static file URLs
  and asset expectations also use real native paths; router/static production
  logic and every original assertion remain intact.
- Two shared speed-metric failures use an obsolete simulated response with only
  `arrayBuffer()` and no streaming body. A focused run reproduced both failures.
  The fixture now supplies a fresh readable body per fetch, keeps the actual
  metric/bitrate assertions and prohibits the unbounded fallback. Missing-range
  cases also have valid bodies, so they test the missing-range condition.
- The lost multi-chunk sampling boundary is restored: chunks 4/8/8 against a
  5-byte budget return 5, read exactly twice, cancel once and release once. The
  oversized single-chunk case also asserts a single read.

The narrative incorrectly lists `safeFetchDeadlineHttp` and
`beforeAndAfterBenchmark` among shared failures: their failing stable cases pass
in both PR raw runs. No product speed-up is inferred from a passing benchmark.
The remaining shared-cache integration failures and PR59's stale-date AK47
fixture are not claimed fixed by this follow-up.

## Local validation of the follow-up

Node 22.23.2 and Node 24.19.0, installed locked Jest 29.7.0:

```sh
node scripts/test-pr59-offline.cjs
```

Both pass 60 suites, 583 tests, with 1 existing TODO. The runner adds five existing
mocked/local suites (streamVerifyRetry, resolverRequestUrl, resolverStaticErrors,
isolatedNativePackaging, checkResolverRuntime); no previous suite is removed.
An additional Node 22 run presents CRLF bytes for the two VM source files and
passes all 41 cases. This checks CRLF handling on Linux, not Windows execution.
Two independent read-only reviews found no blockers in the fixture/runner
changes. Runtime source, dependencies and workflows are unchanged.

These selected results do not establish a full-suite pass after the changes.
They also do not authenticate the separate Linux offline, listener/native,
Unix-socket or in-memory TLS runs reported in message39. The real deployed
systemd/pinned-TLS/worker/restart matrix and provider/player acceptance remain
as described in the existing isolated-test and integration plans.
