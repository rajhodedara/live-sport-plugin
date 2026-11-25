# Kafka Event-Only Playback Implementation Plan

> **For agentic workers:** Use the executing-plans or subagent-driven-development workflow at implementation time. Track progress with the checkboxes below.

**Goal:** Show every distinct verified Kafka feed discovered for a live matchup and hide ordinary channel streams whenever a playable matchup feed is available.

**Architecture:** Merge all matching SQLite and upstream candidates into one fixture job. Verify the candidates with the existing worker-wide probe limit. Publish the verified results available at the existing response deadline and let bounded background work fill the cache for later requests.

**Tech Stack:** Node.js, Trex SQLite, the Kafka provider, the stream resolve cache, and Jest.

**Spec:** Follow-up to [Kafka event-first playback](2026-11-25-kafka-event-first.md). This plan supersedes the earlier two-result and six-candidate limits in event-first mode. A verified event feed triggers channel suppression. When no event feed verifies in time, normal channel fallback applies.

## Global constraints

- Keep `KAFKA_EVENT_FIRST_ENABLED` as the rollout and rollback switch. Scope the change to live fixture requests with Kafka enabled and selected.
- Keep the existing HTTP response deadlines, two concurrent upstream searches per worker, two concurrent event probes per worker, and 20 upstream requests per sync. Keep upstream response-size and request timeouts.
- Process all distinct matches returned by the supported SQLite and upstream lookup paths. “All” describes discovered, verified playback URLs. Upstream coverage and feed availability can change.
- Preserve source preferences, language ordering among published streams, and existing playback checks. Scope channel suppression to identified broadcaster, team, or linear/24/7 rows from any provider. Preserve independent matchup feeds from other providers and non-playback rows.

## File map

| Files | Responsibility |
| --- | --- |
| `src/services/TrexEventSearch.js`, `src/providers/KafkaProvider.js` | Remove event-first discovery truncation, merge SQLite with upstream results, and keep bounded search/probe scheduling. |
| `src/services/KafkaEventPlayback.js`, `src/streams.js` | Coordinate progressive fixture verification across clicks, expose verified progress before deadline, and apply post-verification channel fallback policy. |
| `src/domain/StreamEntity.js`, `src/services/LanguagePriorityService.js` | Preserve source provenance and event ranking score through resolution, cache cloning, and stream sorting. |
| `src/services/StreamResolveCache.js`, `src/services/ProviderHealthService.js` | Settle partial/complete progress cleanly under fenced cache writes and track discovered/attempted/verified/stop counters. |
| `tests/trexEventSearch.test.js`, `tests/kafkaCoverage.test.js`, `tests/kafkaDispatch.test.js`, `tests/streamHardDeadline.test.js`, `tests/streamPartialRecovery.test.js`, `tests/providerHealth.test.js` | Prove discovery coverage, provenance-safe suppression, progressive readiness, timeout fallback, and resource bounds. |

## Review focus

1. Six+ matches from the first upstream alias and an additional match from the second alias, without spending upstream requests when SQLite already meets the configurable local saturation threshold (e.g. `KAFKA_EVENT_UPSTREAM_MIN_LOCAL`, default bounded) or when the budget would starve thin fixtures.
2. A channel ID repeated across SQLite and upstream, and multiple playable URLs from a single ID verified sequentially inside one probe slot.
3. `readyToRespond()` releasing on verified progress + kept-provider state rather than blocking all requests to `HARD_DEADLINE_MS` while slow background candidates continue probing.
4. A repeat click during a running job or after partial progress: per-worker fixture coordinator preserves cursor/verified state, while `StreamResolveCache` settles per HTTP window with fenced shared-cache writes only on valid settled payloads.
5. Exact non-Kafka provenance separation: broadcaster/linear channels (`daddylive` non-`Event Stream`, `damitv`, `vavoo`, `cdnlive`, `streamsports99`, `timstreams`, `scorezone` `sz_iptv_*`) suppressed vs. matchup/OTT feeds (`ppvst`, `sportsbite`, `moviebox_sports`, `roxiestreams`, `ak47live`, `sktech`, `scorezone` fixture tokens) preserved.

## 1. Discover all available candidates

**Interface:** Keep `TrexEventSearch.findForFixture(match, options)` and `KafkaProvider.eventCandidates(match, options)` returning ranked candidate arrays. Each candidate has an ID and name.

