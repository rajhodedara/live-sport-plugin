# Architectural Review — ClearKey DASH → HLS Trans-Muxing & Decryption

**Scope:** the proposal to replace the current zero-bandwidth DASH→HLS converter with an in-memory
decrypting proxy (`uncloakInit` + `decryptFmp4Segment`), as described in
`dash_clearkey_hls_plan.md`.
**Reviewed against:** `src/services/DashToHlsService.js`, `src/routes/dash.js`,
`src/providers/Ak47LiveProvider.js`, `src/impitClient.js`, `tests/dashToHlsService.test.js`,
`tests/fixtures/nitro-live.mpd`.
**Date:** 2026-11-01. **Status:** design not yet implemented in the tree (verified: no
`uncloakInit` / `decryptFmp4Segment` symbols exist in `src/`).

---

## 1. Verdict

**The diagnosis is correct. The direction is defensible. The plan as written will not ship.**

Four things are wrong or unstated, in descending order of cost-of-getting-it-wrong:

| ID | Issue | Severity | Cost if missed |
|----|-------|----------|----------------|
| **B1** | `/api/dash/segment.mp4?u=<any URL>` turns the router into an unauthenticated open proxy — SSRF to cloud metadata and the LAN | **Critical (security)** | Host compromise, not a bugfix |
| **B2** | CTR keystream continuity + IV size taken from `tenc`, not hardcoded to 8 bytes | **Blocker (correctness)** | *Silent* corruption: correct byte count, green/black video, "plays" for 2 s then freezes |
| **B3** | Sample location (moof → tfhd/trun → mdat) is never specified; the plan jumps from "parse `senc`" to "decrypt in place" | **Blocker (scope)** | This is 60% of the work and is where the bugs live |
| **B4** | Box hygiene is incomplete (`saiz`/`saio`, `sgpd`/`sbgp` with `seig`, multi-`traf` moofs, `senc` absent → aux info at `saio`) | **Blocker (interop)** | Works on the fixture, fails on the next feed |
| **B5** | Cache keyed by full segment URL, init cache unbounded, buffer ownership vs in-place mutation | **Major (ops)** | Memory leak + 100% cache-miss on token rotation |
| **B6** | The performance section contains three claims that are wrong as stated, and the real cost (egress) is not in the model | **Major (decision)** | Wrong infra sizing, wrong architecture choice |

None of these invalidate the approach. All of them are cheaper to fix now than after the
playlist code ships, because B2/B3 fail *silently* — the stream "works" in a way that looks
like a CDN problem for a week.

The bigger question — whether a decrypting proxy is the right product architecture at all —
is §5. Short version: it works, but it converts a zero-cost addon into a video CDN, and this
repo already owns a cheaper place to do the same work.

---

## 2. What the plan gets right

Worth stating explicitly, because most of the rest of this document is negative:

- **The non-compliance analysis is correct.** `METHOD=SAMPLE-AES-CTR` + `KEYFORMAT="identity"`
  is not something hls.js, ExoPlayer, or AVPlayer will honour. Apple binds CTR to FairPlay;
  ExoPlayer binds CTR to a DRM session manager. Emitting the tag and hoping is a dead end, and
  the plan correctly stops trying.
- **Decrypt-and-serve beats re-encrypt-and-serve.** If you are already in the byte stream, going
  to plaintext fMP4 is the simplest possible output: no key rotation, no per-client key delivery,
  no IV bookkeeping in the playlist. `#EXT-X-KEY` fully removed is the right target state.
- **In-place CTR is size-preserving.** Encryption does not change byte counts, so `sidx`, `trun`
  offsets, and `mdat` framing remain valid without a rewrite pass. That is a genuine simplification
  and it is why this is feasible in Node at all.
- **Single-flight coalescing is the right primitive** for a live edge where many viewers want the
  same 2 s fragment within the same second.
- **Init-segment uncloaking is cacheable and tiny** (~1.7 KB), and correctly separated from the hot
  path.

---

## 3. Blocking findings

### B1 — The `u=` parameter is an open proxy (SSRF). Fix before any other line of this plan.

`src/routes/dash.js` currently validates only this much:

