# Session Plan: Stream Resolution, Provider Priority Hierarchy & Metadata Recovery

**Date**: 2026-11-08
**Status**: Completed (Phase 1, Phase 2, Phase 3 all verified green)

---

## 1. Architectural Plan & Problem Breakdown

### Incident 1: Upstream Schedule TTL Pruning & SkTech/SonyLIV Ingestion Divergence
- **Problem**:
  1. During long events (e.g. Cricket ODIs 8-10h, Motorsport 4-6h), upstream scrapers (DaddyLive, AK47) prune matches after ~4-5 hours.
  2. Sony LIV streams continue serving 1080p via dynamic M3Us, but `SkTechMatchResolver.cleanEventTitle()` resolved titles as `"2nd ODI"` with `teamA: null, teamB: null` and category `'other'` or feed label.
  3. `MatchAggregator._sameEventPre` line 987 failed deduplication because `p1.digits !== p2.digits` ('2' vs '') on channel-identity path.
  4. `SkTechProvider.js` and `SkTechMatchResolver.js` hard-prune matches after 4 hours (`(now - kickoff) > 4 * 3600 * 1000`).
- **Solution Implemented**:
  1. Added comprehensive bilateral cricket country abbreviation dictionary `CRICKET_COUNTRY_MAP` (IND, NZ, AUS, ENG, SA, PAK, WI, SL, BAN, AFG, ZIM, IRE, SCO, NED, UAE, etc., with `-W` / `_W` suffix handling for Women's teams).
  2. Implemented metadata recovery in `SkTechMatchResolver`: inspects `curMeta.logo` (e.g. `NZvsIND_2nd_odi_clean_landscape_thumb.jpg`), stream URL (e.g. `cricodi_...`), `tvgName` (e.g. `India Tour of New Zealand 2026`), and `rawTitle` to extract teamA and teamB and rebuild canonical match title `${teamA.name} vs ${teamB.name} (${clean})` with category `'cricket'`.
  3. Extended TTL cutoff in `SkTechProvider.js` and `SkTechMatchResolver.js`: allows 10 hours for cricket, 6 hours for motorsport, and 4 hours for standard sports.
  4. Adjusted `MatchAggregator.js:987` digit check: when one match has teams and the other doesn't, or when comparing against a team fixture, allows subset matching rather than immediately rejecting on digit mismatch.

### Incident 2: Provider Priority Inversion & DaddyLive/Vavoo Source Starvation
- **Problem**:
  1. `SOURCE_PRIORITY` previously had `daddylive: 1` alongside `leaf: 1` and `scorezone: 1`, while `timstreams: 9`.
  2. DaddyLive resolves 15-20 mirrors fast; `PRIORITY1_QUORUM = 3` triggered early return while higher-value streams (Leaf, TimStreams, PPV.st, PitSport) were starved out.
  3. Vavoo injected up to 8 broadcast feeds per match in `MatchAggregator.js:725`.
  4. Leaf live overlay flipped to empty snapshot if `incoming.length === 0`, causing flickering.
- **Solution Implemented**:
  1. Reordered `SOURCE_PRIORITY` in `src/streams.js`:
     `leaf: 1, scorezone: 1, timstreams: 2, ppvst: 3, pitsport: 4, daddylive: 5, vavoo: 6, sktech: 7, damitv: 8, ak47live: 8, ...`.
  2. Removed `src.source === 'daddylive'` from Priority 1 check in `src/streams.js:1445`.
  3. Updated `readyToRespond()` in `src/streams.js`:
     - Added Map-based `inFlightSourceByKey` for O(1) source lookup per Invariant I6.
     - Added `withinSoftDeadline = (Date.now() - resolutionStartedAt) < SOFT_DEADLINE_MS`: prevents low-tier sources (DaddyLive/Vavoo) from early-returning while higher tiers (<= 4) resolve during the soft window, but allows them to respond after `STREAM_SOFT_DEADLINE_MS` rather than hanging for 15s to the hard deadline.
  4. In `selectSources()`, capped DaddyLive mirrors to max 4 diverse broadcaster feeds while strictly preserving relative priority ordering against subsequent providers (Vavoo).
  5. In `SkTechMatchResolver.js`: expanded `CRICKET_COUNTRY_MAP` with additional ISO/IOC codes (OMN, NLD, LKA, ZWE, WIE, WIND); ensured stage round titles (e.g. 2nd ODI) are preserved in `cleanEventTitle` when series tour is present in `tvgName`; added category detection in `recoverMatchMetadata` when title is already `Team A vs Team B`.
  6. In `MatchAggregator.js:725`, capped Vavoo injection at configurable `Number(process.env.VAVOO_INJECTION_CAP || 3)` (capped down from 8, compatible with test suites).
  7. In `StreamScoringService.js`: updated bonuses so `leaf (+30)`, `timstreams (+25)`, `ppvst (+20)`, `pitsport (+15)` score higher than `daddylive (+10)` and `vavoo (+5)`.
  8. In `MatchAggregator.js:1084`: returns `result(false, ...)` when `incoming.length === 0` to prevent flapping the Leaf overlay snapshot.

### Incident 3: PitSport / PitStream Presentation & Appearance
- **Problem**:
  1. Stream titles in `PitSportProvider.js:278` formatted as `PitSport - ${channelName} (${matchTitle || 'Live Event'})`, rendering redundantly and cluttering the UI.
  2. `isTikTok: true` and `_isTikTok = true` in `PitSportProvider.js:296-298` wrongfully flagged standard HLS streams as TikTok CDN, causing `LanguagePriorityService` and `StreamScoringService` to heavily penalize them.
  3. `src/streams.js:1719` did not filter out generic parenthesized labels like `(Live Event)`.
- **Solution Implemented**:
  1. Formatted title cleanly as `channelName || matchTitle || 'PitSport Feed'`.
  2. Removed `isTikTok: true` and `_isTikTok = true` from PitSport streams.
  3. Updated `src/streams.js:1719` regex to reject `live event`, `event`, `live stream`, `stream\s*\d*` from being treated as channel names.
  4. Updated `tests/pitSportProvider.test.js` to assert clean titles and non-TikTok status.

---

## 2. Invariant Compliance
- **I1 (No bulk video bytes)**: All streams remain direct CDN URLs with `proxyHeaders` or text manifest proxies.
- **I3 (Providers are leaf nodes)**: Providers return domain entities without reading caches or mutating global state.
- **I6 (O(1) per request)**: In-flight source lookup and candidate capping run in O(1) per candidate source with zero linear `.find` scans.

---

## 3. Verification Record
1. **Syntax Checks**:
   - `node --check src/providers/PitSportProvider.js src/streams.js src/services/StreamScoringService.js src/services/MatchAggregator.js src/resolver/sktech/SkTechMatchResolver.js src/providers/SkTechProvider.js` -> Exit code 0 (pass).
2. **Jest Test Suites (114/114 passing across 8 test suites)**:
   - `tests/pitSportProvider.test.js` (18 passed)
   - `tests/tiktokPrioritization.test.js` (5 passed)
   - `tests/broadcasterMatchService.test.js` (13 passed)
   - `tests/daddyLiveProvider.test.js` (25 passed)
   - `tests/streamPriorityQuorum.test.js` (14 passed)
   - `tests/liveOverlayService.test.js` (23 passed)
   - `tests/skTechFanCodeIntegration.test.js` (4 passed)
   - `tests/streamResolutionAndMetadataRecovery.test.js` (12 passed)