- [x] Add cases in `tests/trexEventSearch.test.js` and `tests/kafkaCoverage.test.js`. Return more than six distinct matches across the existing alias queries, including a second query that contributes new IDs after the first query reaches six. Assert that all IDs survive, that rows for the wrong matchup are excluded, and that overlapping SQLite/upstream IDs occur once.
- [x] Run `npm test -- --runTestsByPath tests/trexEventSearch.test.js tests/kafkaCoverage.test.js`. Confirm the coverage test fails against the current limit.
- [x] Remove the six-candidate early stop and output slice in `_searchEventFirst`. Run both supported aliases within the existing bounded query path. Merge SQLite and upstream candidates deduplicated by ID. Gate automatic cold-click upstream lookup behind a bounded minimum-local threshold (default configurable, e.g. when SQLite hits `< 6` or a cold retry is forced/empty, preserving immediate local results and keeping Trex's 2-concurrent / 20-sync request budget from burning upstream queries on fixtures that already have 10+ local hits). Keep the legacy branch intact. If one upstream request fails, keep available results and permit a later refresh.
- [x] Rerun both suites and record the results.

## 2. Verify beyond the first two results

**Interface:** Extend `collectEventStreams({ provider, match, probe, signal, metrics, deadlineAt })` with a per-worker fixture coordinator keyed by `match.id` + kickoff (`date`). Expose settled-so-far verified rows when the HTTP deadline arrives, let bounded background probing continue up to the decoupled work deadline (60s) within a bounded queue ceiling (configurable max attempts, e.g. 24), and resume remaining queued candidates cleanly on subsequent clicks.

- [x] Add handler tests in `tests/kafkaDispatch.test.js` with at least nine candidates, a duplicate ID, and a provider result with two distinct playable URLs. Include a 502, an ended or frozen playlist, and overlapping playback URLs. Assert that every remaining distinct verified URL appears on cold and warm requests and that a probe failing early doesn't stop the queue.
- [x] Add timing tests in `tests/streamHardDeadline.test.js` and `tests/streamPartialRecovery.test.js`. Assert that fast verified events release within soft/readiness bounds without pinning all requests to the 15s hard deadline when a later probe stalls, that simultaneous viewers share the fixture work, and that a later request sees added results. Simulate 20 same-fixture viewers and assert a maximum of two active event probes per worker.
- [x] Run the suites with `--runTestsByPath` and confirm the new cases fail before the change.
- [x] In `collectEventStreams`, remove the two-success and six-attempt stops. Use a rolling worker-pool queue through `provider.withEventProbe` (giving initial unverified fixtures priority over late tail mirrors where queued, or clean FIFO), deduplicate candidates by ID, and collect all successful unique playback URLs per ID. Remove the single-URL slice in the event probe in `streams.js`. Verify multiple URLs sequentially within a probe slot so the outbound check limit still holds. Skip optional segment measurements if needed to keep manifest checks moving.
- [x] Keep `StreamResolveCache.getOrCreate()` settling cleanly per HTTP request window (`deadlined` returns verified rows so far with short incomplete freshness / deferred retry hint when background work continues, then full TTL + fenced L2 publish once the fixture job finishes), instead of holding L2 `minting` claims open across a 60s background job. Bump the synthetic event cache key (`:v3`) so cached two-result lists cannot mask the change. Update `readyToRespond()` in `src/streams.js` so verified event progress satisfies event readiness once kept providers or `SOFT_DEADLINE_MS` pass, while still waiting up to `HARD_DEADLINE_MS` if zero playable streams exist.
- [x] Preserve aggregate health counters for discovered candidates, attempted candidates, verified streams, and completion versus deadline (`target`/`complete`, `cap`, `deadline`, `exhausted`). Add/update regression assertions in `tests/providerHealth.test.js` and rerun all four suites.

## 3. Publish event feeds with channel fallback

**Interface:** Add `classifyStreamChannelProvenance(stream, src)` / `applyFixtureChannelFallback(rows, match)` in `src/streams.js` (or shared service helper). Suppress broadcaster/linear/team channel rows once `>= 1` verified playable Kafka event stream is eligible for publication; leave matchup/OTT feeds, incomplete/no-event fallbacks, replays, and 24/7 TV channel cards untouched.

- [x] Update & add tests in `tests/kafkaDispatch.test.js` covering a fixture with verified Kafka event feeds, a Kafka broadcaster, a Kafka team channel, a non-Kafka linear channel (`daddylive` / `damitv` / `scorezone` `sz_iptv_*`), and another provider’s matchup feed (`ppvst` / `sportsbite` / `daddylive` `Event Stream`). Assert that all distinct verified event feeds and the other provider's matchup feed remain while all channel rows are suppressed. Repeat for a warm request, an event/fallback duplicate URL, an explicitly preferred language, and late verification after a first fallback response.
- [x] In the same suite, assert that fallback rows stay visible when every event probe fails, the deadline arrives with zero verified events, an event row is blocked by policy/frozen/ended, or Kafka is excluded by the user. Check that replays and standalone 24/7 cards keep their existing response. Confirm the new suppression case fails before implementation.
- [x] Carry source provenance (`_kafkaMatchMode`, `_kafkaEventScore`, and `_isChannelFallback`) through `StreamEntity` and `StreamResolveCache` cloning. Classify Kafka `label`/`team`/legacy-untagged rows and known linear providers (`damitv`, `vavoo`, `cdnlive`, `streamsports99`, `timstreams`, `daddylive` non-`Event Stream`, `scorezone` `sz_iptv_*`) as channel fallbacks; leave `ppvst`, `sportsbite`, `moviebox_sports`, `roxiestreams`, `ak47live`, `sktech`, and `scorezone` fixture IDs preserved as matchup/ambiguous rows. Ensure `eventScore` / declared quality still orders multiple verified event streams cleanly inside the same language tier.
- [x] Apply suppression inside `publicationRows()` (so `readyToRespond()` does not treat soon-to-be-hidden channels as reason to abort waiting) and to the final response after validating event rows against stream policy and deduplicating URLs (preserving `event` mode over colliding fallback URLs). Keep it before final language ranking and donation-link insertion.
- [x] Run `npm test -- --runTestsByPath tests/trexEventSearch.test.js tests/kafkaCoverage.test.js tests/kafkaDispatch.test.js tests/kafkaFrozenRule.test.js tests/languagePriority.test.js tests/streamHardDeadline.test.js tests/streamPartialRecovery.test.js tests/streamPartialRecoveryShared.test.js tests/providerHealth.test.js` (plus related Trex/Kafka suites). Replay Dallas–Denver and Barça UCL against a disposable v2 catalog and verify counts and ordering.

## Rollout checks

- [ ] On a canary worker, compare event-feed coverage, response p95, deadline fallback rate, probe concurrency and worker RSS against the current baseline. Verify that repeat clicks can fill in slow candidates and that a fixture with no playable event feed still has channels. Use `KAFKA_EVENT_FIRST_ENABLED=false` to roll back if fallback or latency regresses.
