# Session Checkpoint: MovieBox Sports & Live TV Provider Integration
**Date**: 2026-11-23
**Status**: Completed & Verified

### Overview
Integrated MovieBox TV's Live Sports (`MovieBoxSportsProvider`) and 145-country Linear Live TV (`MovieBoxTVProvider`) into the Nuvio Live Sports Plugin, strictly adhering to architecture invariants (I1–I10).

### Key Architecture Components
1. **Transsion Gateway Crypto (`src/providers/movieboxCrypto.js`)**:
   - Generates all 5 required authentication headers: `X-Client-Build`, `x-client-token`, `x-client-info`, `x-tr-signature` (HMAC-MD5 with Base64 decoded online secret `76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O`), and canonical sorted query path.
   - Caches visitor login JWT tokens for 5 minutes (in-memory) with in-flight single-promise locking to prevent thundering herd on cold boot.
   - Implements `makeMovieBoxRequest` passing through `proxyFetch` with strict timeouts (`8000ms`, `2 attempts`).

2. **MovieBox Sports Provider (`src/providers/MovieBoxSportsProvider.js`)**:
   - `this.sourceName = 'moviebox_sports'`.
   - `getMatches()` fetches `/wefeed-tv-bff/sport/aggregate-v1`, normalizes sport types via `normalizeCategory()`, parses epoch millisecond kickoff timestamps, and returns standard `MatchEntity` instances.
   - `resolveStream(sourceId)` calls `/wefeed-tv-bff/sport/detail-v1?matchId=...`. Guards against pre-match 404s by returning `[]` when `matchStatus !== 'MatchIng'`, and emits active direct HLS streams with required `Referer: https://sportslive.wine`.

3. **MovieBox Live TV Provider (`src/providers/MovieBoxTVProvider.js`)**:
   - `this.sourceName = 'moviebox_tv'`.
   - `getMatches()` queries `/wefeed-tv-bff/live/tv-country-list` across 145 countries and fetches channels (`perPage=100`) with 50ms inter-country stagger to avoid rate limiting.
   - Categorizes all channels under `'networks'` with null-safe title fallback (`item.name || item.channelName || channelId`).
   - `resolveStream(sourceId)` resolves `/wefeed-tv-bff/live/tv-channel?channelId=...` and extracts direct `.m3u8` streams.

4. **Integration & Wiring**:
   - `src/container.js`: Registered `movieboxSportsProvider` and `movieboxTvProvider` singletons via Awilix.
   - `src/services/MatchAggregator.js`: Injected both providers into constructor and added to `this.providers` aggregation list.
   - `src/streams.js`: Added dispatch branches in `dispatchToProvider`, registered source keys in `KNOWN_LIVE_SOURCES`, `KNOWN_FALLBACKS`, `NICE_NAMES`, and `CHANNEL_TITLE_NICE_NAMES`.

---

### Files Created & Changed
- `src/providers/movieboxCrypto.js` (created)
- `src/providers/MovieBoxSportsProvider.js` (created)
- `src/providers/MovieBoxTVProvider.js` (created)
- `tests/movieboxCrypto.test.js` (created)
- `tests/movieboxSportsProvider.test.js` (created)
- `tests/movieboxTVProvider.test.js` (created)
- `src/container.js` (modified)
- `src/services/MatchAggregator.js` (modified)
- `src/streams.js` (modified)
- `docs/superpowers/plans/2026-11-23-moviebox-providers.md` (created)

---

### Verification
- `npm test -- tests/moviebox` (24/24 unit tests passed across 3 suites).
- `node --check src/container.js`, `node --check src/services/MatchAggregator.js`, `node --check src/streams.js` (all passed).
- `npm test -- tests/localRequest.test.js` (66/66 passed, zero regressions).
- Staged build: `npx @vercel/ncc build src/index.js -o dist.next --minify -e sharp` succeeded in 14s.
- `node --check dist.next/index.js` (passed).
- Bundle verification: `MATCHES_CACHE_PATH` verified present in `dist.next/index.js`.
