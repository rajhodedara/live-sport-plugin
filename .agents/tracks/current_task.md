# Session Checkpoint: Complete Removal of Leaf / Highfly Source
**Date**: 2026-11-24
**Branch**: `feature/remove-leaf-source`
**Status**: COMPLETED (all 6 tasks committed, tests 100% green)
**Plan**: `docs/superpowers/plans/2026-11-24-remove-leaf-source.md`

### Summary of Changes
1. **Decommissioned Leaf Route and Egress Policy (`d8a6a98`)**:
   - Deleted `src/routes/leafManifest.js`.
   - Removed `/api/leaf` from `src/index.js` routes, `STREAM_PREFIXES`, and stream-match regex.
   - Cleaned `isLeafTarget`, `validateLeafManifestUrl`, and `LEAF_PROXY_URL` from `GuardedEgressPolicy.js` and `impitClient.js`.
2. **Decommissioned LiveOverlayService & Overlay Freshening (`fd9d05f`)**:
   - Deleted `src/services/LiveOverlayService.js`.
   - Unregistered `LiveOverlayService` from `container.js`.
   - Removed overlay freshening cron loop and cache invalidation from `CronService.js`.
   - Removed overlay merging from `catalog.js` and `streams.js` (using direct `baseSources`).
   - Removed overlay builder from `MatchAggregator.js`.
3. **Unregistered Leaf Providers & Deleted Leaf Services (`e8d2af4`)**:
   - Deleted `LeafProvider.js`, `LeafRecapProvider.js`, `LeafDiagnostics.js`, `LeafInstallConfig.js`, `LeafMint.js`, `LeafRateLimitState.js`, `LeafState.js`, `LeafStreamProbe.js`, `scripts/leaf-health.mjs`.
   - Unregistered providers from `container.js` and `MatchAggregator.js`.
   - Removed replay & carry-forward provider entries from `catalog.js` and `MatchAggregator.js`.
4. **Deprecate Leaf from Streams, Scoring, and Caching (`f5abd9b`)**:
   - Removed `leaf` and `leaf_recap` from `src/streams.js` priority, known live/replay, nice names, and resolution dispatch.
   - Removed +30 direct CDN bonus and reliable sources entry from `StreamScoringService.js`.
   - Removed from `TimingRelations.js` and `StreamResolveCache.js`.
   - Updated test suites across `tiktokPrioritization`, `streamResolutionAndMetadataRecovery`, `streamPriorityQuorum`, `prewarmResolveKeyAndWarmth`, and `liveDropReport`.
5. **Deleted 29 Dedicated Leaf Test Suites & Cleaned Scripts (`002965a`)**:
   - Deleted all 29 obsolete Leaf and LiveOverlay test files.
   - Updated offline test harnesses `scripts/test-pr59-offline.cjs` and `scripts/test-pr61-offline.cjs`.
6. **Documentation & Env Vars Cleaned (`f026e82`)**:
   - Removed all `LEAF_*` environment variables from `.env.example`.
   - Updated `.agents/context/ARCHITECTURE.md` and `.agents/context/DECISIONS.md`.
   - Removed obsolete Leaf comments in `TimStreamsProvider.js`, `MatchAggregator.js`, and `streams.js`.

---

# Session Checkpoint: Kafka 24/7 Networks Enrichment and Priority Promotion
**Date**: 2026-11-24
**Status**: COMPLETED, MERGED to `stable`, and LIVE in production (`97450b2`)
**Plan**: `docs/superpowers/plans/2026-11-24-kafka-247-channels-enrichment.md`

### Production Rollout & Verification
1. **Priority Promotion (`1c80e46`)**:
   - `src/streams.js`: `SOURCE_PRIORITY.kafka: 1`
   - `src/services/StreamScoringService.js`: +35 direct Kafka bonus, +15 reliability bonus
   - `src/services/LanguagePriorityService.js`: Kafka comparison boost
2. **24/7 Channel Enrichment (`e895ecd`, `f243062`, `97450b2`)**:
   - `src/providers/KafkaProvider.js`: Detected `isChannel` (category networks / 24/7 TV Channels / `_ch_`), matched by `match.title` in `trex_catalog.sqlite`, attached all matching linear feeds (uncapped, whereas match fixtures remain capped at 1).
   - `src/services/MatchAggregator.js`: Removed exclusion filter for `match.category === 'networks'`, allowing 24/7 channel cards to receive Kafka sources during sync.
   - `src/services/TrexCatalogDb.js`: Indexed all 44,567 linear & entertainment/news channels into `channel_keys` (up from 6,852).
