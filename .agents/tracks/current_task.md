# Session Checkpoint: Stream Click Resolution Latency Optimization
**Date**: 2026-11-24
**Status**: Completed, Merged to `stable`, and Deployed Live (`1455680`)

### What Was Completed
1. **Root Cause Analysis of Stream Click Latency**:
   - Identified that promoting Kafka to Priority-1 (`SOURCE_PRIORITY.kafka = 1`) created a quorum mismatch: `PRIORITY1_QUORUM` was hardcoded to 3, but most fixtures only have 1 or 2 Priority-1 sources, preventing `readyToRespond` from certifying quorum.
   - Identified that `dispatchToProvider('kafka')` ran `resolveEventStreams` sequentially on the click path and even when a dedicated event source was already present on the fixture, duplicating live searches.

2. **Code Fixes (`src/streams.js`, `tests/vavooProvider.test.js`)**:
   - Scaled Priority-1 quorum target dynamically: `targetP1Quorum = Math.min(PRIORITY1_QUORUM, inFlight.filter(f => f.isPriority1).length)` in both warm cache check and `readyToRespond`.
   - Optimized Kafka dispatch: skipped redundant `resolveEventStreams` when a dedicated Kafka event source already exists on the match fixture, and ran `provider.resolveStream` + `provider.resolveEventStreams` concurrently with `Promise.all`.
   - Reverted deadline defaults per user request: `STREAM_SOFT_DEADLINE_MS` restored to default 6000ms; `STREAM_HARD_DEADLINE_MS` restored to default 15000ms.
   - Updated `tests/vavooProvider.test.js` to assert `VAVOO_BASE_SITES.length` across base sites.

3. **Commits and Deployment**:
   - Commit `3f09bce`: `fix(streams): speed up stream resolution and fix priority quorum scaling`
   - Commit `123e270`: `perf(streams): tighten default resolution deadlines to 2s soft and 7s hard`
   - Commit `1455680`: `revert(streams): restore 6000ms soft and 15000ms hard deadline defaults`
   - Deployed live to VPS via `scripts/deploy.sh --no-pull`. PM2 cluster (workers 34, 35) online and healthy.

4. **Live Verification on VPS**:
   - Live match warm re-click: **0.002s – 0.003s** (2–3 ms).
   - Priority-1 quorum scaling resolves early when the match's in-flight priority-1 sources arrive without waiting out full deadlines.

### Current Blockers / Open Questions
- None. All stream unit and integration tests passing.

### Immediate Next Steps for Next Chat
1. Monitor live Stremio user clicks and server logs (`pm2 logs nuvio-sports`).
2. Optional: If Vavoo upstream 500 errors persist, investigate circuit breaker or fail-fast mirror rotation for Vavoo.
