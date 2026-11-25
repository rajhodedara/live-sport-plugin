# Private Addon Usage Stats (DAU / WAU / MAU) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track private, privacy-preserving DAU, WAU, and MAU counts across `/manifest.json`, `/catalog/`, and `/stream/` requests across all PM2 cluster workers and expose them on a private `/api/stats` endpoint.

**Architecture:** An Express middleware in `src/index.js` records anonymized `(day, endpoint_kind, visitor_hash)` hits into an in-memory buffer inside `UsageStatsService` (`src/services/UsageStatsService.js`) and flushes batches periodically into a shared WAL-mode `node:sqlite` database (`data/usage_stats.sqlite`) so both PM2 workers aggregate into one store without blocking requests. A private `GET /api/stats` route (`src/routes/stats.js`), gated by `isLocalDirectRequest` or `STATS_TOKEN`, queries deduplicated 1d/7d/30d counts and endpoint totals.

**Tech Stack:** Node >= 22 (CommonJS), `node:sqlite` (`DatabaseSync`), `node:crypto` (SHA-256), Express 4, Awilix DI, Jest.

**Spec:** Conversational requirement from user (2026-11-25): quick private DAU/WAU/MAU numbers for `/manifest.json`, `/catalog/`, and `/stream/` without storing raw IPs or exposing stats publicly.

## Global Constraints

- CommonJS modules only (`require` / `module.exports`); Node >= 22 built-ins (`node:sqlite`, `node:crypto`).
- No raw user IPs stored on disk; hash `ip + salt` with SHA-256 (truncated hex) before buffering or writing.
- O(1) non-blocking request hot path: middleware must only `Set.add` / `Map` increment in memory and never run synchronous SQLite queries per HTTP request.
- Cluster-safe across PM2 `instances: 2`: both workers write to the same `USAGE_STATS_DB` (default `data/usage_stats.sqlite` with `WAL` + `busy_timeout`).
- Private-only access: `GET /api/stats` must deny unauthenticated external requests (`403`/`404`) and allow only `isLocalDirectRequest(req)` or valid `STATS_TOKEN` (`crypto.timingSafeEqual`).
- Do not edit `dist/` directly (I7); run targeted Jest tests via `npm test -- <path>`.

## Review Focus

- Missing or multi-value `cf-connecting-ip` / `x-forwarded-for` headers (comma-separated proxy chains) must normalize to the first client IP cleanly without throwing.
- Requests to non-addon paths (`/posters/...`, `/health`, `/favicon.ico`, `/status`) and `HEAD`/`OPTIONS` preflights must be ignored so static assets and bots don't inflate DAU/MAU.
- Unconfigured `STATS_TOKEN` on a public/proxied request must fail closed (deny access), while `isLocalDirectRequest(req)` continues to work on `127.0.0.1` for `curl` checks on the VPS.
- SQLite `SQLITE_BUSY` when two PM2 workers flush simultaneously must be handled via `PRAGMA busy_timeout = 5000` and `BEGIN IMMEDIATE` without crashing the worker.
- Retention pruning must drop rows older than 35 days so `data/usage_stats.sqlite` stays bounded in size.

---

### Task 1: Create `UsageStatsService` (Hashing, Buffered Batching, SQLite DAU/WAU/MAU)

**Files:**
- Create: `src/services/UsageStatsService.js`
- Test: `tests/usageStatsService.test.js`

**Interfaces:**
- Produces:
  - `class UsageStatsService({ dbPath?, salt?, flushIntervalMs?, retentionDays? })`
  - `UsageStatsService.prototype.extractClientIp(req) -> string | null`
  - `UsageStatsService.prototype.classifyEndpoint(path) -> 'manifest' | 'catalog' | 'stream' | null`
  - `UsageStatsService.prototype.recordRequest(req) -> boolean`
  - `UsageStatsService.prototype.flush() -> number`
  - `UsageStatsService.prototype.getSummary(nowDate?) -> { dau, wau, mau, stickiness, byEndpoint, daily, updatedAt }`
  - `UsageStatsService.prototype.close() -> void`

