# ARCHITECTURE.md — Map of the Territory

> **Read this before opening any source file.** It is the mental index for every agent working in
> this repo. Line references were verified against `HEAD = 4bcf65e` (branch `stable`) on 2026-11-05,
> after PR #59 (`draft/shared-outbound-guard`) and PR #61 (`draft/provider-audit-resilience`) merged.
> Symbols and file paths are stable; **line numbers drift** — if one misses, grep the symbol name.

---

## 0. Mental model in one paragraph

One Node/Express process (`src/index.js`, port `7000`) serves a Stremio/Nuvio addon. It has **two hot
paths**. The *metadata* path builds JSON (`/manifest.json`, `/catalog/*`, `/meta/*`) from an
in-memory match list warmed by a scraper fan-out and persisted to one JSON file. The *stream* path
(`/stream/*.json`) fans out to ~20 provider scrapers, verifies and ranks results, then emits **direct
CDN URLs** wrapped in `behaviorHints.proxyHeaders` — or a *text-only* playlist proxy URL on this
server. Two hard boundaries sit underneath: **all external HTTP goes through one guarded egress
stack** (connect-time DNS validation, pinned TLS profiles, native → undici fallback), and **the
stream resolver is no longer a plain TCP child** — it is either a systemd-activated unix/TLS service
with a pinned certificate, or an explicitly-trusted legacy loopback child, or resolver-backed `/api`
routes answer **503**. Bulk video bytes are not supposed to transit the VPS: that is the Cloudflare
Worker fleet's job.

**There is no database.** All state is JSON files on disk plus in-process maps.

---

## 1. System topology

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ L0  Client: Stremio / Nuvio player (hls.js, ExoPlayer, VLC …)                │
│     Plays video DIRECTLY from upstream CDN. Only talks to L2 for JSON +      │
│     playlists (text), never for media bytes.                                 │
└───────────────┬──────────────────────────────────────────┬───────────────────┘
                │ /manifest.json /catalog /meta /stream      │ .m3u8 / .ts
                v                                            v
┌───────────────────────────────┐              ┌───────────────────────────────┐
│ L1  Cloudflare Workers        │              │ L2  Node addon process        │
│ cloudflare-worker/index.js    │              │ src/index.js   :7000          │
│ deployed as nuvio-proxy1..7   │              │ Express + stremio-addon-sdk   │
│ byte relay, 42-byte strip     │              │ awilix DI, 20+ providers      │
└───────────────────────────────┘              └───────┬───────────────┬───────┘
                                                       │               │
                              ┌────────────────────────┘               │
                              v                                        v
              ┌──────────────────────────────┐        ┌──────────────────────────────┐
              │ L2a  Guarded egress stack    │        │ L3  Stream resolver          │
              │ src/services/…               │        │ resolver/src/server.js       │
              │ ProviderOutbound             │        │ mode A: systemd unix + TLS   │
              │  → SharedOutboundFetch       │        │   (pinned certificate)       │
              │    → NativeGuardedFetch      │        │ mode B: loopback TCP :7003   │
              │      (slot pool, max 4)      │        │   (explicit legacy opt-in)   │
              │    → GuardedOutbound         │        │ mode C: none → /api = 503    │
              │      (undici, guarded DNS)   │        │ embed.st handshake,          │
              │ GuardedEgressPolicy (proxy)  │        │ lock.wasm decrypt, curl relay│
              └───────────────┬──────────────┘        └───────────────┬──────────────┘
                              │                                       │
                              v                                       v
                      ┌────────────────────┐              ┌──────────────────────┐
                      │ L4  upstreams      │              │ L4  streamed.pk /    │
                      │ providers, CDNs    │              │ embed.st / tiktokcdn │
                      └────────────────────┘              └──────────────────────┘
