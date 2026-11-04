# PR59 integration and validation

Current integration: [STABLE_925_INTEGRATION.md](STABLE_925_INTEGRATION.md). The target and counts below are historical.

This candidate integrates stable `a71e49f377a64a76f83104a2fdc03823df43cc84`
with the reviewed published PR59 `e91e9b9f1f031ffde5447fab401942a121de3e5c`.
It is a draft for review, not a production deployment. It does not require
merging PR61 first. STABLE_A71_INTEGRATION.md records the latest integration.

## Resulting behavior

- TimStreams retains stable's new API host and first-hop Referer at
  tim-streams.com. The upstream QEMU and amd64/arm64 workflow declarations are
  preserved; no real arm64 image build or execution is claimed here.
- Leaf retains stable's per-install configuration, manifest-only relay and URL
  sanitization, and its metadata requests use ProviderOutbound.
- SoccerFull's new manifest route and bounded segment probes use the shared
  guarded path. Guard rejection and local capacity are reported as 403/503 with
  no-store; truncated playlists cannot become cached successful rewrites.
- SoccerFull adds HLS version 4 when injecting byte ranges into a versionless
  playlist. Published SoccerFull manifest URLs use the incoming request base.
- All nine flat-copied child scripts resolve ProviderOutbound in both layouts.
  The India extractor flushes a playlist configuration before exiting normally.
- Default native capacity stays four slots. Bounded FIFO admission uses the
  existing total request deadline, at most 128 waiters and a five-second queue
  budget per admission. Diagnostics distinguish `expired` from `queue_full`.
  Sustained load can still reject work; this does not prove faster synchronization.
- Redirects crossing an origin retain only Accept, Accept-Language,
  Accept-Encoding, User-Agent, Range, Content-Type and Content-Encoding.
  Referer, Origin and custom credential headers are removed and not restored
  by a return hop. Values, request bodies and URLs are not sanitized by this
  policy. Providers requiring cross-origin credentials need compatibility review.
- A provider sync timeout updates its health record. A late result from that
  timed-out attempt cannot overwrite a later health result. This does not
  cancel the provider or prevent its internal state from changing.
- Shared resolve-cache publications carry revisions. Conditional invalidation
  cannot erase a newer publication or release an unrelated mint claim. See
  PR59_SUITE_RECONCILIATION.md for the reproduced race, mixed-version limits and
  the separate fixture corrections made after the published 27f35629 review.

## Deployment choice required before merge/deployment

Legacy unauthenticated TCP resolver proxying and L2 cache traffic are disabled
by default. Local provider resolution and local resolve caching continue.
Resolver-dependent public APIs return 503 until a transport is selected.
Choose the pinned Unix/TLS transport described in RESOLVER_ISOLATED_TEST_PLAN.md,
or explicitly set `RESOLVER_TRUST_LEGACY_TCP=true` only in a trusted-local
compatibility deployment. The latter preserves the old TCP behavior and does
not authenticate the listener. Do not silently add this flag as a security fix.
Existing TLS configuration must be valid; an invalid explicit mode cannot
fall back to HTTP. Stable's Leaf configuration is still required independently.

## Reproducible local checks

With Node 24 and installed dependencies:

```sh
node scripts/test-pr59-offline.cjs
npm run build
```

The offline runner selects 64 suites and blocks real worker construction,
network connections and listening sockets. Current result: 636 tests pass,
with one existing TODO for clustered resolver ownership/replacement. The TLS
handshake tests use memory streams. Slow-mint cache tests use a child Node
process with stubbed I/O; these are not real resolver-service tests.
The expanded selection passes on Node22.23.2 and Node24.19.0 with Jest29.7.0.
PR59_LOCKED_RECONCILIATION.md reconciles the newly delivered full PR report and
records the Node22/Jest fixture correction. Runtime code is unchanged by that
fixture-only follow-up.

The full Jest suite is not a validation claim. HTTP listener, native binary,
WASM and real-process integration suites are excluded from the offline command.
Earlier boundary runs identified those real-server suites and they were removed
from this offline selection; their failure under the network block is not a
passing integration result. Packaging, redirect, cancellation, shutdown,
capacity, health, date/identity, provider and cache fixtures run in the selected
set. Date tests use a controlled clock, not the machine's current date.

## Two review passes and practical limits

The first pass resolved stable interactions and identified unguarded SoccerFull
requests, stale test mocks, broken build imports and unresolved default TCP
trust. The second pass independently reviewed the resulting trust gates,
redirect behavior and integration, and found the SoccerFull HLS version and
published URL omissions, which were corrected and tested.

There is no claim of zero defects or full SSRF coverage. Previous Raj deployment
results apply only to their recorded SHAs, not automatically to this tree.
This candidate still needs the target deployment's transport choice and an
isolated runtime/playback check. PPV.st's observed upstream 403 is unresolved:
extracting a playlist does not establish playback. WARP, real Stremio/Exo/Nuvio
compatibility, custom AK47 User-Agent and sustained production-like load are
not proven by these local checks. Do not replace a failed upstream response
with a successful test fixture or relax the destination guard to make playback
appear successful.

After integration, PR61 must be reconciled with this PR59 candidate separately.
No secrets, private captures or token-bearing URLs are included in this report.
