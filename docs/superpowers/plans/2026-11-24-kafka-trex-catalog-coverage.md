# Kafka/Trex Catalog Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Kafka provider attach the right Trex channel to any live fixture (event feed first, then team channel, then broadcaster label) from a local SQLite copy of the full 54k-channel generic catalog, refreshed daily, with zero catalog memory in workers and no frozen stream reaching a user.

**Architecture:** A nightly standalone job pages the upstream catalog into one SQLite file (`data/trex_catalog.sqlite`). Workers open it read-only and answer "which channel matches this team or label" with one indexed query each. Per-game event channels are found by live `search=` near kickoff, cached per fixture, on the click path plus a small budgeted sweep during match sync. The existing click-path playlist verifier gains one rule that drops frozen `MEDIA-SEQUENCE:0` playlists.

**Tech Stack:** Node 22 (VPS) / 24 (dev), CommonJS, built-in `node:sqlite` (`DatabaseSync`), Jest, existing `BaseProvider.proxyFetch` for upstream calls, PM2 + cron on the VPS.

**Spec:** `docs/superpowers/specs/2026-11-24-kafka-trex-catalog-coverage-design.md` (approved 2026-11-24). Background and measurements: `docs/evidence-kafka-trex/HANDOFF_KAFKA_TREX_2026-11-24.md`.

## Global Constraints

- No new npm dependencies. SQLite via the built-in `node:sqlite` only (`DatabaseSync`).
- CommonJS, `'use strict'`, Jest tests under `tests/`, run with `npx jest <file>`. Every touched JS file passes `node --check`.
- Never log, store, or return the manifest URL or any URL containing credentials; errors report a bounded kind (`safeErrorKind` pattern in `src/providers/KafkaProvider.js`).
- Worker memory budget for this feature: under 5 MB RSS. No upstream request may scale with catalog size inside a worker; the only worker-side upstream calls are event searches (at most 20 per sync, plus one per click on a live-window fixture).
- Env switches: `KAFKA_CATALOG_DB` (path; unset or empty = coverage feature off), `KAFKA_EVENT_SEARCH_ENABLED` (default on; `'false'` disables), `KAFKA_LIVENESS_GUARD_ENABLED` (default on; `'false'` disables).
- Existing suites stay green: `tests/kafka*.test.js` (34 tests), `tests/health*.test.js` (28 tests), `tests/broadcasterMatchService.test.js`, `tests/broadcasterMappingIdentity.test.js`.
- Work on a branch off `stable` (suggested name `kafka-trex-coverage`); commit after every task with conventional messages (`feat(kafka): ...`).
- Priority order fixed by the owner: event channel, then team channel, then broadcaster label. Fallbacks stay attached after the event channel.

## Review Focus

1. A fixture whose `team1`/`team2` are missing or nameless (title-only) must get no team source and must not throw. Pinned in Task 7 (test: title-only fixture yields label or nothing, never a throw).
2. A missing, corrupt, or mid-rewrite database at boot must leave `isReady()` false and the provider on today's behavior; nothing may throw into boot, sync, or request paths. Pinned in Task 3 (corrupt file) and Task 8 (store not ready during enrichment).
3. Upstream `search=` returning 502, timing out, or answering HTML must yield `[]`, log a redacted kind, and never cache the failure. Pinned in Task 5.
4. A playlist body that is a master playlist (no `MEDIA-SEQUENCE`), truncated (`bodyTruncated`), or a sequence above 0 must be kept by the frozen rule; non-Kafka sources are never touched by it. Pinned in Task 6.
5. The same fixture dispatched twice in one request (a team source and a label source) must trigger one upstream search, not two, and must not duplicate streams. Pinned in Task 6 (dispatch) and Task 7 (cache hit).

---

### Task 1: Catalog keys and scoring (`TrexCatalogKeys`)

**Files:**
- Create: `src/services/TrexCatalogKeys.js`
- Test: `tests/trexCatalogKeys.test.js`

**Interfaces:**
- Produces (all pure):
  - `normalizeName(value: string): string` (NFKD, diacritics stripped, lowercase, `[^a-z0-9]+` to spaces, trimmed)
  - `channelKey(rawName: string): string`
  - `channelAliasKey(rawName: string): string` (empty when no alias applies)
  - `teamChannelKeys(rawName: string): { league: string, keys: string[] } | null`
  - `teamQueryKeys(teamName: string): string[]`
  - `eventQueryTokens(teamName: string): string[]` (stopwords removed, first three tokens)
  - `classifyChannelKind(name: string): 'team' | 'linear' | 'event' | 'placeholder' | 'other'`
  - `isSportsChannelName(name: string): boolean` and `isPlaceholderName(name: string): boolean` (own copies of the tier A/B patterns and the placeholder pattern, so the runtime never depends on the audit tool modules)
  - `entryScore(name: string, group: string): number` (`qualityScore(name) * 1000 + groupScore(group)`), plus exported `qualityScore`, `groupScore`, `GROUP_PRIORITY`, `QUALITY_TOKENS`, `TEAM_STOPWORDS`

