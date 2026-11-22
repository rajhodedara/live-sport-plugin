# Session Checkpoint: Vavoo 4-5 Minute Playback Crash Remediation
**Date**: 2026-11-23
**Status**: Completed & Verified

### Root Cause Analysis of 4-5 Minute Crash
1. **Upstream Token Re-minting Corruption (`src/remint.js`)**:
   - Vavoo streams resolve to Sunshine CDN URLs with tokens in the URL path (`http://<host>:8008/sunshine/<TOKEN>/hls/index.m3u8`).
   - In `mergeRemintedUrl()`, the check `held.pathname.includes('/hls/')` caused Vavoo URLs to enter the DaddyLive query-parameter replacement branch.
   - Because Vavoo tokens are embedded in the pathname rather than query parameters, `mergeRemintedUrl` returned the **stale expired URL unchanged**.
   - Whenever an upstream hiccup or token rotation triggered remint, the retry immediately failed with 403/404, `/api/manifest` cached a negative 404, and the player permanently crashed.
   - Similarly, `getRemintCacheKey()` erroneously treated Vavoo's `/hls/index.m3u8` as DaddyLive channel key `index`.

2. **ExoPlayer Live Window Drift (`BehindLiveWindowException`) (`src/services/HlsRewriteService.js`)**:
   - Vavoo live sliding playlists only hold 6 segments (~60s window).
   - Without `#EXT-X-START:TIME-OFFSET`, native players (such as ExoPlayer in Stremio Android TV / Fire TV) start at the bleeding live edge (0s buffer).
   - If a segment download stalls briefly or packet loss occurs, the sliding window advances past the playing segment, throwing `BehindLiveWindowException` and exiting playback after 3–5 minutes.
   - Discrepancies between declared `#EXT-X-TARGETDURATION` and actual segment durations caused playback cadence drift.

3. **Mirror Resilience (`src/providers/VavooProvider.js`)**:
   - `VAVOO_BASE_SITES` lacked `https://voltop.net` for failover rotation.

---

### What Was Implemented
- **`src/remint.js`**:
  - In `mergeRemintedUrl()`: Added dedicated handler for Vavoo / Sunshine CDN (`provider === 'vavoo' || fresh.pathname.includes('/sunshine/') || held.pathname.includes('/sunshine/')`) returning `freshUrl` directly.
  - Guarded DaddyLive query-replacement branch with `!held.pathname.includes('/sunshine/')`.
  - In `getRemintCacheKey()`: Returns clean `rck` for Vavoo streams without DaddyLive key corruption.
  - In `attemptRemintInner()`: Returns candidate `freshUrls[0]` directly for Vavoo / Sunshine.
- **`src/services/HlsRewriteService.js`**:
  - Dynamically recalculates and clamps `#EXT-X-TARGETDURATION` to `Math.max(declaredTargetDuration, Math.ceil(maxObservedDuration))`.
  - For live media playlists without `#EXT-X-ENDLIST` or `#EXT-X-PLAYLIST-TYPE:VOD`, injects `#EXT-X-START:TIME-OFFSET=-18.0` (scaled safely to window duration) immediately after `#EXTM3U` to provide a multi-segment buffer cushion.
- **`src/routes/manifest.js`**:
  - Removed unused variable `injectedStart`.
- **`src/providers/VavooProvider.js`**:
  - Added `'https://voltop.net'` to `VAVOO_BASE_SITES` mirror list.
- **`tests/vavooRemintAndBuffer.test.js`**:
  - Added comprehensive test suite verifying remint replacement, cache key stability, target duration clamping, and `#EXT-X-START` live cushion injection.

---

### Verification
- `npm test -- tests/vavooRemintAndBuffer.test.js` (8 passed).
- `npm test -- tests/hlsRewritePlaylist.test.js` (16 passed).
- `npm test -- tests/hlsRewriteService.test.js` (62 passed).
- `npm test -- tests/vavooLocalCapacity.test.js` (54 passed).
- `npm test -- tests/vavooMultiMirrorRemediation.test.js` (26 passed).
- `npm test -- tests/vavooAuthFailover.test.js` (8 passed).
- `npm test -- tests/manifestRecoveryIdentity.test.js` (32 passed).
- `node --check src/index.js`, `node --check src/remint.js`, `node --check src/services/HlsRewriteService.js`, `node --check src/routes/manifest.js`, `node --check src/providers/VavooProvider.js` all pass.
