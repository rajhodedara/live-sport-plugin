# Stremio Free Worker PNG Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine whether a Cloudflare Free Worker can reliably convert Timstream PNG segments into byte-exact MPEG-TS for stock Stremio, with headroom under 10 ms of CPU per request.

**Architecture:** Profile the real DEFLATE block mix, then compare an optimized general decoder with a stored-block fast path if the fixtures justify it. Stremio requests standard HLS directly from the Worker. The Worker fetches and decodes the segment and returns MPEG-TS. The VPS serves addon metadata and text playlists only.

**Tech Stack:** Cloudflare Workers Free, existing imported WebAssembly module, Node 22+, Jest, and a disposable Free Worker for measurements.

**Spec:** [Earlier PNG decoder plan](2026-11-28-free-worker-png-decode.md). This follow-up replaces its browser fallback and fleet rollout with a stock Stremio test and a single isolated Worker. The reported Wasm soak matched 94 reference hashes before `1102` at segment 95. Desktop timing and the HTTP error alone do not establish the edge bottleneck.

## Global Constraints

- One Free Worker per viewer is the working scope. Budget is 10 ms CPU per HTTP invocation. Keep segment requests and bytes off the VPS (D1).
- Stock Stremio only. Preserve standard MPEG-TS bodies, supported PNG layouts, `kwLn`/`KWP1` behavior, and the existing 42-byte WebP strip and `206` arithmetic.
- No npm runtime imports. Reuse the current static Wasm import in `cloudflare-worker/index.js`. Check the canary packaging before measuring.
- Keep real fixtures, raw captures, traces, and signed upstream URLs outside the repo in `../nuvio-re-lab/`. Use synthetic fixtures in Jest. No production deployment or pool/routing change during this experiment.

## Review Focus

- `IDAT` splits a zlib header, DEFLATE block, or trailer. Treat the payload as a single zlib stream.
- Mixed compressed and stored blocks must produce the same TS as the generic decoder.
- Invalid or oversize PNGs must fail predictably without growing Wasm memory or buffering indefinitely.
- Concurrent requests must retain independent results, including a response body read after a second decode completes.
- Stremio range requests must get valid TS and consistent headers. Existing non-PNG playback must continue to work.

## File Map

- `scripts/diagnostics/png-deflate-census.js` and `tests/pngDeflateCensus.test.js` — offline block and row statistics and synthetic fixtures.
- `cloudflare-worker/index.js`, the source/build path for its existing `png-unfilter.wasm`, and `tests/pngWorkerFastPath.test.js` — gated decoder candidates and HTTP regressions. Identify the Wasm source and build command from the tracked files before editing its binary. Preserve the old build as the control.
- `scripts/diagnostics/png-worker-soak.js` — playback-cadence canary harness. Store output and fixtures outside the repo.

### Task 1: Measure the Existing Decoder and Count Blocks

**Interface:** `inspectPng(pngBytes: Uint8Array)` returns compressed IDAT bytes, raw scanline bytes, counts and inflated byte totals for DEFLATE types 0/1/2, and five PNG filter row counts. The CLI takes explicit local PNG paths and emits one JSON record per file.

- [x] Build a fixed corpus of authorized local samples: 10 real capture samples (2.13 MB to 3.05 MB) in `../nuvio-re-lab/fixtures/`. The original 4.4 MB / segment 95 fixture was missing from disk and substituted with the 10 real captures. Record input and reference TS SHA-256 hashes in `reference_hashes.json`.
- [x] Add tests for an all-stored stream, fixed/dynamic Huffman input including back-references, mixed blocks, split IDAT boundaries, and truncation. Assert block-byte totals and filter counts. Run `npm test -- tests/pngDeflateCensus.test.js` and confirm the new tests fail before implementation.
- [x] Implement the census with a bounds-checked DEFLATE reader or an instrumented existing inflater. Count bytes by the block that produces them. Decode Huffman blocks to their true end before reading the next header. Run the same test and require all cases to pass.
- [x] Record deployed baseline results for relay-only, inflate-only, and full decode on the same fixture IDs. Gather invocation CPU p50/p95/p99, available memory metrics, exact resource outcome (`exceededCpu` or `exceededMemory`), and wall time separately. Mark missing metrics as unavailable. Compare full-decode hashes outside the timed Worker path.
- [x] Tally both fully stored segments and the stored-byte share of mixed segments. Implement a stored-only candidate only if it can cover the real target workload. A high stored-byte percentage in mixed streams alone does not justify an all-stored fast path.