```

| Layer | Lives in | Runtime | Owns |
|---|---|---|---|
| L1 | `cloudflare-worker/index.js` (single 547-line file) | Cloudflare Workers, `compatibility-date 2024-01-01` | Byte relay, cloaking-prefix stripping, per-worker budget caps |
| L2 | `src/**` | Node ≥ 22, CommonJS, Express 4 | Protocol surface, aggregation, ranking, playlist rewriting |
| L2a | `src/services/{ProviderOutbound,SharedOutboundFetch,GuardedOutbound,…}` | Node 22, undici 8 | **Every** external request: URL/DNS validation, egress proxy selection, native/undici transport, redirect policy |
| L3 | `resolver/src/**` | Node ≥ 22, **ESM**, `curl` on PATH | embed.st `/fetch` handshake, WASM decrypt, CDN relay |
| L4 | remote | — | Scraped HTML/JSON APIs and video CDNs |

`nuvio-proxy-2/` (an unrelated TypeScript Workers project) **was deleted at `d3bcc5f`**. If you see it
referenced in old notes or in `package.json`'s `testPathIgnorePatterns`, that pattern is now inert.
It is **not part of the addon build** and is excluded from Jest. Do not "fix" it while working on L2.

---

## 2. Request lifecycle

### 2.1 Boot sequence — `src/index.js`

In order (each step is load-bearing; reordering breaks routes):

1. `dotenv` loads `.env` — **first executable statement**, before any local `require`.
2. Requires, incl. `./container` and `./resolverManager`. **Import side effects**: the container
   eagerly builds `asValue` singletons (`streamResolveCache` receives `timingRelations` +
   `sharedResolver: resolverTransport`); `resolverManager` decides whether to spawn a resolver child
   at import time (see §2.5).
3. Global `unhandledRejection` / `uncaughtException` handlers (`:38`, `:44`).
4. Handlers bound onto the SDK builder: catalog, meta, stream.
5. `express()`; `app.set('trust proxy', true)`; `cors()`.
6. Static roots: `/posters`, then `public/`, `src/public`, `cwd/public`.
7. Landing/config/donate HTML: `/`, `/configure`, `/:config/configure`, `/donate`.
8. `/collections.json` (Nuvio Collections export).
9. **Internal `/api/*` JSON routes**: `/api/collections/download`, `/api/server-info`,
   `/api/options`, `/api/provider-health`, `/api/worker-budget`, `/api/matches`.
10. Artwork pipeline: `/img/collection/:sport`, `/img/placeholder`, `/img/date`,
    `/img/sport/:sport`, `/img/match`, `/img/badge`, `/img`.
11. **Playback routers mounted at root** (`:845-851`): `streamProxy`, `manifest`, `leafManifest`,
    `hlsResource`, `embed`, `dash`. Each router declares its own `/api/...` paths.
12. **Four `/api` layers, in this exact order** (`:854-860`):
    1. `PublicResolverApiGate` — allowlist `/stream` + `/health`, 404 everything else (`:854`)
    2. `ResolverTrustPolicy` gate — **503** unless a resolver transport is configured or legacy TCP
       is explicitly trusted (`:855`)
    3. `ResolverConflictGate` — **503** once a resolver port conflict has been observed (`:858`)
    4. `createProxyMiddleware` → `127.0.0.1:${RESOLVER_PORT}/api` (`:860`)
13. Universal JSON base-URL rewriter (wraps `res.write`/`res.end`, addon paths only, `:911`).
14. `GET /:config?/manifest.json` override (`:1061`) — shadows the SDK's own manifest.
15. Config-segment rewrite middleware (base64url → URL-encoded JSON; `rf`/`lg`/`ws`, `:1213`).
16. Direct handler for `nuvio_sports_replays_*` collection sub-catalogs.
17. **SDK router**: `app.use(getRouter(builder.getInterface()))` (`:1268`).
18. `/watch` router, then `/health` router (`:1270-1271`).
19. Cron start **only when `workerOffset === 0`** (`:1275`).
20. `app.listen(PORT, BIND_HOST)` (`:1280`), `BIND_HOST = HOST || IP || '0.0.0.0'`.

"Cluster mode" is **external PM2** (`ecosystem.config.js`: `instances: 2`, `exec_mode: 'cluster'`).
`src/index.js` contains no `cluster` module. `workerOffset` =
`NODE_APP_INSTANCE || pm_id || "0"`, and it gates resolver spawn and cron.

### 2.2 Metadata read path — `/catalog/:type/:id.json`

```
SDK router (index.js:1268)
  └─ handleCatalog            src/catalog.js:975   ← cached wrapper (file unchanged by PR 59/61)
       └─ handleCatalogUncached          :1402
            ├─ handleReplayCatalog       :1256   (replay ids/hubs)
            ├─ buildReplayHubMeta        :1013
            └─ getMatchesReadOnly()  src/services/CacheService.js
                 └─ aggregate → filter by config (teams/sports/languages/replayFilter)
                      → sort → slice(100) → mapMatchToMetaPreview (:445)
```

### 2.3 Stream resolve path — `/stream/:type/:id.json`

```
index.js defineStreamHandler
  └─ handleStream                src/streams.js:1174
       ├─ selectSources(matchSources, config, match)   :130
       ├─ StreamResolveCache.getOrCreate(key, mint)
       │    └─ mintVerifiedSources(src, match, …)      :925
       │         ├─ resolveSource (withRetry)          :301
       │         ├─ dispatchToProvider(sourceName,…)    :199
       │         └─ verifyStreams (probes)             :663
       ├─ dedupe
       ├─ StreamPolicy.isBlockedDashStream filter       services/StreamPolicy.js
       ├─ compareStreams / ranking
       └─ BASE_URL minting: s.url = manifestPlaybackUrl(s.url, BASE_URL)  :1604
returns { streams, cacheMaxAge: 30 }
```

Provider fetches inside `resolveSource` land in the guarded egress stack (§3) — a provider never
dials the network itself.

### 2.4 Playback path — after the client receives a URL

- **Direct CDN URL** (preferred): player fetches video upstream; the addon only supplied
  `behaviorHints.proxyHeaders` (`Referer`, `Origin`, `User-Agent`).
- **Text playlist proxy**: `/api/manifest?url=…` fetches the upstream playlist through the guarded
  stack (`guardExternal: true`), remints tokens, rewrites child URIs, returns **text**.
- **307 redirect**: `/api/hls/resource/:token/media.ts` verifies an HMAC and 307s to the CDN.
- **Cloudflare Worker relay**: URLs shaped for `CF_PROXY_URL` are fetched by L1, not L2.

### 2.5 Resolver transport and shutdown

There are **three** resolver modes, and they change how the addon behaves at runtime:

| Mode | Trigger | Effect |
|---|---|---|
| **Pinned unix + TLS** | `RESOLVER_TRANSPORT=systemd-unix-tls` | `ResolverTransportConfig` reads the pinned certificate (`RESOLVER_CERT_DIR`, `RESOLVER_TLS_SERVERNAME`) and builds unix-socket TLS clients (`RESOLVER_SOCKET_PATH`). `resolverManager` **never probes, spawns, or adopts** a TCP listener. `/api` routing allowed. |
| **Legacy loopback TCP** | no `RESOLVER_TRANSPORT` **and** `RESOLVER_TRUST_LEGACY_TCP=true` | The child is spawned on `127.0.0.1:${RESOLVER_PORT}` (default 7003) exactly as before. Plaintext, unauthenticated — trust every local process. |
| **None** (default) | neither set | No spawn. `/api` resolver-dependent routes answer **503**. Local provider resolution and the local resolve cache keep working. |

An unknown `RESOLVER_TRANSPORT` value throws at startup — there is no silent fallback.

`resolverManager` behaviour that changed with PR #59:

- A health response on the port is **not** ownership. It now logs "resolver ownership is unverified"
  instead of claiming the resolver is healthy.
- It **no longer runs `fuser -k`** on the port. If the child exits with code `98` (EADDRINUSE),
  `ResolverConflictState.markConflict()` is called: this worker's `/api` returns 503 **permanently**
  (until restart), and restarts stop. It deliberately does not kill the other process.
- Shutdown is now **bounded and real**: `SIGINT`/`SIGTERM` → `shutdownOnSignal()` closes the native
  pool, waits for the owned resolver child to exit, and closes the resolver transport, each capped at
  3 s (`NativeShutdown.closeNativePool`). There is still **no HTTP server drain** — in-flight
  proxying is cut.

`ResolverConflictState` is a `globalThis` symbol singleton: per-process, not shared across PM2
workers, fails closed.

---

## 3. Guarded egress — the only way out

This is the biggest post-merge change. **Every external request funnels through it.** If you add a
provider, extractor, or route that fetches a URL, you go through this stack or you are bypassing the
security boundary.

```
provider / route / extractor
  └─ BaseProvider.proxyFetch          → ProviderOutbound.safeFetch
     or ProviderOutbound.{request,fetch,streamingFetch}
        └─ impitClient.safeFetch(url, { guardExternal: true })
             └─ SharedOutboundFetch.fetchSharedOutbound(url, opts)
                  ├─ selectGuardedEgress(url)      → { proxyUrl, profile }
                  ├─ providerRequestHeaders(url)   → normalised header pairs
                  ├─ NativeGuardedFetch (primary)  → NativeGuardedSlot pool (MAX_SLOTS = 4)
                  │    or IsolatedNativePoolCandidate when GUARDED_NATIVE_ISOLATION=true
                  │       (child process: services/isolated-native-child.cjs)
                  └─ GuardedOutbound.guardedFetch  (undici fallback, transport:'undici' forces it)
                       └─ createGuardedLookup → asserts URL **and every DNS answer** at connect
```

### 3.1 `SharedOutboundFetch` — the policy front door

Validates its own inputs and throws `RangeError` on violation:

| Option | Allowed | Default |
|---|---|---|
| `timeoutMs` | `1 … 30000` | 15000 |
| `maxBodyBytes` | `1 … 8 MiB` | 1 MiB |
| `attempts` | `1 … 3` | 3 |

Behaviour worth knowing before you touch it:

- A **truncated body is an error** (`ERR_OUTBOUND_BODY_LIMIT`) unless the caller passed an explicit
  `maxBodyBytes`. Prefix sampling must be explicit; a default cap must not silently turn a large
  playlist into valid-looking text.
- `403` from the native transport: if a `proxyUrl` was selected the response is returned as-is;
  otherwise it retries through the undici fallback, and a **guard rejection is not retried**.
- Native capacity errors (`ERR_NATIVE_POOL_*` / `ERR_NATIVE_SLOT_*`) become
  `ERR_OUTBOUND_CAPACITY` with `statusCode: 503` and are fatal — they are not retried.
- Non-retryable: `isFatal`, `ERR_OUTBOUND_BLOCKED`, `TypeError`, `RangeError`.

### 3.2 `GuardedOutbound` — validation that survives DNS rebinding

- `assertOutboundUrl` rejects credentials-in-URL and delegates to `OutboundUrlGuard.checkOutboundUrl`
  (private/loopback/metadata ranges). Failure is `OutboundBlockedError`, `statusCode: 403`, `isFatal`.
- `createGuardedLookup` re-validates **inside the socket connector**, so a preflight DNS answer that
  changes before connect cannot smuggle a private address. IP literals are validated too.
- Redirects are manual (`maxRedirections: 0`), capped at 5 hops, re-validated each hop; cross-origin
  hops drop sensitive headers (`RedirectHeaderPolicy.filterRedirectHeaders`) and a 303 drops the body.
- SOCKS5 goes through `GuardedSocksDispatcher`: it validates the tunnel target and connects to the
  **numeric address** (undici 8.10 would otherwise send the hostname to the proxy). Max 32 concurrent
  proxy dispatchers; the hook is version-sensitive and covered by real-handshake regressions.
- External, caller-controlled URLs only. Internal worker/resolver loopback calls keep their own
  transport and never enter this policy.

### 3.3 `GuardedEgressPolicy` — which proxy, which TLS profile

| Target | Proxy chain | Profile |
|---|---|---|
| Leaf (`sports.highfly.to`, `papacito.cfd` except `w1.*`) | `LEAF_PROXY_URL` → `WARP_PROXY_URL` → `DAMITV_PROXY_URL` | `chrome` |
| DamiTV (`damitv.st`, incl. subdomains) | `WARP_PROXY_URL` → `DAMITV_PROXY_URL` | `vanilla` |
| everything else | none (direct) | `chrome` |

`options.proxyUrl` (including an explicit `null`) overrides the derived choice for that request and
its whole redirect chain. `validateLeafManifestUrl` separately admits only `https` `*.papacito.cfd`
with no credentials/port and ≤16 KiB.

### 3.4 `ProviderOutbound` — the compatibility facade

Metadata extractors written against `undici`/`fetch` keep working, but all I/O re-enters the guarded
path with `guardExternal: true`:

| Export | Shape |
|---|---|
| `safeFetch` | guarded fetch → `{ ok, status, headers, text, json, arrayBuffer, bodyTruncated }` |
| `request` | undici-like `{ statusCode, headers, body }`; body has `.text/.json/.arrayBuffer/.dump` |
| `fetch` | WHATWG `Response` clone with `url` and `bodyTruncated` |
| `fetchUndici` | `fetch` with `transport: 'undici'` (skips the native transport) |
| `streamingFetch` | `GuardedOutbound.guardedRequest` → streamed `Response` (use for large bodies) |

Caller-supplied dispatchers cannot supply an alternate dial — that is the point.

---

## 4. State & data flow — where canonical state lives

| State | Location | Lifetime | Notes |
|---|---|---|---|
| Match list (canonical) | `CacheService` in-process arrays + `matches_cache.json` | Process + disk | `getMatches()` returns **clones**; `getMatchesReadOnly()` is the hot read path. |
| Disk cache file | `data/matches_cache.json`, `schemaVersion: 4` | Disk | ~14 MB / ~16k matches at time of writing. Temp file + `renameSync` (atomic). `MATCHES_CACHE_PATH` overrides. **Gitignored.** |
| Match indices | `MatchAggregator` per sync: `idIndex`, `channelNormIndex`, `tokenIndex`, `categoryBuckets` | Rebuilt per sync | **Derived, never authoritative.** |
| Squad/gender/age markers | `_precompute` (`EventSquadIdentity.eventSquadIdentity`) | Rebuilt per sync | Constrains identity — see §6.10. |
| Team logos | `data/team_logos_cache.json` + `src/data/team_logos_seed.json` | Disk | Seed tracked; cache gitignored. |
| Iframe domain KB | `src/data/iframe_domains.json` + `IframeDomainRegistry` (`asValue`) | Process + seed | Self-healing for the process lifetime only. |
| Stream resolve results | `StreamResolveCache` (in-process LRU + single-flight) | Minutes | TTL from URL token expiry. **Shared L2 only when a resolver transport exists** (or legacy TCP is trusted) — otherwise per-worker. |
| Native transport slots | `NativeGuardedSlot` pool, `MAX_SLOTS = 4` | Process | Capacity exhaustion → `ERR_OUTBOUND_CAPACITY` (503). |
| Resolver conflict flag | `ResolverConflictState` (`globalThis` symbol) | Process, permanent | Set on child exit 98; `/api` stays 503. |
| Timing telemetry | `TimingRuntime.relations` | Process | **`null` unless `STREAM_TIMING_EXPERIMENT=true`.** |
| Static catalog data | `src/data/*.json` (`vavoo_channels.json` 1.95 MB, `tv_logos_map.json` 1.23 MB, …) | Tracked | Shipped assets, not caches. |

### Write path (sync)

```
CronService (0 */4 * * *)  →  MatchAggregator.syncMatches()      :1063
    └─ _fetchProviderMatches(provider, shouldRecord)              :1040
    └─ _precompute(entity)                                        :683  ← fold once, build squad markers
    └─ build idIndex → channelNormIndex → tokenIndex → categoryBuckets
    └─ _sameEventPre(p1, p2)                                      :816  ← identity verification
    └─ mergeMatches(primary, secondary)                           :976
    └─ carry-forward of unseen-but-recent matches (CARRY_FORWARD_MAX, default 600)
    └─ CacheService.setMatches(matches)
         └─ _rebuildIndices() → _saveDiskCache() (temp + rename)
