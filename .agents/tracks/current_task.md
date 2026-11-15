# Current Task Checkpoint

## Session Context
- **Date**: 2026-11-15
- **Branch**: `stable` (at commit `6248e85`)
- **Status**: Production Stable, fully verified.

## Accomplishments
1. **DaddyLive ReDoS Root Cause**:
   - Unanchored regexes in `src/providers/DaddyLiveProvider.js` caused 38s V8 event loop freezes on 150KB modern embed pages.
   - Initial pre-guard merged (`6272b4c`), followed by PR #86 bounded regex quantifiers (`b2a7b18`).
2. **Caddy Reverse Proxy & Bandwidth Bleed**:
   - Replaced wildcard relay paths (`/api/fastmp4*`, `/api/mp4proxy*`, `/api/hlschunk*`, `/api/dash/segment.mp4*`) with immediate `403` in `/etc/caddy/Caddyfile`.
   - Separated Cloudflare Orange Cloud origin certs (`nuviosports.xyz`) from Let's Encrypt certs (`stream.nuviosports.xyz`).
3. **PR #85 (Diagnostics Capacity Attribution)**:
   - Merged commit `56bafa8` to attribute native-pool capacity rejections by owner and upstream host.
   - Hotfixed `scripts/copy-guarded-worker-deps.js` (`1dd652d`) to include `CapacityDiagnostics` in worker/standalone bundle.
   - Live attribution proved TheSportsDB team-logo enrichment was responsible for 83%+ of all pool capacity rejections under owner `other`.
4. **PR #87 (TheSportsDB Outbound Lookup Gate)**:
   - Merged commit `007b053` (`OutboundLookupGate.js` concurrency cap of 2/worker, exponential backoff, breaker on capacity/timeout/5xx/429, 6h negative TTL).
   - Rejections dropped from ~505/min to ~9/min (98.2% reduction); TheSportsDB rejections dropped to 0.
5. **PR #88 (Live Drop Logging Observability)**:
   - Merged commit `e0b3323` (`src/services/LiveDropReport.js`, `src/services/MatchAggregator.js`).
   - Logs `[LiveDrop]` whenever a previously-live fixture disappears between sync cycles.
6. **PR #89 (Category Word Boundaries Matching)**:
   - Merged commit `e8ebd76` / `939cbae` (`BaseProvider.js`, `LiveTVProvider.js`, `SkTechMatchResolver.js`).
   - Bounds short cricket codes (`t20`, `odi`, `ipl`, `bbl`, etc.) as whole words.
   - Fixes Spanish/Italian "del" (e.g. "Copa del Rey") matching German DEL hockey league in LiveTV.
7. **PR #90 (LiveTV Archive Sport Section Matching)**:
   - Merged commit `21a3522` (`src/providers/LiveTVProvider.js`, `tests/liveTvSportSection.test.js`).
   - Parses `<span class="whitetitle">...</span>` sport headings in LiveTV replay archive so "Champions League" in hockey/basketball/handball/table tennis maps to its actual sport instead of defaulting to football.
8. **PR #91 (Bounded Title in LiveDrop Line)**:
   - Merged commit `fe9db56` (`src/services/LiveDropReport.js`, `tests/liveDropReport.test.js`).
   - Appends sanitised `title="<max 60 chars>"` to `[LiveDrop]` output.
9. **PR #92 (DaddyLive Folder Probe Breaker)**:
   - Merged commit `f1107b6` (`src/services/FolderProbeBreaker.js`, `src/providers/DaddyLiveProvider.js`, `tests/daddyLiveFolderBreaker.test.js`).
   - Pauses DaddyLive folder probes (`cast`, `plus`, `casting`) only after 15 consecutive empty pages AND no hit from it for 15 min, re-probing every 3 min.
10. **PR #93 (DaddyLive HDM1 Fast Path)**:
    - Merged commit `49b462a` (`src/data/hdm1_slugs.json`, `src/providers/DaddyLiveProvider.js`, `tests/daddyLiveHdm1FastPath.test.js`).
    - Bypasses ~685 KB folder scrapes for verified channel IDs and hits `wideiptv.top/player/<slug>` (~10 KB) directly.
    - Expanded with additional verified slugs in commit `286b893`.
