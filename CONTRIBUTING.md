# Contributing

Two files describe how this codebase is built: this one for people, and
[`GEMINI.md`](GEMINI.md) for coding agents. They encode the same rules. The reasoning behind
individual choices — and the measurements that settled them — lives in
[`.agents/context/DECISIONS.md`](.agents/context/DECISIONS.md).

Read the invariants below before opening a PR. They are not style preferences; a PR that breaks one
gets sent back regardless of how well it fixes the bug in front of it.

## Hard invariants

### Bandwidth

**I1 — No bulk video bytes through this server.** The addon is a metadata and stream resolver, not
a video CDN. Providers emit direct CDN URLs with `behaviorHints.proxyHeaders`, or a *text* manifest
URL, or a 307 redirect. Never route media through `/api/hlschunk`, `/api/fastmp4`, `/api/mp4proxy`
or `/api/dash/segment.mp4`.

This is the rule contributors trip over most, so state it as a test: **does your change cause
segment or body bytes to flow through the Node process?** If yes, it needs a different shape —
Cloudflare worker fleet, 307, or a direct CDN URL. Even when the worker pool is exhausted the
answer is to emit the upstream URL and let the stream fail, not to start relaying
(`HLSCUNK_FALLBACK=off`). A single 3 Mbps viewer relays ≈1.4 GB/hour.

### URLs and routing

**I2 — Never hand-concatenate base URLs.** `BASE_URL` / `STREAM_BASE_URL` are frozen at module load
in `src/config.js`. Use `BASE_URL` or `getRequestBaseUrl(req)`. SVG and `.m3u8` text bypass the JSON
rewriter.

**I8 — Relayed DASH stays off.** `StreamPolicy.isBlockedDashStream` drops ClearKey/relayed DASH by
design, including nested `/api/manifest?url=…` forms. Do not re-enable without an owner decision.

**I9 — Filter order is load-bearing.** `/api` gates sit after the routers but before the SDK router
in `src/index.js`; a route mounted past them silently 404s.

### Providers

**I3 — Providers are leaf nodes.** A provider returns entities; it must not read the cache, mutate
global state, or mount routes. Side effects belong in `src/services/`.

**I4 — Register it or it does not exist.** A new provider needs **all three**: a line in
`src/container.js`, a slot in the aggregator, and a dispatch branch in `src/streams.js`. YAML
providers load from `src/providers/yaml/`.

**I5 — Identity is verified, never assumed.** An id or index hit is a *candidate*.
`MatchAggregator._sameEventPre` decides; ids and aliases cannot override a date/session or squad
contradiction.

### Performance and correctness

**I6 — O(1) per request.** Index matches/channels by normalized id and alias at ingest. Precompute
normalization once; never regex inside comparators or request loops, and no O(N) `.find()` scans.

**I7 — `dist/` is generated.** Never hand-edit it, never commit it. Edit `src/` and rebuild.

**I10 — All external HTTP goes through the guarded egress stack.** Use `BaseProvider.proxyFetch` or
`ProviderOutbound`; never `fetch`/`undici`/`impit` directly — that skips connect-time DNS validation
and egress-proxy selection.

## Before you open a PR

- `npx jest` passes. If you touched `HlsRewriteService`, also run
  `tests/hlsRewritePlaylist.test.js`.
- Behaviour changes that operators can flip are behind an env var, documented in `.env.example`
  with the production default, and default to the current behaviour.
- If you are fixing a real playback bug, say what it looks like when it fails — an error string or a
  player name saves the next reader an hour.
- Reference the endpoint that carries the bytes. "Routes through the segment proxy" is enough.

## Reporting a bug

The most useful report names the provider, the client (Stremio desktop / web / Android), and the
shape of the failure. A manifest URL that still resolves, or the first line of the player error, is
worth more than a description.
