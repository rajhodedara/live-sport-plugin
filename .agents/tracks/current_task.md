# Current Task Checkpoint

## Session Context
- **Date**: 2026-11-18
- **Branch**: `stable` (at commit `93abe97`)
- **Status**: Production Stable, fully verified. Deployed to VPS.

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
15. **SoccerFull Football Replay Stream Extraction**:
    - Investigated `nuviosports.xyz` football replay stream outage where `nuvio_sport_sf_*` returned empty streams (`streams: []`).
    - Upstream `soccerfull.net/play/<sid>` transitioned from legacy ArtPlayer `var m3u8Url = ...` to inline Clappr with `const source = "https:\/\/..."` (escaped slashes), self-hosted `.txt` playlists (`/vod/<id>.txt`), and direct `.mp4` video iframes (e.g. Footballia).
    - Updated `src/providers/SoccerFullProvider.js`:
      - Extracted direct stream sources from Clappr/script inline declarations (`source`, `m3u8Url`, `file`, `streamUrl`) with unescaping.
      - Supported direct external HLS CDNs, self-hosted `.txt` playlists routed via `/api/soccerfull/manifest`, and direct `.mp4` / `.m3u8` iframes.
      - Enhanced `_formatPartLabel` to cleanly normalize language tags (e.g. `(EN)`, `(ES)`, `(RU)`, `(AR)`).
    - Passed `opts` to `soccerFullProvider.resolveStream` in `src/streams.js`.
16. **UEFA Nations League Replay Ranking and Discovery**:
    - Investigated why UEFA Nations League replays were not appearing at the top of football replays or in the UEFA sub-catalog on `nuviosports.xyz` even after syncing matches.
    - Discovered 4 contributing root causes:
      - `MatchAggregator.js` Smart Trending Engine was injecting `popular = '1'` onto finished replays whose titles matched trending club keywords (Real Madrid, Barcelona, Manchester, Arsenal), causing older club matches to leapfrog new international replays.
      - `sortCatalogMatches` in `src/catalog.js` fell back to input order when replay dates were identical. Added O(1) precomputed SoccerFull sequential numeric ID comparison (`sfIdB - sfIdA`) to guarantee the newest uploads (e.g. `sf_5008` Spain vs England, `sf_5007` Croatia vs Czechia) rank first.
      - Replay sync cadence in `MatchAggregator.js` was locked to 12 hours for all replay providers; added a 1-hour fast cadence for SoccerFull (`FAST_REPLAY_SYNC_INTERVAL_MS`) and a `forceReplays` override for manual syncs.
      - Added dedicated `nuvio_sports_replays_football_nations_league` sub-catalog in `collections.js` and `index.js`, and expanded the `ucl` filter in `catalog.js` to match `nations league` fixtures.
17. **SportsBite Live Stream Provider Integration**:
    - Dissected SportsBite architecture (`sportsbite.org`) using `rea` and Chrome DevTools MCP. Identified dual-layer pipeline: `TIKTIKPX` pixel steganography on ByteDance/TikTok image CDNs vs clean direct MPEG-TS on Cloudflare R2 (`seg.cr7goated.site`).
    - Implemented `SportsBiteProvider` (`src/providers/SportsBiteProvider.js`) ingesting structured event catalog from `https://sportsbite.org/api/forestgump/matches` via guarded egress.
    - Added strict steganography gate: drops `247-embed` and non-selfhost feeds at ingestion; retains only verified self-hosted match streams.
    - Implemented `resolveStream()` extracting the direct variant `.m3u8` playlist URL and routing through `/api/manifest` text-only proxy. Chunks stream directly from Cloudflare R2 with 0 VPS video proxy bytes (100% compliant with I1/D1).
    - Registered `sportsBiteProvider` across Awilix container (`src/container.js`), aggregator (`src/services/MatchAggregator.js`), and stream resolver dispatch (`src/streams.js`) per invariant I4.
    - Verified with 6 unit tests across `tests/sportsBiteProvider.test.js` and `tests/sportsBiteRegistration.test.js`.
18. **SportzX Live Stream Provider Integration**:
    - Investigated competitor PenguPlay and reversed SportzX TV v3.2 architecture.
    - Implemented `SportzXCrypto.js` (`src/resolver/sportzx/SportzXCrypto.js`) implementing ChaCha20 sponge permutation and protocol v3 payload decoding.
    - Implemented `SportzXProvider` (`src/providers/SportzXProvider.js`) extending `BaseProvider`: ingests events from `https://in.dotmatrixstream.us/events.json` with failovers (`android.onlystream.stream`, `cdn-stream.top`) via guarded egress.
    - Implemented zero-bandwidth stream resolution in `resolveStream()`:
      - Strictly filters out and drops unplayable Akamai CENC DASH (`.mpd`) and ClearKey encrypted streams to protect server bandwidth and memory (Invariant I8 / D2).
      - Emits direct unencrypted `.m3u8` streams (such as AWS S3 1080p60 NBA master playlists and sports edge CDN feeds) with client-side `behaviorHints.proxyHeaders` (User-Agent: `Dalvik/2.1.0` and Referer: `https://gooz.aapmains.net`).
      - Guarantees 0 video byte proxy overhead on VPS (Invariant I1).
    - Registered `sportzxProvider` in Awilix container (`src/container.js`), `MatchAggregator` (`src/services/MatchAggregator.js`), and stream resolver dispatch (`src/streams.js`) per Invariant I4.
    - Verified with 14 unit and integration tests across `tests/sportzXCrypto.test.js`, `tests/sportzXProvider.test.js`, and `tests/sportzXIntegration.test.js`.

## Verification
- Tests: 14 passed across SportzX test suite (`tests/sportzXCrypto.test.js`, `tests/sportzXProvider.test.js`, `tests/sportzXIntegration.test.js`). 76 passed across regression suites (`tests/channelStreamTitleScope.test.js`, `tests/streamPolicy.test.js`, `tests/matchAggregatorDates.test.js`).
- Invariants: I1 (zero video proxy bytes), I3 (leaf node provider), I4 (three-point registration), I8/D2 (relayed DASH stays off), I10 (guarded outbound egress) strictly preserved. Clean `node --check` across all touched files.