- [ ] **Step 1: Write the failing test** with these assertions:
  - `normalizeName('Atlético de Madrid ᴿᴬᵂ') === 'atletico de madrid'` (diacritics stripped; the superscript RAW glyphs are not `a-z0-9` and vanish) and `channelKey('UK| SKY SPORTS CRICKET FHD') === 'sky sport cricket'`.
  - `channelKey('US| CHICAGO SPORTS NETWORK HD') === 'chicago sport network'` (`sports` becomes `sport` in every token, on both the catalog side and the query side); `channelKey('UK| BEIN SPORTS 1 PREMIUM HD') === 'bein sport 1 premium'` and `channelAliasKey(same) === 'bein sport 1'`; `channelAliasKey('UK| SKY SPORTS CRICKET HD') === ''`.
  - `teamChannelKeys('NBA TEAM| CHICAGO BULLS')` equals `{ league: 'nba', keys: ['chicago bulls', 'bulls chicago'] }`; `teamChannelKeys('AHL-TEAM| CHICAGO WOLVES [CHI]')` keys contain `'chicago wolves'`; `teamChannelKeys('NFL TEAMS| CBS BEARS CHICAGO IL')` keys equal `['bears chicago', 'chicago bears']`; `teamChannelKeys('NFL TEAMS| CBS BILLS GIANTS JETS NEW YORK NY')` keys equal `['new york bills', 'new york giants', 'new york jets']`; `teamChannelKeys('LA LIGA| AC MILAN')` keys equal `['milan']`; `teamChannelKeys('US| MLB CHICAGO CUBS HD')` equals `{ league: 'mlb', keys: ['chicago cubs', 'cubs chicago'] }`; `teamChannelKeys('UK| SKY SPORTS CRICKET HD')` is `null`.
  - `teamQueryKeys('Atlético de Madrid')` contains `'atletico madrid'`; `teamQueryKeys('Valencia CF')` equals `['valencia']`; `teamQueryKeys('East Carolina Pirates')` equals `['east carolina pirates', 'pirates east carolina']`.
  - `eventQueryTokens('East Carolina Pirates')` equals `['east', 'carolina', 'pirates']`; `eventQueryTokens('Atlético de Madrid')` equals `['atletico', 'madrid']`.
  - `classifyChannelKind('NBA TEAM| CHICAGO BULLS') === 'team'`; `classifyChannelKind('NEXT | CHI - BULLS VS CLE - CAVALIERS | Mon 23 Nov 19:00 EST (US) | 8K EXCLUSIVE | US: NBA PASS PPV 6') === 'event'`; `classifyChannelKind('US (ESPN+ 073) | NCAA Women`s Basketball: Wofford vs. Wake Forest (Wofford vs. Wake Forest) (2026-11-23 18:00:40)') === 'event'`; `classifyChannelKind('NO EVENT STREAMING NOW -| Box Office') === 'placeholder'`; `classifyChannelKind('CA| WILLOW CRICKET HD') === 'linear'`; `classifyChannelKind('JOYN| 3SAT ᴿᴬᵂ') === 'other'`.
  - `entryScore('UK| SKY SPORTS CRICKET FHD', 'UK') > entryScore('IE| SKY SPORTS CRICKET HD', 'IE') > entryScore('XX| SKY SPORTS CRICKET', 'XX')`; `qualityScore('X 8K') > qualityScore('X 4K') > qualityScore('X FHD') > qualityScore('X HD') > qualityScore('X') > qualityScore('X SD')` (8K is the top tier, then 4K/UHD, FHD, HD, plain, SD).
- [ ] **Step 2: Run `npx jest tests/trexCatalogKeys.test.js`**; expected: FAIL with "Cannot find module '../src/services/TrexCatalogKeys'".
- [ ] **Step 3: Implement `src/services/TrexCatalogKeys.js`** per the Interfaces block and spec section 2. `classifyChannelKind` uses `isPlaceholderName` and `isSportsChannelName` from this same module (the runtime must not import the audit tool). Event detection: name starts with `Live |`, `Next |`, `End |`, `Ended |` (any case), or matches `/\bvs\.?\b/i` together with `/\(20\d\d-\d\d-\d\d/`. Team channel keys strip a leading network (`CBS|FOX|NBC|ABC|ESPN|PRIME|CW`), a trailing two-letter uppercase state code, and `[...]` codes. City phrases are detected whether they start the token list (`new york giants`) or end it (`bills giants jets new york`); in both cases every remaining token becomes `city + token`.
- [ ] **Step 4: Run `npx jest tests/trexCatalogKeys.test.js`**; expected: PASS.
- [ ] **Step 5: Commit** `git add src/services/TrexCatalogKeys.js tests/trexCatalogKeys.test.js && git commit -m "feat(kafka): add Trex catalog key normalization and scoring"`.

