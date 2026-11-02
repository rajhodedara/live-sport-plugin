# Review — ClearKey DASH→HLS Decryption Plan **v2**

**Reviewed:** `dash_clearkey_hls_plan.md` (v2, "Hardened Implementation Plan").
**Against:** `src/services/DashToHlsService.js`, `src/routes/dash.js`, `src/providers/Ak47LiveProvider.js`,
`src/impitClient.js`, `tests/fixtures/nitro-live.mpd`.
**Date:** 2026-11-01. **Status:** plan is now *structurally* sound; 5 concrete defects remain, 3 of
which are in the code snippets the plan proposes to ship.

---

## 1. Verdict

v2 closes the architectural findings properly: no client-supplied URLs, HMAC, per-sample keystream,
box hygiene, bounded caches. That is the right shape and it is worth building.

But the plan moves from "underspecified" to "specified **and wrong in three lines of code**". Each of
those lines fails at a different layer, and two of them fail *silently* — the reason this review is
blunt rather than congratulatory is that the test plan (§4 of v2) would still pass every one of them
except N1.

| ID | Defect | Layer | Evidence |
|----|--------|-------|----------|
| **N1** | `decipher.update(src, 0, size, buf, offset)` does not exist in Node — no in-place cipher API | code (won't run) | verified: `ERR_UNKNOWN_ENCODING: Unknown encoding: 64` |
| **N2** | `for (let i = 0; i < spans.entries(); i++)` never executes — the clear spans are never restored | code (silent corruption) | verified: 0 iterations |
| **N3** | HMAC is applied to `/segment.mp4` + `/init.mp4` only; the three playlist endpoints stay open, and `renderMediaPlaylist` prints the **unsigned** `dRaw` | security (blind SSRF survives) | v2 §3.2 vs §3.3 |
| **N4** | Host allowlist is necessary but not sufficient — `safeFetch` follows redirects | security | `impitClient.js:486` redirect chain |
| **N5** | B3 still lacks the three rules that decide whether framing is right (`base_data_offset` precedence, multi-`trun`/multi-`traf`, `saio` fallback), and v2 dropped `sgpd`/`sbgp(seig)` from B4 | correctness (feeds break per-channel) | v2 §B3, §B4 |

Everything in §2 below is the fix. §3 lists the second-order items that will bite in production but
not on the fixture. §4 is the test delta that would have caught N1/N2/N5.

---

## 2. Defects that block merge

### N1 — Node has no in-place cipher API; the decryption snippet cannot run

v2 §B2 proposes:

```js
decipher.update(buf.subarray(sampleStart, sampleStart + sampleSize), 0, sampleSize, buf, sampleStart);
```

`Cipher.update()` accepts `(data[, inputEncoding][, outputEncoding])` and **returns a new Buffer**.
There is no output-buffer / offset overload — in any Node version. The call above is parsed as
`inputEncoding = 0`, `outputEncoding = 64`, and throws immediately:

```
$ node -e "…createDecipheriv('aes-128-ctr'…).update(d, 0, 64, buf, 32)"
ERR_UNKNOWN_ENCODING: Unknown encoding: 64
```

Consequence: the "zero-copy in-place" property that v2 §B6 relies on does not exist. Peak memory per
in-flight segment is **2× segment size** (source + one decrypted sample), not 1×, and that changes
the B5 arithmetic. It is still cheap — one 8–12 KB allocation per sample, ~300 per 2 s segment — but
the plan must budget it.

Correct form (peak extra = one sample, not one segment):

```js
const ivBlock = track.ivSize === 16 ? iv : Buffer.concat([iv, Buffer.alloc(8)]);

for (const s of samples) {                          // {start, size, iv, subsamples[]}
  const base = s.start;
  // 1. save the clear spans *before* anything is overwritten
  const spans = [];
  let o = 0;
  for (const ss of s.subsamples) {                   // [] => full-sample (AAC)
    if (ss.clear) spans.push({ off: o, len: ss.clear });
    o += ss.clear + ss.cipher;
  }
  const saved = spans.map(sp => Buffer.from(buf.subarray(base + sp.off, base + sp.off + sp.len)));

  // 2. one continuous keystream over the whole sample
  const cipher = crypto.createDecipheriv('aes-128-ctr', key, s.ivBlock || ivBlock);
  const plain = cipher.update(buf.subarray(base, base + s.size));   // returns Buffer

  // 3. write back, then restore the clear spans
  plain.copy(buf, base);
  for (let i = 0; i < spans.length; i++) saved[i].copy(buf, base + spans[i].off);
}
```

`setAutoPadding(false)` is a no-op for CTR (stream cipher) — harmless, but its presence in the plan
signals the snippet was adapted from a CBC example, which is where N2 came from too.

### N2 — The clear-span restore loop is dead code

```js
for (let i = 0; i < spans.entries(); i++) { clearBackup[i].copy(buf, …); }
```

`spans.entries()` is an `Array Iterator`. `i < iterator` coerces the iterator to `NaN`, so the
condition is false on the first check and **the loop body never runs** (verified: 0 iterations).
Every NAL header stays decrypted — i.e. every sample becomes exp-Golomb garbage, the decoder
conceals, and the stream shows a fully broken picture rather than "green blocks".

The fix is trivial (`i < spans.length`), but note the more important point: this is exactly the class
of bug the plan's §4 test plan cannot see, because §4 only checks that frames *advance* in a browser.
A picture is either clean or it isn't; there is no middle signal.

> **Correction, 2026-11-01 — after live feeds.** One claim in this section is wrong. Clear bytes do
> **not** consume keystream. The cipher runs of a sample share one continuous keystream anchored at
> the sample IV, so the correct construction is one `Decipher` per sample fed *only* the cipher spans
> — not "decrypt the whole sample, then restore the clear spans". A live A/B on the AK47 Amazon
> feeds settled it: whole-sample keystream produced `non-intra slice in an IDR NAL unit`, cipher-only
> produced a clean `ffmpeg` decode. N1 and N2 remain valid findings; the implementation and fixtures
> follow the corrected model (`docs/DASH_CLEARKEY_HLS_IMPLEMENTATION_PLAN.md` §5, §7a).

### N3 — Only two of five endpoints are verified; the playlist routes still print the unsigned payload

Two separate holes:

**(a) Coverage.** v2 §3.2 signs in `buildMaster` and §3.3 adds `verifyDashPayload` to
`/init.mp4` + `/segment.mp4`. `/index.m3u8`, `/video.m3u8`, `/audio.m3u8` keep today's
`decodeDashPayload()` — which is unsigned base64 JSON. Anyone can therefore still make the server
fetch an arbitrary `mpdUrl` and read the *result* (the generated playlist echoes resolved segment
URLs, base URL, and representation metadata). That is the blind SSRF we removed, still reachable,
just with a smaller blast radius. **All five handlers must call the same verifier** — one middleware,
mounted on the router, not five call sites.

**(b) Inconsistency.** §3.2 says `buildMaster` generates the signed `d`, but `renderMediaPlaylist`
is shown printing `d=${dRaw}` — the *inbound, unsigned* token. If that ships as written, the child
playlists carry an unsigned payload and `/segment.mp4` will 403 on every request: a plan that plays
nothing. Be explicit about the data flow:

```
provider → dRaw (unsigned, base64 JSON)     ← existing, unchanged
router   → verify(dRaw) → payload           ← new, every endpoint
render   → dSigned = payload + "." + hmac    ← one helper, used by master AND both media playlists
client   → /segment.mp4?d=dSigned&n=…&k=…
```

Also: the signed token must carry `exp`. Today's `d` is a permanent bearer token for the channel; a
signature without an expiry authenticates the *stream*, not the client, and this service's cost
driver is egress (see N7). A 4-hour `exp`, re-minted on each playlist reload, costs nothing and caps
the damage from a leaked URL.

### N4 — Allowlist alone does not stop redirect escapes

`safeFetch` follows redirects (`impitClient.js:486`, "redirect chain"). An allowlisted host that
302s to `http://169.254.169.254/…` is still an allowlisted host at the moment of the check. The guard
must be **per hop**, not per request:

- `redirect: 'manual'`, re-validate each `Location` against the policy, max 3 hops;
- policy = exact host match to the signed payload's `mpdUrl` host (not a global `*.aiv-cdn.net`
  suffix — that list will rot the first time a feed moves to `*.amazonaws.com`), `https` only, no
  `user:pass@`, port 443 only;
