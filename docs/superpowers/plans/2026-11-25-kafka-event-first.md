# Kafka event-first playback implementation plan

> **For agentic workers:** Use the subagent-driven-development or executing-plans workflow at implementation time. Track progress with the checkboxes below.

**Goal:** A viewer opening a live fixture gets verified Kafka feeds for that specific game first, including late in the game. Other playable sources stay available throughout.

**Architecture:** Build an indexed fixture lookup during the existing Trex catalog refresh. Use it during sync and on demand, supplement it with bounded upstream searches, then verify candidates within the stream request's existing deadline. Preserve the reason each feed matched through the resolve cache and final client ordering.

**Tech stack:** Node.js, built-in SQLite, existing Trex refresh job, stream verifier and Jest.

**Spec:** Extends `docs/superpowers/specs/2026-11-24-kafka-trex-catalog-coverage-design.md` with the November 25 live audit and the owner's event-first priority.

## Global constraints

- Preserve provider enablement, user-selected sources, replay handling and the existing stream response deadline. Honor explicit language preferences. Proposed default playback order is verified Kafka event, Kafka broadcaster, Kafka team, then other eligible streams. Within an explicitly preferred language, apply the same order.
- Keep catalog rebuilds outside the app workers. During a sweep, retain the shared budget of 20 upstream search requests including retries. Reuse the 10-minute cache and 2,000-entry limit. Bound aggregate upstream search concurrency to two per worker across sweep and click paths.
- Proposed starting limits for event playback are two verified event choices, two concurrent candidate probes per worker and six distinct candidates attempted per fixture per request. Instrument these limits before tuning. All attempts share the existing deadline.

## Review focus

1. Live overtime, explicit final status, missing dates and dates stored as ISO strings.
2. Nickname-only, reverse-order and abbreviated listings alongside same-city teams, stale rematches and multi-game listings.
3. Concurrent clicks across several broadcaster rows, a canceled caller, and a fresh fixture with zero attached Kafka rows.
4. A dead top-ranked feed, a frozen slate, duplicate IDs and a working third candidate.
5. Final client order after deduplication, cache hits, explicit language selection and early publication.

## 1. Make discovery eligible throughout the game

**Files:** `src/services/TrexEventSearch.js`, `src/providers/KafkaProvider.js`, `src/services/MatchAggregator.js`, `tests/trexEventSearch.test.js`, `tests/kafkaAggregatorCoverage.test.js`.

- [ ] Write failing cases for Dallas at kickoff +57 minutes, explicit live overtime at +5 hours, final/replay, numeric and ISO dates, and unknown status with missing kickoff. Run `npx jest --runInBand --runTestsByPath tests/trexEventSearch.test.js tests/kafkaAggregatorCoverage.test.js` to capture the failures.
- [ ] Introduce one predicate, `isFixtureSearchable(match, now)`. Reuse the add-on's fixture status conventions. Finished or replay is ineligible, explicitly live is eligible, otherwise require a valid kickoff and a time from 15 minutes before through four hours after kickoff. Include boundary tests. Replace the independent numeric-date checks in sweep, attachment and click paths. Exercise the aggregator's age guard with an explicitly live fixture.
- [ ] Run the same tests to green and commit this timing fix independently.

## 2. Find the matchup in SQLite

**Files:** `src/services/TrexCatalogKeys.js`, `src/services/TrexCatalogDb.js`, `src/services/TrexCatalogStore.js`; cover with `tests/trexCatalogKeys.test.js`, `tests/trexCatalogDb.test.js` and `tests/trexCatalogStore.test.js`.

- [ ] Add failing fixture tests from the snapshot. Include Mavericks vs. Nuggets, Dallas @ Denver, DENVER NUGGETS - DALLAS MAVERICKS, DEN - NUGGETS VS DAL - MAVERICKS, Celtics vs. Wizards and Golden Knights @ Oilers. Include a wrong opponent, a previous week's rematch, two teams sharing a city and a listing with two different matchups. Assert unique candidate IDs and rejection of ambiguous pairs.
- [ ] Extract opponent pairs at refresh time across all catalog kinds. Recognize vs., v, at, @ and spaced dashes in matchup context. Save normalized opponent aliases and available sport/date evidence in a dedicated indexed event table keyed by opponent pair and channel ID. Match aliases on opposite sides of the same matchup. Accept city or short forms only when the pairing and sport/date evidence disambiguate them. Interpret explicit time zones and avoid rejecting cross-midnight listings on a bare calendar-date comparison.
- [ ] Build the index in the existing catalog replacement transaction and bump the schema version. Add `TrexCatalogStore.findEvents(match)` returning ranked unique channel candidates. Check table availability independently of broadcaster lookup so a v1 DB still works. Test rollback, a v1 database, and indexed lookup with `EXPLAIN QUERY PLAN`.
- [ ] Run the three named suites with `--runTestsByPath`, compare results against the downloaded snapshot using a disposable DB, and commit. The earlier Dallas count of 17 was a lower bound because the first scan omitted dash-separated titles.

