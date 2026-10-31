# PR61 integration review

The candidate starts from published PR61
`c952b588b14277dadae133764da589c97e3088c0` and now includes stable
`a71e49f377a64a76f83104a2fdc03823df43cc84`. The local PR59 integration
`324472c6b2a7cf0dee373db29825f9d72f8bbe74` is an ancestor, preserving its
guard, resolver policy, cache correction and reconciled fixtures. Both merges
applied without conflicts. This report does not authorize merge or deployment.
STABLE_A71_INTEGRATION.md records fresh validation and remaining acceptance.
PR59_SUITE_RECONCILIATION.md preserves the historical full-suite analysis.
The mapping follow-up is integrated on top of local PR61 7d72771; see
PR61_MAPPING_REVIEW.md for reproduced association defects and compatibility limits.

## Behavior and compatibility

- The PR59 destination guard, redirect policy, resolver trust choice, native
  admission limits, provider-health behavior, Leaf install configuration and
  SoccerFull fixes are preserved. PR61 does not require weakening those guards.
- Latest stable's TimStreams API and first-hop Referer use tim-streams.com;
  token-hop Referer/Origin remain bound to the embed page. The upstream QEMU
  and amd64/arm64 publication declarations are retained, without claiming an
  actual arm64 image build or runtime check.
- Scraper changes resolve relative links against their containing page and
  classify supported players by actual hostname/path, rather than domain-like
  text in a query. MLB/NFL bridge pages containing player names in query strings
  no longer skip iframe extraction. Malformed provider rows are isolated so they
  do not discard later valid events.
- Mapping preserves requested broadcaster country and signal identity, keeps
  explicit squad distinctions attached to their competitors, and rejects
  ambiguous legacy cache lookups. Known aliases, literal channel brands and
  Unicode names remain covered. Missing qualifiers can leave separate cards;
  this deliberately avoids inferring that their sources belong together.
- AK47 custom User-Agent is validated before the proxy URL and verification
  hints. Parent/child playlist URLs and cache identity preserve it. The final
  player response retains only bounded User-Agent, HTTP(S) Referer and Origin
  for AK47's direct media requests; Authorization, Cookie and custom headers
  are removed from those player hints. This is a provider-specific compatibility
  change. Allowed header values may still contain secrets (for example a
  Referer query); this validates shape, not confidentiality. A real player may
  ignore hints; actual playback is not established.
- PPV returns an explicitly labeled Web Player alternative beside extracted
  HLS. Verification still drops a refused HLS stream. When a verified direct
  stream exists, normal publication hides the web alternative; with web streams
  disabled it is hidden too. A PPV fallback-only cached result uses at most the
  existing negative-cache duration (30 seconds by default), so another HLS
  attempt is not delayed by a longer positive TTL.
- A Web Player link is a browser hand-off, not a successful HLS result. This
  does not solve the observed real upstream 403 or prove the embed plays.
- The shared-cache follow-up gives publications revisions and uses conditional
  PATCH invalidation. A delayed conditional invalidation cannot erase a different
  revision or release an unrelated mint claim. A publication invalidated/pruned
  while its POST is pending is retracted using its own revision. PPV's fallback
  TTL remains intact. Bulk pruning still uses active match IDs, not revisions.

## Reproducible checks

With installed dependencies, run:

```sh
node scripts/test-pr61-offline.cjs
npm run build
```

Current result: the inherited 64-suite PR59 selection passes 636 tests and has
one existing TODO. The PR61 selection passes 377 tests in 52 suites. Seven
additional Node-runner checks pass. Total: 1013 Jest tests and seven Node tests
across 116 Jest suites;
no claim of a full repository suite pass. Worker construction, socket connects
and listeners are blocked. The Node file's real-HTTP case is deliberately outside
this offline command. Manifest route/cache/HLS tag cases invoke real handlers
with mocked upstream I/O; they do not start a listener or contact a provider.

Scenario tests cover provider dispatch, simulated extractor success/failure,
HLS acceptance/refusal, Web Player publication, cache reuse/expiry/recovery,
web-stream settings, local overload, effective redirected bases, HLS key/map and
playlist references, request-host/UA cache separation, and safe AK47 headers.
The AK47 date fixture uses a fixed clock rather than a now-expired calendar date.
The actual build also completes. These are tests against controlled data, not
claims that the production-like transport, upstream servers or players work.

## Remaining acceptance evidence

PR59's newly reported full-suite differences and its pinned-TLS deployment test
must be reconciled separately. This candidate preserves that dependency rather
than bypassing it. PPV upstream 403 remains unexplained; real Stremio/Exo/Nuvio,
WARP and AK47 custom-UA behavior remain to be verified on an isolated runtime.
No production process, PM2 setting, signing key or raw private log is modified.
Use the exact newly agreed test SHA for each report; earlier target results
do not automatically validate this update. No zero-defect guarantee is made.

Independent review identified the pre-existing ownerless-DELETE race and a
controlled reproduction confirmed it. The integrated revision/PATCH correction
has nine scenarios, including failure/pruning during publication, local eviction
and resolver rollback. An older resolver rejects PATCH; snapshots without
revisions retain their existing bounded TTL instead of being deleted unsafely.
Upgrade the resolver and both workers together: old workers still use DELETE.
See PR59_TRANSPORT_MIGRATION.md for the coordinated rollout requirements.

The correction protects the entry observed when noteFailure runs. An older
manifest URL carries only a cache key, so its later failure can still target
that key's current entry. This is not proof that every stale-reader/cache race
is solved, and the reproduced invalidation bug has not been tied to Raj's logs.

Mapping validation includes all 8,147 complete committed catalog rows with
their group and real aggregation/cache/dispatch/publication against simulated
providers. Two independent reviews closed their findings. A fresh isolated
catalog sync is required to assess mapping changes; already-mixed persisted
rows cannot be untangled from their current aggregate alone. HTTP200 does not
prove the video content, and the mapping correction does not resolve DRM or
upstream access errors.

The locked PR59 report is reconciled in PR59_LOCKED_RECONCILIATION.md, and the
subsequent raw stable/PR59/PR61 Windows comparison is audited in
PR59_MESSAGE39_RECONCILIATION.md. This follow-up preserves all PR61 runtime and
mapping changes. The combined command now passes 1013 Jest tests and 7 Node tests
on both Node 22.23.2 and Node 24.19.0, with 1 existing TODO. Its YAML fixture uses
the exact native input path and asserts provider creation before testing event
links. Both candidate builds passed at the stable integration; runtime source,
dependencies and workflows have not changed in this test/documentation follow-up.

The updated full Windows reports and both complete Linux HTTP/native selections
have now arrived; see PR59_WINDOWS_UPDATED_REVIEW.md. The Windows redirect/body
case passes in both PRs, and each Linux selection passes 11 suites/80 tests.
Updated Windows PR61 still has seven shared-cache failures and one newly
observed hosted catalog timeout. The live test directly queries a deployed host
and imports no candidate application code; it does not establish a PR61 runtime
regression. The follow-up fixes its deadline ownership and failure visibility
while retaining its status/metas assertions. Real cache/hosted results still
need the focused run. The deployed pinned-transport/worker acceptance matrix
and real provider/player checks also remain pending.

AK47 now runs once in the inherited selection, with a narrow clock spy that
restores in finally. PR61's own selection removes that duplicate; no case is
lost. Owned-child and deadline/hosted models do not prove real integration.
