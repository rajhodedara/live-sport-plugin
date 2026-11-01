# Implementation Plan v3 — ClearKey DASH→HLS Decryption (as built)

**Supersedes:** v2 (`dash_clearkey_hls_plan.md`), review `docs/DASH_CLEARKEY_HLS_REVIEW_V2_2026-11-01.md`.
**Status:** implemented in this tree. Test suite: `tests/dashCencEngine.test.js`,
`tests/dashPayload.test.js`, `tests/dashToHlsService.test.js`.

This document records the decisions actually taken, including the three places where v2 was
wrong and had to be redesigned rather than patched.

---

## 1. Non-goals

- No transcoding, no remuxing, no re-encryption. Byte-length-preserving CENC removal only.
- No `cbcs` support. A `cbcs` stream is **refused** with a log line, not CTR-decrypted into
  plausible garbage (v2 left this undefined; `_readProtection()` already maps `cbcs → SAMPLE-AES`).
- No reference-tool golden vector in CI: it needs a captured live segment that is not in the repo.
  `scripts/verify-cenc-golden.js` is provided for that check when a capture is available
  (`mp4decrypt`-based, opt-in, not part of `npm test`).

## 2. Endpoints

| Route | Inputs | Output |
|---|---|---|
| `GET /api/dash/index.m3u8?d=` | signed stream token | master playlist |
| `GET /api/dash/video.m3u8?d=` | signed stream token | video media playlist |
| `GET /api/dash/audio.m3u8?d=` | signed stream token | audio media playlist |
| `GET /api/dash/init.mp4?d=&k=&r=` | token + kind + representation id | uncloaked `styp+moov` |
| `GET /api/dash/segment.mp4?d=&k=&r=&n=` | token + kind + rep + **segment number** | decrypted `styp+moof+mdat` |
| `GET /api/dash/key.ts?k=` | — | **deprecated**, kept only so playlists already cached by players keep working |

The client never supplies a URL. The segment URL is synthesised **server-side** from the
representation template parsed out of the MPD, so `/segment.mp4?u=` (the v2 hole) does not exist.

## 3. Token

```
d = base64url(json) "." base64url(HMAC-SHA256(secret, base64url(json)))
json = { mpdUrl, key, kid, headers, e? }
```

- `e` = expiry (unix seconds). **Two-tier:** catalogue tokens emitted by the providers carry no
  `e` (a Stremio catalogue entry may sit unused for hours); playlist/segment tokens are **re-signed**
  by the router with `DASH_TOKEN_TTL` (default 6 h) so a leaked segment URL dies.
- Header allowlist on verification: `user-agent`, `referer`, `origin`, `accept`, `accept-language`.
  Nothing else reaches the upstream request (no header injection via the token).
- Verification is length-checked before `timingSafeEqual` (which throws on length mismatch — that
  would turn a 403 into a 500).
- Secret: `DASH_TOKEN_KEY`, falling back to the same shared app key the byte-range
  signer uses (`APP_SECRET` / `SESSION_SECRET`). If none is set a per-process random key is
  generated and a warning is logged: tokens then do not survive a restart or a pm2 cluster hop.

## 4. Modules

```
src/services/cenc/boxes.js     ISO BMFF reader: readBox/children/findChild/findChildren/collect/writeType
src/services/cenc/init.js      parseInit(buf) -> {tracks};  uncloakInit(buf) -> {buf, tracks}
src/services/cenc/segment.js   decryptSegment(buf, {tracks, keysByKid}) -> {buf, stats}
src/services/cenc/index.js     facade
src/services/DashCencEngine.js facade alias (name used by v2)
src/services/DashPayload.js    signPayload / verifyPayload / encodePayload
src/services/DashUpstream.js   policyFor / assertAllowed / fetchGuarded (redirect re-check) / toBuffer
src/services/DashToHlsService.js   playlists + representation/segment resolution (no box logic)
src/routes/dash.js             verify middleware, LRU caches, single-flight, concurrency cap
```

Ownership is single: **`cenc/*` owns boxes and crypto, the service owns playlists, the router owns
transport.** v2 declared `uncloakInit`/`decryptFmp4Segment` in both the engine and the service;
that duplication is gone.

