# Kafka Live-Sports Provider Implementation Plan

**Goal:** Add a provider named `Kafka` (`sourceName: 'kafka'`) that contributes Flix-backed streams only to scheduled live-sports fixtures. Kafka must not publish the upstream's general TV catalog or create standalone 24/7 channel cards.

**Architecture:** Treat the upstream manifest and category APIs as a sports-channel inventory and stream resolver. Existing Nuvio providers remain the schedule authority. During each match sync, Kafka builds a bounded index from explicitly selected sports catalogs, then attaches a Kafka source when an existing fixture carries a broadcaster identity that exists in the index. Playback does not require EPG: the Kafka source stores the upstream channel meta ID, and `resolveStream()` calls the configured manifest's Stremio stream route for that ID.

**Why no Kafka EPG is required:** EPG answers “what is airing?”; the Stremio stream route answers “how do I play this channel?”. Nuvio already has scheduled fixtures, kickoff times, and broadcaster labels from providers such as DaddyLive, TimStreams, StreamSports99, SportzX, and MovieBox Sports. Kafka only needs to map those broadcaster labels to upstream channel meta IDs and resolve them on demand.

## Validated Upstream Findings (2026-11-23)

- The public Dream4K category API returned 837 categories, including US ESPN+ (399), DAZN Switzerland PPV (350), US FloSports (279), and multiple regional Amazon Prime Events groups.
- The public Dino category API returned 362 categories, including USA Flo PPV (1,000), USA ESPN+ (500), UK World Sports (196), and UK PPV Events (175).
- The public Cloud category API returned 344 categories, including BeIN Sports (354), French Soccer PPV (201), and TSN Sports (104).
- These endpoints provide `{name, slug, count}` taxonomy records. They are useful for sports allowlist discovery, but they are not an EPG and must not be turned directly into Nuvio match cards.
- The earlier `.../u/<profile>/epg.xml` claim is stale/incomplete. The current Flix account client builds `.../u/<profile>/live/epg.xml`, `.xml.gz`, and provider-specific `.../live/<source>/epg.xml` variants from the stable manifest URL.
- The owned profile's live playlist and XMLTV routes returned `403` from an unauthenticated backend check. Kafka must distinguish `401/403` entitlement failures from `404` unsupported routes and fall back cleanly to Nuvio's scheduled fixtures.

## Context Map

### Files to Modify

| File | Purpose | Changes Needed |
|---|---|---|
| `src/providers/KafkaProvider.js` | New deep module at the upstream seam | Load/validate the configured manifest, select sports catalogs, build the broadcaster index, attach sources, and resolve streams |
| `src/container.js` | Awilix registration | Register `kafkaProvider` as a singleton |
| `src/services/MatchAggregator.js` | Canonical fixture sync and enrichment | Inject Kafka, refresh its index in parallel, and attach Kafka sources before cache persistence |
| `src/streams.js` | Source selection and provider dispatch | Add Kafka priority, allowlisting, labels, and dispatch |
| `public/configure.html` | User-facing live-source configuration | Add a `Kafka` checkbox to live sources |
| `.env.example` | Safe operator configuration | Document Kafka enablement and manifest/catalog settings without a real token |

### Dependencies

| File | Relationship |
|---|---|
| `src/providers/BaseProvider.js` | Supplies guarded `proxyFetch`; Kafka must never call `fetch` directly |
| `src/services/ChannelIdentityService.js` | Canonical broadcaster identity and country/quality parsing |
| `src/domain/StreamEntity.js` | Normalized stream output |
| `src/services/ProviderHealthService.js` | Kafka refresh/resolve health reporting |
| `src/services/BroadcasterMatchService.js` | Existing Vavoo enrichment is the reference behavior; Kafka must not change its results |
| `src/services/MatchAggregator.js` | Existing provider sources supply `channelName` and scheduled match metadata |

### Test Files