```js
if (!payload || typeof payload.mpdUrl !== 'string' || !/^https?:\/\//i.test(payload.mpdUrl)) {
```

`src/impitClient.js` has **no** private-address guard (`rg` for `169.254|isPrivate|ssrf` → no hits
in the request path). Today the exposure is bounded: an attacker can make the server fetch an
arbitrary URL, but the response body is only ever parsed as XML and either turned into a playlist or
discarded with an error message — blind SSRF and port scanning, not data exfiltration.

The plan adds:

```
GET /api/dash/segment.mp4?d=<payload>&u=<arbitrary URL>
```

which fetches `u` and returns its **bytes to the client**. That is a full read-capable SSRF:
`http://169.254.169.254/latest/meta-data/iam/security-credentials/` on EC2/Lightsail, `:8500` on a
Nomad host, any internal dashboard, any `file:`-adjacent service on localhost. The `d` payload is
also unsigned base64 JSON, so there is nothing binding `u` to the same host as `mpdUrl`.

Required before merge:

1. **Sign the payload.** `d` becomes `base64url(json) + "." + base64url(HMAC-SHA256(secret, json))`,
   verified with `crypto.timingSafeEqual`. Secret from env, rotated with the deploy.
2. **Never accept a raw URL from the client.** Two acceptable shapes:
   - put the *segment template* in the signed payload and derive `u` server-side from
     `template + number` (the client sends `&n=19800890`), or
   - sign each segment URL individually with an expiry: `&u=...&e=<unix>&s=<hmac(u|e)>`.
   The first is better: shorter URLs, no per-segment signing cost, and it composes with the
   cache-key fix in B5.
3. **Belt and braces:** in the fetch path for `/api/dash/*`, resolve the host and reject RFC1918,
   loopback, link-local (`169.254.0.0/16`), CGNAT (`100.64.0.0/10`), and `::1`/`fc00::/7`.

Note that `getRequestBaseUrl()` trusts `x-forwarded-proto`/`x-forwarded-ssl`/`cf-visitor`; that is
fine for playlist URLs but must not be used to decide anything security-relevant.

### B2 — A per-subsample `createDecipheriv` is wrong, and hardcoding an 8-byte IV is wrong

Two independent defects buried in one sentence of the plan: *"extract the 8-byte IV (padded with 8
zeroes) and parse the subsample clear/cipher ranges… decrypt only the encrypted slice bytes in
place."*

**(a) The CTR keystream is continuous across the sample.** In CENC `cenc`, a sample gets one
keystream; `BytesOfClearData` are left in the clear but they **still consume keystream**. So a
cipher initialized at the sample IV and applied to subsample *k* alone produces garbage for every
*k > 0* (the first cipher run after the ~20–36-byte NAL header is the one that "works", which is
exactly why this bug survives a smoke test — the first 16 bytes of the IDR look plausible).

Implementation that is both correct and cheap:

```js
// One cipher per sample. Save the small clear spans, decrypt the whole sample,
// then put the clear spans back. Clear spans are ~20-36 bytes each; the scratch
// cost is a few hundred bytes, not a copy of the 2 MB sample.
const spans = [];                       // [{off, len}]
let off = 0;
for (const ss of subsamples) {
  if (ss.clear) spans.push({ off, len: ss.clear });
  off += ss.clear + ss.enc;
}
const clearCopy = spans.map(s => Buffer.from(buf.subarray(base + s.off, base + s.off + s.len)));
const c = crypto.createDecipheriv('aes-128-ctr', key, ivBlock);
c.setAutoPadding(false);
c.update(buf.subarray(base, base + sampleSize), /* out */ out);   // whole sample in one call
for (const [i, s] of spans.entries()) clearCopy[i].copy(out, s.off);
```

If you insist on per-subsample ciphers, you must advance the counter block by
`floor(byteOffsetWithinSample / 16)` and discard `byteOffset % 16` bytes of keystream — Node's
`aes-128-ctr` cannot seek, so that means encrypting zeros and throwing them away. The single-cipher
form above is simpler and strictly faster.