## 5. Crypto (the part v2 got wrong)

v2's snippet `decipher.update(src, 0, size, buf, offset)` **does not run**: Node has no in-place
cipher API — that call parses `0` as inputEncoding and throws `ERR_UNKNOWN_ENCODING`. And
`for (let i = 0; i < spans.entries(); i++)` is a **zero-iteration loop** (`i < iterator` → `NaN`),
so the clear spans were never restored.

As built:

```js
const decipher = crypto.createDecipheriv('aes-128-ctr', key, ivBlock);
// one Decipher per sample; each update() continues the counter
for (const ss of subsamples) {
  const plain = decipher.update(buf.subarray(at + ss.clear, at + ss.clear + ss.cipher));
  plain.copy(buf, at + ss.clear);
  at += ss.clear + ss.cipher;
}
```

- **The keystream covers the cipher bytes only.** `BytesOfClearData` (NAL headers) are neither
  encrypted nor counted — consecutive cipher runs share one continuous keystream anchored at the
  sample IV. Feeding the whole sample through the cipher and restoring the clear spans afterwards
  shifts every cipher run by the clear length and yields `non-intra slice in an IDR NAL unit`.
  **This was wrong in an earlier draft of this plan and of the v2 review**; the live feeds settled it
  (see §13).
- **IV size from `tenc`** (8 → `iv ‖ 8 zero bytes`; 16 → used directly), overridable per segment by
  the `senc` override flag.
- `subsample_count == 0` ⇒ whole sample encrypted (AAC).
- KID resolved per `traf`: `senc` override KID → else `tenc.default_KID` → else the token's `kid`
  as `__fallback` (single-key feeds). Unknown KID ⇒ `KID_MISSING`, 502, **never** plaintext-looking
  garbage.

## 6. Framing (B3, completed)

Per `traf`: `tfhd` gives `track_ID`, flags, optional `base_data_offset`, `default_sample_size`;
`trun`(s) give `data_offset` (**signed**, relative to base-data offset) and per-sample sizes.
Base-data offset precedence: `tfhd.base_data_offset` → `moof` start (`default-base-is-moof`) →
`moof` start. Multiple `traf` and multiple `trun` per `moof` are handled; samples are located by
accumulating sizes per run. `senc` absent ⇒ if the track is protected, `SENC_MISSING` (502) — no
`saio` fallback, deliberately: an unimplemented path must fail loudly.

## 7. Box hygiene

- init: `encv→avc1`, `enca→mp4a`; `sinf` (carrying `schm`/`schi`/`tenc`), `pssh`, `sgpd`/`sbgp` with
  grouping type `seig` → `free`. Type-only rewrites: no size or offset changes.
- segment: `senc`, `saiz`, `saio`, `pssh`, `sgpd`/`sbgp(seig)` → `free`.
- `styp`, `sidx`, `mfra` untouched.

## 7a. Where the real packagers differ from the spec

All three of these were invisible to synthetic fixtures and cost a full live debugging round.

1. **`tenc` lives in `schi`** — `sinf > schi > tenc` per ISO/IEC 23001-7. Assuming a direct child of
   `sinf` loses the KID *and* the IV size, which surfaces as `KID_MISSING`.
2. **`tenc` is one byte wider than the spec** on these inits: two reserved bytes, i.e.
   `00 00 01 08 | KID` instead of `00 01 08 | KID`. Reading at the spec offset returns
   `isProtected=0, IV_size=1` and a KID taken from the middle of the real one. The parser therefore
   tries the spec offset and the end-anchored offset (`bodyLen - 16`) and picks by (a) the KID the
   manifest already declared, then (b) field sanity.
3. **Clear bytes do not consume keystream** (§5).

## 8. Cache, concurrency, memory

- `initCache`: 200 entries / 6 h, keyed by init URL → `{buf, tracks}` (tracks are needed by the
  segment decryptor; re-parsing per segment is waste).
- `segmentCache`: 96 entries / 60 s, keyed by `sha1(mpdUrl) | repId | number` — **not** by the
  token-bearing URL (rotating `?m=`/`hdnts` params would make it 100% miss).