- additionally resolve and reject RFC1918 / loopback / `169.254.0.0/16` / CGNAT / ULA, because a
  compromised DNS answer defeats host matching.

One more: `crypto.timingSafeEqual` **throws** on length mismatch (`ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`,
verified). Compare `Buffer.byteLength(a) === Buffer.byteLength(b)` first, or the 403 path becomes a
500 and a log-spam amplifier.

### N5 — B3 is still three rules short, and B4 lost the `seig` case

v2 §B3 says: parse `tfhd` → `trun.data_offset` → correlate sample *i* with `senc` entry *i*. That is
the happy path only. Missing:

1. **Base-data-offset precedence.** `tfhd.flags & 0x01` → use the 8-byte `base_data_offset`;
   `flags & 0x20000` (`default-base-is-moof`) → `moof` start; neither → `moof` start for fragmented
   files. v2 mentions "relative to `moof` start or `base_data_offset`" without the rule that selects
   between them. Get this wrong and every sample shifts by the `moof` header length — decodable
   noise, no error.
2. **Multiplicity.** `moof` may hold several `traf` (muxed A/V; also split video tracks), and a
   `traf` may hold several `trun`, each with its own signed `data_offset`. v2's `decryptSegment(buf,
   keyHex, trackInfo)` signature takes **one** `trackInfo` and one key — that is structurally unable
   to handle a two-track `moof`, and it silently bakes in the single-KID assumption that
   `nitro-live.mpd` happens to satisfy today (all 7 `ContentProtection` entries share `18E6AF4A…`).
   Signature must be `decryptSegment(buf, { tracks: Map<trackId, {ivSize, kid}>, keysByKid })`,
   resolving key per `traf` from `senc` override → `tenc` default.
3. **`senc` absent.** Some packagers emit only `saiz`/`saio` (aux info at the end of `moof`). v2 has
   no branch and no failure rule. Decide: parse `saio` offsets, or **fail loudly with 502**. What you
   must not do is fall through and serve ciphertext.
4. **`subsample_count == 0`** is listed for audio but the pseudo-code never branches on it — `[]` must
   mean "whole sample", which N1's snippet does by iterating an empty list. Fine, but state it.
5. **B4 regression:** v2 masks `senc`/`saiz`/`saio`/`pssh` and drops `sgpd`/`sbgp` with grouping type
   `seig` (key-rotation sample groups). Leave those and some demuxers still tag samples as encrypted.
   Mask in both `moof` and `moov`.
6. **Scheme guard:** `schm.scheme_type` must be `cenc`. If a feed switches to `cbcs` (CBC, 1-in-10
   pattern), CTR-decrypting it yields garbage that looks like a codec bug. Refuse `cbcs` with a log
   line rather than producing plausible-looking corruption. `_readProtection()` already maps
   `cbcs → SAMPLE-AES`, so this is one `if`.

---

## 3. Second-order items (will bite in production, not on the fixture)

**N6 — Cache key semantics and peak concurrency (v2 §B5).** `(kid, streamKind, segmentNumber)` cannot
be evaluated before the fetch: the KID is only known from `tenc`/`senc`, which arrive with the
segment. Key on `(hash(mpdUrl), repId, number)` — the signed payload already has all three. Also:
`segmentCache` "24 per active worker" × N pm2 workers × channels is not a bound; make it global-with-
per-channel-share, and note that 100 viewers joining six channels at once produce up to 15 distinct
fetches **per channel** — single-flight dedupes *within* a segment, not *across* a playlist. Cap
concurrent decrypt+fetch with a small limiter (16–32); unbounded in-flight × 2× segment size is how
this OOMs on a viral match, not by cache growth.

**N7 — The toggle is a broken-stream switch, and egress is still unquantified.** `DASH_DECRYPT_ENABLED=false`
as described restores "direct encrypted pass-through" — i.e. the `SAMPLE-AES-CTR` playlist that plays
on nothing. A rollback switch must degrade to *not advertising the channel* (drop it from the
catalogue) or to the `mpd` URL, never to a known-unplayable playlist. And B6 still has no number: at
the fixture's 8.2 Mbps top rendition this is **≈3.7 GB/hour per viewer** of VPS egress, ~370 GB/h at
100 viewers, with per-viewer cost that single-flight does not reduce. Put that in the plan, with a
per-IP rate limit and a bandwidth alarm, or the first popular channel is a surprise bill.

**N8 — Duplicate ownership of the decryptor.** §3 says `DashCencEngine.js [NEW]` *and*
`DashToHlsService.js [MODIFY] Add uncloakInit, decryptFmp4Segment, tfhd/trun parser`. Two homes for
the same functions guarantees drift (and the service file is already 18 KB with no business knowing
about `tfhd`). One owner: `DashCencEngine` owns boxes + crypto; the service owns playlists only.
Split it further if it helps (`cenc/boxes.js`, `cenc/init.js`, `cenc/segment.js`) — the box walker is
the part you will want to unit-test in isolation.

**N9 — `/api/dash/key.ts` should be deleted.** It echoes any 32-hex string back as bytes. With the
`#EXT-X-KEY` gone from every output, it has no consumer and only serves as a key-validity oracle.