**(b) IV size comes from `tenc`, not from a constant.** `senc` carries `IV_size` only when its
flags bit 0 (override) is set; otherwise it comes from `tenc.default_IV_size` in the init segment
(`sinf` → `schm` → `tenc`). Both 8 and 16 occur in the wild:

- `IV_size == 8` → counter block is `IV ‖ 0x0000000000000000` (8-byte big-endian counter). Padding
  the 8-byte IV with zeros to 16 bytes gives exactly this — the plan's instinct is right *for this
  case only*.
- `IV_size == 16` → the whole 16 bytes are the counter block and are incremented directly. Padding
  is a no-op and the code happens to work — but only if you read 16 bytes from `senc` instead of 8.

So: read `default_IV_size` (and `default_KID`, and `default_IsProtected`) out of `tenc` during
`uncloakInit`, keep them in the init cache entry, and pass them to the segment decryptor. That
also gives you B4's per-track key mapping for free.

**(c) Full-sample (no-subsample) encryption is a real case.** `senc` with
`subsample_count == 0` means the *entire sample* is encrypted — this is the normal layout for AAC
audio, and the plan has no branch for it. Handle `subsamples.length === 0` as "decrypt
`sampleSize` bytes".

### B3 — The plan never says how it finds the samples

"Parse `moof` → `traf` → `senc`… decrypt in place" skips the hard half. To decrypt you need the
byte range of every sample, which lives in a chain the plan does not mention:

| Box | What you need from it |
|-----|----------------------|
| `tfhd` | `track_ID`; flags: `base_data_offset` present (0x1, 8 bytes), `default-base-is-moof` (0x20000), `default_sample_size` (0x10), `default_sample_flags` (0x20) |
| `trun` | flags: `data_offset` present (0x1, **signed** int32, relative to base data offset), `first_sample_flags` (0x4); per-sample `size` (0x200) when `default_sample_size` is absent |
| `senc` | per-sample IV + optional subsample table |
| `saiz`/`saio` | only if `senc` is absent — aux info then lives elsewhere in the `moof` |
| `mdat` | payload start; sample *k* starts at `baseDataOffset + trun.dataOffset + Σ(sizes[0..k-1])` |

Two traps that will bite on live Nitro/Akamai specifically:

- **Multiple `traf` per `moof`.** Muxed A/V fragments, and occasionally video tracks split across
  tracks for SPS-merged renditions. Iterate every `traf`; do not assume `moof.traf[0]`.
- **Multiple `trun` per `traf`**, each with its own `data_offset`. Accumulate.

Base data offset resolution order: `tfhd.base_data_offset` if the flag is set → else `moof` start
when `default-base-is-moof` → else `moof` start (fragmented files virtually always use moof).
Getting this wrong shifts every sample by a few dozen bytes and produces *decodable-looking noise*.

Recommend a separate, unit-testable module — `src/services/cenc/boxes.js` (walk only),
`src/services/cenc/init.js` (`parseInit`, `uncloakInit`), `src/services/cenc/segment.js`
(`decryptFmp4Segment`) — rather than growing `DashToHlsService.js` from 18 KB to 35 KB. The service
should only ever *call* these; the box walker has no business knowing about HLS.

### B4 — Box hygiene is incomplete

The plan masks `senc` and `pssh` to `free`. That is necessary and not sufficient:

- **`sgpd` + `sbgp` with grouping type `seig`** carry key-rotation metadata per sample group. Leave
  them and some demuxers will still mark samples as encrypted (or, worse, hand a `seig` KID to a
  decryptor you no longer have). Mask both in `traf` *and* in `moov`.
- **`saiz` + `saio`** point at the now-`free` `senc`. Harmless when the track is unencrypted, but
  zeroing them removes an entire class of "why is it still trying to decrypt" debugging.
- **`pssh` in `moov`** — yes; `pssh` in media segments — essentially never, but cheap to mask.
- **`tenc` lives inside `sinf`**, so masking `sinf` handles it; make sure `schm` goes with it.
- **Sample entry rename**: `encv` → `avc1`, `enca` → `mp4a` is correct, but note `enca` for AAC
  carries `esds` as a *sibling* of `sinf` — after renaming, the `esds` must remain the direct child
  of `mp4a`, not swallowed. Masking `sinf` in place (same size, type → `free`) preserves that.
  Do **not** rebuild the `stsd` with a different length; `stsd`, `stsz`, `stco`/`co64` in `moov`
  would all need offset repair, and there is no reason to take that risk.