## 3. Share discovery across sync and clicks

**Files:** `src/services/TrexEventSearch.js`, `src/providers/KafkaProvider.js`, `src/services/MatchAggregator.js`, `src/streams.js`; tests in `tests/trexEventSearch.test.js`, `tests/kafkaCoverage.test.js`, `tests/kafkaDispatch.test.js`.

- [ ] Write failing tests for simultaneous clicks, one canceled caller, a failed search followed by a retry, and a live fixture with zero existing Kafka sources. Assert that an explicitly disabled Kafka provider performs zero requests.
- [ ] Seed discovery with `findEvents(match)`. Top up from upstream if local candidates are insufficient or fail verification, including when the DB is unavailable. Query a distinctive team alias and check the opposing aliases using the same matcher. Test with the actual separate queries `boston celtics` and `celtics`. Prefer recent, exact event matches and currently live listings over upcoming listings.
- [ ] Give each eligible fixture one Kafka event discovery operation during stream handling, independent of its number of broadcaster rows. Coalesce in-flight searches by fixture ID and kickoff per worker, release entries on success or failure, and preserve other waiters when one caller cancels. Keep retries inside the sweep budget and bound click work with the shared concurrency and deadline limits. Cache candidate IDs independently of transient playback failures.
- [ ] Run the three named suites with `--runTestsByPath`. Verify two concurrent viewers plus a sweep issue one shared search for the fixture, and commit.

## 4. Verify alternatives and preserve Kafka priority in the response

**Files:** `src/providers/KafkaProvider.js`, `src/domain/StreamEntity.js`, `src/streams.js`, `src/services/LanguagePriorityService.js`, `tests/kafkaDispatch.test.js`, `tests/kafkaFrozenRule.test.js`, `tests/languagePriority.test.js`.

- [ ] Add a stream-handler regression where event candidates one and two return a 502 and an ended sequence-zero playlist, candidate three passes, and broadcaster and team feeds are ready. Assert the third event feed is first on both cold and cached responses. Cover a slow event lookup, duplicate playback URLs, explicit language preference and all-event failure.
- [ ] Move the two-result cutoff past verification. Resolve event candidates in bounded batches, reuse the existing verifier, and advance after failure until the target, cap or deadline. Count only a successful media check toward the verified-event target. Keep per-candidate failure state so one bad feed cannot invalidate its siblings.
- [ ] Carry event/label/team mode from lookup through minting, cache, deduplication and row comparison. Keep the strongest verified match for duplicate URLs. Reserve room in the existing priority scheduling and early-return rules for pending Kafka event work while respecting the response deadline. Deliver available fallbacks on timeout. Use a fixture-specific cache identity for event results and handle pre-change cached rows with missing mode.
- [ ] Run the three named suites with `--runTestsByPath`, then run all Kafka, Trex and language priority tests from the current checkout. Commit after the final public stream payload passes the ordering assertions.

## 5. Measure and roll out

- [ ] Record a baseline on the same VPS for stream response p95, worker RSS/CPU, search requests per sync and resolver timeout rate. Add aggregate counters for DB hits, shared searches, candidates probed, verified event feeds and stop reason. Use existing health reporting in `src/services/ProviderHealthService.js`; test counters in `tests/providerHealth.test.js`. Keep credentials and playback URLs out of metrics.
- [ ] Build a separate v2 catalog with `scripts/refresh_trex_catalog.js`; verify integrity, refresh timestamp and fixture query plans. Replay the three captured fixtures offline. With 20 concurrent simulated viewers of one game, assert one discovery per worker, at most two active event probes per worker and completion within the existing request deadline.
- [ ] At deployment time, gate the new behavior behind `KAFKA_EVENT_FIRST_ENABLED` and document it in `.env.example`. Compare one enabled worker with the baseline through a live game. Use the public stream response to verify event ordering and spot-check media playlist advancement. Record counts, actual latency and resource deltas before enabling the remaining workers.
- [ ] Roll back the event-first flag if the request deadline, upstream budget or worker memory headroom regresses. Retain the previous catalog path through rollout and verify broadcaster and team playback after rollback.
