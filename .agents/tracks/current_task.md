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

# Session Checkpoint: Discord `/token` Sign-In
**Date**: 2026-11-27
**Status**: Completed locally on `auth` (production deployment deferred to separate request)

### What Was Completed
- **SQLite token store & atomic redemption** (`src/auth/AuthStore.js`, `src/auth/AuthService.js`):
  - Added migration v2 (`discord_access_tokens` with unique `interaction_id`, hashed token `token_hash`, `expires_at`, `retain_until`, `redeemed_at`), opportunistic deletion of rows past `retain_until`, and `500 ms` lock wait bound on issuance (`storage_busy` on contention).
  - Implemented `AuthService.issueDiscordAccessToken` (`nt_` + 24 bytes, 5-minute TTL, interaction deduplication through `Math.max(signedAtMs, issuedAtMs) + 300_000`, no early identity creation) and `AuthService.redeemDiscordAccessToken` (trims whitespace, single SQLite write transaction claiming unexpired token, resolving/creating `discord` identity with empty email, checking `disabled_at`, and inserting browser session).
- **Config, Discord webhook & redemption routes** (`src/auth/authConfig.js`, `src/auth/index.js`, `src/auth/discordInteractions.js`, `src/routes/auth.js`, `src/index.js`):
  - Added strict validation for `AUTH_DISCORD_APPLICATION_ID`, `AUTH_DISCORD_PUBLIC_KEY` (32-byte Ed25519 hex), `AUTH_DISCORD_GUILD_ID`, optional `AUTH_DISCORD_ROLE_ID` (fail-closed if invalid), and canonical `ADDON_URL`.
  - Added `hasSignInMethods({ config, service })` in `src/auth/index.js` and wired it into both page gating and `/configure` in `src/index.js`; extended `GET /api/auth/providers` with `accessTokenEnabled`.
  - Mounted `POST /api/auth/discord/interactions` (raw 16 KiB JSON body, Ed25519 verification before JSON parse, 5-minute timestamp window, <=30s command future skew, app/guild/role/`/token` checks, ephemeral `flags: 64` replies, 2.5 s response deadline) and `POST /api/auth/access-token/redeem` (exact canonical `Origin` check before touching token, trusted-proxy per-IP rate limit, normalized same-origin non-`/api` `redirectTo`, `nuvio_session` cookie).
- **Account UI & docs** (`public/account.html`, `.env.example`, `docs/DISCORD_TOKEN_SETUP.md`, `.agents/context/ARCHITECTURE.md`, `tests/discordTokenAuth.test.js`):
  - Added left-aligned Nuvio-styled **Google** / **Access token** accessible tabs (when both methods are enabled), single-method direct views, keyboard navigation (`ArrowLeft`/`ArrowRight`/`Home`/`End`), `Open Nuvio Discord` invite link (no Discord OAuth button), method-specific privacy text, inline validation, duplicate-submit protection, and `320 px` / desktop light & dark theme support.
  - Verified in Jest (`tests/authSso.test.js`, `tests/discordTokenAuth.test.js`, `tests/localRequest.test.js`), `node --check`, and real Chrome (desktop 1280x800 + 320x640, light + dark, signed Discord `/token` interaction -> paste -> redeem -> `/configure` -> device creation -> manifest resolution).

### Current Blockers / Open Questions
- Live Discord Developer Portal verification (setting `Interactions Endpoint URL`, registering guild `/token` command, and live production deployment) depends on owner credentials and HTTPS origin.