### Task 2: Database schema and writer (`TrexCatalogDb`)

**Files:**
- Create: `src/services/TrexCatalogDb.js`
- Test: `tests/trexCatalogDb.test.js`

**Interfaces:**
- Consumes: `classifyChannelKind`, `channelKey`, `channelAliasKey`, `teamChannelKeys`, `entryScore` from Task 1.
- Produces:
  - `openDatabase(dbPath: string, { readOnly?: boolean }): DatabaseSync` (creates the file when not read-only; sets `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`, `PRAGMA synchronous=NORMAL`)
  - `ensureSchema(db): void` creating `meta`, `channels`, `channel_keys`, `channel_health` exactly as in spec section 1 (index `idx_channel_keys_norm` on `channel_keys(norm_key)`)
  - `replaceCatalog(db, metas: Array<{ id: string, name: string, type?: string }>, { generatedAt: string, source: string }): { rows: number, teamChannels: number, linearChannels: number, eventChannels: number, keys: number }` (one transaction: delete `channels` and `channel_keys`, insert all; dedupes by id; one `channel_keys` row per team key and per channel key plus alias)
  - `writeCatalogFile(dbPath: string, metas, opts): stats` (open, ensureSchema, replaceCatalog, close)
  - `readMeta(db): Record<string, string>`

- [ ] **Step 1: Write the failing test** using a temp directory (`fs.mkdtempSync(path.join(os.tmpdir(), 'trex-'))`): given 6 metas (NBA team, AHL team, NFL combined entry, linear `CA| WILLOW CRICKET HD`, event `NEXT | ...`, placeholder), assert `replaceCatalog` returns `{ rows: 6, teamChannels: 3, linearChannels: 1, eventChannels: 1, keys: 8 }` (the NBA entry 2 keys, the AHL entry 2, the NFL combined entry 3, the linear channel 1; event and placeholder rows carry no keys) and that `SELECT kind, COUNT(*) FROM channels GROUP BY kind` returns `{ team: 3, linear: 1, event: 1, placeholder: 1 }`; assert a second `replaceCatalog` with 2 metas leaves exactly 2 rows (old rows deleted); assert `readMeta(db).generated_at` equals the passed value; assert that writing through `writeCatalogFile` to a path whose directory does not exist throws a clear error and leaves no partial file.
- [ ] **Step 2: Run `npx jest tests/trexCatalogDb.test.js`**; expected: FAIL (module not found).
- [ ] **Step 3: Implement `src/services/TrexCatalogDb.js`** with `node:sqlite`. Key rows: `score = entryScore(name, group)` where `group` is the token before `|` in the name (empty string when none). Placeholder and event rows are stored without keys. Suppress the one-time `ExperimentalWarning` in tests by nothing: it is a stderr line only, assertions are unaffected.
- [ ] **Step 4: Run `npx jest tests/trexCatalogDb.test.js`**; expected: PASS.
- [ ] **Step 5: Commit** `git add src/services/TrexCatalogDb.js tests/trexCatalogDb.test.js && git commit -m "feat(kafka): add Trex catalog SQLite schema and writer"`.

### Task 3: Read-only store (`TrexCatalogStore`)

**Files:**
- Create: `src/services/TrexCatalogStore.js`
- Test: `tests/trexCatalogStore.test.js`

**Interfaces:**
- Consumes: `openDatabase` from Task 2 (readOnly), `teamQueryKeys`, `channelKey`, `teamChannelKeys` from Task 1.
- Produces: `class TrexCatalogStore { constructor({ dbPath } = {}); isReady(): boolean; findTeam(teamName: string): Candidate[]; findChannel(label: string, context: { country?: string, countryCode?: string } = {}): Candidate[]; stats(): { rows: number, teams: number, channels: number, generatedAt: string } }` with `Candidate = { id: string, name: string, group: string, league: string | null, score: number }`; `findTeam` tries `teamQueryKeys` in order and returns the first key's matches (max 2); `findChannel` orders by country match first (candidate `group` starts with `context.countryCode` or equals `context.country`, case-insensitive), then `score` desc, max 2.

