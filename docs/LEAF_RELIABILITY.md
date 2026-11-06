# Leaf and Highfly reliability

This follow-up builds on the Premium, regional-host, Bunny CDN and Recap support
already in stable at `2aac780`. It does not require a new environment variable
for an existing working install.

## Install selection

Live, Recap, URL minting and the playlist route share install parsing. Existing
free blobs and raw free IDs work. Premium accepts a UUID, UUID/profile path,
official install URL or configure URL with a UUID fragment. A bare UUID retains
stable's Premium default. Explicit `LEAF_PREMIUM_TOKEN` and optional
`LEAF_PREMIUM_PROFILE` provide an alternative. Invalid explicit Premium settings
disable Leaf operations without exposing the supplied credential.

`LEAF_API_URL` retains whole-base precedence, including the existing local-port
kill switch. Legacy `LEAF_API_ORIGIN` retains custom-origin support. When using
the new explicit Premium fields, origin selection is restricted to the public
Premium, US2 and EU1 hosts on `highfly.to` and `highfly.dev`.

Treat account identifiers, install URLs and signed upstream playback URLs as
credentials. Examples and tests use fixtures. Do not copy a real trial token
into source, issue text, logs or a PR description.

## Quota and cache behavior

Premium is subject to upstream limits. An actual stream API HTTP 429 or JSON
rate-limit stub creates a process-local advisory shared by Live, Recap and
minting for the same account, across profiles and Highfly regional hosts. New
stream API requests wait for the advertised countdown, bounded to ten minutes.
Catalog requests remain independent. A different account has a separate bucket.
This state is not coordinated between PM2 workers or separate servers.

Already valid minted URLs remain usable during an advisory, including forced
refresh calls that can be satisfied from that cache. Force does not bypass a
known upstream quota block. Mint cache lifetimes retain the existing four-hour
default and eight-hour configuration ceiling, further capped by a known JWT
expiry. The eight-hour token seen in Raj's research is an observation, not a
guarantee for future responses.

Fallbacks never renew the original successful timestamp or absolute token
expiry. Live metadata fallback requires valid application state and a currently
valid cached mint. Recap's stale grace is bounded to sixty seconds and any known
media expiry. Capacity, cancellation and timeouts remain short retryable control
outcomes under the existing two-second deferred-resolution contract.

## Bounded work and catalog health

Live resolution has one eight-second budget and examines at most eight
candidates. The playlist metadata checker admits two active checks and thirty-two
waiters per process, with a 1.5-second maximum including queue time and a 16 KiB
body limit. A slot remains occupied while an uncooperative transport is draining.
It fetches no playlist segments and does not relay video. A successful metadata
sample establishes playlist structure, not guaranteed end-to-end playback.

Live and Recap private stream caches and pending work are bounded. Entries are
partitioned by install configuration. Explicit refresh and exact-match overlay
invalidation fence old pending Live work so it cannot refill the private cache.
Cron invalidation preserves other providers' entries.

The Live catalog is healthy only after a bounded, untruncated, structurally valid
response. A verified empty Leaf catalog is authoritative; an unsuccessful fetch
uses the aggregator's existing bounded carryforward policy. Existing fixture
identity, source IDs, 24/7 exclusions and full-sync persistence gates remain.

## Playlist handling and scope

Child playlists resolve relative to the actual playlist directory. Same-origin
authentication is preserved without copying it to another origin. Child context
retains signed application state, is checked against the selected install and
is confined to the minted channel path.
Independent child credentials are preserved. Metadata caching coalesces requests
without sharing viewer-specific signed context. Positive and stale lifetimes are
absolute, bounded by known upstream expiry; 429 responses honor Retry-After.
Cross-origin CDN children and redirects outside the minted channel directory
retain the existing guarded URL route with their own upstream credentials;
automatic state-based credential refresh applies only inside that directory.

Existing guarded egress and the direct Bunny/w1 CDN selection remain in use.
There is no authentication bypass, credential forgery, domain rotation or media
decoder. This work does not redesign shared L2 cache revision protocols or the
secondary worker's overlay disk-sync invalidation path.

Validation uses locked Node 22 with mocked transports and a boundary that rejects
real sockets, listeners and workers. It does not establish real account access,
production playback quality or VPS resource measurements. Raj's report supplies
the live observations; no authenticated trial calls are needed to reproduce the
offline reliability checks.