**N10 — Init-map caching headers.** `#EXT-X-MAP` is fetched once and treated as immutable by players;
serve `Cache-Control: public, max-age=31536000, immutable` for `/init.mp4` (it is derived from an
immutable upstream init), and `Accept-Ranges: none` on both binary routes so a proxy does not attempt
a byte range on a body you generate per request.

---

## 4. Test delta (this is the part that would have caught N1, N2, N5)

v2 §4 is still playlist text + "open headless Chrome and watch it advance". That verifies exactly one
thing: that decryption ran at all. Replace with:

1. **Byte-exact golden vector.** One real 2 s Nitro segment + its init, committed under
   `tests/fixtures/` (~2 MB) or fetched-and-skipped when offline. Decrypt with the engine and with a
   reference tool (`mp4decrypt --key <kid>:<key>`); assert `sha256(ours) === sha256(reference)`.
   Anything less cannot distinguish "correct" from "plausible".
2. **Structured negative cases, built in the test (~200 bytes each):** `subsample_count == 0`;
   two `trun` in one `traf`; two `traf` in one `moof`; `IV_size == 16`; `senc` with the override flag
   carrying a foreign KID (expect 502, not bytes); `senc` absent + `saiz`/`saio` present (expect 502);
   `schm == cbcs` (expect 502).