- [ ] **Step 1: Write the failing test**: build a temp database with `writeCatalogFile` from Task 2 containing `NBA TEAM| CHICAGO BULLS`, `UK| SKY SPORTS CRICKET FHD`, `IE| SKY SPORTS CRICKET HD`, `CA| WILLOW CRICKET HD`; assert `isReady()` is true; `findTeam('Chicago Bulls')[0].id` equals the Bulls id and `.league === 'nba'`; `findTeam('Bulls')` returns `[]`; `findChannel('Sky Sports Cricket HD')[0].group === 'UK'`; `findChannel('Sky Sports Cricket HD', { countryCode: 'IE' })[0].group === 'IE'`; `findChannel('Willow Cricket')[0].name === 'CA| WILLOW CRICKET HD'`; a store pointed at a non-existent path reports `isReady() === false` and every lookup returns `[]`; a store pointed at a file containing `not sqlite` reports `isReady() === false` without throwing; `stats().rows === 4`; concurrent read during a write: with a writer connection holding `BEGIN` plus an `INSERT INTO channels`, the store (its own read-only connection) still returns only the pre-transaction hits, and after `COMMIT` the new row is returned.
- [ ] **Step 2: Run `npx jest tests/trexCatalogStore.test.js`**; expected: FAIL (module not found).
- [ ] **Step 3: Implement `src/services/TrexCatalogStore.js`**: lazy open on first use, `readOnly: true`, every failure caught and turned into `isReady() === false` with one `console.warn('[TrexCatalogStore] not ready:', kind)`. Default `dbPath` is `process.env.KAFKA_CATALOG_DB`; empty means not ready.
- [ ] **Step 4: Run `npx jest tests/trexCatalogStore.test.js`**; expected: PASS.
- [ ] **Step 5: Commit** `git add src/services/TrexCatalogStore.js tests/trexCatalogStore.test.js && git commit -m "feat(kafka): add read-only Trex catalog store"`.

### Task 4: Nightly refresh job (`scripts/refresh_trex_catalog.js`)

**Files:**
- Create: `scripts/refresh_trex_catalog.js`
- Test: `tests/refreshTrexCatalog.test.js`

**Interfaces:**
- Consumes: `writeCatalogFile` from Task 2.
- Produces: `fetchCatalogRows({ baseUrl: string, catalogId?: string ('flix-live-tv-v2-trex'), pageSize?: number (100), concurrency?: number (4), maxPages?: number (600), fetchImpl? (global fetch), timeoutMs?: number (15000) }): Promise<{ metas: Array<{ id, name, type }>, pages: number, truncated: boolean }>` (pages in batches of `concurrency`, stops scheduling once any fetched page returned fewer than `pageSize` metas or a non-200 status; `truncated` is true when `maxPages` was hit before a short page); `run(argv: string[], deps?: { fetchImpl? }): Promise<number>` returning the exit code; CLI flags `--db <path>` (default `data/trex_catalog.sqlite`), `--from-csv <path>`, `--base-url <url>` (default: `KAFKA_MANIFEST_URL` without `/manifest.json`), `--concurrency`, `--max-pages`, `--quiet`. The script runs only when `require.main === module`. Also exports `parseCsvLine(line: string): string[]` (RFC 4180: double quotes, `""` escapes) used by `--from-csv`, which skips the header row.

- [ ] **Step 1: Write the failing test**: a `fetchImpl` stub that answers `skip=0` and `skip=100` with 100 metas each and `skip=200` with 40 metas must yield `pages === 3`, `metas.length === 240`, `truncated === false`, and the stub must never be called with `skip=300`; a stub answering every page with 100 metas under `maxPages: 3` yields `truncated === true`; a stub answering `skip=100` with status 502 must make `fetchCatalogRows` reject with an error whose `message` contains `HTTP 502` and not the base URL; `run(['--db', tmpDb, '--from-csv', fixtureCsv])` returns `0` and the resulting database has `readMeta(db).source === 'csv'` with the CSV's row count; `run(['--db', tmpDb, '--base-url', 'https://upstream.invalid/u/secret'])` with a stub that fails returns `1` and leaves a pre-existing database at `tmpDb` unchanged (compare `readMeta(db).generated_at` before and after). Create a small redacted CSV fixture inline in the test (`id,name,prefix,type,description` with 3 rows).
- [ ] **Step 2: Run `npx jest tests/refreshTrexCatalog.test.js`**; expected: FAIL (module not found).
- [ ] **Step 3: Implement `scripts/refresh_trex_catalog.js`**: `require('dotenv').config({ quiet: true })`; base URL derived with `replace(/\/manifest\.json$/, '')`; page URL `${base}/catalog/tv/${catalogId}/skip=${skip}.json`; each response read with a body cap of 4 MB; metas pushed as `{ id, name, type }` only; the database is written only after all pages succeeded; log one summary line with counts and duration, never a URL. `--from-csv` parses with the script's own `parseCsvLine` and uses `source: 'csv'`.
- [ ] **Step 4: Run `npx jest tests/refreshTrexCatalog.test.js`**; expected: PASS.
- [ ] **Step 5: Commit** `git add scripts/refresh_trex_catalog.js tests/refreshTrexCatalog.test.js && git commit -m "feat(kafka): add nightly Trex catalog refresh job"`.

### Task 5: Event channel search (`TrexEventSearch`)