| Test | Coverage |
|---|---|
| `tests/kafkaProvider.test.js` | Manifest parsing, sports filtering, pagination, index identity, resolution, secret hygiene |
| `tests/kafkaRegistration.test.js` | Container registration and disabled-by-default state |
| `tests/kafkaAggregator.test.js` | Sports-only attachment to existing fixtures, no standalone channel rows |
| `tests/kafkaDispatch.test.js` | `source: 'kafka'` routes to `kafkaProvider.resolveStream` |
| `tests/broadcasterMatchService.test.js` | Existing Vavoo behavior remains unchanged |
| `tests/broadcasterMappingIdentity.test.js` | Country/channel-number identity remains strict |
| `tests/motorsportSessionIsolation.test.js` | Match aggregation regression |
| `tests/adversarialMotorsportVerification.test.js` | Match identity regression |
| `tests/concurrencyStressAndIsolation.test.js` | Sync concurrency regression |
| `tests/streamHardDeadline.test.js` | Stream dispatch deadline regression |

### Reference Patterns

| File | Pattern |
|---|---|
| `src/providers/MovieBoxSportsProvider.js` | Small provider interface and guarded upstream requests |
| `src/services/BroadcasterMatchService.js` | O(1) broadcaster-to-channel lookup and exact aliases |
| `src/services/MatchAggregator.js::_enrichMatchesWithBroadcasters` | Attach a channel source to a scheduled fixture without creating new fixture rows |
| `src/providers/VavooProvider.js` | Channel identity and direct-stream output |
| `tests/roxieStreamsRegistration.test.js` | Provider registration test shape |

### Risk Assessment

- [x] Configuration changes required: manifest URL is a secret and must be supplied by environment.
- [x] External availability risk: Kafka depends on upstream manifest/catalog/stream routes.
- [x] Match correctness risk: loose matching could attach the wrong sports channel.
- [x] Secret exposure risk: URL-path bearer tokens must never be logged or committed.
- [ ] Database migration required.
- [ ] Public Stremio protocol change required.

## Design Decisions

### 1. Kafka is resolver/enrichment-only

`KafkaProvider` does not publish upstream channels as `MatchEntity` rows. Its scheduled-match method returns `[]`, and it is not placed in the normal `MatchAggregator.providers` fixture fan-out. Instead, the aggregator calls Kafka through a dedicated enrichment seam.

This keeps the user-visible catalog event-centric:

```text
existing scheduled fixture -> broadcaster label -> Kafka channel identity -> Kafka source
```

It deliberately avoids:

```text
19,000 upstream sports channels -> 19,000 Nuvio catalog cards
```

### 2. Existing fixtures are the EPG

Kafka consumes broadcaster labels already present on merged fixture sources (`channelName`, `channel_name`, or `channel`) and attaches only exact channel matches. Kickoff, league, teams, status, and live-window behavior continue to come from Nuvio's existing providers.

No broadcaster label means no Kafka attachment in phase one. Do not guess from sport alone (for example, attaching every ESPN/Sky channel to every football match).

### 3. Sports catalogs are discovered dynamically and fail closed

The generic catalog `flix-live-tv-v2-trex` is always excluded. With an empty `KAFKA_CATALOG_ALLOWLIST`, Kafka automatically selects manifest catalogs whose ID/name taxonomy identifies sports, events, PPV, or known sports networks. This follows dynamic sports categories without exposing the general TV catalog. A non-empty allowlist remains available as an exact operator override.

Example optional override:

```text
flix-live-tv-v2-trex-cat-wc-world-cricket
flix-live-tv-v2-trex-cat-uk-scottish-football
```

New sports/event catalogs are picked up automatically after the index TTL expires. Kafka must not classify a catalog as sports merely because its name contains a broad word such as `live`.

### 4. The manifest URL is a bearer credential

Use environment configuration only:

```dotenv
KAFKA_ENABLED=false
KAFKA_MANIFEST_URL=
KAFKA_CATALOG_ALLOWLIST=
KAFKA_INDEX_TTL_MS=900000
KAFKA_INJECTION_CAP=4
```

Never include the real manifest URL in source, fixtures, snapshots, logs, error messages, or commits. Errors may report the hostname and route kind, never the path token. Do not derive or expose the profile slug in client-visible output.

## Task 1: Characterize and Lock the Upstream Contract

**Files:**

- Create: `tests/kafkaProvider.test.js`
- Create: `src/providers/KafkaProvider.js`

