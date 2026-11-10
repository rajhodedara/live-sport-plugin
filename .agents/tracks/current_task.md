# Session Checkpoint: NFL Replay Provider Modernization & Sister Site Alignment

**Date**: 2026-11-10
**Status**: Completed

### What Was Completed
- **Root Cause Identified**:
  1. Internal link bleed in `NflVideoProvider.resolveStream()`: lacked domain filtering for internal `nfl-video.com` URLs, causing match listing cards on the target page (marked with "Watch") to be erroneously treated as video stream embed buttons and recursively fetched as bridge pages.
  2. Missing sister-site bridge logic: lacked `isBridgeUrl()`, `isNbaOnTvUrl()`, and `guidedesgemmes.com` domain recognition from `BasketballVideoProvider.js`, and lacked an internal domain guard in the bridge unwrapper.
  3. Outdated season endpoints in `getMatches()`: only fetched `/`, `/2026`, and `/cfb/`, missing `/nfl2025`, `/nfl2024`, and `/super-bowls`.
  4. Underscore slug format on modern `nfl-video.com`: modern archive links use underscore slugs (`_full_game_replay`, `_full_show_replay`, `_vs_`, `_at_`) and category archives end in `/\d+$`.
  5. Part name extraction: added heading extraction for `<b>`/`<span>`/`<p>` tags (`Server #1 OK`, `Server #2 FM`, `Condensed Game`).
- **Files Modified**:
  - `src/providers/NflVideoProvider.js`
  - `tests/streamHardDeadline.test.js` & `tests/streamTimingWindow.test.js` (pruned stale watchfooty references)
- **Verification**:
  - Unit tests: `npm test -- tests/nflVideoProvider.test.js` (12/12 passing).
  - Sister tests: `npm test -- tests/basketballVideoProvider.test.js` (11/11 passing).
  - Modified stream tests: `npm test -- tests/streamHardDeadline.test.js tests/streamTimingWindow.test.js` (10/10 passing).
  - Live extraction: successfully parsed 64 replay matches and resolved 16 direct SprintCDN & OK.ru streams for `Tampa Bay Buccaneers vs. Chicago Bears`.

### Current Blockers / Open Questions
- None.

### Immediate Next Steps for Next Chat
- Deploy to production VPS when scheduled.