3. **Live Verification on VPS (`nuvio-sports` PM2 Cluster)**:
   - Deployed `97450b2` with `scripts/deploy.sh --no-pull`; health OK.
   - Run `node scripts/sync-matches.js`: Injected **6,024 Kafka sources** into **3,157 live fixtures and 24/7 channels** (up from 1,357 and originally 0).
   - Live stream resolution verified:
     - `Cartoon Network` (`dlv_ch_339_cartoon-network`): 16 streams, with 10 Kafka feeds (FHD 1080p · 6.8 Mbps, 4K IT 2160p · 3.5 Mbps, 4K NL 2160p · 4.1 Mbps, HD PL, FHD FR).
     - `CNN` (`dlv_ch_345_cnn`): 8 streams, with Kafka at Rank #1 (FHD 1080p · 7.1 Mbps, 4K 2160p · 5.4 Mbps).
     - `HBO` (`dlv_ch_321_hbo`): 6 streams, with Kafka at Rank #1 (HD US 1080p60 · 5.7 Mbps, FHD 1080p · 3.1 Mbps).
     - `Discovery Channel` (`dlv_ch_313_discovery-channel`): 7 streams, with 5 Kafka feeds (FHD DE 1080p · 6.1 Mbps, FHD FR 1080p · 5.1 Mbps).
     - Sports channels (`TNT Sports 1`, `Sky Sports F1`, `Fox Sports 1`) continue to lead at Rank #1.

---

# Session Checkpoint: Trex Catalog Coverage for Kafka
**Date**: 2026-11-24
**Status**: MERGED to `stable` and LIVE in production since 2026-11-24 05:51Z (`f434b1d`)
**Plan**: `docs/superpowers/plans/2026-11-24-kafka-trex-catalog-coverage.md` (9 tasks, all done)
**Spec**: `docs/superpowers/specs/2026-11-24-kafka-trex-catalog-coverage-design.md`
### Production rollout (2026-11-24)
- Deployed `4167c03` then `c74b081` then `f434b1d` with `scripts/deploy.sh --no-pull`; health OK each time.
- Catalog built on the box: `data/trex_catalog.sqlite`, 54,611 channels (237 team, 6,852 linear, 3,035 event), 8.1 MB, 138 s.
- `.env`: added `KAFKA_CATALOG_DB=/root/nuvio-live-sports/data/trex_catalog.sqlite`, removed the dead `KAFKA_INJECTION_CAP`; backup written beside it.
- Cron installed: `0 */6 * * * ` with `flock -n /tmp/trex-refresh.lock` and `--disable-warning=ExperimentalWarning`. Verified live: 143 s, exit 0, database replaced in place, no pm2 reload needed.
- Live result: 217 fixtures carry 402 Kafka sources (7 event, 126 team, 268 label, then 127 team after the last sync), and the rendered label shows measured quality, e.g. `1080p · 4.2 Mbps` and `2160p · 6.2 Mbps`.
- Two defects found by deploying and fixed: `prepare-build.js` wiped `data/matches_cache.json` on every build (now held and restored by `deploy.sh`), and the refresh job could not see `.env` from cron (now loads it itself).


### What changed
- `src/services/TrexCatalogKeys.js`: name normalization, team/channel keys, channel classification, quality and group scoring.
- `src/services/TrexCatalogDb.js` and `TrexCatalogStore.js`: SQLite schema, transactional full replace, read-only worker lookups, no catalog rows in worker memory.
- `scripts/refresh_trex_catalog.js`: nightly rebuild from the 546-page generic catalog, or from a CSV snapshot; a failed run leaves the previous database untouched.
- `src/services/TrexEventSearch.js`: click-path search for per-game event channels, live window -15 min to +4 h, trim-and-retry, request budget, 512 KB body cap, per-fixture cache.
- `src/services/StreamPolicy.js` and `src/streams.js`: frozen `EXT-X-MEDIA-SEQUENCE:0` playlist guard for Kafka streams, event feeds prepended on the click path.
- `src/providers/KafkaProvider.js`: `createSourcesForFixture` (event, team, label), `resolveEventStreams`, `sweepEvents`, `isCoverageReady`.
- `src/services/MatchAggregator.js`: attaches the prioritized sources, runs the 20-search sweep before enrichment, records `byMode` telemetry.
- Switches: `KAFKA_CATALOG_DB`, `KAFKA_EVENT_SEARCH_ENABLED`, `KAFKA_LIVENESS_GUARD_ENABLED`; deployment order in the handoff, section 5.2.

### Verification
- Kafka and Trex suites: 197/197 green across 21 suites (including the broadcaster and aggregator neighbours).
- Neighbouring suites: 61/61 (broadcaster, matchAggregator variants).
- `node --check` clean on every new or modified source file.

### Next
1. Operator rollout on the VPS in the order from handoff section 5.2 (deploy with the path empty, build the catalog, set the path, reload, cron, watch).
2. Whole-branch review before merging to `stable`.

---

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
