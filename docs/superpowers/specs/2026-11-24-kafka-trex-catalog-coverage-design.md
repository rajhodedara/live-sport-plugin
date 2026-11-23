# Kafka/Trex catalog coverage via a local SQLite catalog: design

**Date:** 2026-11-24
**Status:** approved by the owner on 2026-11-24 (after the priority change: event channel first)
**Scope:** Kafka provider (`src/providers/KafkaProvider.js`), match enrichment (`src/services/MatchAggregator.js`), a new catalog store and refresh job. No change to other providers.

## Intent and why

Kafka today attaches streams to a fixture only when one of its existing source labels matches a channel in two small dedicated catalogs (World Cricket, Scottish Football). In the measured production sync that produced 1 Kafka attachment against 114 for Vavoo. Everything people actually watch (NBA, NFL, NHL, MLB, La Liga, Serie A, small leagues, women's competitions) lives in the upstream's generic catalog `flix-live-tv-v2-trex` (54,561 channels) as three kinds of channels: permanent team channels (`NBA TEAM| CHICAGO BULLS`), per-game event channels that appear at kickoff, and linear sports channels (`CA| WILLOW CRICKET HD`, `US| CHICAGO SPORTS NETWORK HD`).

The owner's goal is **efficiency**: find the right Trex channel for any fixture without holding 54k rows in worker memory, without making upstream requests proportional to catalog size, and without slowing match sync. He wants all 54k rows kept for future use and is fine with a database.

Measured constraints this design is built around (details in `docs/evidence-kafka-trex/HANDOFF_KAFKA_TREX_2026-11-24.md`):

- VPS: 2 PM2 workers, 1.5 GB ceiling, workers at 522/425 MB idle, a match sync already adds +119 MB transient and takes ~4 minutes. Any catalog memory in workers must stay near zero.
- Upstream: pages of 100 (546 pages), `cacheMaxAge` 120 s, literal `search=` (max 100 results), `Live |` event channels created at kickoff, one relay host for all streams.
- Health: 86% of channels answer, but 39% of those are frozen playlists with `EXT-X-MEDIA-SEQUENCE:0`. Widening coverage without a liveness guard would add dead clicks.
- Runtime: Node 22.23 on the VPS, so the built-in `node:sqlite` module is available without a flag (it prints one experimental warning; suppress only that warning via `--disable-warning=ExperimentalWarning` in the PM2 node args).

## Goals

1. Every live or upcoming fixture gets a Kafka source whenever the generic catalog holds a matching channel. Priority (owner decision, 2026-11-24): the per-game **event channel first**, because that is where the 4K/8K/FHD feeds are; then the team channel; then the broadcaster label.
2. Zero catalog memory in workers; lookups take microseconds; the sync path makes no upstream request for static rows.
3. The full catalog (all 54k rows) is refreshed daily from the upstream, streamed page by page, never inside a worker.
4. No frozen stream reaches a user: the click-path playlist check that already runs (`verifyStreams` in `src/streams.js`) gains one rule that drops media playlists carrying `EXT-X-MEDIA-SEQUENCE:0`. No extra request is added.
5. The data stays useful later: every row is stored with id, name, group, kind and normalized keys, and the schema leaves room for health data.

## Non-goals

- No Kafka 24/7 catalog cards; Kafka stays enrichment-only.
- No schedule or EPG taken from Trex.
- No media byte relay; streams keep going through the existing `/api/manifest` wrapper.
- The two dedicated catalogs keep working exactly as today.

## Anti-goals (a failure even if it technically works)

- Worker RSS grows by more than about 5 MB for this feature.
- Match sync becomes slower by more than a few seconds, or its upstream traffic scales with the catalog size.
- A frozen stream ever reaches the user's player. (The catalog may still list a Kafka source that later resolves to nothing; v1 accepts that, see Builder check 5.)
- The bearer manifest URL, or any stream URL with credentials, ends up in the database, logs, or error messages.

## Approaches considered

| | Memory per worker | Lookup | Daily refresh | Grows into |
|---|---|---|---|---|
| **A. SQLite file on disk, all rows (chosen)** | 0 MB | microseconds, read-only connection | upsert in one transaction, WAL | search by any column, full-text, health data, history |
| B. Whole catalog in memory from a JSON file | 21.5 MB (measured) | fastest (Map) | rewrite a 5 MB file, re-parse in both workers | in-addon code only |
| C. Live upstream search for everything | 0 MB | 100 to 300 ms each, rate-limit exposure | none | nothing stored |
| D. Separate search daemon on localhost | 0 MB in workers | localhost round trip | same as A | same as A, plus a process to run and monitor |

- The owner picked **A** because it keeps every row at zero worker memory, the nightly refresh is a transaction instead of rewriting a file a worker may be reading, and the database is what future features can grow into.
- B is safe on this VPS but keeps two copies of the data and a bespoke file format.
- C was dropped: hundreds of requests per sync against a shared bearer credential is right for event channels and wrong for 54k static rows.
- D was dropped: it saves 21 MB but adds a process to run, monitor and fail.

## The design

### 1. Storage: `data/trex_catalog.sqlite`

One SQLite file in the runtime data directory (gitignored, shared by both workers, opened read-only by them).

- `meta(key TEXT PRIMARY KEY, value TEXT)`: `schema_version`, `generated_at`, `row_count`, `source` (`live` or the manifest hostname only, never the path).
- `channels(id TEXT PRIMARY KEY, name TEXT NOT NULL, grp TEXT, kind TEXT NOT NULL, league TEXT, tier TEXT)`: one row per catalog channel, all 54k. `kind` is `team`, `linear`, `event`, `placeholder` or `other`. Matching uses `team` and `linear`; the other kinds are stored only, for future use.
- `channel_keys(norm_key TEXT, channel_id TEXT, score INTEGER, PRIMARY KEY(norm_key, channel_id))` with an index on `norm_key`: every name a channel can be found under, with a precomputed score (quality x 1000 + group priority) so a lookup is one indexed query ordered by score. Keys exist for `team` and `linear` rows; `event` and `placeholder` rows are stored without keys.
- `channel_health(channel_id TEXT PRIMARY KEY, status TEXT, checked_at TEXT, frozen INTEGER)`: reserved for the health audit to write later; not written in v1.

Lookup query: `SELECT c.* FROM channel_keys k JOIN channels c ON c.id = k.channel_id WHERE k.norm_key = ? ORDER BY k.score DESC LIMIT 2`.

### 2. Keys: `src/services/TrexCatalogKeys.js` (shared by the refresh job and the runtime)

- `normalizeName`: NFKD, strip diacritics, lowercase, keep `a-z0-9`, collapse spaces.
- Channel key: drop the leading group token (`UK| `), bracketed and parenthesised annotations, quality tokens (`HD`, `FHD`, `4K`, `RAW`, `UHD`, `SD`, fps and resolution markers), map `sports` to `sport`. An alias key also drops a trailing qualifier (`premium`, `extra`, `plus`, `max`, `vip`, `xtra`) and only fills gaps, never overriding an exact key.
- Team channel keys: recognize `NBA TEAM|`, `NHL TEAM|`, `AHL-TEAM|`, `NFL TEAMS|`, `LA LIGA|`, `SERIE A|` and `MLB <club>` names; strip `[CHI]` codes, a leading network (`CBS`, `FOX`, `NBC`, `ABC`, `ESPN`, `PRIME`, `CW`), a trailing US state code; drop club filler (`de`, `del`, `fc`, `cf`, `ac`, `sc`, `club`, ...). Emit every plausible order: two-token names in both orders (`bears chicago` and `chicago bears`); names containing a multi-word city (`new york`, `kansas city`, `green bay`, `los angeles`, ...) emit city + each club token, so `BILLS GIANTS JETS NEW YORK NY` yields `new york bills`, `new york giants`, `new york jets`.
- Fixture team query keys: same normalizer and rules applied to the team name as the schedule source writes it (`Chicago Bulls`, `Valencia CF`, `Atlético de Madrid`). No nickname dictionary in v1: the upstream names teams by city or university, and schedule sources do too.
- Event search tokens: the first three cleaned tokens of a team name. If the search returns nothing, retry once without the last token (`east carolina pirates` -> `east carolina`), and still require the other team's tokens in the result name.
- Score: `qualityScore(name) * 1000 + groupPriority(group)`, with `UHD/4K > FHD > HD > plain > SD` and UK/US/IE/CA/AU preferred over smaller markets when the same identity exists in several groups.

### 3. Refresh job: `scripts/refresh_trex_catalog.js`

- Standalone script, run by cron once a day (default 08:00 UTC, configurable), never inside a worker: `node scripts/refresh_trex_catalog.js --db data/trex_catalog.sqlite`.
- Pages the generic catalog with `skip=` in batches of 4 requests, stops at the first page with fewer than 100 metas, keeps only compact `{id, name, type}` tuples (about 11 MB for 54k rows, never the full metas with posters), classifies each meta (team, linear via the sports taxonomy, event by the `Live |` / `Next |` / `End |` prefixes or a `vs` plus timestamp, placeholder by name, other), computes keys and scores, and writes everything in one transaction into the same file with WAL journaling so workers keep reading the previous content until the commit.
- Records `meta`. Deletes rows that disappeared upstream. Targets: about 1 minute, about 60 MB, zero worker involvement.
- On any error the transaction rolls back, the database stays as it was, and the script exits non-zero with a redacted error kind (no URL).
- A `--from-csv` mode builds the same database from `trex_channels.csv` for development and for the first production seed.

### 4. Runtime store: `src/services/TrexCatalogStore.js`

- One read-only `node:sqlite` connection per worker, opened lazily on first use and registered as a singleton in the container. If the file is missing or unreadable, `isReady()` is false and Kafka falls back to today's behavior (dedicated catalogs only); nothing throws into the request or sync path.
- `findTeam(teamName)` and `findChannel(label)` return up to two candidates ordered by score; each call is one indexed query.
- Context: when a fixture source carries a country (`country` / `countryCode`), candidates from that country rank first; otherwise the global score decides. The dedicated-catalog `createSource` keeps its strict refusal unchanged; the store is the widened path, so a label that exists in several regions resolves to the preferred region's best feed instead of being refused.
- Env `KAFKA_CATALOG_DB` sets the path; unset or empty disables the feature (kill switch).

### 5. Event channels: `src/services/TrexEventSearch.js`

- Timing: event channels are looked up on the click path, not only in the sync, because sources are published by syncs that may not run near kickoff. When a request for a fixture's streams reaches the Kafka dispatch and the fixture has no event source yet, `TrexEventSearch.findForFixture(fixture)` runs for fixtures with kickoff between 15 minutes ago and 4 hours ahead (so a source is not dropped mid-game). The resulting channels are resolved in the same request and returned next to the team and label candidates.
- A sync-time sweep covers live-window fixtures, nearest kickoff first, at most 20 searches per sync, so the cards of the fixtures about to start already show the event source. Everything else is found at click time, which costs nothing unless someone opens the fixture.
- Query: `search=` with the first team's cleaned tokens (up to three), trim-and-retry once on zero results (section 2), confirm the other team's tokens in the result name, keep names carrying an event marker (`vs`, `Live |`, `Next |`).
- Priority and ranking: event candidates come first in the fixture's source list and are ranked by the quality markers in their names (8K, then 4K/UHD, then FHD, then HD), then by group priority. The team channel and the label candidates follow as fallbacks within the injection cap, so if the event feed is dropped by the frozen rule at click time the fallbacks still play.
- Cache per fixture id for 10 minutes, cap 2,000 entries, concurrency 2. Each search is one request.
- Kill switch `KAFKA_EVENT_SEARCH_ENABLED`.

### 6. Provider and aggregator wiring (only after this design is approved)

- `MatchAggregator._enrichMatchesWithKafka` gains two steps around the existing label matching: event channels for live-window fixtures (section 5) and team channels from the fixture's home and away names. Sources are appended in priority order (event, team, label) and carry `matchMode: 'event' | 'team' | 'label'` for telemetry. The injection cap still applies; duplicates by channel id are skipped; an event-channel hit is placed before a team or label hit for the same fixture.
- Liveness guard as a verifier rule, not a provider fetch: `verifyStreams` in `src/streams.js` already unwraps `/api/manifest`, downloads the playlist body (`bodySample`) and parses it within its verify budget. Add one rule once the body is available: if the body is a media playlist (contains `#EXT-X-MEDIA-SEQUENCE`) with sequence `0`, drop the stream and log `[Filter] Dropped frozen playlist (sequence 0)`. Master playlists without a sequence stay as they are (unknown is kept). No extra request and no second cache. The rule applies to Kafka sources only (kill switch `KAFKA_LIVENESS_GUARD_ENABLED`, default on), including the rare Kafka stream whose upstream hints would otherwise skip verification.
- Alternates: because the store returns up to two candidates per identity, a frozen top feed is dropped by the verifier while the alternate still plays. That is the v1 acceptance: no frozen stream reaches the player, even though a listed source can still resolve to nothing.
- Logs per sync: `[KafkaProvider] attached N Kafka source(s): team a, label b, event c`, plus the refresh job's one-line summary. No URLs in any log line.

### 7. Tests

- Keys: normalizer, channel keys and aliases, team keys for every naming style found in the catalog (NBA, NHL, AHL bracket codes, NFL network + state code, the combined New York entry, La Liga and Serie A fillers, MLB), scoring and ordering.
- Store: build a temporary database from fixture rows through the refresh job's build function; team and label lookups; missing database reports not ready; a reader sees the old content while a refresh transaction is open.
- Refresh job: pagination with a mocked fetch (stops on a short page, batches, error leaves the database untouched), streaming memory (never collects all metas), redacted errors.
- Verifier: a media playlist with sequence 0 is dropped; a master playlist and any sequence above 0 are kept; non-Kafka sources are untouched; kill switch.
- Event search: live window, trim-and-retry, other-team confirmation, cache, sync budget, the dispatch integration, and ordering (event candidates precede team and label candidates; 8K/4K/FHD names outrank HD).
- Provider: source creation per mode with country preference and alternates; kill switches.
- Aggregator: team and event attachment, cap, dedupe, telemetry, and the existing behavior unchanged when the store is not ready.
- Regression: the existing 34 Kafka tests and the broadcaster match tests stay green.

### 8. Rollout

1. Land keys, store, refresh job and tests with `KAFKA_CATALOG_DB` unset: no behavior change.
2. Run the refresh job on the VPS by hand; check counts (about 54.5k rows, 172 team channels, about 8k linear sports channels) and the file size.
3. Set `KAFKA_CATALOG_DB`; watch attachments per sync and worker memory (expected change: none measurable).
4. Enable event search and the liveness guard; watch resolve outcomes and the frozen share.
5. Add the cron line.

## Builder check (independent review of this document)

A fresh reviewer read this document as the builder and raised five questions. Each was settled as my call, listed here so the owner can veto any of them:

1. Event search only in the sync would miss most fixtures (syncs do not always run near kickoff) and a 90-minute cutoff would drop sources mid-game. Settled: lookup on the click path with a 4-hour window, plus a small sync-time sweep for fixtures starting within 30 minutes.
2. Whether label matching really widens to the generic catalog and whether the strict ambiguity refusal survives. Settled: the store is the widened path with ranked candidates and country preference; the dedicated-catalog strict path stays as it is.
3. Fixture names with nicknames (`East Carolina Pirates`) match nothing. Settled: no nickname dictionary in v1; search tokens trimmed with one retry; both teams still required.
4. A second playlist fetch in the provider would duplicate what `verifyStreams` already downloads. Settled: the frozen rule lives in `verifyStreams`, zero extra requests.
5. "No dead clicks" cannot be guaranteed at publish time in v1 without per-channel health data. Settled: acceptance at click time, with an alternate candidate per identity so a frozen top feed does not leave the user with nothing.

## What is left to the builder

- Exact SQL, indexes, WAL and `busy_timeout` settings, and whether the read-only connection is cached per worker as a container singleton.
- Log wording and env names, provided they do not collide with existing ones.
- Redacted test fixtures (rows copied from the catalog with any token-bearing text removed).
- Whether the first production seed comes from `--from-csv` or from the first live run.

## Decisions made in conversation (owner) and calls made here (mine)

- Owner: efficiency is the goal; keep all 54k rows; a database is fine; daily refresh; "mainstream" means US major leagues; event channels take priority because they carry the 4K/FHD feeds; do not edit existing code before approval of this design.
- My calls: SQLite via built-in `node:sqlite`; one file in `data/`; same-file transactional refresh with WAL; refresh at 08:00 UTC; event search on the click path with a small sync sweep; no nickname dictionary in v1; frozen rule inside `verifyStreams`; dedicated catalogs left as they are.