3. **Route-level regression for N3/N4:** unsigned `d` on all five endpoints → 403; signed `d` with
   `mpdUrl` on a private host → 403; allowlisted host that 302s to `169.254.169.254` → 403 and **no
   second hop executed**; `timingSafeEqual` length mismatch → 403 (not 500).
4. **Soak, not smoke.** 60 min, 20 readers, one channel: `rss` slope < 5 MB/h, `.external` bounded,
   `kid_miss_total == 0`, `senc_missing_total == 0`. v2's manual step 3 ("frames advance past 30 s")
   cannot detect a 2 MB-per-request leak or a per-sample keystream desync.
5. **Player matrix as pass/fail rows:** hls.js in Chrome, ExoPlayer `HlsMediaSource` on Fire TV,
   VLC desktop. Safari only if iOS is in scope.

---

## 5. Bottom line

Build it — but before the first commit of `DashCencEngine.js`, replace the three code snippets in §B2
and §3 with the corrected forms above (N1, N2), and make the verifier a router-level middleware rather
than two call sites (N3). Those three are the difference between a two-day implementation and a
two-week bug hunt: N1 fails at first run, N2 fails as a white/green picture with no error, and N3
looks fine until someone audits the playlist routes.

Then finish B3's three missing rules and re-add `seig` masking (N5) — that is the set of items that
decides whether the *second* channel you point this at works, which is the only real test of a
format-level decoder.

One architectural note, recorded rather than re-argued: v2 accepts 3.7 GB/h/viewer of egress as a
design decision. If that is deliberate, write the number and the per-IP cap into §B6 so it is a
decision rather than an oversight — and keep the `cloudflare-worker/` path sketched as the escape
hatch for the day one channel gets popular.
