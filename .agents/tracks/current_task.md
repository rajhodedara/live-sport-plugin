# Session Checkpoint: SportzX Live Resolution & VPS Build Remediation
**Date**: 2026-11-23
**Status**: Completed & Verified

### Root Cause Analysis: Missing SportzX Matches & 0 Streams on `nuviosports.xyz`
1. **VPS Build Failure Stalled Deployment (`@vercel/ncc` Conflict)**:
   - When updating the VPS, `npm run build:local` crashed due to an NCC asset collision:
     `Error: Conflict: Multiple assets emit different content to the same filename data/iframe_domains.json / matches_cache.json / team_logos_cache.json`.
   - Because `ncc` crashed, the VPS never compiled a new `dist/index.js` and PM2 remained running the previous code and in-memory cache with old matches (`50087`, `50088`, `50089`).
   - *Fix*: Created `scripts/prepare-build.js` that automatically unlinks transient runtime cache files in `data/` before `ncc` executes, ensuring zero asset conflicts.

2. **Category Normalization Failure Masked SportzX Fixtures (`normalizeSportzXCategory`)**:
   - SportzX emits emoji league strings for major competitions: `'MLS 🇺🇸'`, `'EPL 🏴󠁧󠁢󠁥󠁮󠁧󠁿'`, `'Brasileirão'`, `'ISL'`, `'WBBL'`.
   - `BaseProvider.normalizeCategory` did not strip Unicode flags/emojis, resulting in all soccer and cricket leagues falling back to category `'other'`.
   - In `MatchAggregator`, candidate deduplication rejected merging category `'other'` with primary providers (`'football'` / `'cricket'`). As a result, live games like Vancouver Whitecaps had 0 SportzX streams attached, and were omitted from sport-specific catalogs.
   - *Fix*: Implemented `normalizeSportzXCategory()` in `SportzXProvider.js` stripping emojis and explicitly mapping soccer, cricket, basketball, motorsport, and combat sports leagues to their standard canonical categories.

3. **Stream Protocol Variance across Live Games**:
   - Matches with direct HLS links (e.g. `50090` Vancouver Whitecaps, `50118` South Africa vs Bangladesh) yield 4 working direct HLS streams (`MONO MAX HD`, `SportzX Live`, `HD SERVER`, `LOW SERVER`).
   - NBA games (`50058`, `50056`) encrypted under protocol `0x04` fail HMAC verification and NFL games (`50013`) provide only Amazon Prime DASH (.mpd) which are dropped per Invariant I8 / D2.

---

### Files Changed
- `src/providers/SportzXProvider.js`: Added `normalizeSportzXCategory()` with emoji stripping and explicit league regex; switched fallback events loading to dynamic paths without static require.
- `scripts/prepare-build.js`: Cleaned colliding runtime cache files before ncc packaging.
- `package.json`: Wired `prepare-build.js` into `build` and `build:local`.

---

### Verification
- `npm test -- tests/sportzXProvider.test.js tests/sportzXCrypto.test.js` (16 passed).
- `node scripts/prepare-build.js; npx @vercel/ncc build src/index.js -o dist --minify -e sharp` (completed in 14s with zero conflicts).
- `node --check src/index.js`, `node --check src/providers/SportzXProvider.js`.
