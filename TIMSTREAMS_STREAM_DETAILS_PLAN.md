# TimStreams Stream Details — Plan

Goal: make TimStreams rows carry the same detail PPV.st rows do — broadcaster channel name,
listed quality, and measured bitrate — including a real 4K label, without adding playback cost
to other providers.

Target row (today vs. after):

```
today:  ⚽ TimStreams
        📺 Quality: HD

after:  ⚽ TimStreams | 📺 TNT Sports 1 [GB • English]
        📺 Quality: 4K UHD · 18.4 Mbps
```

---

## 1. What actually blocks the detail today (verified, 2026-11-05)

| # | Finding | Evidence |
|---|---------|----------|
| 1 | Upstream already names the broadcaster. `https://tim-streams.com/api/live-upcoming` returns `streams[].name` = `TNT Sports 1`, `Sky Sports+`, `Board 3`, `NBA League Pass`, `ESPNU`, `Stan Sport`, `Fanatiz`. | live payload, 40 events / 43 stream objects |
| 2 | The provider keeps that name on the catalog source (`name: st.name`) but the stream row never sees it: `src/providers/TimStreamsProvider.js:196` builds `TimStreams ${matchTitle}` with no channel, and `src/streams.js:226` calls `resolveStream(src.id, match.category, match.title)` — the source object (`src.name`) is not forwarded, unlike `ppvst`/`damitv`/`embedIndia`. | `src/streams.js:224-226` |
| 3 | `src/streams.js:1517-1536` derives the display channel from the first `(...)` or `[...]` group in the stream title. `TimStreams <match>` has neither, and the `!title.includes('Stream')` fallback can never fire because the provider name itself contains "Stream" → channel stays empty. | `src/streams.js:1517-1540` |
| 4 | Quality/bitrate come from `M3U8ParserService.parseManifestText()` on the verified playlist (`src/streams.js:903-909`). TimStreams serves **media** playlists only — 0 `#EXT-X-STREAM-INF` in 10/10 successful samples — so it returns `qualityTag: 'HD'`, `bitrateTag: ''`. That is the entire reason PPV.st shows Mbps/quality and TimStreams does not: PPV's embed chain hands out a master playlist with `RESOLUTION`/`BANDWIDTH`. | `src/services/M3U8ParserService.js:78-132` |
| 5 | Resolution is hard-coded: `resolution: 'HD'` on every TimStreams row. | `src/providers/TimStreamsProvider.js:184` |
| 6 | Real resolution **is** recoverable. TimStreams segments are MPEG-TS behind the known 42-byte fake RIFF/WEBP cloak (`SegmentLengthService.CLOAKED_PREFIX_BYTES`). Stripping 42 bytes and reading the H.264 SPS of a live segment returned **1920×1080**; the same parser reads 2160 for a 4K feed. | probe run against `tims-001.sytes.net` segment |
| 7 | Segment byte total is already measurable: one Board 1 segment = 1,034,794 B over `#EXTINF:4.000` → 2.07 Mbps, matching the formula in `measureStreamSpeed` (`src/streams.js:546-551`). | probe run |

Consequences to design around:

- `parseManifestText` writes `s.quality = 'HD'` for **every** single-rendition provider, so any 4K label the provider sets gets clobbered unless `src/streams.js` stops treating "HD" as new information.
- The provider is also currently re-downloading the whole 40-event catalog on every resolve (the `getMatches()` fallback at `TimStreamsProvider.js:127`) — forwarding `src` removes that cost as a side effect.
- Upstream throttles bursts: 14 of 24 stream extractions returned transient `ECONNRESET` in one sample run, so any extra per-stream request needs a concurrency cap, a cache, and a soft failure path.
- `node_modules` is currently **empty** in this checkout (no `jest`, no `m3u8-parser`), so no test can run until dependencies are installed — that is step 0 of verification, not a defect introduced by this change.

---

## 2. Design

### 2.1 Channel name — pull, don't guess

Forward the source object into the provider and publish the upstream name as the stream's channel,
using the format `streams.js` already parses for Leaf/PPV rows:

```
title:        `(${channel}) ${matchTitle}`      ← first parens = broadcaster, per streams.js:1517
channelName:  channel                            ← country/language detection, channel cards
canonicalChannel: channel
```

Rejected: encoding the channel into the source id (fragile, breaks hex-url ids and
resolved-cache keys); scraping the embed page for the name (the payload has no channel
metadata — only the API does).

`Board 1..4` are feed variants of one event, not broadcasters. Keep the upstream text but render
it as a feed label (`Board 1` → `Feed 1 (Board 1)`) so a user is not told "Board 1" is a channel.
Decision point in §5.

### 2.2 Bitrate and quality — measure, with a real 4K read

New service `src/services/HlsQualityProbe.js` (provider-agnostic, TimStreams is first caller):

1. Input: verified media-playlist URL, referer, and the `#EXTINF` duration of its first segment.
2. One ranged GET `Range: bytes=0-524287`, 8 MB hard cap, 3.5 s timeout, `attempts: 1`.
3. **Bitrate**: `Content-Range` total (fallback `Content-Length`) × 8 ÷ EXTINF → display label in
   the repo's existing convention (`6.2 Mbps` / `840 kbps`), never raw bps.