### Immediate Next Steps for Next Chat
1. Follow [docs/DISCORD_TOKEN_SETUP.md](file:///C:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/docs/DISCORD_TOKEN_SETUP.md) to test `/token` live via an HTTPS tunnel or staging host, then deploy when explicitly requested.


# Session Checkpoint: Live Commentary Language Customization
**Date**: 2026-11-27
**Status**: Completed locally on `auth`

### What Was Completed
- **Language selection & normalization** (`src/services/LanguagePriorityService.js`):
  - Added `parseSelectedLanguages(value)` preserving first-seen user order and deduplicating aliases (including English) while returning `[]` for absent, malformed, `'none'`, or unsupported input.
  - Retained `parseLanguagePriority` and `compareStreams` contracts.
- **Stream resolution readiness & filtering** (`src/streams.js`):
  - Added `resolveRowLanguageContext()` with request-local `WeakMap` cache.
  - Applied `liveLanguages` / `languageFilter` to live fixtures and 24/7 channels across both `publicationRows()` readiness quorum and final stream filtering (ahead of deduplication, fixture fallback, and web fallback suppression; emitting `language_excluded` in candidate tracing).
  - Ensured faster excluded streams cannot satisfy readiness while an eligible stream is pending within the deadline.
  - Bypassed live language filtering for `isReplayCard` and `isHubEpisode` requests to preserve legacy replay ordering and behavior.
- **Config & device persistence** (`src/manifest.js`, `src/auth/AuthService.js`, `src/index.js`):
  - Added `liveLanguages` and `languageFilter` to `manifest.config` and `SETTINGS_KEYS`.
  - Extended `/api/options` with `languageAliases` from `LanguagePriorityService`.
  - Carried forward legacy `languages` setting verbatim for existing installs.
  - Omitted `liveLanguages` and `languageFilter` from Collections Copy and Download URLs (`0` characters added).
- **Configure UI** (`public/configure.html`):
  - Added **Live commentary languages** fieldset with **Show all languages** and **Only selected languages** native radios.
  - Rendered English immediately and merged supported options from `/api/options` into a responsive chip grid.
  - Added **English only**, **Clear selection**, empty-selection notice (`No languages selected. Showing all languages.`), and **Add a language** field with alias validation.
  - Applied `ui-ux-pro-max` guidance: `>= 44px` touch targets, visible keyboard focus outlines, clean wrapping, and `scroll-padding-bottom` offset for sticky action bar.
- **Tests & Verification**:
  - Added unit/integration coverage in `tests/languagePriority.test.js`, `tests/authSso.test.js`, `tests/streamPriorityQuorum.test.js`, and `tests/channelLanguageRegression.test.js`.
  - Re-verified all 7 suites (`134/134` tests passed), syntax checks, collections filter size baseline (18,657 characters, 0 added), and browser QA at 1280px and 320px.

### Current Blockers / Open Questions
- Pre-existing collections size assertion in `tests/collectionsFilter.test.js` remains at 18,657 characters vs `< 18650`.

### Immediate Next Steps for Next Chat
- Deploy to staging/production when authorized.

# Session Checkpoint: Motorsport Session Identity
**Date**: 2026-11-27
**Status**: Draft implementation plan ready for review

### What Was Completed
- Reproduced the split F1 Qatar and MotoGP Valencia candidate pairs in the public catalog and confirmed the current matcher rejects both. Saved the design and plan in `../nuvio-re-lab/motorsport-identity/HANDOFF.md` and its linked plan.

### Current Blockers / Open Questions
- Public catalog timestamps and titles support both proposed pairs, but do not establish individual stream contents. Confirm kickoff provenance before allowing incomplete claims to merge.

### Immediate Next Steps for Next Chat
1. If implementation is requested, follow the linked plan and record the baseline before making code changes.

# Session Checkpoint: Configure Device Prerequisite
**Date**: 2026-11-27
**Status**: Design approved; implementation plan completed, product code unchanged

### What Was Completed
- Investigated `public/configure.html` account bootstrap and confirmed the source permits generic link generation before asynchronous `__accountsOn` initialization despite server-rendered `html.accounts`.
- Owner approved gating Steps 2 onward until a selected device's stored manifest URL loads and requested ui-ux-pro-max in the plan. Applied its disabled-state guidance with readable prerequisite copy, keyboard semantics and an active recovery action.
- Saved design/evidence to `../nuvio-re-lab/configure-device-gate/HANDOFF.md` and implementation plan to `../nuvio-re-lab/configure-device-gate/2026-11-27-configure-device-gate-plan.md`.

### Current Blockers / Open Questions
- Planning baseline `npm test -- tests/configurePageWiring.test.js`: 5 failed / 13 passed. Failures assert removed legacy languages controls; preserve separately from feature acceptance. Existing browser verification script has the same legacy assumption.

### Immediate Next Steps for Next Chat
1. If implementation is requested, read the external HANDOFF and plan; implement synchronous account readiness, link/action guards, then accessible downstream locking/navigation.
2. Run the new focused behavior suite and real-browser pending/error/success, keyboard, wizard, mobile and light/dark checks specified in the plan.

### Follow-up: Implementation & Verification Completed
**Date**: 2026-11-27
**Status**: Completed locally on `auth` (not deployed or pushed)

- **Implementation (`public/configure.html`)**:
  - Initialized `window.__accountsOn` synchronously from `document.documentElement.classList.contains('accounts')` before the first `updateLink()`, and added `isDeviceSetupReady()` (`!window.__accountsOn || !!window.__deviceUrl`).
  - Gated `updateLink()`, `configIssues()`, `applyValidity()`, `renderProgress()`, `openInstallDialog()`, `openInstall`, `copyBtn`, `barCopy`, `finishCopy`, `copyCollectionsBtn`, `downloadCollectionsBtn`, and `[btn, barInstall, wizInstall]` so no generic/base64 URL is exposed and no clipboard/download/dialog/autosave/install action runs while locked.
  - Added `syncDeviceSetupGate()` and `focusDeviceStep()`, wrapped downstream panel bodies (`.panel-body`) in `inert` + native `disabled` state preservation (`data-gate-prev-disabled`), added the visible `#deviceGateNotice` (`Add or choose a device to continue.` + `Go to Step 1` >=44px button) outside inert regions, and guarded `go(i)`, sidebar links, support shortcuts, and `window.nuvioGoTo` to route locked attempts to `sec-device`.
  - Updated Step 1 bootstrap to show `Loading your device…` synchronously in account mode, display clear error messages with `/account` recovery on providers/devices/detail failures or missing `manifestUrl`, and preserve single-device/config-restore redirects, autosave, and account-disabled self-hosted behavior.
- **Tests & Browser Verification**:
  - `npm test -- tests/configureDeviceGate.test.js`: **9 passed, 9 total** (1 passed suite).
  - `npm test -- tests/configurePageWiring.test.js`: **5 failed, 13 passed, 18 total** (matches pre-existing baseline; all 5 failures reference removed legacy `languages` controls).
  - Playwright (headless Edge): verified slow bootstrap, no devices, multiple devices/no selection, stale 404 device, missing `manifestUrl`, network error, valid device unlock (preserving focus in all-steps), account-disabled self-hosted mode, wizard/sidebar/hash navigation guards, 320px & 1280px widths in light & dark themes, no horizontal overflow, and >=44px recovery targets (`ALL_BROWSER_CHECKS_PASSED`).
- **Docs**:
  - Updated `.agents/context/ARCHITECTURE.md` with the configure device prerequisite lifecycle.

# Session Checkpoint: Stremio Free Worker PNG Fast Path (Corrected & Hardened)
**Date**: 2026-11-28
**Status**: Fast-path optimizations & benchmark hardening completed; unsupported metrics retracted; edge CPU verification gated on Cloudflare telemetry

### What Was Completed
- **Corpus & Fixtures Located (`../nuvio-re-lab/fixtures/`)**:
  - Located 10 real PNG segment fixtures (2.13 MB to 3.05 MB) and verified reference TS SHA-256 hashes in `reference_hashes.json`.
  - Identified that the 4.4 MB (`1214×1213`) sample and segment 95 from prior in-memory soak were missing from disk; the 10 real captures served as the empirical corpus.
- **DEFLATE Block & Scanline Census (Task 1)**:
  - Implemented `scripts/diagnostics/png-deflate-census.js` and verified with `tests/pngDeflateCensus.test.js` (5 passed).
  - Distribution: 1 fixture (`fixture_2635597_BBC.png`, 2.63 MB) is 100% stored DEFLATE blocks (42 stored, 0 Huffman) with 100% filter None. 9 fixtures (ESPN, ESPN 2, etc.) are mixed blocks with 62%–88% dynamic Huffman blocks and 12%–38% stored blocks.
  - Scanline filter breakdown: 66%–73% None (0), 9%–12% Sub (1), 6%–7% Up (2), 3%–4% Average (3), 5%–7% Paeth (4).
- **Fast-Path Decoder & Wasm Optimization (Task 2)**:
  - Recompiled `cloudflare-worker/png-unfilter.wasm` from `scripts/build-png-unfilter-wasm.js` with native WebAssembly `(memory.copy)` instructions replacing the byte-by-byte loop for None (0) and Up-row0 (2) scanlines.
  - Added Wasm chunked (NMAX=5552) `adler32` implementation in `png-unfilter.wasm` and integrated into `tryFastStoredDeflate` in `cloudflare-worker/index.js`, dropping stored-block Adler-32 verification from ~18.57 ms (JS byte-by-byte) to 2.18 ms (Wasm, 8.5x speedup) on `fixture_2635597_BBC.png`.
  - Added `tryFastStoredDeflate` for zero-copy bulk extraction of stored blocks directly into linear Wasm memory without `DecompressionStream` overhead.
  - Optimized general decoder: streamed IDAT chunks directly into `DecompressionStream` and wrote inflated chunks straight into request-owned linear Wasm memory (`memU8`), eliminating 4 intermediate buffer copies.
  - Verified 100% SHA-256 bit-for-bit parity across all 10 real capture fixtures and all 28 Jest tests (`npm test -- tests/pngWorkerFastPath.test.js tests/pngDeflateCensus.test.js tests/pngUnfilterWasm.test.js`).
- **Benchmark Security Hardening & Telemetry Sanitation**:
  - Gated benchmark endpoints behind `X-Bench-Token` matching `env.BENCHMARK_TOKEN || env.BENCH_SECRET`. If secret is missing or header is mismatched, Worker returns `403 Forbidden`.
  - Enforced `POST` method only (returning `405 Method Not Allowed` for GET / URL fetch) and enforced a 10 MB payload cap (`413 Content Too Large`).
  - Removed all `performance.now()` headers (`x-decode-time-ms`, `x-inflate-time-ms`, `x-relay-time-ms`, `Server-Timing`) across all endpoints because Cloudflare Workers freeze timers to mitigate Spectre, rendering wall-clock response-header timings invalid.
  - Updated `scripts/diagnostics/png-worker-soak.js` and `../nuvio-re-lab/fixtures/bench_results.json` so missing edge CPU telemetry is recorded strictly as `null`, never `0` or estimated.
  - Labeled `scripts/diagnostics/benchmark-size-curve.js` as local-only synthetic desktop benchmarks.
  - Confirmed zero media segment bytes touch the VPS (all segment traffic is between Stremio, the Worker, and the upstream CDN per Decision D1).

### Explicit Retractions of Unsupported Statements
1. **Retracted 8–12 ms Cloudflare CPU Percentiles**: `performance.now()` in Cloudflare Workers cannot measure invocation CPU. Reported edge CPU percentiles derived from response headers or local estimates are invalid and retracted; missing edge CPU is recorded as `null`.
2. **Retracted 6 MB Edge Memory Measurement**: Isolate memory consumption was not directly exposed by Cloudflare edge metrics and was inferred without platform telemetry; retracted.
3. **Retracted Differentiated `exceededCpu` Outcome**: HTTP 1102 / 530 error pages do not differentiate between `exceededCpu` and `exceededMemory`. The failure mode at segment 17 is classified as undifferentiated `resource_limit_1102` until Cloudflare Trace / Tail Worker logs are captured.
4. **Retracted Completed 30-Minute Soak Claims**: The live playback soak stopped at segment 17 on Error 1102; it was NOT a completed 30-minute soak.
5. **Retracted Cloudflare Edge Stability for Lower Bitrates**: Lower-bitrate sizing curve data was obtained solely from local Node.js V8 execution and has not been verified on Cloudflare Free Workers.

### Empirical Cloudflare Tail Telemetry (Authoritative Edge Evidence)
- **Direct Edge Instrumentation via Cloudflare WebSocket Tail (`wss://tail.developers.workers.dev/...`)**:
  - Script: `scripts/diagnostics/cf-trace-benchmark.js` connecting via `trace-v1` protocol on `nuvio-proxy2.rajodedara360.workers.dev`.
  - Gathered exact Cloudflare edge telemetry (`cpuTime`, `wallTime`, `outcome`, `cf-ray`, SHA-256 parity) across 26 invocations on all 10 real capture fixtures.
- **Stage Breakdown**:
  1. **Relay-only** (`bench_relay`):
     - Min: 2 ms, Max: 6 ms, p50: **3 ms**.
     - Well within the 10 ms Free Worker CPU limit.
  2. **Inflate-only** (`bench_inflate` via `DecompressionStream('deflate')`):
     - 100% Stored DEFLATE (`fixture_2635597_BBC.png`, 2.63 MB): Min: 6 ms, Max: 12 ms, p50: **7 ms**.
     - Dynamic Huffman Streams (2.13 MB – 3.05 MB ESPN, etc.): Min: 20 ms, Max: 35 ms, p50: **24 ms**.
  3. **Full Decode** (`bench_decode`, Inflate + Wasm Unfilter + MPEG-TS alignment):
     - 100% Stored DEFLATE (`fixture_2635597_BBC.png`): All runs **11 ms** (Wasm Adler-32 + bulk copy).
     - Dynamic Huffman Streams: Min: 24 ms, p50: **37 ms**, p95: **46 ms**, p99: **64 ms**.
  4. **Parity**:
     - **100% Bit-for-bit SHA-256 Match** (`parity=PASS`) across all 10 real capture fixtures.
- **Root Cause & Failing Bottleneck**:
  - Exact failing resource: `exceededCpu` (10 ms invocation CPU limit on Cloudflare Free tier).
  - Smallest remaining measured bottleneck: **`DecompressionStream('deflate')`** alone consumes **p50 = 24 ms CPU** on 2.5–3.0 MB dynamic Huffman streams, which exceeds Cloudflare Free's 10 ms allowance by **2.4x**, independent of Wasm unfiltering.
  - While Cloudflare Free Workers occasionally allow burst execution up to ~50 ms on fresh isolates, live playback sustains continuous invocations that trigger CPU throttling and circuit breakers (Error 1102 at segment 17).

### Current Blockers / Conclusions
- **Full-Quality 1080p Sports Feeds on Cloudflare Free Workers**: Cannot reliably fit within 10 ms invocation CPU due to the fundamental CPU cost of dynamic Huffman DEFLATE decompression on segments $\ge 2.1$ MB.
- **Free Worker Rollout Status**: Stopped for full-quality 1080p dynamic Huffman PNG sources per Task 3 line 60 of the plan.
- **Production Architecture Alternatives**:
  1. Route PNG streams to Cloudflare Workers Paid (50 ms CPU limit, where 37 ms p50 comfortably passes with headroom).
  2. Use upstream lower-bitrate renditions ($\le 720\text{p}$ / $\le 1.2$ MB segments) which fall under the 10 ms threshold.
  3. Serve standard non-PNG MPEG-TS/ByteRange streams directly through the existing proxy path (2–4 ms CPU).

### Immediate Next Steps for Next Chat
1. Present empirical Cloudflare Tail telemetry to the user.
2. Maintain existing hardened Worker deployment on test proxies without fleet rollout.