- **`styp` / `sidx` / `mfra`**: leave alone.

Verified on `tests/fixtures/nitro-live.mpd`: all seven `ContentProtection` entries carry the **same**
`cenc:default_KID` (`18E6AF4A-…`), so today's single-key payload is sufficient for these feeds. It
will not stay sufficient — the provider signature is `api:"<kid>:<key>`, one pair for the whole
stream. Make the decryptor take a **KID → key map** (one entry today) and read the effective KID per
`traf` from `senc` override flags or `tenc`. If a KID shows up that is not in the map, fail the
request loudly (`502` + a warn line with the KID); do not emit undecrypted bytes, because the player
will happily render them as a green smear and nobody will look at the server log.

### B5 — Cache keys, cache bounds, buffer ownership

1. **Cache key by identity, not by URL.** The Nitro fixture's segment URIs carry a rotating query
   token (`cenc_video_1_0_$Number$.mp4?m=1792596286`). If `m` (or an `hdnts` signature) changes on
   playlist reload, a URL-keyed LRU misses 100% of the time and every viewer re-fetches from
   upstream. Key on `${representationId}:${number}` (or `sha1(mpdUrl host + rep + number)`), and
   treat `u` as a hint to be re-derived, not identity.
2. **`initCache` "max 100 entries, permanent" is a slow leak** as written in the plan. 100 × 1.7 KB
   is trivial, but the *permanent* part is not: channels churn, and each entry holds a `tenc` parse
   plus a Buffer that never returns. Use an LRU with a TTL matched to the stream's uptime, evict on
   playlist 4xx.
3. **`segmentCache` at 30 entries × 2 MB = 60 MB per process, shared across all channels.** With
   the live edge at 2 s/segment and a 15-segment window, 30 entries covers ~60 s of *one* channel
   or 4 s of fifteen. Size per channel, not globally: ~6 entries per active channel (12 s), with a
   global cap and LRU across channels. Put the numbers in a config constant so ops can tune without
   a deploy.
4. **In-place decryption mutates the fetch buffer.** `safeFetch` retries (`attempts: 2`); confirm the
   retry path returns a *fresh* buffer and never a cached/replayed one, otherwise attempt 2 decrypts
   already-decrypted bytes and produces garbage. Easiest guarantee: decrypt into the response write,
   never back into the source buffer, and `Object.freeze`-style discipline — one owner per buffer.
5. **Single-flight + LRU means one Buffer object is referenced by N concurrent responses.** That is
   fine for reads and desirable for memory, but it means a buffer cannot be reused, resized, or
   evicted-and-recycled while any response is still flushing. Do not pool these buffers.

### B6 — The performance section will mislead whoever sizes the box

See §4. The one number that matters (`8.2 Mbps × N viewers` of *egress*) is absent.

---

## 4. Audit of the stated numbers