```

**Identity rule:** a match id is *not* proof of identity. `_sameEventPre` verifies, and as of PR #61
**ids and aliases cannot bypass** a date/session mismatch or a squad contradiction (`_squadsCompatible`,
`:352`). Missing gender/age/squad qualifiers are deliberately *not* treated as "adult/first team" —
that can produce duplicate cards, and duplication is preferred over cross-source mixing.

---

## 5. Route surface

### Protocol (client-facing)

| Method | Path | Handler |
|---|---|---|
| GET | `/manifest.json`, `/:config/manifest.json` | `src/index.js:1061` (override; falls through to SDK when config is undecodable) |
| GET | `/catalog/:type/:id.json` (+`/:extra.json`, `/:config/…`) | `src/catalog.js` `handleCatalog`; `nuvio_sports_replays_*` handled directly in `index.js` |
| GET | `/meta/:type/:id.json` | `src/catalog.js` `handleMeta` |
| GET | `/stream/:type/:id.json` | `src/streams.js` `handleStream` |

### Internal — media-carrying (⚠ read §6.4 before touching)

| Path | File | Carries |
|---|---|---|
| `/api/fastmp4` | `routes/streamProxy.js` | **Video bytes** (parallel-range MP4) |
| `/api/mp4proxy` | `routes/streamProxy.js` | **Video bytes** (passthrough) |
| `/api/hlschunk` | `routes/streamProxy.js` | **Video bytes** (cloaked HLS segments) |
| `/api/dash/init.mp4`, `/api/dash/segment.mp4` | `routes/dash.js` | **Video bytes** — token-gated, and `StreamPolicy` drops these URLs |

### Internal — text / redirect only

| Path | File | Carries |
|---|---|---|
| `/api/manifest`, `/api/manifest.m3u8` | `routes/manifest.js` | Playlist **text** (guarded fetch, `hlsua` selects UA) |
| `/api/manifest.mpd` | `routes/manifest.js` | MPD **text** (BaseURL injected) |
| `/api/leaf/manifest.m3u8`, `/api/leaf/live.m3u8`, `/api/leaf/m3u8/*` | `routes/leafManifest.js` | Playlist **text** |
| `/api/soccerfull/manifest` | `routes/soccerFullManifest.js` | Playlist **text** |
| `/api/hls/resource/:token/media.ts` | `routes/hlsResource.js` | **307 redirect** after HMAC verification |
| `/api/dash/*.m3u8` | `routes/dash.js` | Playlist **text** from a signed payload |
| `/api/proxy-embed` | `routes/embed.js` | Embed **HTML**, `ALLOWED_EMBED_DOMAINS` allowlist |
| `/api/clearkey/license`, `/api/license` | `routes/manifest.js` | ClearKey licence passthrough |
| `/watch` | `routes/watch.js` | Player HTML page |
| `/health` | `routes/health.js` | Status JSON |

Then, for anything left: `PublicResolverApiGate` (allowlist) → `ResolverTrustPolicy` (503 unless
transport configured) → `ResolverConflictGate` (503 on conflict) → proxy to the resolver.

---

## 6. Deliberate patterns & gotchas

### 6.1 Anything under `/api` must be mounted **above** the gates (`:854`)
Routers are mounted `:845-851`; the four `/api` layers start at `:854`. A route registered after them
never runs. `src/index.js` says so at `:218-220`. That is why `/api/options` lives in `index.js`.

### 6.2 Env is read at module load — `BASE_URL` is a frozen `const`
`src/config.js` computes `PORT`, `STREAM_BASE_URL`, `BASE_URL` once. Mutating `process.env.ADDON_URL`
at runtime does nothing. `ADDON_URL` also short-circuits the request-derived host for every caller.

### 6.3 Resolver-dependent `/api` routes are **503 by default**
This is the single most surprising post-merge behaviour. With neither `RESOLVER_TRANSPORT` nor
`RESOLVER_TRUST_LEGACY_TCP=true`, the addon boots fine, catalogs work, and every resolver-backed
`/api` path returns 503. If someone reports "streams resolve but nothing plays", check the transport
mode **before** debugging providers. See `DECISIONS.md` D9.

### 6.4 The Zero Server Bandwidth Bleed policy
`src/streams.js:1604` mints URLs from `BASE_URL`. Emit a direct CDN URL + `proxyHeaders`, a *text*
manifest URL, or a 307. Never route segments through `/api/hlschunk`, `/api/fastmp4`,
`/api/mp4proxy`, or `/api/dash/segment.mp4`. `notWebReady` is a client hint, not a routing decision.

### 6.5 DASH is policy-blocked, and the check now unwraps nesting
`StreamPolicy.isBlockedDashStream()` drops relayed `/api/dash` URLs and any `clearkey` /
`format:'dash'` / `.mpd` stream. Since PR #61 it **parses pathnames** (never raw query text) and
follows `?url=` through `/api/manifest*` up to **8** levels, so
`/api/manifest?url=/api/dash/segment.mp4` is caught. `query`-string tricks that used to look inert now
resolve to the real target. ClearKey DASH would cost ~3.74 GB/viewer-hour to relay
(`docs/CLEARKEY_ZERO_EGRESS_DECISION_2026-11-01.md`). Do not re-enable.

### 6.6 Never call `fetch`/`undici`/`impit` directly
Go through `ProviderOutbound` (or `BaseProvider.proxyFetch`). Direct calls skip URL + DNS validation,
the egress proxy selection, and the native slot pool — they are the exact bypasses PR #59 closed.
`impitClient.safeFetch` without `guardExternal: true` is the *legacy* path; do not add new callers.

### 6.7 The build copies guarded services by name
`scripts/copy-guarded-worker-deps.js` copies 17 fixed service files plus
`services/isolated-native-child.cjs` and `impitClient.js` into the bundle. These are loaded by path /
spawned at runtime, so ncc cannot trace them. **Adding a guarded service that is dynamically required
or spawned means adding it to that list** — otherwise it works in `npm run dev` and fails only in
`dist/`.

### 6.8 The JSON rewriter buffers whole addon bodies
`src/index.js:911` replaces `res.write`/`res.end` and concatenates every chunk before deciding to
rewrite. It matches only `/manifest.json`, `/catalog/`, `/meta/`, `/stream/`. Generated **SVG** never
passes through it (`src/services/EmbedBase.js` documents the blank-logo failure) — embed absolute URLs.

### 6.9 Requiring `src/index.js` can start a child process
`src/index.js` requires `./resolverManager`, whose module body may spawn the resolver (legacy mode).
Any test that requires the app can boot a sidecar. Construct services directly instead.

### 6.10 `match.date` is polymorphic — confirm the shape before you touch it
`MatchEntity` normalises `date` to an **epoch-millisecond string** (`parseTimezone(...).toString()`),
and `src/streams.js:1788` relies on it (`Number(match.date)`). But `MatchAggregator` writes ISO
`YYYY-MM-DD` for standalone replays with no date, and `src/catalog.js` date hubs group on
`m.date.slice(0, 10)` under a `// Group by date (YYYY-MM-DD)` comment. `Number('2026-11-04')` is `NaN`;
the first 10 chars of an epoch-ms string are not a date. Establish which shape reaches your line, and
test both. Also: `this_week` means 2–7 days ago and excludes today.

### 6.11 Provider fan-out is lazy and gated
`selectSources` filters by request config (`liveSources` / `replaySources` / legacy `sources`), then
`dispatchToProvider` resolves through the container. A registered provider absent from the match's
`sources` is never called. `circuitBreaker` and `providerHealthService` sit in that path.

### 6.12 Motor-classification is regex territory
`_extractMotorsportSession` (`:585`) and `_extractMotorsportSeries` (`:581`) decide
`p1|p2|p3|p4|sprint|qualifying|race` and the series. Hyphen-splitting a race title can fabricate teams
and overwrite a Grand Prix title. Change these only with `tests/adversarialMotorsportVerification.test.js`
and `tests/motorsportSessionIsolation.test.js` green.

### 6.13 `aliasIds` can black-hole a match
Alias arrays have no length bound; `PROJECT.md` records a shipped entry with 204 aliases. Prefer a
verified `_sameEventPre` result over an index hit — and note ids/aliases no longer override squad or
date/session contradictions.

### 6.14 Timing telemetry is opt-in and not production-shaped
`STREAM_TIMING_EXPERIMENT=true` creates a `globalThis` singleton with `maxEvents: 100000`, writes
`stream_timing` rows and prints a summary on exit. Off by default (`relations === null`). The code
comment says it is "not yet suitable for load tests" — do not enable it to diagnose a production
incident.

### 6.15 The ncc bundle rewrites `path.join(process.cwd(), 'data')`
Documented in `ecosystem.config.js`; `deploy.yml` greps the staged bundle for `MATCHES_CACHE_PATH` and
refuses to deploy without it, then primes `data/matches_cache.json` from the bundle on a cold host.
Without that env var a bundle resolves its cache to `<bundle dir>/matches_cache.json`.

### 6.16 Boot-time behaviour that looks like a bug
- `getRequestBaseUrl` closes over `BASE_URL` declared *later* in `src/config.js` — safe only because it
  is never called during module evaluation.
- `app.set('trust proxy', true)` makes `req.ip` caller-controlled; "local" is decided by
  `isLocalDirectRequest` requiring **no** forwarding header plus a private/loopback peer, so
  `/api/matches` 403s anything arriving through the reverse proxy.
- `resolverManager.shutdownOnSignal()` calls `container.resolve('browserSniffer')` inside a `try/catch`;
  no such registration exists in `src/container.js`. Harmless stale reference.
- In pinned mode, an HTTP response on `127.0.0.1:7003` may belong to *something else*. Nothing adopts
  it, and nothing kills it.

---

## 7. Verified commands

Confirmed in this workspace on 2026-11-05. **`npx jest` does not resolve the local binary here** —
use the `npm test` forms.

| Purpose | Command | Status |
|---|---|---|
| Install | `npm install` | declared |
| Build (staged, deploy shape) | `npm run build` → `dist.next/` | declared; now also runs `copy-guarded-worker-deps` |
| Build (in place, Docker) | `npm run build:local` → `dist/` | declared |
| Run production | `npm start` (`node dist/index.js`) | needs `dist/` |
| Run from source | `npm run dev` | declared |
| Full test suite | `npm test` | **284** suites discovered |
| **One test file** | `npm test -- tests/localRequest.test.js` | ✅ 33/33 passed |
| One new guarded suite | `npm test -- tests/sharedOutboundPolicy.test.js` | ✅ 13/13 passed |
| Syntax-check a file | `node --check src/index.js` | ✅ passed |
| Resolver standalone | `cd resolver && npm start` | port from `PORT` |
| Deploy | GitHub Actions → *Deploy to VPS* (`workflow_dispatch`) | manual only |

**Not configured — do not invent them:** no `lint`, `format`, or `typecheck` script, and no
ESLint/Prettier config at root. `tsconfig.json` exists but nothing invokes it. CI runs **no tests and
no lint** — it builds on the VPS and gates on `node --check dist.next/index.js` plus a
`MATCHES_CACHE_PATH` grep. Jest config is `testPathIgnorePatterns` + `testMatch`
(`**/?(*.)+(spec|test).[tj]s?(x)`); no `setupFiles`, default Node environment.

---

## 8. Subsystem routing table

| Directory | Purpose | Local rules |
|---|---|---|
| `src/` (root files) | Entry, DI, manifest, catalog, streams, config | this file |
| `src/providers/` | 20+ scrapers (`BaseProvider` contract) + WASM decryptors | `src/providers/GEMINI.md` |
| `src/services/` | Aggregation, **guarded egress**, caching, rewriting, artwork, timing | `src/services/GEMINI.md` |
| `src/routes/` | HTTP proxy/rewrite layer (byte vs text) | `src/routes/GEMINI.md` |
| `src/domain/` | `MatchEntity`, `StreamEntity` | `src/services/GEMINI.md` |
| `src/data/` | Tracked seed/asset JSON — **not** runtime cache | `src/services/GEMINI.md` |
| `tests/` | 284 Jest suites | `tests/GEMINI.md` |
| `scripts/` | Ops, benchmarks, probes, **build copy helper** | `scripts/GEMINI.md` |
| `resolver/` | ESM subprocess/service: handshake + WASM + curl | `resolver/GEMINI.md` |
| `cloudflare-worker/` | Single-file Worker deployed 7× | `cloudflare-worker/GEMINI.md` |
| ~~`nuvio-proxy-2/`~~ | Removed at `d3bcc5f` — do not recreate it | — |
| `docs/` | Decision records + resolver safety drafts | — |

### Services by cluster (start here, not at the file listing)

| Cluster | Members |
|---|---|
| **Guarded egress** | `ProviderOutbound`, `SharedOutboundFetch`, `GuardedOutbound`, `GuardedEgressPolicy`, `GuardedCurlClient`, `OutboundUrlGuard`, `RedirectHeaderPolicy`, `ProviderRequestHeaders`, `NativeGuardedFetch`, `NativeGuardedSlot`, `NativeExclusiveSlot`, `NativeSocksConnection`, `IsolatedNativePoolCandidate`, `NativeShutdown`, `ManifestUserAgent` |
| **Resolver transport** | `ResolverTransportConfig`, `ResolverTransportRuntime`, `ResolverUnixClients`, `ResolverPinnedClients`, `ResolverPinnedIdentity`, `ResolverPublicIdentity`, `ResolverIdentityProvision`, `ResolverTrustPolicy`, `ResolverConflictGate`, `ResolverConflictState`, `ResolverProxyEvents` |
| **Identity / aggregation** | `MatchAggregator`, `EventSquadIdentity`, `CacheService`, `TeamNameExtractor`, `BroadcasterMatchService`, `ChannelIdentityService` |
| **Stream path** | `StreamResolveCache`, `StreamPolicy`, `HlsRewriteService`, `DashToHlsService`, `SegmentLengthService`, `ByteRangeSigner`, `M3U8ParserService`, `StreamScoringService` |
| **Telemetry (opt-in)** | `TimingRuntime`, `TimingContext`, `TimingRelations`, `TimingStatistics`, `TimingOutput`, `TimingSnapshotTimer`, `NativeTiming` |
| **Ops** | `CronService`, `CircuitBreakerService`, `ProviderHealthService`, `WorkerBudget`, `retry` |

---

## 9. Where to look for a task

| If the task is… | Open first |
|---|---|
| A catalog is empty / mis-sorted / wrong sport | `src/catalog.js` `handleCatalog`, then `MatchAggregator._precompute` |
| A match merged with the wrong event (incl. women's/U21/reserves) | `MatchAggregator._sameEventPre` (`:816`), `_squadsCompatible` (`:352`), `EventSquadIdentity` |
| A provider returns nothing | that provider file → `BaseProvider` → `dispatchToProvider` (`streams.js:199`) |
| A request is blocked / 403 / "OutboundBlockedError" | `GuardedOutbound.assertOutboundUrl`, `OutboundUrlGuard`, `GuardedEgressPolicy` |
| A proxy is not being used | `GuardedEgressPolicy.selectGuardedEgress` (`LEAF_PROXY_URL` / `WARP_PROXY_URL` / `DAMITV_PROXY_URL`) |
| Native transport is saturated | `NativeGuardedSlot` (`MAX_SLOTS = 4`), `ERR_OUTBOUND_CAPACITY`, `/api/provider-health` |
| Streams resolve but nothing plays | resolver transport mode (§6.3) → `routes/manifest.js` → `proxyHeaders` |
| A stream 403s / token expired | `routes/manifest.js` remint path, `StreamResolveCache._ttlFor` |
| `/api` suddenly 503 | `ResolverTrustPolicy` (not configured) or `ResolverConflictState` (port conflict) |
| Playback URL points at the wrong host | `src/config.js` `BASE_URL` / `ADDON_URL`; `streams.js:1604` |
| An image/badge is blank | `ImageService` / `EmbedBase` (SVG bypasses the JSON rewriter) |
| Memory climbs or the box restarts | native slot pool, `IMPIT_RECYCLE_MS`, `WorkerBudget`, `/health` |
| Adding a provider | `src/providers/GEMINI.md` |
| A DASH stream was dropped | `StreamPolicy` — intentional (§6.5) |
| Build works locally, fails in `dist/` | `scripts/copy-guarded-worker-deps.js` (§6.7) |

---

## 10. Known stale / legacy artefacts

From earlier agent-framework runs; **not deleted** (removal is an owner decision):

- `PROJECT.md` — milestone tables marked `IN_PROGRESS` from a previous framework.
- `.agents/teamwork/`, `.agents/teamwork_preview_*`, `.agents/sentinel/` — scaffolding output.
- `src/api.js` — legacy self-caching module; nothing on the Express path requires it.
- `src/providers/yaml/` — only `sample.yml.example`, so **zero YAML providers load**.
- `src/providers/StreamicProvider.js` — exists but is **never registered** in `src/container.js`.
- `impitClient.safeFetch` without `guardExternal` — the legacy unguarded path, retained for callers
  that are not external-URL driven. New code should not use it.

---

*Generated by the Antigravity environment bootstrap; refreshed after PR #59 + #61. If `HEAD` has moved
far past `4bcf65e`, re-verify §2.1 anchor lines and §5 route line numbers before trusting them.*
