# PR61 local integration review

Prepared locally from PR61 `53c8afc873f8dd88395692994677d44a21f2750b` and
published PR59 `27f35629f880306589ca51f676002c7a2b73e79a`, which includes stable
`94042c2d5d8251cd4dee83323c0b61bff9882043`. The merge applied without conflicts.
The local PR59 follow-up `ad4857ed0d341d294a5c16348e3fa8ec67b9a3d4` is also
integrated, including fixture reconciliation and revision-based L2 invalidation.
This report does not publish the branch or authorize merge/deployment. The
PR59_SUITE_RECONCILIATION.md report records the remaining full-suite/runtime gaps.
The mapping follow-up is integrated on top of local PR61 7d72771; see
PR61_MAPPING_REVIEW.md for reproduced association defects and compatibility limits.

## Behavior and compatibility

- The PR59 destination guard, redirect policy, resolver trust choice, native
  admission limits, provider-health behavior, Leaf install configuration and
  SoccerFull fixes are preserved. PR61 does not require weakening those guards.
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

Current result: the inherited 54-suite PR59 selection passes 515 tests and has
one existing TODO. The PR61 selection passes 400 tests in 53 suites. Seven
additional Node-runner checks pass. Total: 915 Jest tests and seven Node tests;
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
Keep the published heads fixed until the user reviews the local result and a
new test SHA is agreed. No zero-defect guarantee is made.

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

The locked PR59 report has now arrived and is reconciled in
PR59_LOCKED_RECONCILIATION.md. Its fixture-only follow-up preserves all PR61
runtime/mapping changes. The complete combined command passes915 Jest tests and
7 Node tests on both Node22.23.2 and Node24.19.0, with1 existing TODO. Runtime
source and dependency files are unchanged since the mapping candidate98afbdc,
whose build passed.