**Files:**
- Create: `src/services/TrexEventSearch.js`
- Test: `tests/trexEventSearch.test.js`

**Interfaces:**
- Consumes: `teamQueryKeys`' normalizer pieces: `eventQueryTokens`, `normalizeName` from Task 1; `entryScore` for ranking.
- Produces: `class TrexEventSearch { constructor({ baseUrl?: string, fetchImpl? (global fetch), ttlMs?: number (600000), maxEntries?: number (2000), concurrency?: number (2), now?: () => number })`; `isInWindow(kickoffMs: number, nowMs?: number): boolean` (now minus 15 min through now plus 4 h); `cachedFor(fixtureId: string): EventCandidate[]` (no network; `[]` when absent or expired); `findForFixture(match, { force?: boolean } = {}): Promise<EventCandidate[]>`; `sweep(matches: Array<{ id, date }>, { maxSearches?: number (20) } = {}): Promise<Map<string, EventCandidate[]>>` (live-window fixtures sorted by absolute distance from now, at most `maxSearches` upstream searches, run with the instance concurrency); `EventCandidate = { id: string, name: string, group: string, score: number }`. Search: `GET ${base}/catalog/tv/flix-live-tv-v2-trex/search=${encodeURIComponent(tokens.join(' '))}.json` (timeout 8 s, body cap 512 KB); candidates must contain the other team's first normalized token in `normalizeName(name)`; ranked by `entryScore(name, group)` desc; max 2; on zero results retry once without the last token; failures return `[]`, log `[TrexEventSearch] search failed: <kind>`, and are not cached. Team names come from `match.team1`/`match.team2` which may be objects (`{ name }`) or strings.

