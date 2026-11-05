# Project: Scorezone Provider Integration & VPS Deployment

## Architecture
- **Language & Runtime**: Node >= 22, CommonJS only. Express 4 + stremio-addon-sdk + Awilix DI container.
- **Provider Pattern**: `ScoreZoneProvider` inherits from `BaseProvider`, scraped upstream from `https://testscore.pxxl.pro`.
- **Egress Stack (PR #59 / PR #61 / Invariant I10)**: All outbound HTTP requests route through `BaseProvider.prototype.proxyFetch` or `ProviderOutbound.safeFetch` with `guardExternal: true`, connect-time DNS validation (`OutboundUrlGuard`), and `SharedOutboundFetch` native slot pool queueing with Undici capacity fallback.
- **Delivery Model (Invariant I1 / Decision D1)**: Master and variant playlists proxied through `/api/scorezone/manifest/...` (manifest text only). Media segments (.ts) rewritten to direct upstream CDN URLs with `behaviorHints.proxyHeaders`. Zero bulk media bytes transit the server.
- **Security & Tokens**: HMAC SHA256 signing of `sourceId` using `APP_SECRET` / `SESSION_SECRET` with non-production fallback.
- **Memory Retention (Decision D4)**: All in-memory caches (`tokenCache`, `playlistCache`, `ipRateLimits`, `_channelCache`) strictly bounded with FIFO eviction to respect 1500 MB PM2 memory ceiling.
- **Registration (Invariant I4)**:
  - `src/container.js`: `scorezoneProvider: asClass(ScoreZoneProvider).singleton()`
  - `src/services/MatchAggregator.js`: Injected and conditionally registered in `this.providers` via `isEnabled()`
  - `src/streams.js`: Priority, known sources, display names, prewarm skipping, and `dispatchToProvider`
  - `src/index.js`: Route mounted above `/api` gates, prefix in `STREAM_PREFIXES`, regex in `streamMatch`

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Branch Rebase & Conflict Resolution | Rebase `feature/scorezone-provider` commits (`fc27ed6`, `1780143`, `3109411`) onto `stable` (`b1399cf`), resolving conflicts in `.env.example`, `src/index.js`, `src/streams.js` | M1 | Survey |
| 2 | Guarded Egress Migration | Replace direct `impitClient.safeFetch` in `ScoreZoneProvider.js` and `scoreZoneStream.js` with `BaseProvider.prototype.proxyFetch` / `ProviderOutbound.safeFetch` (`guardExternal: true`) | M1 | Survey / PR #59 |
| 3 | Pre-flight Check Alignment | Reset `behaviorHints.notWebReady: false` (with `proxyHeaders`) in `ScoreZoneProvider.js` to prevent `verifyStreams` dropping proxy URLs | M1 | Survey / PR #61 |
| 4 | Cache Capacity Bounds | Enforce FIFO size limits on `tokenCache` (1000), `playlistCache` (1000), `ipRateLimits` (5000), and `_channelCache` (500) | M1 | Survey / D4 |
| 5 | DI & Aggregator & Stream Registration | Register `ScoreZoneProvider` in `src/container.js`, `src/services/MatchAggregator.js`, `src/streams.js`, and `src/index.js` | M1 | Survey / I4 |
| 6 | Scorezone Unit & Integration Tests | Update `tests/scorezoneProvider.test.js` to spy on `ProviderOutbound.safeFetch` and verify 17/17 tests pass | M1 | Survey |
| 7 | Full Regression Test Suite | Verify `node --check` syntax on all files, run targeted tests, and run full suite (`npm test`, 284+ test files) | M2 | R3 |
| 8 | Multi-Agent Review & Gate Check | Reviewers, Challengers, and Forensic Auditor gate verification | M2 | System |
| 9 | Production VPS Deployment | Push `stable` to `origin/stable`, deploy to VPS, build staged `dist.next`, swap `dist`, reload PM2 cluster, and live verify | M3 | R4 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Integration & Architectural Alignment | Rebase Scorezone branch onto `stable`, resolve conflicts, migrate egress to guarded stack, bound caches, and verify Scorezone unit tests | none | PLANNED |
| M2 | Full Suite Verification & Audit Gate | Syntax verification, full 284-suite regression tests, Reviewer, Challenger, and Forensic Auditor gate checks | M1 | PLANNED |
| M3 | Production VPS Deployment | Push `stable` to remote, deploy on VPS (staged build `dist.next`, swap `dist`, reload PM2), and verify live endpoint | M2 | PLANNED |

## Interface Contracts
### `ScoreZoneProvider` ↔ `MatchAggregator`
- `getMatches()`: Returns `Promise<MatchEntity[]>`, with `category: String`, `title: String`, `date: String(timestampMs)`, `team1`, `team2`, `sources: [{ id: String, name: String }]`.
- `isEnabled()`: Returns `Boolean` (`process.env.SCOREZONE_ENABLED === 'true'`).

### `ScoreZoneProvider` ↔ `streams.js`
- `resolveStream(sourceId, category, title, src)`: Returns `Promise<StreamEntity[]>`. Emits URL `${BASE_URL}/api/scorezone/manifest/...` with `behaviorHints: { notWebReady: false, proxyHeaders: { Referer, Origin, 'User-Agent' } }`.

### `scoreZoneStream.js` ↔ Upstream CDN
- Manifest Route: `GET /api/scorezone/manifest/:sourceId/:channelId.m3u8`
- Egress: Calls `https://testscore.pxxl.pro` via `ProviderOutbound.safeFetch`.
- Rewriting: Master playlist rewrites variant URLs to `/api/scorezone/manifest/...`. Media playlists rewrite segment URLs (.ts) to direct CDN absolute URLs.

## Code Layout
- `src/providers/ScoreZoneProvider.js` (Scraper & match/stream generator)
- `src/routes/scoreZoneStream.js` (HLS manifest proxy router)
- `src/services/HlsRewriteService.js` (Playlist URI rewriter)
- `src/services/MatchAggregator.js` (Multi-provider aggregator)
- `src/container.js` (Awilix DI registration)
- `src/streams.js` (Stream dispatch & priority)
- `src/index.js` (Express entry & route mounting)
- `tests/scorezoneProvider.test.js` (ScoreZone provider & route test suite)
- `.env.example` (Scorezone configuration options)