| Claim in the plan | Reality |
|---|---|
| "~1,250 MB/s via AES-NI" | Achievable as a raw OpenSSL CTR throughput on a large contiguous buffer on one modern core. It is not the sustained rate of this pipeline: each request adds an upstream TLS fetch, a box walk, and a `res.end()` copy. Budget **300–600 MB/s** end-to-end per core and measure with `autocannon` against a local fixture. |
| "2 MB fragment decrypts in 1.6 ms (~0.08% of a core per stream)" | The arithmetic is right (1.6 ms per 2 s of 8 Mbps media ≈ 0.08% duty cycle) — the conclusion is right, CPU is a non-issue. But it will be ~3–5× that in this pipeline; still a non-issue. Do not spend a single optimization on crypto. |
| "Buffers > 8 KB allocate in C++ `external` memory, bypassing V8 GC sweeps (zero GC pause impact)" | Overstated. `Buffer` > `Buffer.poolSize` (8 KB) does allocate outside the JS heap, but (i) every such `ArrayBuffer` is still tracked by V8's external-memory accounting and triggers GC pressure at `--max-external-memory` thresholds, (ii) each ~2 MB allocation is a `malloc`, so you trade GC pauses for allocator fragmentation, and (iii) at 30 cached + N in-flight buffers you will see RSS grow in steps that never come back down, because glibc will not return the arenas. Practical consequence: measure `process.memoryUsage().rss` **and** `.external` **and** `--max-old-space` separately in the soak test; the plan only checks `rss` after 50 requests, which proves nothing. |
| "100 viewers on the same stream only pull 1 copy from upstream (~8 Mbps total)" | True only for viewers clustered within one cache window (4 segments ≈ 8 s) of each other *and* with `segmentCache` keyed correctly (B5.1). Any viewer who pauses, stalls, seeks back, or joins late pulls its own full stream. And this sentence describes **ingress**. The cost driver is egress: 8.2 Mbps ≈ **3.7 GB/hour per viewer**, i.e. ~370 GB/h at 100 viewers. The cache does not reduce egress by one byte. |

---

## 5. The architectural question the plan answers too quickly

The plan says "for a VPS deployment this routes stream bytes through the VPS" and moves on. That
single sentence is the whole product decision, and it deserves its own section because it changes
what the addon *is*: from a metadata service (a few KB per request, free to run) to a video CDN
(3.7 GB/hour per viewer, with an egress bill and a bandwidth ceiling).

Four options, ranked by cost of ownership. Test them in this order — the first one may delete the
whole plan.

**A. Check whether the client can play the `.mpd` at all. (30 minutes, cost 0.)**
The premise "our targets are HLS-first" is inherited, not re-verified this cycle. ExoPlayer has
`DashMediaSource` and a ClearKey `MediaDrm` path; Nuvio's player is ExoPlayer-derived. If a
`?url=<mpd>` variant plays even on one target platform (Android TV is the one that matters), then
the correct answer is *emit the MPD with the key inline and keep the zero-bandwidth design*, and
HLS conversion becomes a per-platform fallback rather than the default. This is a one-afternoon
experiment that could remove an entire subsystem. Do it before writing `boxes.js`.

**B. Move the decryption to the edge you already own.**
This repo ships `cloudflare-worker/` and `nuvio-proxy-2/`. Workers egress is free and unmetered on
the paid plan; the Node VPS stays a control plane that mints playlists and signed segment tokens.
WebCrypto has no seekable CTR, but you do not need one: build the keystream with `AES-ECB` over
explicit counter blocks (`IV ‖ counter`, counter incrementing) and XOR. That is ~40 lines, is
byte-exact by construction, and it is exactly the shape of the B2(a) fix. The 50 ms CPU budget is
not a problem — 2 MB of CTR is single-digit milliseconds, and large-buffer WebCrypto calls do not
block the isolate for long.
This is the only option that keeps the "serverless, no egress bill" property the addon currently
has.

**C. Local relay.** If the addon runs on the viewer's machine (desktop Nuvio, or a LAN box), serve
the decrypting proxy on `127.0.0.1` and the egress problem disappears entirely. Costs nothing,
requires no hosting, and is the natural fit for a plugin that already depends on the user's local
network position for other providers. Worth checking whether Nuvio's addon model permits a
localhost transport (it does for the desktop build).

**D. Node proxy, as planned.** Accept 3.7 GB/h/viewer, then engineer for it: per-stream
concurrency caps, `Range` support, `Cache-Control` on immutable live segments, per-IP rate limits,
and a bandwidth alarm. Viable for a private/small audience; not viable as a public addon default.

**Recommendation:** ship A as a spike this week, and B as the production target. Treat D as the
fallback for the one platform that refuses both — and gate it behind an env flag
(`DASH_HLS_DECRYPT=proxy|off`) so it can be turned off per-provider without a rollback.

---

## 6. Revised design (if D is chosen)

### 6.1 Modules

