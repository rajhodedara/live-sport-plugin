# Session Checkpoint: Kafka Live Sports Provider Review and Repair
**Date**: 2026-11-23
**Status**: Completed

## 2026-11-24 update: Kafka/Trex coverage expansion (in progress, not implemented)

- Full context handoff: `docs/evidence-kafka-trex/HANDOFF_KAFKA_TREX_2026-11-24.md` (gitignored on purpose, it holds host details). Read it first.
- Verified: the upstream has 3 catalogs; NBA/NFL/NHL/MLB coverage lives in the generic `flix-live-tv-v2-trex` catalog as team channels, per-game event channels and RSNs, not in the two dedicated sports catalogs.
- Catalog health audit tool exists as new files only (`scripts/run_stratified_health_audit.js` + three `src/services/Health*.js` modules, 28 tests). Measured: 85.7% +/- 2.9% of channels answer, but 39% of those are frozen `MEDIA-SEQUENCE:0` slates, so a liveness guard is mandatory before widening Kafka coverage.
- Agreed design: small pre-normalized index (team + sports channels, ~1 MB, +2.5 MB per worker, refreshed daily by a standalone job) plus live `search=` for event channels near kickoff. Memory measured on the VPS: a sync already costs +119 MB per worker; the index is 2% of that.
- 2026-11-24: owner chose the SQLite design (all 54k rows on disk, daily refresh, click-path event search, frozen rule in `verifyStreams`) and set the priority: event channel first (it carries the 4K/FHD feeds), then team channel, then broadcaster label. Design approved: `docs/superpowers/specs/2026-11-24-kafka-trex-catalog-coverage-design.md`. Implementation plan written (9 tasks): `docs/superpowers/plans/2026-11-24-kafka-trex-catalog-coverage.md`; execution method not yet chosen; no code written.

## 2026-11-24 update: Unregistered TimStreams and PitSport providers (PNG steganography breakage)

- Upstream embeds on `embdlol.st` / `vixnuvew` moved to canvas pixel PNG steganography, breaking direct HLS extraction for TimStreams and PitSport.
- Deactivated both providers from active catalog sync and carry-forward:
  - Added `isEnabled()` method to `TimStreamsProvider` (`TIMSTREAMS_ENABLED === 'true'`) and `PitSportProvider` (`PITSPORT_ENABLED === 'true'`), defaulting to `false`.
  - Gated their inclusion in `src/services/MatchAggregator.js` so they are not included in `this.providers` by default, preventing catalog scraping and duplicate/ghost card creation.
  - Dynamically gated `CARRY_FORWARD_PROVIDERS` in `MatchAggregator.js` so `pitsport` is only carried forward if active in `this.providers`.
  - Updated `tests/pitSportProvider.test.js` and `tests/timStreamsProvider.test.js` to assert default deactivation in `MatchAggregator.providers` and successful registration when explicitly enabled.
- Verification:
  - `npm test -- tests/pitSportCatalogCarryForward.test.js tests/pitSportTransientRecovery.test.js tests/timFeedIsolation.test.js tests/timStreamsChannels.test.js tests/timStreamsStreamDetails.test.js tests/timStreamsTransientRecovery.test.js tests/streamHardDeadline.test.js tests/streamPartialRecovery.test.js tests/streamPriorityQuorum.test.js tests/streamResolutionAndMetadataRecovery.test.js tests/timStreamsProvider.test.js tests/pitSportProvider.test.js` — 36 suites, 429/429 tests passing.
  - `node --check` passed for all modified source and test files.
  - `git diff --check` clean.
  - `npm run build --ignore-scripts` verified into `dist.next/` and syntax checked with `node --check dist.next/index.js`.

### What Was Completed
- Reviewed the Kafka implementation against repository standards and `docs/superpowers/plans/2026-11-23-kafka-live-sports-provider.md`.
- Kept the enrichment-only architecture: `src/providers/KafkaProvider.js` returns no standalone matches and resolves `/stream/tv/{metaId}.json` through guarded egress.
- Wrapped resolved Kafka streams through `/api/manifest` proxy (`${BASE_URL}/api/manifest?url=...`) preserving upstream Referer/Origin headers while keeping media byte delivery zero-bandwidth direct from the CDN.
- Made `KAFKA_CATALOG_ALLOWLIST` optional: an empty value automatically discovers dynamic sports/event catalogs from manifest taxonomy, while a non-empty value remains an exact override; the generic all-TV Trex catalog is always excluded.
- Prevented bearer-path disclosure by replacing raw upstream exception messages with bounded error kinds in `src/providers/KafkaProvider.js` and `src/services/MatchAggregator.js`.
- Added a 1,000-item per-catalog cap and made partial catalog failures retain the complete last-good index instead of publishing a partial replacement.
- Forwarded the stream request abort signal through `src/streams.js` into Kafka's guarded `proxyFetch` call.
- Restricted Kafka enrichment to upcoming/live fixtures, excluding finished/ended events and fixtures more than 14 hours past kickoff.
- Added Kafka refresh and attachment telemetry through generic auxiliary/enrichment methods in `src/services/ProviderHealthService.js`.
- Fixed Kafka test environment restoration and replaced future fixture dates with deterministic values.
- Added regression coverage for secret-safe logs, item caps, partial-refresh retention, abort-signal forwarding, stale-fixture exclusion, provider-health telemetry, and `/api/manifest` proxy wrapping.
- Verification passed:
  - `npm test -- tests/kafkaProvider.test.js tests/kafkaAggregator.test.js tests/kafkaRegistration.test.js tests/kafkaDispatch.test.js` — 34/34 passing.
  - `node --check` passed for all modified JavaScript and test files.
  - `git diff --check` passed for the reviewed files.
  - `npm run build --ignore-scripts` completed successfully into `dist.next/` and verified with `node --check dist.next/index.js`.

### Current Blockers / Open Questions
- No code blocker remains.
- A production-shaped smoke test with the owned `KAFKA_MANIFEST_URL` is still needed to measure real catalog coverage, broadcaster match rate, and stream playback without logging the bearer URL.

### Immediate Next Steps for Next Chat
1. Deploy with `KAFKA_ENABLED=false`, add the manifest URL through runtime secrets, and enable one allowlisted sports catalog.
2. Verify provider-health index/attachment counts and resolve one controlled fixture without printing its playback URL or profile slug.