- [ ] Capture redacted JSON fixtures for an owned manifest, one sports catalog page, and one stream response. Replace all bearer path segments and playback URLs with deterministic test values.
- [ ] Add redacted fixtures for the three public category-taxonomy responses and lock the observed `{name, slug, count}` contract.
- [ ] Verify the catalog pagination route supported by the manifest's `skip` extra before implementation. Lock the observed route shape in a fixture test.
- [ ] Define `KafkaProvider` metadata: `name = 'Kafka'`, `sourceName = 'kafka'`, and `configured` based on `KAFKA_ENABLED` plus `KAFKA_MANIFEST_URL`.
- [ ] Parse and validate the manifest URL: HTTPS only, no username/password, expected `/manifest.json` suffix, and an explicit host allowlist if production will always use Flixnest.
- [ ] Implement `_selectSportsCatalogs(manifest, allowlist)` with automatic sports/event taxonomy discovery when the allowlist is empty and exact-ID override behavior when it is set. Always reject the generic Trex Live TV catalog.
- [ ] Implement bounded catalog paging with explicit `timeoutMs`, `maxBodyBytes`, and page/item caps.
- [ ] Run: `npm test -- tests/kafkaProvider.test.js`.

**Completion criterion:** Given fixtures containing general TV plus sports catalogs, automatic mode selects only sports/event catalogs; override mode selects only exact configured IDs; the generic all-TV catalog is never indexed.

## Task 2: Build the Sports Channel Index

**Files:**

- Modify: `src/providers/KafkaProvider.js`
- Modify: `tests/kafkaProvider.test.js`

- [ ] Normalize every upstream meta with `ChannelIdentityService.parseChannel(meta.name, context)`.
- [ ] Store an O(1) index keyed by strict `identityKey`, with country/channel-number context retained.
- [ ] Preserve upstream meta ID, catalog ID, channel name, language, country, and quality; do not store playback URLs in the index.
- [ ] Add single-flight refresh and a TTL controlled by `KAFKA_INDEX_TTL_MS`.
- [ ] Retain the last-good immutable snapshot when refresh fails; an initial failure produces an empty index.
- [ ] Add `createSource(rawChannelName, context)` returning either `null` or one source shaped as:

```javascript
{
  source: 'kafka',
  id: '<upstream-meta-id>',
  channelName: '<canonical channel name>',
  catalogId: '<sports catalog id>',
  country: '<optional country>',
  language: '<optional language>',
  type: 'channel'
}
```

- [ ] Refuse ambiguous identities, conflicting country context, mismatched channel numbers, backups, and timeshift variants unless explicitly requested by the source label.
- [ ] Run: `npm test -- tests/kafkaProvider.test.js`.

**Completion criterion:** Exact broadcaster identities resolve in O(1); ambiguous or approximate names return `null`.

## Task 3: Attach Kafka to Existing Scheduled Fixtures

**Files:**

- Modify: `src/services/MatchAggregator.js`
- Create: `tests/kafkaAggregator.test.js`

- [ ] Inject `kafkaProvider` into the `MatchAggregator` constructor and store it separately from `this.providers`.
- [ ] Start `kafkaProvider.refreshIndex()` in parallel with the normal provider fan-out so upstream catalog latency does not serialize fixture ingestion.
- [ ] Before cache persistence, inspect each non-replay, non-network fixture's existing sources for broadcaster labels.
- [ ] Call `kafkaProvider.createSource()` for those labels and append unique Kafka sources up to `KAFKA_INJECTION_CAP`.
- [ ] Never create a new match from a Kafka channel and never add Kafka to an existing `category: 'networks'` row.
- [ ] Treat a Kafka refresh failure as non-fatal; keep the fixture catalog and use the last-good Kafka snapshot when available.
- [ ] Record refresh and attachment counts through provider-health telemetry without logging the manifest URL.
- [ ] Run:

```bash
npm test -- tests/kafkaAggregator.test.js
npm test -- tests/motorsportSessionIsolation.test.js tests/adversarialMotorsportVerification.test.js tests/concurrencyStressAndIsolation.test.js
```

**Completion criterion:** Kafka sources appear only on already-scheduled fixtures carrying exact broadcaster labels; the number and identity of catalog cards are unchanged.

## Task 4: Resolve Kafka Streams

**Files:**

- Modify: `src/providers/KafkaProvider.js`
- Modify: `tests/kafkaProvider.test.js`