```
src/services/cenc/boxes.js     walkBoxes(buf, start, end) -> [{type, size, start, end}]
                               findPath(buf, ['moof','traf','senc']) — no allocation per box
src/services/cenc/init.js      parseInit(buf)  -> { tracks: Map<trackId,{format, ivSize, kid, protected}> }
                               uncloakInit(buf) -> Buffer   (uses parseInit's map, masks sinf/pssh/sgpd)
src/services/cenc/segment.js   decryptFmp4Segment(buf, { keysByKid, tracks }) -> Buffer (in place)
```

`uncloakInit` should return `{ buf, tracks }`, not just `buf` — the segment decryptor needs `ivSize`
and the track's KID, and re-parsing the init per segment is waste. Cache the pair.

### 6.2 Init cache entry

```js
{
  buf,                        // uncloaked init
  tracks: new Map([[1, { kind:'video', ivSize:8, kid:'18e6af4a…', protected:true }]]),
  createdAt, lastUsedAt
}
```

### 6.3 Decrypt path (per segment request)

1. Resolve identity `${repId}:${number}` (B5.1). Cache hit → respond.
2. Miss → single-flight by identity. Fetch `u` with the payload's headers (UA sanitisation already
   exists in `_sanitizeUpstreamHeaders`).
3. `for (const traf of moof.trafs)`:
   - resolve `baseDataOffset` (§B3), walk `trun`(s), accumulate sample ranges;
   - read IV/subsamples from `senc` (or `saio` fallback);
   - look up `key = keysByKid[effectiveKid]`; **if missing → throw** (B4);
   - decrypt per §B2(a), restore clear spans.
4. Mask `senc`/`saiz`/`saio`/`sgpd`/`sbgp(seig)` → `free` (length-preserving `writeUInt32BE(0x66726565, off)` — no reallocation).
5. Respond `200`, `Content-Type: video/mp4`, `Content-Length` set from the buffer,
   `Accept-Ranges: none`, `Cache-Control: public, max-age=4` (not `no-store` — live segments are
   immutable and the player is allowed to cache them), CORS as today.

### 6.4 Playlist changes

- `#EXT-X-MAP:URI="…/init.mp4?d=<signed>"` — per representation, not per kind (audio and video
  init segments differ; the plan's single `/init.mp4?d=&u=` is fine, the cache key must include `u`'s
  identity).
- Segments: `…/segment.mp4?d=<signed>&n=<number>` — number, not URL (B1.2, B5.1).
- No `#EXT-X-KEY`. Keep `#EXT-X-VERSION:7` (required for `EXT-X-MAP` fMP4).
- Add `#EXT-X-INDEPENDENT-SEGMENTS` (true for these feeds; helps player startup).

### 6.5 Failure behaviour

Never partially emit a segment. If decryption throws, `502` and log
`{ mpdUrl, repId, number, kid, reason }`. A player that gets a 502 retries; a player that gets
half-decrypted bytes shows a green frame and blames the network.

---

## 7. Acceptance criteria (the plan's verification section is not sufficient)

The current test file asserts playlist *text*. None of B2/B3/B4 is reachable from playlist text, and
all three fail silently, so the test plan needs one byte-exact oracle:

1. **Golden vector.** Capture one real 2 s segment + its init from a Nitro stream, commit both
   (~2 MB, acceptable in `tests/fixtures/`, or generate at test time and skip if offline). Decrypt
   with the implementation and with a reference tool:
   ```
   mp4decrypt --key 18e6af4a0daf2a1fdfbdc5b541520c88:ca0b64b84edb4f20eb1e135ff03db4f7 in.mp4 out.mp4
   ```
   Assert `sha256(ours) === sha256(reference)`. Not "decodes" — **byte equality**. Any CTR offset
   error still produces a file that decodes; it just produces the wrong pixels.
2. **Second oracle, independent of the first:** `ffmpeg -v error -i out.mp4 -f null -` must emit
   nothing. "non-existing PPS", "error while decoding MB", "concealing errors" are all failures.
3. **Init assertion:** re-parse the uncloaked init and assert no `encv`/`enca`/`sinf`/`pssh` remains,
   and that `stsd` entry count and `esds` placement are unchanged.
