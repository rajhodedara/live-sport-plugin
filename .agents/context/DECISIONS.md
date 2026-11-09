# DECISIONS.md — Settled Owner Decisions

> **Do not re-litigate these.** Each was decided by the repo owner with measurements behind it.
> An agent that "improves" one of these is reverting a deliberate choice, not fixing a bug.
> If you believe a decision is wrong, say so and cite the evidence — do not change behaviour.

---

## D1 — No bulk video bytes transit the VPS

**Rule:** the addon is a metadata and stream resolver, not a video CDN. Providers emit **direct CDN
URLs** with `behaviorHints.proxyHeaders` (`Referer` / `Origin` / `User-Agent`), or a **text** manifest
URL. Bulk relays (`/api/hlschunk`, `/api/fastmp4`, `/api/mp4proxy`, `/api/dash/segment.mp4`) must not
be in any new provider's output.

**Why:** outbound bandwidth saturation on a single VPS; the measured cost is in `StreamPolicy`'s
header comment. Byte traffic is offloaded to the Cloudflare Worker fleet instead.

**Allowed exceptions:** *text* playlists (`/api/manifest`, `/api/leaf/*`, `/api/soccerfull/manifest`,
`/api/manifest.mpd`) and **307 redirects** (`/api/hls/resource/:token/media.ts`, HMAC-verified).
These cost kilobytes, not gigabytes.

**Where enforced:** `src/services/StreamPolicy.js`, `src/streams.js:1604`, root `GEMINI.md`.

**Hardened by PR #61:** the classifier parses `pathname` only (never raw query text) and **unwraps
nested proxy URLs** through `/api/manifest*` up to 8 levels, so `/api/manifest?url=/api/dash/…` is
detected. Do not "simplify" it back to a regex over the whole URL — that was the bypass.

---

## D2 — Relayed ClearKey DASH is not offered at all

**Rule:** `StreamPolicy.isBlockedDashStream()` drops relayed `/api/dash` URLs *and* any stream with
`clearkey`, `format: 'dash'`, `type: *dash*`, or an `.mpd` target. Providers must not mint `/api/dash`.

**Why:** hls.js has no sample-level AES path and Media3 only decrypts whole segments, so the only way
to play ClearKey DASH is to fetch, decrypt, and re-serve **every segment** — measured at ~3.74 GB per
viewer-hour for 1080p. See `docs/CLEARKEY_ZERO_EGRESS_DECISION_2026-11-01.md` and
`docs/CLIENT_SIDE_CLEARKEY_FEASIBILITY_2026-11-04.md`.

**Not in scope:** `/api/manifest.mpd` and `/api/manifest?url=<mpd>` — those only relay manifest text
and are used by the 24/7 channel path.

**Evidence of intent:** `HEAD 92589e4` is `feat(dash): stop offering relayed ClearKey DASH`.

---

## D3 — The matches cache lives outside the bundle, pinned by env

**Rule:** the runtime catalog cache is `data/matches_cache.json`, resolved through
`MATCHES_CACHE_PATH` at **runtime**. Never write the cache inside `dist/`.

**Why:** ncc rewrites the source's `path.join(process.cwd(), 'data')` and drops the `data` segment, so
a bundle otherwise resolves its cache beside the bundle. A tracked or in-bundle cache is also wiped by
the deploy's `git reset --hard HEAD`. See `docs/MATCHES_CACHE_PATH_CUTOVER.md`.

**Where enforced:** `.github/workflows/deploy.yml` greps the staged bundle for `MATCHES_CACHE_PATH` and
**refuses to deploy** without it; `ecosystem.config.js` sets the env var.

---

## D4 — Memory ceiling is 1500 MB, per worker

**Rule:** `max_memory_restart: '1500M'` in `ecosystem.config.js`. **Do not lower it.**

**Why:** observed peak RSS is ~844 MB while the process was started with a 1.5 GB ceiling; the file
previously said `1300M`, so a plain reload would have lowered the ceiling *under* live peak usage.
Owner decision, 2026-10-26.

Related: `IMPIT_RECYCLE_MS` caps the native client's per-instance leak (~250 MB/h measured). The value
in the file (`240000`) is pinned to the observed runtime value on purpose — widening it is a memory
decision, not a side effect of a reload.

---

## D5 — Deploys are manual and never run `npm install` under traffic

