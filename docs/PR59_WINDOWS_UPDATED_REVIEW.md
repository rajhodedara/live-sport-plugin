# Updated Windows results and focused follow-up

The received full-pr59-updated.json and full-pr61-updated.json are Windows
full-run reports following the earlier fixture update. Their intended targets
were PR59 f3dd4c3 and PR61 e80b97a. The files do not embed source SHA/tree,
versions or command metadata; that run record remains to be confirmed.
Machine-specific paths and complete failure stacks are retained outside Git.

## Verified raw comparison

| Report | Suites | Passed tests | Failed | Pending | TODO | Total tests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Updated PR59 | 208 | 1867 | 8 | 2 | 1 | 1878 |
| Updated PR61 | 246 | 2079 | 8 | 2 | 1 | 2090 |

Nested suite/assertion records reconcile exactly. Relative to each earlier PR
run, PR59 has 50 former failures now passing, and PR61 has 53. Each changes the
real Unix UID/mode test from failed to an intentional Windows skip; it is not
counted as a passing fix. The other pending case and resolver ownership TODO
remain unchanged. Each update adds the passing multi-chunk probe case and
removes no previous PR assertion identity. Duplicate POST test titles remain
represented as two separate occurrences.

PR59 retains seven shared-cache failures and the expired-date AK47 fixture.
PR61 retains the same seven cache failures and has one newly observed failure:
the hosted catalog smoke check exceeds Jest's default 5000 ms timeout. It passed
in stable, both older PR runs and updated PR59. This is a real pass-to-fail
observation; the reports do not establish a runtime product regression.

The previous path, packaging, VM and probe-response fixture failures now pass.
The guarded redirect/body deadline case also passes in both updated Windows
runs. Separate Linux JSONs each contain the exact complete 11-suite/80-test
HTTP/native/cancellation selection, all passed with no skipped/TODO cases.
Their names match the old selection exactly. This closes the previously
unreported six-suite PR61 Linux subset; it is not a deployed TLS acceptance run.

## Current follow-up

- The AK47 dated fixture uses a local Date.now spy restored in finally. It
  retains all date/team/title assertions. Import mocks prevent workers and
  unexpected upstream calls. PR61 uses the same fixture without global fake
  timers for this dated case.
- Shared-cache setup preserves the actual resolver server.js entrypoint and
  requires its own child's exact listening line, valid health JSON and fresh
  zero cache counters. It checks that child before every scenario. Startup
  failure includes its PID, exit state and bounded output; a foreign health 200
  cannot hide EADDRINUSE. Client environment is isolated/restored. Teardown
  waits for close and signals only that captured child. The final fallback
  scenario deliberately stops its own listener instead of assuming 7098 unused.
  The fixed 7099 port is documented honestly; PORT=0 maps to 3000 in env.js.
- Cache failure bodies still contain uppercase "Not found", matching the
  public application's private-cache gate rather than the resolver's JSON
  cache API. Wrong-listener startup is source-supported but not proved by the
  raw reports. The owned-child fixture diagnoses it; no runtime gate is relaxed.
- Controlled-clock guard tests check one 150 ms deadline across DNS, redirect
  and body with remaining request budgets 130/80 ms, plus late-DNS suppression.
  They are models, not physical socket cancellation evidence.
- Hosted smoke checks directly fetch the fixed deployed host and import no
  candidate application code. Their old catalog request allowed 6000 ms while
  Jest stopped waiting after 5000 ms. Catch-and-return could also mark transport
  failures as successful tests. The repair keeps request budgets 5000/6000 ms,
  gives those two cases explicit Jest limits 7000/8000 ms, and propagates fetch/
  JSON failures. Status/id/version/metas assertions and fixed URLs remain.
  A five-case offline audit executes the actual callbacks against controlled
  responses and proves visible errors and header/body deadline wiring.

## Validation and next run

Node 22.23.2 and Node 24.19.0 with installed locked Jest 29.7.0:

```sh
node scripts/test-pr59-offline.cjs
```

Both runs pass 64 suites/636 tests plus 1 existing TODO. Four suites were added:
the existing AK47 suite and the guard-deadline, owned-resolver and hosted-smoke
audit suites. PR61 moves AK47 out of its own selection because it now runs in
the inherited selection. No previous coverage is removed or counted twice.
Runtime source, dependencies and workflows are unchanged by this follow-up.
Earlier successful builds and HTTP/native results apply to unchanged code paths.

In each isolated updated checkout, run only the focused integration group next:

```sh
node node_modules/jest/bin/jest.js --runInBand --silent --json --outputFile=focused-results.json --runTestsByPath tests/sharedResolveCache.test.js tests/ak47LiveProvider.test.js tests/liveVsLocalComparison.test.js
```

Keep the raw JSON, command/exit code, SHA/tree, Node/Jest versions and complete
bounded startup diagnostics. If 7099 is occupied, leave that listener alone;
the fixture should report its own child's setup failure before cache assertions.
Do not interpret a setup failure as a demonstrated cache protocol regression.

Real shared-cache integration and hosted availability are not claimed to pass
from the offline audits. Their focused results, deployed pinned TLS/both workers/
restart acceptance and real provider/player checks remain pending. Another full
Windows or unchanged 11-suite Linux rerun is not needed for this test-only update.