4. **Subsample edge cases as synthetic fixtures** (build them in the test, ~200 bytes each):
   `subsample_count == 0` (audio), one `traf` with three `trun`s, two `traf`s in one `moof`,
   `IV_size == 16`, `senc` with the override flag set, `senc` absent + `saiz`/`saio` present
   (expect a loud failure, not silent pass-through).
5. **KID mismatch:** a `senc` override KID not in the map must `502`, not emit bytes.
6. **Soak:** 60 min against a live channel with 20 concurrent readers; assert `rss` slope < 5 MB/h,
   `external` bounded, and zero `senc`-parse warnings. The plan's "50 requests" check cannot detect
   a 2 MB-per-request leak.
7. **Player matrix, stated as pass/fail per platform:** hls.js 1.5 in Chrome, ExoPlayer
   `HlsMediaSource` on Fire TV (the 4.4/720p decoder profile), VLC desktop. Web and ExoPlayer are
   the two that matter; Safari/AVPlayer only if iOS is in scope (it should now pass, since the
   stream is plaintext H.264 in fMP4).

---

## 8. Operational guardrails (missing from the plan)

- **Feature flag per provider**, `DASH_HLS_DECRYPT` ∈ `off | decrypt`. Off = today's behaviour.
  Rollout: one channel → one provider → all.
- **Counters, not logs, in the hot path:** `decrypt_total{result}`, `cache_hit_ratio`,
  `kid_miss_total`, `upstream_status{code}`, `segment_bytes_total`. A silent-corruption bug shows up
  as an unusual `kid_miss_total` or a `ffmpeg`-side complaint, not as a 5xx.
- **Bandwidth alarm** on egress bytes/hour per channel. This is now the dominant cost and the
  dominant failure mode (a viral channel will saturate the VPS uplink before it saturates the CPU —
  the CPU projection in the plan is off by three orders of magnitude relative to the network).
- **`MAX_WINDOW_SEGMENTS = 15` and 2 s segments**: the playlist window is 30 s but a proxy only
  needs to serve what players request; keep the window as is, but confirm the player does not
  request segments older than the cache depth (it will, on a stall — that is a cache miss, not a
  bug).

---

## 9. Non-blocking nits

- `renderMediaPlaylist` uses `rep.segments[0].number` for `MEDIA-SEQUENCE`; when the decrypted
  route 502s mid-window the player re-reads the playlist and may see a *different* first number —
  fine, but do not add `EXT-X-DISCONTINUITY` on the error path.
- `_keyLine()` will become dead code once `SAMPLE-AES-CTR` is proxied; keep it for `cbcs`, but note
  `cbcs` (SAMPLE-AES) has the same "no identity-key CTR" problem and *will* fail on ExoPlayer too.
  The current `_readProtection` maps `cbcs → SAMPLE-AES`, which is spec-correct and player-broken.
  Either treat `cbcs` as unsupported (drop the stream) or route it through the same decryptor.
- `parseMpd` picks `videoReps[0]` after sorting by bandwidth; that is the 8.2 Mbps rendition, i.e.
  the most expensive one to proxy. Offer the ladder if you are going to pay for egress anyway.
- `#EXT-X-MEDIA-…` audio group is rendered even when audio is missing; harmless.
- The `?m=` token in the fixture is not a signature; do not assume it is one when designing the
  cache key — key on identity and be agnostic.
- Legal/ToS: server-side decryption plus re-origination changes this from "the viewer's player
  fetches the CDN" to "we redistribute the feed from our host". That is a different posture with
  the upstream CDN and the rights holder than the current zero-bandwidth design, and it is worth a
  deliberate decision rather than a side effect of a `res.send()`.

---

## 10. Bottom line

Do B1 and B2 before writing any decryptor code: one is a security hole, the other is a silent
corruption bug, and both are cheaper to design around than to debug. Then run experiment A (§5)
before committing to a proxy architecture at all — if one target platform plays the `.mpd`, the
zero-bandwidth design survives and this plan's most expensive consequence disappears.

If the proxy is still the answer, build it as `src/services/cenc/*` with a byte-exact golden-vector
test, keyed by segment identity, signed end-to-end, and behind a per-provider flag.
