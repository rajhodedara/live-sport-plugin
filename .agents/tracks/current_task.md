# Session Checkpoint: Kafka Event and Channel Playback
**Date**: 2026-11-26
**Status**: Completed (local Tasks 1–3 implemented, committed, and verified; Task 4 VPS live validation & rollout pending deployment)

### What Was Completed
- Implemented [docs/superpowers/plans/2026-11-26-kafka-event-and-channel-playback.md](file:///C:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/docs/superpowers/plans/2026-11-26-kafka-event-and-channel-playback.md) across three commits on branch `stable`:
  1. `08fb3ce` — `feat(kafka): publish event and channel feeds together`
     - `src/streams.js`: Derived `mixedKafkaFixture` for live fixture cards with `KAFKA_EVENT_FIRST_ENABLED=true` and Kafka selected; removed channel suppression on the mixed path; ran `isBlockedStream` policy filtering before per-identity deduplication (`playbackIdentity` / `dedupeByPlaybackIdentity`) so blocked copies never suppress eligible copies while keeping event precedence only on identical playback URLs; allowed any direct Kafka row (event or channel) to satisfy soft-deadline readiness; formatted live fixture titles as `Kafka · Event` and `Kafka · Channel` while leaving 24/7 cards and flag-off mode unchanged.
     - Updated `tests/kafkaDispatch.test.js`, `tests/streamHardDeadline.test.js`, and `tests/streamPartialRecovery.test.js`.
  2. `6deb771` — `feat(kafka): rank mixed fixture feeds by quality`
     - `src/services/StreamBitrateProbe.js`, `src/domain/StreamEntity.js`, `src/streams.js`: Recorded `_kafkaVerifiedHeight` (from parsed manifest dimensions) and `_kafkaMeasuredBitrateBps` (from `probeBitrate`) onto Kafka rows and preserved them across `StreamEntity` and cache cloning.
     - `src/services/LanguagePriorityService.js`: Extended `compareStreams(..., { mixedKafkaFixture = false } = {})` to rank strong matches (`event`, `label`) before `team`/untagged rows by verified height, bitrate-tier fallback (`resolutionFromBitrate`), secondary positive measured bitrate, `event` provenance tie-break, and score, excluding claimed title quality tags from mixed quality comparison.
     - Updated `tests/languagePriority.test.js` and `tests/kafkaDispatch.test.js`.
  3. `ca40681` — `feat(kafka): configure event probe concurrency`
     - `src/providers/KafkaProvider.js`, `src/services/KafkaEventPlayback.js`, `.env.example`: Added `KafkaProvider#getEventProbeConcurrency()` reading `KAFKA_EVENT_PROBE_CONCURRENCY` once per instance (whole numbers `1..4`, default/fallback `2`), wired it into `withEventProbe` and both worker pool starts in `KafkaEventPlayback`, and documented default `2`, VPS target `4`, and rollback `2` in `.env.example`.
     - Updated `tests/kafkaCoverage.test.js` and `tests/kafkaDispatch.test.js`.
- Verified all 11 suites (`11 passed`, `176 passed`) and `node --check` on all modified JS files (`src/streams.js`, `src/services/LanguagePriorityService.js`, `src/providers/KafkaProvider.js`, `src/services/KafkaEventPlayback.js`, `src/services/StreamBitrateProbe.js`, `src/domain/StreamEntity.js`). Note: Jest exited after printing the 11-suite summary with `"Jest did not exit one second after the test run has completed"` (pre-existing handle in one of the non-edited suites; all 7 modified/core suites exited cleanly on their own).

### Current Blockers / Open Questions
- None locally. Task 4 steps 2–4 (isolated VPS 2-vs-4 comparison, live NBA/NHL window sampling, canary worker activation with `KAFKA_EVENT_PROBE_CONCURRENCY=4`) require running on the VPS.

### Immediate Next Steps for Next Chat
1. Deploy `stable` (`ca40681`) to VPS and run Task 4 steps 2–4: compare `KAFKA_EVENT_PROBE_CONCURRENCY=2` vs `4` in an isolated VPS process, then roll out mixed playback with canary `KAFKA_EVENT_PROBE_CONCURRENCY=4` (revert to `2` if latency, upstream errors, or RSS degrade).
2. User directive: DO NOT run match sync (`scripts/sync-matches.js`) on VPS updates unless explicitly requested by the user.

# Session Checkpoint: Sky Sports F1 Kafka Diagnosis
**Date**: 2026-11-27
**Status**: Diagnostic checks completed; intermittent live failure remains unattributed

### What Was Completed
- Read-only VPS SQL, upstream probes, isolated source handler replay, and live endpoint sampling. VPS git HEAD is `da4187e`. No application changes, reload, deployment, or match sync performed.
- Correct endpoint ID is `nuvio_sport_cdn_ch_xx_sky-sports-f1`. The bare internal ID returns an empty list by design and is not a valid reproduction.
- Attached Kafka IDs `1641637`, `1905859`, `691271`, `691270`, `317780` all returned HLS and recent segment bytes through guarded outbound. Extra IDs `30499`, `1388606`, `83453`, `79479`, `317779` passed the same checks.
- Correct live endpoint returned one Kafka UHD feed initially, then zero on several samples including loopback, then all five attached feeds on loopback/public and three consecutive final public samples (197/729/353ms). Fresh isolated full handler with a private local resolve cache returned all five in 3957ms.
- Confirmed `TrexCatalogStore._query` still returns `ranked.slice(0, 2)`. UK lookup selects two UHD rows, excluding healthy UK FHD/HD feeds. This is a coverage limit, not proof of the intermittent zero-result cause.

### Current Blockers / Open Questions
- Exact production worker/cache/verification stage causing earlier empty responses has not been captured. Do not assert negative caching, frozen streams, or global Kafka outage as proven causes.

### Immediate Next Steps for Next Chat
1. If failure recurs, capture source outcomes, cache status and worker identity for this channel without exposing tokens. Retain the 15-second HTTP deadline.
2. If implementing expanded channel coverage, treat channel candidate count separately from probe concurrency and preserve market identity. User has requested diagnosis, not deployment.

### Follow-up: intermittent resolution investigation
- Sampled live loopback requests using HTTP keep-alive and `/health` before/after. Both workers (3228494/3228531) returned only attached ID `691270`, despite all five passing independent probes previously. First round took 15094/15151ms with cacheMaxAge=2. Later samples ranged 9–14190ms and still one feed. One keep-alive socket changed workers later, so only samples with equal before/after PID establish worker attribution.
- During the first round, health reported 164/95 in-flight resolutions, 199/200 cache entries, 278/178 cache evictions and 126/119 deferrals added over the request interval. These are aggregate worker counters, not F1-specific outcomes. Do not claim specific native-slot saturation or a particular F1 negative entry was observed.
- Deterministic reproduction through real `mintVerifiedSources` with mocked Kafka timeout and private cache: first and second clicks both empty, one upstream call, cache status `failed`, TTL 30000ms, negativeHits=1. Kafka channel resolve defaults `preserveFailure=false`, catches the timeout into `[]`, bypassing resolve retries and inconclusive handling. Event candidate path sets preserveFailure=true, channel path does not.
- Separate deterministic cache reproduction: 201 concurrent successful mints with the default 200-entry cache produced only 200 nonempty caller results. Eviction occurs before `getOrCreate` rereads the entry to deliver the result. This proves successful resolutions can disappear under cache churn; it is not proof that this particular mechanism caused every observed F1 omission.
- No application changes, deployments, restarts or match sync performed. Next fixes to consider: retain typed transient failures for channel mints, preserve successful results for waiting callers across ordinary LRU eviction while respecting invalidation/pruning, and bound/background-prioritize work using measured load. Keep HTTP deadlines and guard transport limits intact.

# Session Checkpoint: Kafka Reliability Reverification and Plan
**Date**: 2026-11-27
**Status**: Reverification and draft plan completed; implementation not started

### What Was Completed
- Reverified real channel mint timeout -> failed/30000ms/one upstream call for two clicks, and 201 successful cache mints -> 200 nonempty caller results.
- Fresh paired live samples returned zero Kafka F1 feeds on both workers (14654/15093ms); all five attached upstream feeds subsequently passed guarded resolve, HLS and nonempty media-byte probes in 2163–3702ms. Aggregate health counters confirm churn but do not attribute each omission.
- Corrected baseline passed 8 suites / 123 tests. An earlier invocation included a nonexistent streamResolveCache test filename and was explicitly corrected; see RE-lab handoff for exact command.
- Draft design/evidence: `../nuvio-re-lab/kafka-reliability/HANDOFF.md`. Draft implementation plan: `../nuvio-re-lab/kafka-reliability/2026-11-27-kafka-resolution-reliability-plan.md` (4 tasks, 21 steps). Stored outside repo per workspace rule, self-reviewed for referenced existing paths and invalidation/expiry safety.

### Current Blockers / Open Questions
- Definitive attribution of each production F1 omission requires selected-source outcome traces. Proposed fixes cover independently reproduced defects and must not be represented as proof that all production contention is solved.

### Immediate Next Steps for Next Chat
1. Execute the plan if requested: channel failure propagation, active media delivery under LRU, cross-worker regressions and bounded traces, then isolated load/canary validation.
2. Preserve existing web-only LRU test semantics, event cache validity, two/four probe distinctions, HTTP deadlines and no-match-sync instruction. No application or VPS mutations were made in this planning turn.

# Session Checkpoint: Kafka Reliability Review Corrections
**Date**: 2026-11-27
**Status**: Local review corrections complete; deployment requested

### What Was Completed
- Reviewed `f3fd1b8`, `493d461`, and `48220cd` against the Kafka reliability plan and repository standards. The temporary-channel failure and active-delivery fixes passed the focused regression suite (14 suites, 189 tests).
- Corrected production tracing so a request-scoped Kafka trace receives cache outcomes, including an LRU eviction while the same operation is still publishing; normalized channel publication stage to `published`.
- Constrained `scripts/diagnostics/kafka-channel-reliability.js` to loopback HTTP(S) origins and a 1 MiB response cap. Optional upstream probes remain on guarded outbound.
- Added `tests/kafkaChannelReliabilitySampler.test.js` and extended the active-delivery test with the cache-eviction trace assertion. `node --check` passed for all changed runtime files.

### Current Blockers / Open Questions
- Full Task 4 isolated VPS load comparison and canary evidence remain to be collected after deployment. Do not represent unit coverage as proof that every production F1 omission is solved.

### Immediate Next Steps for Next Chat
1. Build, push, and deploy the reviewed reliability commits only through the manual staged workflow; do not run npm install, match sync, SQLite reindex, or a catalog reset.
2. Use the loopback-only sampler and selected F1 trace on both PM2 workers to collect post-deploy evidence before considering the separate top-two channel-coverage change.

### Follow-up: sampler deadline correction
- The reviewed reliability commit `f21838b` was pushed and deployed through a staged bundle swap with the VPS project-local IANA 2026f timezone data. No dependency install, match sync, SQLite maintenance, or catalog reset was run.
- A live two-sample diagnostic exposed that Node's request `timeout` is inactivity-based, so the sampler did not enforce its documented 22-second wall-clock limit under a slow active response. The sampler now owns an absolute timer which destroys the request and releases it at the deadline; the regression test uses a loopback server that keeps sending bytes without completing.
- The correction must be committed, pushed, and deployed before further live Kafka sampling. After its rolling reload, verify `/health` first; do not repeat the two-sample F1 diagnostic while the host is under load.
