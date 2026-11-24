# Session Checkpoint: Stream Click Resolution Latency Optimization
**Date**: 2026-11-24
**Status**: Completed, Merged to `stable`, and Deployed Live (`123e270`)

### What Was Completed
1. **Root Cause Analysis of Stream Click Latency**:
   - Identified that cold match resolution blocked on `Promise.allSettled(inFlight)` up to `SOFT_DEADLINE_MS` (previously defaulting to 6000ms), waiting for failing mirrors like Vavoo (returning 500 across all 5 base sites) even when direct playable streams had already resolved in <1s.
   - Identified that promoting Kafka to Priority-1 (`SOURCE_PRIORITY.kafka = 1`) created a quorum mismatch: `PRIORITY1_QUORUM` was hardcoded to 3, but most fixtures only have 1 or 2 Priority-1 sources, preventing `readyToRespond` from certifying quorum.
   - Identified that `dispatchToProvider('kafka')` ran `resolveEventStreams` sequentially on the click path and even when a dedicated event source was already present on the fixture, duplicating live searches.
   - Identified that fixtures with 0 active streams waited up to `HARD_DEADLINE_MS` (15000ms).

2. **Code Fixes (`src/streams.js`, `tests/vavooProvider.test.js`)**:
   - Scaled Priority-1 quorum target dynamically: `targetP1Quorum = Math.min(PRIORITY1_QUORUM, inFlight.filter(f => f.isPriority1).length)`.
   - Optimized Kafka dispatch: skipped redundant `resolveEventStreams` when a dedicated Kafka event source already exists on the match fixture, and ran `provider.resolveStream` + `provider.resolveEventStreams` concurrently with `Promise.all`.
   - Tightened fallback resolution deadlines: `STREAM_SOFT_DEADLINE_MS` default reduced from 6000ms to 2000ms; `STREAM_HARD_DEADLINE_MS` default reduced from 15000ms to 7000ms.
   - Updated `tests/vavooProvider.test.js` to assert `VAVOO_BASE_SITES.length` across base sites.

3. **Commits and Deployment**:
   - Commit `3f09bce`: `fix(streams): speed up stream resolution and fix priority quorum scaling`
   - Commit `123e270`: `perf(streams): tighten default resolution deadlines to 2s soft and 7s hard`
   - Deployed live to VPS via `scripts/deploy.sh --no-pull`. PM2 cluster (workers 34, 35) online and healthy.

4. **Live Verification on VPS**:
   - Live match cold click (`nuvio_sport_dlv_event_b63170b611ef87eacb9f6af3`): **2.03s** (down from **6.49s**).
   - Live match warm re-click: **0.008s** (~8 ms).
   - Fixture with no live streams cold click: **7.03s** (down from **15.00s**).

### Current Blockers / Open Questions
- None. All 183 stream unit and integration tests passing.

### Immediate Next Steps for Next Chat
1. Monitor live Stremio user clicks and server logs (`pm2 logs nuvio-sports`).
2. Optional: If Vavoo upstream 500 errors persist, investigate circuit breaker or fail-fast mirror rotation for Vavoo.
