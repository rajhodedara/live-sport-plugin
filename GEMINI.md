# GEMINI.md - Nuvio Live Sports Plugin

Stremio/Nuvio live-sports addon. Node >= 22, **CommonJS**, Express 4 + stremio-addon-sdk, awilix
DI. Prod: PM2 cluster (2x) + 7 Cloudflare Workers for byte traffic. **No database** - JSON files
and in-process maps.

---

## 0. Zero-Exploration Directives

Do **not** explore this repo to "get oriented". Read the index, then go straight to the file.

1. **First read, every session:** `.agents/context/ARCHITECTURE.md` - topology, request lifecycle,
   entry points, state map, gotchas.
2. **Before starting work:** `.agents/tracks/current_task.md` - what the last session left open.
3. **Before changing deliberate behaviour:** `.agents/context/DECISIONS.md` - settled decisions.
4. **Then** open only the files your task names; the per-directory `GEMINI.md` (section 2) carries
   local conventions.

**Forbidden:** recursive grep / whole-tree file hunting; reading `dist*`, `node_modules/`,
`review-checkouts/`, `scratch/`, `*.tar.gz`, `classes.dex`.

**Narrow search only:** one targeted `rg -n "symbol" src/` for a specific definition. If you
cannot name the symbol, you are exploring - return to step 1.

**Conflict rule:** code beats docs - if `ARCHITECTURE.md` is wrong, fix it in the same change.

---

## 1. Verified CLI Commands

| Purpose | Command |
|---|---|
| Build (staged, deploy shape) | `npm run build` -> `dist.next/` |
| Build (in place, Docker) | `npm run build:local` -> `dist/` |
| Run production | `npm start` (`node dist/index.js`) |
| Run from source | `npm run dev` |
| Full suite | `npm test` (284 files) |
| **One test file** | `npm test -- tests/localRequest.test.js` |
| Syntax-check a file | `node --check src/index.js` |

**Do not invent commands.** No `lint`, `format`, or `typecheck` script exists, and there is no
ESLint/Prettier config; `tsconfig.json` is never invoked. `npx jest` does not resolve here - use
`npm test -- <path>`. CI runs no tests: it builds on the VPS and gates on `node --check`.
Resolver-backed `/api` routes return **503** unless a resolver transport is configured (D9).

---

## 2. Subsystem Routing Table

| Directory | Purpose | Local rules |
|---|---|---|
| `src/` (root) | Entry, DI, manifest, catalog, streams, config | `.agents/context/ARCHITECTURE.md` |
| `src/providers/` | Scrapers + `BaseProvider` contract + WASM decryptors | `src/providers/GEMINI.md` |
| `src/services/` | Guarded egress, aggregation, caching, rewriting, artwork | `src/services/GEMINI.md` |
| `src/routes/` | HTTP proxy/rewrite layer (byte vs text) | `src/routes/GEMINI.md` |
| `src/domain/`, `src/data/` | Entities; tracked seed/asset JSON | `src/services/GEMINI.md` |
| `tests/` | 284 Jest suites | `tests/GEMINI.md` |
| `scripts/` | Ops, benchmarks, probes, build copy helper | `scripts/GEMINI.md` |
| `resolver/` | ESM subprocess: handshake + WASM + curl | `resolver/GEMINI.md` |
| `cloudflare-worker/` | Single-file Worker, deployed 7x | `cloudflare-worker/GEMINI.md` |

---

## 3. Inviolable Invariants

**I1 - No bulk video bytes through this server.** Providers emit direct CDN URLs with
`behaviorHints.proxyHeaders`, or a *text* manifest URL, or a 307 (`/api/hls/resource`). Never
route media through `/api/hlschunk`, `/api/fastmp4`, `/api/mp4proxy`, `/api/dash/segment.mp4`.

**I2 - Never hand-concatenate base URLs.** `BASE_URL` / `STREAM_BASE_URL` are frozen at module
load in `src/config.js`. Use `BASE_URL` or `getRequestBaseUrl(req)`. SVG and `.m3u8` text bypass
the JSON rewriter.

**I3 - Providers are leaf nodes.** A provider returns entities; it must not read the cache, mutate
global state, or mount routes. Side effects belong in `src/services/`.

**I4 - Register it or it does not exist.** A new provider needs **all three**: a line in
`src/container.js`, a slot in the aggregator, and a dispatch branch in `src/streams.js`.
YAML providers load from `src/providers/yaml/`.

**I5 - Identity is verified, never assumed.** An id or index hit is a *candidate*.
`MatchAggregator._sameEventPre` decides; ids and aliases cannot override a date/session or
squad contradiction. `aliasIds` has no length cap - do not grow it blindly.

**I6 - O(1) per request.** Index matches/channels by normalized id and alias at ingest. Precompute
normalization once (`_precompute`); never regex inside comparators or request loops. No O(N)
`.find()` scans.

**I7 - `dist/` is generated.** Never hand-edit it, never commit it. Edit `src/` and rebuild.

**I8 - Relayed DASH stays off.** `StreamPolicy.isBlockedDashStream` drops ClearKey/relayed DASH by
design, including nested `/api/manifest?url=…` forms (D2). Do not re-enable without an owner
decision.

**I9 - Filter order is load-bearing.** `/api` gates sit after the routers but before the SDK router
in `src/index.js`; a route mounted past them silently 404s.

**I10 - All external HTTP goes through the guarded egress stack.** Use `BaseProvider.proxyFetch` or
`ProviderOutbound`; never `fetch`/`undici`/`impit` directly - that skips connect-time DNS
validation and egress-proxy selection.

---

## 4. Work Rules

- **Read before you write.** No edits inferred from filenames or memory.
- **Baseline first.** Run the relevant tests before changing code; label pre-existing failures with
  evidence.
- **Surgical diffs only.** No opportunistic refactors, reformatting, or dead-code deletion. Every
  changed line must trace to the request.
- **Same-layer verification.** Changed `src/services/x.js`? Run its test file. A green new test does
  not prove the suite is green.
- **Report honestly.** State which commands ran and their output. Never write "should pass" as
  "passed"; never delete, skip, or weaken a test to reach green.

---

## 5. Commits

Follow `.agents/rules/git-commits.md` - Conventional Commits title, **Problem** / **Solution**,
**Before & After** for performance or architecture changes, and a **Verification** line.

---

## 6. Handoff

End every non-trivial session by writing `.agents/tracks/current_task.md` from
`.agents/tracks/TEMPLATE_CHECKPOINT.md`; the next agent reads it as step 2.