- [ ] **Step 1: Write failing tests for `UsageStatsService`**

Create `tests/usageStatsService.test.js` covering:
1. `classifyEndpoint`: matches `/manifest.json`, `/:config/manifest.json`, `/catalog/...`, `/:config/catalog/...`, `/stream/...`, `/:config/stream/...`; returns `null` for `/posters/x.png`, `/health`, `/api/stats`, `/`.
2. `extractClientIp`: prefers `cf-connecting-ip`, falls back to first entry of `x-forwarded-for`, then `req.ip`.
3. Privacy & deduplication: `recordRequest` hashes the IP (assert raw IP string does not appear in SQLite rows), deduplicates same IP on the same day across `DAU`, deduplicates same IP across 2 different days in `WAU`/`MAU`, and counts distinct IPs across `manifest` / `catalog` / `stream`.
4. Retention pruning: inserting a row 40 days old and calling `flush()` / `prune()` removes it from `MAU` and the table.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/usageStatsService.test.js`
Expected: FAIL (`Cannot find module '../src/services/UsageStatsService'`).

- [ ] **Step 3: Implement `UsageStatsService` in `src/services/UsageStatsService.js`**

- Use `node:sqlite` (`DatabaseSync`) with `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;`.
- Schema:
  - `daily_visitors (day TEXT NOT NULL, endpoint TEXT NOT NULL, visitor_hash TEXT NOT NULL, PRIMARY KEY (day, endpoint, visitor_hash))`
  - `daily_hits (day TEXT NOT NULL, endpoint TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, endpoint))`
- `recordRequest(req)` ignores non-`GET` methods and `classifyEndpoint(req.path) === null`; adds `${day}\0${endpoint}\0${hash}` to an in-memory `Set` and increments `pendingHits` `Map`.
- `flush()` drains both buffers inside a `BEGIN IMMEDIATE ... COMMIT` transaction with `INSERT OR IGNORE INTO daily_visitors` and `INSERT INTO daily_hits ... ON CONFLICT(day, endpoint) DO UPDATE SET hits = hits + excluded.hits`, plus once-per-hour pruning of `day < cutoff`.
- Background interval timer (`flushIntervalMs = 10000`, `.unref()`) and `close()` that flushes and closes the DB cleanly.
- `getSummary()` queries `COUNT(DISTINCT visitor_hash)` for today (`dau`), last 7 days (`wau`), last 30 days (`mau`), `byEndpoint` (`manifest`, `catalog`, `stream` for 1d/7d/30d + hit totals), and last 14 days breakdown.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/usageStatsService.test.js`
Expected: PASS (all tests in `tests/usageStatsService.test.js` green).

- [ ] **Step 5: Commit**

```bash
git add src/services/UsageStatsService.js tests/usageStatsService.test.js
git commit -m "feat(stats): add UsageStatsService for privacy-safe DAU/WAU/MAU tracking"
```

---

### Task 2: Add Private `GET /api/stats` Route

**Files:**
- Create: `src/routes/stats.js`
- Test: `tests/statsRoute.test.js`

**Interfaces:**
- Consumes: `UsageStatsService.prototype.getSummary()`, `isLocalDirectRequest(req)` from `src/services/localRequest.js`
- Produces: Express `router` handling `GET /api/stats` (with optional `?days=14`)

- [ ] **Step 1: Write failing tests for `src/routes/stats.js`**