11. **PR #94 (Manifest Error Diagnostics & Attribution)**:
    - Merged commit `465810b` / `6248e85` (`src/remint.js`, `src/routes/manifest.js`, `src/services/ManifestDiag.js`, `tests/manifestDiag.test.js`).
    - Appends `source=<name> host=<upstream>` to `[ManifestProxy]` errors and `source=<name> ms=<elapsed>` to re-mint failures and slow re-mints (>= 4s).
12. **DaddyLive HDM1 Catalog Expansion (Phase 1)**:
    - Discovered and verified 53 new active channels across DaddyLive 24/7 catalog and external enumeration ledgers (`map.json`, `combined_hdm1_slugs.json`).
    - Catalog in `src/data/hdm1_slugs.json` expanded from 144 to 197 strictly verified channels (+36.8%).
    - Every added channel validated through 6-stage playability pipeline: master M3U8, variant sub-playlist, range request on live `.ts` chunks with `0x47` MPEG-TS sync byte check.
    - Enforced strict digit invariance, country invariance, and zero duplicate slugs (197 unique slugs across 197 IDs). Ambiguous IDs 274 and 362 preserved as excluded per contract.
13. **DaddyLive HDM1 Catalog Expansion (Phase 2 - 26 Verified Channels)**:
    - Cross-referenced live 24/7 channels ledger from `livelive24.com/tv.json` and DaddyLive numerical channel registry (`thedaddy.li/24-7-channels.php`).
    - Filtered 52 high-confidence unmapped candidate channels and put every single one through the strict 6-stage MPEG-TS playability test suite (hitting `wideiptv.top/player/<slug>`, master M3U8, variant sub-playlist, and validating `0x47` sync byte on live `.ts` chunk range request).
    - Dropped 26 inactive/404 channels and merged 26 verified 100% playable channels into `src/data/hdm1_slugs.json`, expanding the verified fastpath catalog from 197 to **223 channels** (+13.2%).
    - High-value additions: USA Network (`343`: `USANETEAST`), RMC Sport 1 FR (`119`: `RMCSPORT1FR`), beIN Sports 2 & 3 FR (`117`: `BEINSPORT2FR`, `118`: `BEINSPORT3FR`), beIN Sports 4 TR (`67`: `BEINSPORT4TR`), Movistar Liga de Campeones (`435`: `MLIGADECAMPEONES`), Arena Sport Premium 1 & 3 (`134`: `ARENASPORT1PREMIUMRS`, `139`: `ARENASPORT3PREMIUMRS`), Canal+ Sport Afrique 2, 4, 5 (`487`, `489`, `490`), ESPN Argentina 1-3 (`149`, `150`, `798`), Eurosport 1 & 2 Sweden/France/Italy, Polsat Sport 2 & Premium 2, Sport 2 CZ, Sky History UK, and Sky Sport Austria.
    - Enforced all contracts: strict digit invariance, zero duplicate slugs, zero duplicate IDs, ambiguous IDs 274 & 362 excluded.
14. **NFL-Video Condensed vs Full Game Stream Selection**:
    - Added partition detection in `src/providers/NflVideoProvider.js` to identify `Condensed Game` sections and server headings.
    - Tagged emitted streams with `isCondensed` on `StreamEntity.js` and set explicit `partName` (e.g. `Full Game (Server #1 OK)`, `Condensed Game (OK)`).
    - Updated `src/streams.js` regex to recognize `Full Game` and `Condensed Game` badges (`🎬 Full Game`, `🎬 Condensed Game`) and isolated binge groups (`nuvio_sport_${matchId}_full` vs `nuvio_sport_${matchId}_condensed`).
    - Added priority sorting in `src/services/LanguagePriorityService.js` placing Full Game streams first, followed by Condensed Game streams.

## Verification
- Tests: 25 passed in `tests/nflVideoProvider.test.js` (including new 'Condensed Game vs Full Game Replay Extraction' suite). 120 passed in `tests/languagePriority.test.js`. Clean `node --check` across all modified files.
- Zero server bandwidth: direct CDN playback (`okcdn.ru`, `SprintCDN`) preserved per Invariant I1.