4. **Resolution**: if the buffer starts with `RIFF....WEBP`, drop 42 bytes; require 0x47 TS sync at
   0/188/376; scan for H.264 SPS (NAL 7) and, if present, HEVC SPS (NAL 33) inside 512 KB.
   Map 2160 → `resolution: '2160p'`, `quality: '4K UHD'`; 1440 → `'1440p'`/`'QHD'`;
   1080 → `'1080p'`/`'FHD'`; 720 → `'720p'`/`'HD'`; otherwise `'SD'`.
5. Cache: key = manifest path with the signed token removed (slug such as `tntsports1-uk`),
   TTL 10 min, in-flight dedupe, max 4 concurrent probes, negative result cached 60 s.
6. Failure is silent: no SPS and no bitrate → the row keeps `HD` exactly as today. No stream is
   ever dropped or delayed past its budget because of this probe.

Placement: called from `TimStreamsProvider.resolveStream` in parallel with `extractM3u8`, so it
costs `max(extract, probe)` rather than a serial tail, and only for the streams actually being
resolved (1–8 per event). Rejected: relying on `ENABLE_SPEED_PROBE` in `streams.js` (off by
default, and it measures throughput/implied bitrate only — it cannot read resolution, so it can
never say 4K).

### 2.3 One shared-label fix (small, but required for 4K to survive)

`src/streams.js:903-909` must stop overwriting a provider-declared tier with the generic `HD` that
a media playlist produces:

- if the parsed playlist declared a real resolution (master playlist) → parsed wins, as today;
- else if the provider set `quality`/`resolution` → keep the provider value;
- else → `HD`.

This keeps PPV.st/Streamed.pk/Leaf/SKTech behaviour identical for master playlists and only
changes single-rendition rows that previously displayed the meaningless `HD` placeholder.

### 2.4 Explicitly out of scope

- No re-encode, no variant ladder invention, no `/api/manifest` variant filtering change: a 4K
  TimStreams feed already arrives as 4K media segments and the manifest route rewrites them
  1:1.
- No new outbound dependency, no worker/CF proxy change, no cache-schema change.

---

## 3. Work plan

| Step | Change | Files |
|------|--------|-------|
| 0 | Install dependencies, capture the pre-change test baseline (`npx jest`), record pre-existing failures | — |
| 1 | Forward `src` into the TimStreams dispatch | `src/streams.js:224-226` |
| 2 | `resolveStream(..., src)`: use `src.name` as channel, stop the catalog re-fetch when `src` is present, keep the `getMatches()` fallback for id-only callers | `src/providers/TimStreamsProvider.js` |
| 3 | Publish `channelName` + `canonicalChannel` + `(${channel}) ${title}` on both the direct row and the web fallback row | `src/providers/TimStreamsProvider.js` |
| 4 | New `HlsQualityProbe` service: ranged GET, cloak strip, TS/SPS resolution sniff, implied bitrate, TTL cache, concurrency cap, silent failure | `src/services/HlsQualityProbe.js`, `src/container.js` |
| 5 | Wire the probe into TimStreams resolve; set `resolution`/`quality`/`bitrate` from the probe result | `src/providers/TimStreamsProvider.js` |
| 6 | Shared-label guard so a measured tier is not clobbered by a media playlist's `HD` | `src/streams.js:903-909` |
| 7 | Tests: SPS fixture parsing (1080p + synthetic 2160p), cloak strip, cache/dedupe/timeout/failure, channel propagation, no-refetch-when-src, label guard, end-to-end title | `tests/hlsQualityProbe.test.js`, `tests/timStreamsProvider.test.js`, `tests/timStreamsLabels.test.js` |
| 8 | Verify: targeted suites, then the full suite; diff against the step-0 baseline; live spot-check of one resolved TimStreams row | — |

---

## 4. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Upstream rate-limits the extra ranged GET (observed ECONNRESET bursts) | max 4 concurrent, attempt 1, 10 min cache, negative cache 60 s, retry only on the next resolve |
| Probe adds latency to resolve | runs in parallel with `extractM3u8`, 3.5 s hard timeout, never blocks the row |
| Wrong 4K claim | only SPS ground truth labels 4K; no SPS → keep `HD`; bitrate-tier guessing stays off |
| HEVC-only feeds | implement HEVC SPS in the same pass; if parsing fails, fall back to `HD` (never guess) |
| `HD` guard regresses another provider | the guard only changes single-rendition rows; unit test pins PPV.st/Streamed.pk master-playlist behaviour unchanged |
| Extra bandwidth per resolve | ~300–500 KB per stream per 10 min, zero video bytes relayed to clients |

Rollback: steps 1–3 (channel) and 4–6 (quality) are independently revertable; the probe service is
additive and unused if step 5 is reverted.

---

## 5. Decisions needing your call

1. **Multi-board feeds**: label `Board 1` as-is, or as `Feed 1 (Board 1)`? (default: `Feed 1 (Board 1)`)
2. **4K threshold**: label 4K only when SPS says 2160, or also when bitrate ≥ 15 Mbps and SPS is unreadable? (default: SPS only — no guessing)
3. **Probe budget**: 3.5 s / 512 KB per stream acceptable? (default: yes)