- [ ] **Step 1: Write the failing test** with a `fetchImpl` stub and `now` fixed at `Date.UTC(2026, 10, 23, 19, 0)`:
  - `isInWindow(now - 14 * 60000)` true, `isInWindow(now - 16 * 60000)` false, `isInWindow(now + 4 * 3600000 - 1)` true, `isInWindow(now + 4 * 3600000 + 1)` false.
  - Fixture `{ id: 'f1', date: String(now + 600000), team1: { name: 'Wofford' }, team2: { name: 'Wake Forest' } }`: stub returns `{ ok: true, status: 200, json: async () => ({ metas: [{ id: 'trex:1', name: 'NEXT | WOFFORD VS. WAKE FOREST | Mon 23 Nov 23:55 CET (SE) | 8K EXCLUSIVE | SE: PLAY+ PPV 19' }, { id: 'trex:2', name: 'US (ESPN+ 073) | NCAA Women`s Basketball: Wofford vs. Wake Forest (Wofford vs. Wake Forest) (2026-11-23 18:00:40)' }, { id: 'trex:3', name: 'ESPN+: Queens vs. Wofford (Queens vs. Wofford) (2026-11-24 18:00:55)' }] }) }`; assert the stub URL contains `search=wofford`; result ids equal `['trex:1', 'trex:2']` (8K first, `trex:3` excluded because `wake` is missing); a second `findForFixture` for `f1` makes no further stub call; `cachedFor('f1')` returns the same two.
  - Trim-and-retry: `{ team1: { name: 'East Carolina Pirates' }, team2: { name: 'Indiana State' } }` with a stub answering `search=east carolina pirates` with zero metas and `search=east carolina` with one meta whose name contains `INDIANA STATE VS. EAST CAROLINA`; assert exactly two calls and the meta is returned.
  - Failure: stub answering `{ ok: false, status: 502, json: async () => ({}) }` yields `[]`, `cachedFor` stays `[]`, and a later good call is made again.
  - `sweep` with 30 live-window fixtures and `maxSearches: 20` calls the stub exactly 20 times, nearest kickoff first (assert the first URL contains the nearest team's token).
- [ ] **Step 2: Run `npx jest tests/trexEventSearch.test.js`**; expected: FAIL (module not found).
- [ ] **Step 3: Implement `src/services/TrexEventSearch.js`** per the Interfaces block. Cache is a `Map` keyed by fixture id with `{ at, candidates }`, evicting the oldest entry when `maxEntries` is exceeded. Base URL default: `process.env.KAFKA_MANIFEST_URL` without `/manifest.json`.
- [ ] **Step 4: Run `npx jest tests/trexEventSearch.test.js`**; expected: PASS.
- [ ] **Step 5: Commit** `git add src/services/TrexEventSearch.js tests/trexEventSearch.test.js && git commit -m "feat(kafka): add live event channel search with cache and budget"`.

### Task 6: Frozen-playlist rule and click-path event streams (`StreamPolicy`, `streams.js`)

**Files:**
- Modify: `src/services/StreamPolicy.js` (exports)
- Modify: `src/streams.js` (`verifyStreams` content checks right after the Pluto takedown-slate block, the `takedownslate|ptv_takedownslates` check; the `sourceName === 'kafka'` dispatch branch)
- Test: `tests/streamPolicyFrozen.test.js`, `tests/kafkaFrozenRule.test.js`; extend `tests/kafkaDispatch.test.js`

**Interfaces:**
- Produces: `isFrozenMediaPlaylist(body: string): boolean` in `StreamPolicy.js` (true when `/#EXT-X-MEDIA-SEQUENCE:\s*0(?!\d)/` matches and the body also contains `#EXTM3U`).
- Consumes: `KafkaProvider.resolveEventStreams(match, opts): Promise<StreamEntity[]>` (Task 7) in the dispatch branch.

- [ ] **Step 1: Write the failing tests**:
  - `tests/streamPolicyFrozen.test.js`: `isFrozenMediaPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:11\n#EXT-X-MEDIA-SEQUENCE:0\n')` is true; `#EXT-X-MEDIA-SEQUENCE:12` is false; `#EXT-X-MEDIA-SEQUENCE:0` without `#EXTM3U` is false; a master playlist (only `#EXT-X-STREAM-INF`) is false; `'not a playlist'` is false.
  - In `tests/kafkaDispatch.test.js`, add a test where the fake `kafkaProvider` exposes `resolveEventStreams: jest.fn().mockResolvedValue([{ name: 'Kafka', title: 'Event feed', url: 'https://cdn.example.invalid/e.m3u8', _source: 'kafka' }])`: dispatching a source with `matchMode: 'team'` returns the event stream first followed by the `resolveStream` result; dispatching a source with `matchMode: 'event'` never calls `resolveEventStreams`; dispatching a second non-event source for the same fixture returns the event stream again (the second `resolveEventStreams` is a cache hit upstream; `handleStream` dedupes by `source:url`, existing behavior, not re-tested here).
  - Verifier, in a new `tests/kafkaFrozenRule.test.js`: mock `../src/impitClient` exactly as `tests/vavooChannelIsolationAndVerification.test.js` does (`safeFetch: jest.fn(), isImpitAvailable: () => false, getImpit: () => null`), build a `StreamEntity` whose url is `https://cdn.example.invalid/live/media.m3u8`, set `stream._source = 'kafka'`, and call `verifyStreams([stream], 'cacheKey', parser, cache)` with the same `parser` construction as that file. Body `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n` is dropped (length 0, `cache.failures === 1`); the same body with `MEDIA-SEQUENCE:7` is kept; a stream with `_source: 'vavoo'` and sequence 0 is kept; with `process.env.KAFKA_LIVENESS_GUARD_ENABLED = 'false'` the Kafka stream with sequence 0 is kept (restore the env afterwards).
- [ ] **Step 2: Run `npx jest tests/streamPolicyFrozen.test.js tests/kafkaFrozenRule.test.js tests/kafkaDispatch.test.js`**; expected: FAIL.
- [ ] **Step 3: Implement**: add `isFrozenMediaPlaylist` to `StreamPolicy.js`; in `verifyStreams`, right after the Pluto takedown-slate block add the rule guarded by `s._source === 'kafka' && process.env.KAFKA_LIVENESS_GUARD_ENABLED !== 'false' && isFrozenMediaPlaylist(bodySample)`, logging `[Filter] Dropped frozen playlist (sequence 0): ${targetUrl}`, calling `resolveCache.noteFailure(cacheKey)` when `cacheKey` is set, returning `null`; in the `kafka` dispatch branch, after `resolveStream`, when `typeof provider.resolveEventStreams === 'function' && src.matchMode !== 'event'`, prepend `await provider.resolveEventStreams(match, opts)` (filter falsy entries).
- [ ] **Step 4: Run the three test files plus `tests/vavooChannelIsolationAndVerification.test.js`**; expected: PASS.
- [ ] **Step 5: Commit** `git add src/services/StreamPolicy.js src/streams.js tests/streamPolicyFrozen.test.js tests/kafkaFrozenRule.test.js tests/kafkaDispatch.test.js && git commit -m "feat(kafka): drop frozen Trex playlists in verification and resolve event feeds on the click path"`.

### Task 7: Provider source creation and event resolution (`KafkaProvider`)

**Files:**
- Modify: `src/providers/KafkaProvider.js` (constructor, new methods; existing `resolveStream` unchanged)
- Modify: `src/container.js` (register `trexCatalogStore` as `asClass(TrexCatalogStore).singleton()`, `trexEventSearch` as `asClass(TrexEventSearch).singleton()`, pass `catalogStore` and `eventSearch` into `kafkaProvider`)
- Test: `tests/kafkaCoverage.test.js`; extend `tests/kafkaRegistration.test.js`

**Interfaces:**
- Consumes: `TrexCatalogStore` (Task 3), `TrexEventSearch` (Task 5), existing `resolveStream(sourceId, matchCategory, matchTitle, src, opts)`.
- Produces:
  - `constructor(opts = {})` additionally reads `opts.catalogStore` (default `null`) and `opts.eventSearch` (default `null`)
  - `isCoverageReady(): boolean` (store present and ready)
  - `teamNamesOf(match): string[]` (from `team1`/`team2`, object `.name` or string, trimmed, empty entries dropped)
  - `createSourcesForFixture(match, { now?: number } = {}): KafkaSource[]` where `KafkaSource = { source: 'kafka', id: string, channelName: string, catalogId: 'flix-live-tv-v2-trex', matchMode: 'event' | 'team' | 'label', country?: string, language?: string }`; order: event candidates from `eventSearch.cachedFor(match.id)` when `isInWindow(match.date)`, then team hits for each team name, then label hits for each existing source's `channelName`/`channel_name`/`channel` with `{ country, countryCode }` context; ids deduped; `KAFKA_INJECTION_CAP` respected
  - `sweepEvents(matches, { maxSearches?: number } = {}): Promise<number>` (calls `eventSearch.sweep`, returns the number of fixtures that gained candidates; `0` when event search is disabled or absent)
  - `resolveEventStreams(match, opts): Promise<StreamEntity[]>` (`[]` unless event search is enabled and the fixture is in the window; otherwise `eventSearch.findForFixture(match)` then `resolveStream(id, match.category, match.title, { channelName: name, country }, opts)` for up to 2 candidates, concatenated)

- [ ] **Step 1: Write the failing tests** with a fake store (`{ isReady: () => true, findTeam: jest.fn(), findChannel: jest.fn() }`) and a fake event search (`{ isInWindow: jest.fn(), cachedFor: jest.fn(), findForFixture: jest.fn(), sweep: jest.fn() }`):
  - Fixture with `team1: { name: 'Chicago Bulls' }`, `team2: { name: 'Cleveland Cavaliers' }`, a DaddyLive source labelled `Chicago Sports Network`, kickoff in 30 minutes, cache holding one event candidate, store returning one team hit and one label hit: `createSourcesForFixture` returns modes `['event', 'team', 'label']` in that order, each with `source: 'kafka'` and `catalogId: 'flix-live-tv-v2-trex'`.
  - Same fixture but kickoff in 3 hours (outside the window): no event source; the same fixture with the cache empty: no event source.
  - Title-only fixture (`team1`/`team2` null) with a labelled source: returns only the label source; no throw.
  - `KAFKA_INJECTION_CAP=1`: exactly one source (the event one).
  - Dedupe: store returns the same id for the team hit and the label hit: one source with `matchMode: 'team'`.
  - Store not ready: `isCoverageReady()` false and `createSourcesForFixture` returns `[]`.
  - `sweepEvents` with `KAFKA_EVENT_SEARCH_ENABLED='false'` returns `0` and never calls `eventSearch.sweep`.
  - `resolveEventStreams` with one cached candidate calls `resolveStream` once with the candidate's id and returns its streams; outside the window returns `[]` without calling `resolveStream`.
  - `tests/kafkaRegistration.test.js`: `container.resolve('trexCatalogStore')` and `container.resolve('trexEventSearch')` are instances of their classes, and `container.resolve('kafkaProvider').catalogStore` is the same instance as the store.
- [ ] **Step 2: Run `npx jest tests/kafkaCoverage.test.js tests/kafkaRegistration.test.js`**; expected: FAIL.
- [ ] **Step 3: Implement** in `KafkaProvider.js` and `src/container.js`. Awilix injects by constructor parameter name through the container proxy, so the constructor destructures `{ catalogStore, eventSearch }`; register the two singletons so those names resolve. Existing `createSource` and the dedicated-catalog index stay exactly as they are.
- [ ] **Step 4: Run `npx jest tests/kafkaCoverage.test.js tests/kafkaRegistration.test.js tests/kafkaProvider.test.js`**; expected: PASS.
- [ ] **Step 5: Commit** `git add src/providers/KafkaProvider.js src/container.js tests/kafkaCoverage.test.js tests/kafkaRegistration.test.js && git commit -m "feat(kafka): build prioritized sources from the catalog store and event search"`.

### Task 8: Aggregator enrichment with priority order and event sweep (`MatchAggregator`)

**Files:**
- Modify: `src/services/MatchAggregator.js` (`_enrichMatchesWithKafka` around line 753; the Kafka refresh block around lines 1847 to 2223)
- Test: extend `tests/kafkaAggregator.test.js`

**Interfaces:**
- Consumes: `kafkaProvider.createSourcesForFixture(match, { now })`, `kafkaProvider.sweepEvents(matches, { maxSearches })`, `kafkaProvider.isCoverageReady()` from Task 7; existing `kafkaProvider.refreshIndex()`.
- Produces: enrichment result telemetry `{ enrichedFixtures, totalSourcesAttached, byMode: { event, team, label } }` passed to `providerHealthService.recordEnrichment`.

- [ ] **Step 1: Write the failing tests** in `tests/kafkaAggregator.test.js` with the existing `mockKafkaProvider` extended by `isCoverageReady: () => true`, `sweepEvents: jest.fn().mockResolvedValue(0)`, and `createSourcesForFixture: jest.fn((match) => [{ source: 'kafka', id: 'fx:ev', channelName: 'NEXT | ...', matchMode: 'event' }, { source: 'kafka', id: 'fx:team', channelName: 'NBA TEAM| CHICAGO BULLS', matchMode: 'team' }])`:
  - After `syncMatches`, the fixture's Kafka sources appear in the order event, team, label (an existing label source from `createSource` may follow), and `createSourcesForFixture` was called with the fixture and `{ now: expect.any(Number) }`.
  - `sweepEvents` is awaited before enrichment (assert the call order with `mock.invocationCallOrder`).
  - `recordEnrichment` receives `byMode` summing to `totalSourcesAttached` (if the existing assertion is an exact object match, change it to `expect.objectContaining`).
  - `isCoverageReady()` false: behavior is identical to today (label-only path), `sweepEvents` not called.
  - Existing tests in the file stay green unchanged except for the exact-match adjustment above.
- [ ] **Step 2: Run `npx jest tests/kafkaAggregator.test.js`**; expected: FAIL on the new assertions.
- [ ] **Step 3: Implement**: in `_enrichMatchesWithKafka`, when `isCoverageReady()` is true, prepend `kafkaProvider.createSourcesForFixture(match, { now })` to the candidate list (dedupe by id against existing Kafka sources), keep the label loop as the fallback, count per mode. In the sync block, start `kafkaProvider.sweepEvents(activeMatches, { maxSearches: 20 })` right after the Kafka refresh promise is created (fail-soft with a `console.warn` of the error kind), and await it alongside the refresh before enrichment. Log `[MatchAggregator] Injected N Kafka source(s) into M live fixture(s) (event a, team b, label c).`
- [ ] **Step 4: Run `npx jest tests/kafkaAggregator.test.js tests/kafkaProvider.test.js tests/kafkaDispatch.test.js tests/kafkaRegistration.test.js tests/kafkaCoverage.test.js`**; expected: PASS (the 34 original Kafka tests plus the new ones).
- [ ] **Step 5: Commit** `git add src/services/MatchAggregator.js tests/kafkaAggregator.test.js && git commit -m "feat(kafka): enrich fixtures with event, team and label sources from the Trex catalog"`.

### Task 9: Configuration, documentation and rollout notes

**Files:**
- Modify: `.env.example` (append the three Kafka coverage variables with blank defaults and comments)
- Modify: `docs/evidence-kafka-trex/HANDOFF_KAFKA_TREX_2026-11-24.md` (section 0 row and section 5.1 point to this plan and the new files)
- Modify: `.agents/tracks/current_task.md` (one line: plan path and status)

- [ ] **Step 1: Add to `.env.example`** after the existing Kafka block: `KAFKA_CATALOG_DB=` (comment: path to `data/trex_catalog.sqlite`; empty disables the generic-catalog coverage), `KAFKA_EVENT_SEARCH_ENABLED=true`, `KAFKA_LIVENESS_GUARD_ENABLED=true`, and the cron line as a comment: `0 8 * * * cd <app dir> && node scripts/refresh_trex_catalog.js >> data/trex_refresh.log 2>&1`.
- [ ] **Step 2: Run the full relevant suites**: `npx jest tests/kafka*.test.js tests/kafkaCoverage.test.js tests/trexCatalogKeys.test.js tests/trexCatalogDb.test.js tests/trexCatalogStore.test.js tests/refreshTrexCatalog.test.js tests/trexEventSearch.test.js tests/streamPolicyFrozen.test.js tests/health*.test.js tests/broadcasterMatchService.test.js tests/broadcasterMappingIdentity.test.js`; expected: all PASS.
- [ ] **Step 3: Run `node --check`** on every created or modified JS file; expected: no output (exit 0).
- [ ] **Step 4: Update the handoff and checkpoint** with the plan path, the file list, and the rollout checklist from spec section 8 (deploy with `KAFKA_CATALOG_DB` unset; run the refresh job by hand; expect about 54.5k rows, 172 team channels, about 8k linear sports channels; then set the path and watch; then enable event search and the guard; then add the cron line). Note the PM2 `node_args` addition `--disable-warning=ExperimentalWarning` as an operator step, to be applied at the next reload.
- [ ] **Step 5: Commit** the tracked files only (the handoff lives under the gitignored `docs/evidence-*/` and stays local): `git add .env.example .agents/tracks/current_task.md && git commit -m "docs(kafka): document Trex catalog coverage switches and rollout"`.
