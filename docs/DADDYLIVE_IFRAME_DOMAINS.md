# DaddyLive — Iframe Domains & Decoder Strategies

Reference for how DaddyLive-family streams are resolved, which embed domains
exist, and how each one has to be decoded.

Last audited: **2026-09-21** (400 live channels sampled from 781).

## The resolution chain

A DaddyLive channel is resolved in hops:

```
player page            https://dlstreams.st/stream/stream-<id>.php
  -> <iframe src>      embed domain (the "iframe domain")
    -> embed page      contains the stream, one of several structures
      -> manifest      .m3u8
```

The tricky part is the third step: **the embed domains do not share one
structure**. Four distinct shapes have been observed.

## Decoder strategies

| Strategy | Signal | Domains seen using it |
|---|---|---|
| `econfig` | inline `_econfig='...'` blob | `assetrage.net`, `*.dynproclaim.net` |
| `chain` | packed / obfuscated JS | generic |
| `direct` | plain `.m3u8` in page source | `play.matchli.st`, `streame.center` (2nd hop) |
| `json-hop` | page calls `api/player.php?id=N` → `{"url": "..."}` | `vertex.st` |
| `nested` | embed is only a wrapper iframe (may need 2 hops) | `w1.sportsonlinee.click`, `streame.center` |
| `atob-embed` | atob() → external embed provider | `rockystream.st` → `embed.st` |

### `_econfig` is the common case

The majority of traffic uses the `_econfig` obfuscation, decoded by
`DaddyLiveProvider.decodeEconfig`. Two distinct host families were confirmed to
decode with the **exact same routine**:

* `assetrage.net` (319 of 400 channels)
* `*.dynproclaim.net` (reached as a nested hop, e.g. from `w1.sportsonlinee.click`)

So when a new domain appears, **test it against the existing decoder first** — it
very often works unchanged.

## Escaped-URL pitfall

Some players place the manifest inside an inline JSON blob, so the query
separator arrives JS-escaped:

```
window.PP_CLAPPR_CONFIG={"srcBase":"https://hls.hockey.do/secure_hls.php?path=…%2Findex.m3u8\u0026e=…\u0026sig=…"}
```

A character class that excludes `\` stops at the first `\u0026`, keeping only the
first query parameter and **silently dropping `e` and `sig`** — the CDN then
answers `403 Forbidden`. Unescaped, the same URL returns a live playlist.
`_cleanManifestUrl()` normalises this on every extraction path.

## Known domains

Maintained in `src/data/iframe_domains.json` and kept fresh by
`scripts/selfheal-iframe-domains.js`.

### Terminal stream hosts

| Host | Referer that works |
|---|---|
| `*.7odxv0l067ka.net:8443` | `https://assetrage.net/` |
| `*.a737cozfwjmm.net:8443` | `https://assetrage.net/` |
| `edgestream[0-9]*.pro` | `https://streame.center/` |
| `hls.hockey.do` | `https://play.matchli.st/` — see caveat below |
| `*.dynproclaim.net` | `https://<node>.dynproclaim.net/` |

Note `edgestream*.pro` **rotates its node number** — `edgestream2.pro`,
`edgestream5.pro` and `edgestream7.pro` were all observed serving the same
family within one session. Always match the family, never one numbered host.

### Domain rotation

Several of these families rotate subdomains:
`<32-hex>.dynproclaim.net` (per channel), `edgestream<N>.pro`,
`<node>.a737cozfwjmm.net`. Match on the registrable suffix, not the full host.

## `hls.hockey.do` — known-flaky, deliberately left as-is

`hls.hockey.do` is the terminal host behind the `vertex.st` JSON-hop chain
(`vertex.st` → `play.matchli.st` → `hls.hockey.do`).

**Observed behaviour (2026-09-21):** the *identical* request returned, across
repeated attempts within minutes:

| Result | |
|---|---|
| `200` + `#EXTM3U`, 10 segments | served a perfectly live playlist at least once |
| `403 Forbidden` | repeated, later |
| `404` | repeated, later |
| connect timeout | occasionally |

This was tested with **every** plausible Referer — `https://play.matchli.st/`,
the full embed URL, `https://vertex.st/ch?id=91`, and none at all — and the
outcome did **not** correlate with the referer. DNS resolves normally
(`45.88.138.65`).

**Conclusion:** the URL *construction* is correct (proved by the 200/live
response through the same code path). The host itself is intermittently
available — most likely geo-gating or edge rate-limiting rather than a defect.

**Decision:** left as-is. No workaround applied. `vertex.st` channels will work
when `hls.hockey.do` is serving and fail otherwise. If it proves to be
geo-blocked from the deployment region, the fix would be routing that host
through the residential-proxy path, not a change to the decoder.

## Self-healing

`src/services/IframeDomainRegistry.js` + `scripts/selfheal-iframe-domains.js`
keep this knowledge current:

* the registry remembers, per host, **which strategy actually worked**;
* at runtime the provider consults it to try the known-good strategy first and
  records what it learns, so a newly-rotated domain self-registers on first use;
* the script re-runs the full discovery sweep and reports new/unknown domains,
  with `--update` to persist them into `src/data/iframe_domains.json`.

## Re-running the audit

```bash
# discovery sweep (read-only): finds iframe domains and tests decoder support
node scripts/selfheal-iframe-domains.js

# persist newly-discovered domains into the registry
node scripts/selfheal-iframe-domains.js --update
```