**Rule:** `.github/workflows/deploy.yml` is `workflow_dispatch` only. It pulls → builds to `dist.next/`
→ verifies → renames into place → `pm2 reload`. If `package-lock.json` changed, it **refuses** and
prints the manual command instead.

**Why:** `impit` is a native NAPI addon that ncc bundles, so every worker maps it. `npm install`
re-extracts those binaries; a live worker faulting on a replaced backing file gets **SIGBUS** and dies
instantly with no JS stack. Every SIGBUS on the host landed 40–50 s after a push, during
`npm install`. Pushing to a branch must never touch production.

---

## D6 — `/api` is a private worker→resolver surface

**Rule:** the public `/api` proxy exposes **only** `/stream` and `/health`
(`PublicResolverApiGate`). Cache claims/writes/deletes/stats are worker-internal L2 operations and
must stay behind the gate.

**Why:** those endpoints mutate shared cache state; exposing them lets any client poison the cache.

---

## D7 — Verify identity, never trust an id

**Rule:** two candidates are the same event only when `_sameEventPre` / `isSameEvent` agrees. An
`idIndex` hit is a candidate, not a verdict. As of PR #61, **ids and aliases cannot override** a
date/session contradiction or a squad contradiction (`_squadsCompatible`), and `EventSquadIdentity`
adds gender / age / squad markers.

**Why:** providers reuse ids and emit unbounded alias arrays — one shipped entry accumulated 204
aliases and black-holed unrelated fixtures (`PROJECT.md`, Milestone 1). PR #61 additionally closed
the case where a women's, U21 or reserve fixture was merged into its senior counterpart.

**Deliberate consequence:** a missing qualifier is *not* evidence of the adult/first team, so the
same fixture listed twice with and without metadata can produce two cards. Duplication is preferred
over mixing sources. Do not "fix" the duplicate by relaxing the guard.

---

## D8 — Every external request goes through the guarded egress stack

**Rule:** no new `fetch`, `undici`, `impit`, or `curl` call may dial an external host directly.
Callers use `BaseProvider.proxyFetch` or `ProviderOutbound.{safeFetch,request,fetch,streamingFetch}`.
Validation happens **at connect time** (the DNS answers, not just a preflight lookup), redirects are
re-validated hop by hop, and the SOCKS tunnel receives a numeric address instead of a hostname.

**Why:** PR #59 (`draft/shared-outbound-guard`). The previous path let a provider or extractor reach
loopback / private / metadata addresses through DNS rebinding or a redirect, and every provider chose
its own proxy and TLS profile. Three behaviours are intentional, not bugs: a truncated body is an
error unless the caller passed `maxBodyBytes`; native capacity exhaustion surfaces as 503 instead of
being retried into a stampede; and a guard rejection is never retried against another fingerprint.

**Where enforced:** `src/services/{ProviderOutbound,SharedOutboundFetch,GuardedOutbound,GuardedEgressPolicy}.js`,
`src/impitClient.js` (`guardExternal`), `scripts/copy-guarded-worker-deps.js`.

---

## D9 — The resolver is a configured transport, not an assumed port

**Rule:** resolver-backed `/api` routes work only when one of these holds:

- `RESOLVER_TRANSPORT=systemd-unix-tls` — pinned unix socket + TLS with a pinned certificate; or
- `RESOLVER_TRUST_LEGACY_TCP=true` **and** no transport set — plaintext loopback, trust every local
  process.

Neither → resolver-dependent routes answer **503**, deliberately. An unknown transport value throws
at startup; there is no silent fallback.

**Why:** PR #59. A TCP listener on a known port proves reachability, not ownership — any local process
could occupy 7003 and receive requests. The old code "healed" that by `fuser -k`-ing the port, killing
whatever was there. Now a bind conflict (child exit `98`) marks the worker permanently degraded and
stops restarts instead.

**Where enforced:** `ResolverTrustPolicy`, `ResolverTransportConfig`, `ResolverConflictState`,
`src/resolverManager.js`. Operator notes: `docs/RESOLVER_PORT_SAFETY_DRAFT.md`,
`docs/RESOLVER_ISOLATED_TEST_PLAN.md`.

**Operational consequence:** the shared L2 resolve cache between PM2 workers is transport-gated too
(`StreamResolveCache.sharedResolver`). Without a transport each worker caches independently — correct,
just more duplicate upstream work.

---

## Adding a decision

Append `D10 — …` with **Rule / Why / Where enforced**. Cite a file, a measurement, or a dated owner
statement. Undated hand-waving is not a decision and will be re-opened.