- [ ] Derive the upstream base from the configured manifest URL without exposing the bearer path in logs.
- [ ] Resolve with the Stremio route `/stream/tv/{encodedMetaId}.json` through `proxyFetch`.
- [ ] Map only entries containing a direct `url` into `StreamEntity` objects.
- [ ] Preserve upstream `behaviorHints`, request headers, quality, and video-size metadata.
- [ ] Label returned streams as `Kafka` while retaining the broadcaster name in the title.
- [ ] Drop upstream `externalUrl` pages, empty URLs, torrent hashes, and blocked DASH/ClearKey forms; the shared stream policy remains the final guard.
- [ ] Return direct CDN URLs or text-manifest URLs only. Never relay bulk media bytes through the VPS.
- [ ] Apply explicit request deadlines that fit inside `streamHardDeadline`.
- [ ] Run: `npm test -- tests/kafkaProvider.test.js tests/streamHardDeadline.test.js`.

**Completion criterion:** A fixture source resolves into normalized Kafka streams without exposing the manifest token or introducing a byte-relay route.

## Task 5: Registration, Dispatch, and User Configuration

**Files:**

- Modify: `src/container.js`
- Modify: `src/streams.js`
- Modify: `public/configure.html`
- Modify: `.env.example`
- Create: `tests/kafkaRegistration.test.js`
- Create: `tests/kafkaDispatch.test.js`

- [ ] Register `kafkaProvider: asClass(KafkaProvider).singleton()`.
- [ ] Add `kafka` to `KNOWN_LIVE_SOURCES` and `KNOWN_FALLBACKS`.
- [ ] Give Kafka an explicit priority near Vavoo rather than allowing the unknown-source default.
- [ ] Add `Kafka` to `NICE_NAMES` and `CHANNEL_TITLE_NICE_NAMES`.
- [ ] Add the `sourceName === 'kafka'` dispatch branch.
- [ ] Add the Kafka checkbox to `liveSourcesGrid`; disabled/unconfigured Kafka should still resolve to an empty source cleanly.
- [ ] Document all Kafka environment variables using blank/non-secret examples.
- [ ] Run:

```bash
npm test -- tests/kafkaRegistration.test.js tests/kafkaDispatch.test.js
node --check src/providers/KafkaProvider.js
node --check src/container.js
node --check src/services/MatchAggregator.js
node --check src/streams.js
```

**Completion criterion:** Kafka can be selected in configuration, dispatches through the provider, and remains inert when disabled or unconfigured.

## Task 6: End-to-End Verification and Rollout

- [ ] Run the focused Kafka and regression suites.
- [ ] Run `npm run build` and verify the staged `dist.next/` bundle.
- [ ] Deploy first with `KAFKA_ENABLED=false` and confirm boot/health behavior.
- [ ] Add the owned `KAFKA_MANIFEST_URL` only in the runtime secret environment.
- [ ] Enable one sports catalog and compare pre/post catalog card counts; counts must remain unchanged.
- [ ] Confirm Kafka attachment count is non-zero only for fixtures with matching broadcaster labels.
- [ ] Resolve one controlled live fixture and verify at least one direct stream without printing its URL.
- [ ] Confirm logs, provider-health output, error messages, and built artifacts contain no bearer token.
- [ ] Monitor upstream request rate, refresh duration, resolve latency, and 401/403/429 rates before adding more catalog IDs.
- [ ] Update `.agents/tracks/current_task.md` after implementation and verification.

## Acceptance Criteria

1. Provider display name is `Kafka`; source key is `kafka`.
2. Kafka publishes zero standalone TV/channel matches.
3. Kafka attaches only to existing live/upcoming sports fixtures with an exact broadcaster identity.
4. General Trex Live TV and non-sports catalogs are never indexed.
5. Schedule fields come from existing Nuvio fixture providers and are never inferred from channel taxonomy.
6. Kafka refresh failure never removes existing fixtures or other provider sources.
7. The bearer manifest URL is absent from Git, logs, tests, and client responses.
8. Stream output respects guarded egress, hard deadlines, and zero-bulk-byte policy.

## Deferred Phase: Independent Kafka EPG

Only promote Kafka XMLTV into an independent schedule adapter after measuring that the owned guide has reliable sports titles, start/stop times, and channel identities. That adapter should be a separate module returning normalized fixture records and must deduplicate against the existing aggregator. If the guide is insufficient, use another owned or licensed schedule source. Do not scrape program titles from stream playback, guess broadcasters from sport alone, or treat linear channel names as an event schedule.