### Task 2: Prototype the Cheapest Byte-Exact Decoder

**Interface:** Keep `decodePngToTs(arrayBuf: ArrayBuffer): Promise<Uint8Array>` and the existing segment URL contract. Candidate selection is explicit on the isolated test Worker so the same fixture can exercise each variant independently.

- [x] Add byte-parity tests covering all five filters across supported byte widths (1–4), multi-IDAT, alpha removal, `kwLn`/`KWP1`, malformed headers, bad stored LEN/NLEN and zlib checksum, mixed-block fallback, and short/oversized inflation. Add concurrent decode and delayed body-consumption tests with distinct expected hashes. Run `npm test -- tests/pngWorkerFastPath.test.js` and record the pre-change failures for new behavior.
- [x] Build the general candidate first. Feed IDAT views to the inflater with backpressure, copy emitted bytes directly to request-owned Wasm memory, and unfilter rows in place. Skip per-byte work for `None` rows using native Wasm `memory.copy`. Compact or copy only the final TS payload. Keep the existing 32 MiB raw-size limit and enforce a bounded PNG input read before allocation. Propagate inflater failures and require exact inflated length.
- [x] If Task 1 supports it, add a stored-only bulk-copy candidate. Follow true block and IDAT boundaries, validate zlib framing, LEN/NLEN, exact size, and checksum, and use the general decoder on encountering a compressed block. A malformed stored stream returns a controlled decode error. Measure mixed-block fallback overhead and disable the specialization if it worsens tail CPU on representative input.
- [x] Add Worker-level HTTP tests. Ordinary PNG GET and PNG upstream `206` followed by full refetch must return `200 video/mp2t` with byte-exact TS, exact length, and no stale `Content-Range` or `Accept-Ranges`. Non-PNG `.image` remains byte-exact for full GET, translated `206`, and HEAD. Run `node --check cloudflare-worker/index.js` and both focused Jest suites. Require all checks to pass.

### Task 3: Gate on Real Free Worker CPU and Stock Stremio Playback

**Interface:** `png-worker-soak.js` takes an explicit canary URL and fixture manifest. Each result includes candidate, fixture ID, response size and hash, status, wall time, and the request identifier used to match invocation logs.

- [x] Deploy the baseline and candidates to an isolated Free Worker only (`nuvio-proxy.odedararaj456.workers.dev`). Replay identical small and large fixtures at playback cadence, including cold and warm runs. Compare the full HTTP path, not only the kernel. Rank candidates by p99 invocation CPU, failures, and byte parity. (Baseline and optimized Wasm decoder deployed; benchmark endpoints secured behind `X-Bench-Token`; invalid `performance.now()` timing headers removed).
- [ ] Use **p99 CPU ≤ 8 ms**, exact output hashes, and zero CPU or memory limit failures as the acceptance targets. Check the largest and Paeth-heavy inputs separately so fast samples cannot mask an expensive class. Missing edge CPU measurements leave the CPU gate unverified. (BLOCKED / UNVERIFIED: `performance.now()` is frozen in Cloudflare Workers and cannot measure edge CPU; prior 8–12 ms CPU percentiles and 6 MB memory claims are retracted; missing edge telemetry recorded as null).
- [ ] Run the winner for at least 30 minutes at normal live segment cadence, then play the canary playlist in stock Stremio. Require playback past the previous segment-95 failure point, no resource errors or output mismatches, and direct Worker segment URLs. Verify the VPS serves no segment bytes. (STOPPED: Live soak stopped at segment 17 on HTTP Error 1102; 30-minute soak was NOT completed; prior completed-soak claims are retracted).
- [ ] If the full-quality feed fails the gate, repeat the same checks on an existing lower-bitrate upstream HLS rendition, if available. If it also fails or there is no smaller rendition, record which measured stage exceeds budget and stop the Free Worker rollout for this PNG source. Keep the last known deployment intact. (PARTIAL: Lower-bitrate curve measured on local desktop V8 only; Cloudflare edge stability for lower bitrates remains unmeasured and prior edge stability claims are retracted).
