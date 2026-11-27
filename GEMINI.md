# GEMINI.md - Nuvio Live Sports Plugin

Stremio/Nuvio live-sports addon. Node >= 22, **CommonJS**, Express 4 + stremio-addon-sdk, awilix
DI. Prod: PM2 cluster (2x) + 7 Cloudflare Workers for byte traffic. State: JSON/SQLite catalog
files and in-process maps.

---

## 0. Zero-Exploration Directives

Never explore blindly; read the index, then open only target files.

1. **First read:** `.agents/context/ARCHITECTURE.md` - topology, lifecycle, entry points, state,
   gotchas.
2. **When resuming prior work:** `.agents/tracks/current_task.md` - open checkpoint and handoff
   notes (skip for general questions, new ideas, or unrelated tasks).
3. **Before changing behaviour:** `.agents/context/DECISIONS.md` - settled owner decisions.
4. **Then** open task files only; per-directory `GEMINI.md` (§2) holds local rules.
5. **RE & captures live outside the repo:** write APK dumps, disassemblies, raw captures, and draft
   plans in `../nuvio-re-lab/`, never in repo root; read only `../nuvio-re-lab/<target>/HANDOFF.md`
   here.

**Forbidden:** recursive grep / whole-tree hunting; reading `dist*`, `node_modules/`,
`review-checkouts/`, `scratch/`, `*.tar.gz`, `classes.dex`.

**Narrow search only:** one targeted `rg -n "symbol" src/` (or `git grep`) for a named symbol;
otherwise return to step 1. **Conflict rule:** code beats docs - update `ARCHITECTURE.md` in the
same change if stale.

---

## 1. Verified CLI Commands

| Purpose | Command |
|---|---|
| Build (staged, deploy shape) | `npm run build` -> `dist.next/` |
| Build (in place, Docker) | `npm run build:local` -> `dist/` |
| Run production | `npm start` (`node dist/index.js`) |
| Run from source | `npm run dev` |
| Full suite | `npm test` (284+ files) |
| **One test file** | `npm test -- tests/localRequest.test.js` |
| Syntax check | `node --check src/index.js` |

**Do not invent commands.** No `lint`/`format`/`typecheck` scripts or ESLint/Prettier config exist;
`tsconfig.json` is unused. Use `npm test -- <path>` (`npx jest` does not resolve). VPS CI builds
without tests and gates on `node --check`. Resolver `/api` routes return **503** without a
configured transport (D9).

---

## 2. Subsystem Routing Table

| Directory | Purpose | Local rules |
|---|---|---|
| `src/` (root) | Entry, DI, manifest, catalog, streams, config | `.agents/context/ARCHITECTURE.md` |
| `src/providers/` | Scrapers + `BaseProvider` contract + WASM decryptors | `src/providers/GEMINI.md` |
| `src/services/` | Guarded egress, aggregation, caching, rewriting, artwork | `src/services/GEMINI.md` |
| `src/routes/` | HTTP proxy/rewrite layer (byte vs text) | `src/routes/GEMINI.md` |
| `src/domain/`, `src/data/` | Entities; tracked seed/asset JSON | `src/services/GEMINI.md` |
| `tests/` | Jest suites | `tests/GEMINI.md` |
| `scripts/` | Ops, benchmarks, probes, build copy helper | `scripts/GEMINI.md` |
| `resolver/` | ESM subprocess: handshake + WASM + curl | `resolver/GEMINI.md` |
| `cloudflare-worker/` | Single-file Worker, deployed 7x | `cloudflare-worker/GEMINI.md` |

---

## 3. Inviolable Invariants

**I1 - No bulk video bytes through this server.** Emit direct CDN URLs with
`behaviorHints.proxyHeaders`, a *text* manifest URL, or a 307 (`/api/hls/resource`) - never
`/api/hlschunk`, `/api/fastmp4`, `/api/mp4proxy`, or `/api/dash/segment.mp4`.

**I2 - Never hand-concatenate base URLs.** `BASE_URL` / `STREAM_BASE_URL` are frozen in
`src/config.js`. Use `BASE_URL` or `getRequestBaseUrl(req)`. SVG and `.m3u8` skip JSON rewriting.

**I3 - Providers are leaf nodes.** Return entities only; never read cache, mutate global state, or
mount routes (side effects belong in `src/services/`).

**I4 - Register it or it does not exist.** Wire new providers in `src/container.js`, the aggregator,
and `src/streams.js`. YAML providers load from `src/providers/yaml/`.

**I5 - Identity is verified, never assumed.** Id/index hits are candidates;
`MatchAggregator._sameEventPre` decides and never overrides date/session or squad contradictions.
Keep `aliasIds` bounded.

**I6 - O(1) per request.** Index normalized ids/aliases at ingest and `_precompute` once; never run
regex in comparators/request loops or O(N) `.find()` scans.

**I7 - `dist/` is generated.** Never hand-edit or commit it; edit `src/` and rebuild.

**I8 - Relayed DASH stays off.** `StreamPolicy.isBlockedDashStream` drops ClearKey/relayed DASH,
including nested `/api/manifest?url=…` forms (D2). Never re-enable without an owner decision.

**I9 - Filter order is load-bearing.** `/api` gates sit after routers and before the SDK router in
`src/index.js`; routes mounted past them 404 silently.

**I10 - Guarded egress only.** Use `BaseProvider.proxyFetch` or `ProviderOutbound`; never raw
`fetch`/`undici`/`impit` (skips connect-time DNS validation and proxy selection).

---

## 4. Work Rules

- **Read before writing.** No edits from memory.
- **Baseline first.** Run relevant tests first; label pre-existing failures with evidence.
- **Surgical diffs only.** Every changed line must trace to the task.
- **Verify at layer.** Run the affected test suite; never claim green without running it.
- **Report honestly.** Cite exact commands and outputs; never weaken/skip tests to pass.

---

## 5. Commits & Handoff

Commits follow `.agents/rules/git-commits.md` (Conventional Commits title, **Problem**,
**Before & After**, **Verification**). End non-trivial sessions by updating
`.agents/tracks/current_task.md` from `.agents/tracks/TEMPLATE_CHECKPOINT.md`.
