# Session Checkpoint: Kafka Event-Only Playback
**Date**: 2026-11-25
**Status**: Completed (local implementation & verification; rollout/flag activation deferred)

### What Was Completed
- Implemented [docs/superpowers/plans/2026-11-25-kafka-event-only-playback.md](file:///C:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/docs/superpowers/plans/2026-11-25-kafka-event-only-playback.md) while keeping `KAFKA_EVENT_FIRST_ENABLED=false` rollback default intact:
  - `src/services/TrexEventSearch.js`: Removed the 6-candidate truncation and early stop in `_searchEventFirst`, ran both alias queries within the bounded upstream budget, and returned `{ rows, partial }` so single-alias failures preserve available hits without poisoning negative cache.
  - `src/providers/KafkaProvider.js`: Added `upstreamMinLocal()` (`KAFKA_EVENT_UPSTREAM_MIN_LOCAL`, default `6`) and preserved `_kafkaEventScore` onto `StreamEntity` in `resolveStream` when `KAFKA_EVENT_FIRST_ENABLED=true`.
  - `src/domain/StreamEntity.js`: Preserved `_kafkaEventScore`, `_isChannelFallback`, and `_kafkaMatchMode` across entity creation and cache cloning.
  - `src/services/StreamResolutionOutcome.js` & `src/services/StreamResolveCache.js`: Added WeakMap-backed `markPartialStreams` / `partialStreamsTtlMs` (`2000ms` short freshness, `partial: true`, `isDeferred` support, no L2 premature publish, `noteSuccess` guard) so HTTP requests settle at their deadline without holding 60s L2 claims.
  - `src/services/KafkaEventPlayback.js`: Rebuilt around a per-worker fixture coordinator (`fixtureJobKey(match)`), removing 2-stream and 6-candidate caps, merging deduplicated SQLite + upstream candidates, probing with 2 concurrent workers inside a 60s work deadline (zero timers), keeping every distinct playable URL per candidate, exposing live progress (`subscribeEventProgress`), and resuming pending candidates across clicks without re-probing completed IDs.
  - `src/services/LanguagePriorityService.js`: Added `_kafkaEventScore` ordering before `streamRankScore` among verified Kafka `'event'` feeds.
  - `src/services/ProviderHealthService.js`: Added `discovered` counter in `recordKafkaPlayback` / `recordKafkaSearchStats`.
  - `src/streams.js`: Bumped `:v3:` / `fixture-events-v3-` keys, removed `.slice(0, 1)` in `mintVerifiedSources` (verifying multiple URLs per candidate sequentially within one probe slot), decoupled probe `signal` from HTTP abort, surfaced live progress and released `readyToRespond()` past soft deadline when verified event progress exists, added `isChannelFallbackSource` / `applyFixtureChannelFallback` to hide broadcaster/team/linear channel fallbacks across providers (`kafka` non-event, `damitv`, `vavoo`, `cdnlive`, `timstreams`, `streamsports99`, `streamsports`, `moviebox_tv`, `daddylive` non-`Event Stream`, `scorezone` `sz_iptv_*`) once a verified playable Kafka event exists while preserving non-channel matchup feeds (`ppvst`, `sportsbite`, `moviebox_sports`, `roxiestreams`, `ak47live`, `sktech`, `sportzx`, `scorezone` fixture tokens), replays, 24/7 TV cards, and channel fallbacks on failure/timeout/policy block.
- Updated and verified tests in `tests/trexEventSearch.test.js`, `tests/kafkaCoverage.test.js`, `tests/kafkaDispatch.test.js`, `tests/providerHealth.test.js`, `tests/streamHardDeadline.test.js`, `tests/streamPartialRecovery.test.js`, plus focused regression suites and disposable v2 catalog replay.

### Current Blockers / Open Questions
- None locally. Production deployment, v2 SQLite catalog rebuild on VPS (`scripts/refresh_trex_catalog.js`), and `KAFKA_EVENT_FIRST_ENABLED=true` canary rollout are separate steps.

### Immediate Next Steps for Next Chat
1. Deploy updated `src/` + build on VPS, refresh the v2 Trex SQLite catalog (`scripts/refresh_trex_catalog.js`), and enable `KAFKA_EVENT_FIRST_ENABLED=true` on a canary worker first to monitor coverage, p95 latency, deadline fallback rate, and RSS before full activation.
2. User directive: DO NOT run match sync (`scripts/sync-matches.js`) on VPS updates unless explicitly requested by the user.