Create `tests/statsRoute.test.js` covering:
1. External request without `STATS_TOKEN` configured returns `403`.
2. External request with wrong `Authorization: Bearer ...` or `?token=...` when `STATS_TOKEN` is set returns `403`.
3. External request with matching `Authorization: Bearer <token>` or `?token=<token>` returns `200` JSON with `Cache-Control: no-store` and `getSummary()` payload.
4. Local direct request (`isLocalDirectRequest(req) === true`) returns `200` even without a token.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/statsRoute.test.js`
Expected: FAIL (`Cannot find module '../src/routes/stats'`).

- [ ] **Step 3: Implement `src/routes/stats.js`**

- Gate `GET /api/stats` with `isAuthorizedStatsRequest(req)`:
  - Allow if `isLocalDirectRequest(req)`.
  - Otherwise read `process.env.STATS_TOKEN` (trimmed); if non-empty, compare against `Bearer <token>` header or `req.query.token` using `crypto.timingSafeEqual` on equal-length UTF-8 buffers.
  - Otherwise return `res.status(403).json({ error: 'Forbidden' })`.
- Resolve `usageStatsService` from `container`, set `Cache-Control: no-store`, and return `res.json(usageStatsService.getSummary())`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/statsRoute.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/stats.js tests/statsRoute.test.js
git commit -m "feat(stats): add private /api/stats route with local/token gate"
```

---

### Task 3: Wire `UsageStatsService` into Container, Middleware, and Shutdown

**Files:**
- Modify: `src/container.js`
- Modify: `src/index.js`
- Modify: `.env.example`
- Test: `tests/usageStatsIntegration.test.js`

**Interfaces:**
- Consumes: `UsageStatsService` (`src/services/UsageStatsService.js`), `src/routes/stats.js`
- Produces: `usageStatsService` singleton in `container`, request-recording middleware before addon routes in `src/index.js`, and `/api/stats` mounted before the SDK router (I9).

- [ ] **Step 1: Write failing integration test**

Create `tests/usageStatsIntegration.test.js` verifying:
1. `container.resolve('usageStatsService')` returns a `UsageStatsService` instance.
2. Middleware invokes `usageStatsService.recordRequest(req)` for `/manifest.json` and `/stream/tv/123.json` without delaying or altering the response.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/usageStatsIntegration.test.js`
Expected: FAIL (`AwilixResolutionError` for `usageStatsService`).

- [ ] **Step 3: Wire `src/container.js`, `src/index.js`, and `.env.example`**

- `src/container.js`: register `usageStatsService: asFunction(() => new UsageStatsService()).singleton()`.
- `src/index.js`:
  - Add lightweight middleware right after `app.set('trust proxy', true)` / `cors()` that calls `try { container.resolve('usageStatsService').recordRequest(req); } catch (_) {}` then `next()`.
  - Mount `app.use(require('./routes/stats'));` alongside `health` / before the SDK router (respecting I9).
  - Flush/close `usageStatsService` on `SIGINT`/`SIGTERM` if shutdown handler exists, or in `UsageStatsService`.
- `.env.example`: document optional `STATS_TOKEN=` and `STATS_SALT=` and `USAGE_STATS_DB=`.

- [ ] **Step 4: Run all stats tests and syntax checks**

Run: `npm test -- tests/usageStatsService.test.js tests/statsRoute.test.js tests/usageStatsIntegration.test.js` and `node --check src/index.js`
Expected: PASS (3 suites green, syntax check exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/container.js src/index.js .env.example tests/usageStatsIntegration.test.js
git commit -m "feat(stats): wire UsageStatsService and /api/stats into app"
```

---

## Self-Review

- **Spec coverage:** Private DAU/WAU/MAU numbers for `/manifest.json`, `/catalog/`, `/stream/`, hashed IPs, cluster-safe across 2 PM2 workers, private `/api/stats` endpoint — all covered across Tasks 1–3.
- **Step scan:** Each step names exact files, signatures, test assertions, and verification commands.
- **Type consistency:** `UsageStatsService`, `recordRequest`, `flush`, `getSummary`, `close`, `isLocalDirectRequest`, `usageStatsService` match across all 3 tasks.
- **Review Focus:** All 5 failure modes (`cf-connecting-ip` chains, static-asset filtering, fail-closed `STATS_TOKEN`, SQLite `busy_timeout` + `BEGIN IMMEDIATE`, 35-day pruning) have explicit handling and test coverage.