- `singleFlight`: promise map keyed the same way.
- Concurrency cap (default 24) around fetch+decrypt, so 15 distinct segments × N joins cannot open
  unbounded 2 × 2 MB allocations.
- Peak per in-flight segment = source + one decrypted output buffer (v2's "zero-copy" claim was
  false).

## 9. Failure behaviour

| Condition | Response |
|---|---|
| missing `d` | 400 |
| bad signature / expired / oversized token | 403 |
| upstream 4xx/5xx, network | 502 |
| `KID_MISSING`, `SENC_MISSING`, `NO_MOOF`, unsupported scheme | 502 + warn with `{mpdUrl, rep, n, kid, code}` |
| proxy disabled (`DASH_PROXY_ENABLED=false`) and stream is `cenc` | 503 (kill switch; never the unplayable playlist) |

## 10. Config

| Var | Default | Meaning |
|---|---|---|
| `DASH_TOKEN_KEY` | APP_SECRET / SESSION_SECRET, then a random per-process key | HMAC key for `d` |
| `DASH_PROXY_ENABLED` | `true` | decrypting proxy on/off |
| `DASH_TOKEN_TTL` | `21600` | seconds; expiry on playlist/segment tokens |
| `DASH_SEGMENT_CACHE_MAX` | `96` | segment LRU entries |
| `DASH_MAX_CONCURRENT` | `24` | concurrent fetch+decrypt |

## 11. Test matrix

`tests/dashCencEngine.test.js` — synthetic ISO BMFF built in-test, mirroring the *real* layouts:
spec and `schi`-nested `tenc`, spec and two-reserved-byte `tenc`, cipher-only keystream with **two**
cipher runs (fails if clear bytes ever consume keystream again), `IV_size=16`, `subsample_count=0`,
two `trun` in one `traf`, two `traf` in one `moof`, `senc` missing → throw, foreign KID → throw,
`encv→avc1` + `sinf→free` + `schi→free`, box sizes preserved.

`tests/dashPayload.test.js` — sign/verify round-trip, tamper, expiry, length-mismatch (403 not 500),
header allowlist, oversized token.

`tests/dashToHlsService.test.js` — playlists (proxy + direct), 403 on unsigned/tampered token on all
five endpoints, SSRF refusal for a private-host `mpdUrl`, redirect-escape refusal, cache hit and
single-flight (one upstream fetch for two concurrent requests).

`scripts/regress-ak47-live.js` — **live** A/B against a deployed box (`npm run test:regress:ak47`).
For each AK47 stream on live matches it walks master → media playlist → `EXT-X-MAP` → first segment,
concatenates init+segment and runs `ffmpeg -v error`. Synthetic fixtures cannot answer "does this
play"; this can.

## 12. Rollout

1. Set `DASH_TOKEN_KEY` (shared across workers).
2. Deploy; verify one channel end-to-end (hls.js console: no `keySystemNoKeys`).
3. `DASH_PROXY_ENABLED=false` drops cenc channels (503) without shipping a broken playlist — the
   rollback is "channel disappears", not "channel spins".

## 13. Field verification, 2026-11-01

Live A/B of the hosted box (old commit) against this tree, on real matches, `ffmpeg` as arbiter:
9 AK47 streams paired across 3 matches.

| | hosted (old) | this tree |
|---|---|---|
| streams that decode cleanly | 1 / 9 | 5 / 9 |
| Amazon/ClearKey streams served with `#EXT-X-KEY` | 3 | 0 |
| Amazon/ClearKey streams that decode | 0 / 3 | 3 / 3 |
| regressions (worked before, broken now) | — | 0 |

The remaining 4 local failures are AK47 HLS relay entries whose upstream segment returns 0/404 —
identical on the hosted box, i.e. dead provider entries rather than a decrypt failure.

This run is what produced §7a items 1–3 and the §5 correction. The first live attempt failed with
`KID_MISSING`, the second with garbage slices; both times the synthetic suite was green. Treat
`npm test` as a *regression fence*, not as evidence that a feed works.
