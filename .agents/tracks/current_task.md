# Session Checkpoint: Basketball Replays Zero-Bleeding Bridge Unwrapping & Stable Release
**Date**: 2026-11-06
**Status**: Completed

### What Was Completed
- **Branches**: `feat/leaf-premium-integration` & `stable` (both pushed to `origin`).
- **`src/providers/BasketballVideoProvider.js`**:
  - Generalized bridge unwrap with `isBridgeUrl(dest, baseUrl)` covering modern replay domains (`nhlgamestoday.com`, `guidedesgemmes.com`, `guideanimaux.com`, `nflontv.com`, and `nbaontv.com`) while rejecting invalid/host-spoofed URLs (`evil.example`).
  - Added nearest HTML server heading extraction (`<b>Server #1 (OK)</b>`, `<b>Condensed Game</b>`) to label watch links with descriptive titles instead of generic "Watch".
  - Extracted direct MP4/HLS streams from OK.ru embeds (`vd*.okcdn.ru`) and Byse with `behaviorHints: { notWebReady: false, proxyHeaders: ... }`, completely fulfilling Invariant I1 (Zero Server Video Bytes egress).
- **`tests/basketballVideoProvider.test.js`**:
  - Added unit test verifying modern bridge unwrapping, server heading parsing, and zero-egress direct CDN URL generation.
- **Git Actions**:
  - Committed on `feat/leaf-premium-integration`: `aaea07f fix(basketball): unwrap modern replay bridge domains and resolve server headings`.
  - Merged cleanly into `stable` (`5e9265b..aaea07f`).
  - Pushed to `origin stable` and `origin feat/leaf-premium-integration`.

### Verification Record
- `node --check src/providers/BasketballVideoProvider.js`: Clean exit (code 0).
- `npm test -- tests/basketballVideoRelativeLinks.test.js`: 9/9 passed.
- `npm test -- tests/basketballVideoProvider.test.js`: 11/11 passed.
- `npm test -- tests/leafRecapProvider.test.js`: 14/14 passed.
- Replay resolution on `livetv_memphis-sacramento-20261101`: 4 direct OK.ru CDN streams returned with 0 VPS bandwidth.
