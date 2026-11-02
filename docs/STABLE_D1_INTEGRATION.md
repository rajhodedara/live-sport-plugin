# Integration with stable d1b2b626

This review supersedes the earlier a71 integration target. Stable advanced eighteen
commits to `d1b2b626b13d21cafdd7d66ecbf553d90f9c4d9e`. PR59 was integrated
first; PR61 was then integrated on that guarded base. Both remain draft pending
review of the new built addon and real player/provider acceptance.

## Preserved behavior and required corrections

The index merge keeps the stream/metadata hostname split, the new `/api/leaf`
route, pinned resolver proxy configuration, resolver trust/conflict gates,
sanitized events and shutdown wiring. Exact relative endpoint boundaries avoid
rewriting `/api/leaflet` and similar lookalikes. Generic external CDN `/hls/`
paths remain external; nested signed query bytes are retained unchanged.

The DASH service merge retains the new upstream parser/policy implementation
and PR59's guarded MPD request adapter. New signed DASH producers in AK47 and
SKTech remain intact. SoccerFull keeps upstream direct-CDN publication and
post-ID isolation while retaining guarded provider requests. No upstream
cryptographic algorithm or dependency lock was changed by this integration.

Leaf now retains upstream's automatic WARP selection through the guarded shared
and native adapters. Parsed hostname classification prevents query/path text
from changing the selection. Leaf uses the existing Chrome142 slot; DamiTV
keeps vanilla. Explicit direct/proxy/profile choices and redirect egress remain
consistent. Native slot limits, queue bounds, DNS/IP checks and resolver pinning
were not relaxed. A missing required legacy proxy client fails with
`EPROXYUNAVAILABLE` rather than silently using direct Undici.

The new Leaf manifest endpoint uses guarded metadata fetches, a 256 KiB body
limit and a six-second deadline. It validates intended HTTPS Papacito targets
and final response URLs, rejects truncation and invalid playlists, and keeps
authorization/guard failures visible instead of returning stale success. Only
defined transient failures may reuse a short cached playlist. Queries remain
original strings; error responses/logs do not repeat signed targets.

Two independent reviews found a provider/route mismatch: the provider could
publish HTTP or nonstandard-port targets that the route rejected. Both now use
one pure target validator. Unsupported entries are skipped individually;
`?` in a fragment is not accepted as an upstream query. PR61's malformed-entry,
mapping, replay identity/date, country, alias and playback-context fixes survive
the integration. The only stable change to its MatchAggregator is the intended
Leverkusen alias. The pure policy helper is also copied to built child layouts.

## Verification

On Node22.23.2 and Node24.19.0 with Jest29.7.0:

- PR59: `node scripts/test-pr59-offline.cjs` — 72 suites, 741 passing Jest
  tests and one existing TODO.
- PR61: `node scripts/test-pr61-offline.cjs` — inherited72/741 plus own57/477,
  totaling129 suites/1218 passing Jest tests, seven Node tests and the existing
  TODO.
- The separate pure DASH model selection passes18 tests on both versions;
  fifteen listener-based cases are deliberately skipped. Reproduce with Jest
  `--runTestsByPath tests/dashToHlsService.test.js --testNamePattern
  '^(DashToHlsService|SSRF guard) '` under the same offline boundary.

These are selected offline results, not a full repository green-suite claim.
The boundary blocks actual workers, sockets and listeners. Mocks exercise the
real routing/admission/aggregation code; they do not prove native SOCKS, device
DRM, advertised content or successful upstream playback. Node22 offline builds
use cached ncc0.45.0/copyfiles2.4.1. Independent source and compatibility reviews
closed the admission mismatch before publication; reviewers did not execute
the application or tests.

## Real catalog received November2

The supplied catalog hash is
`bc9fe24980a5da397e1a0422e5752c99942c1efe674ebbd4f76f50182eb7f061`:
8820379 bytes,9641 unique canonical IDs,14101 source associations and no
source-empty rows. All source totals match original sync stdout. Recorded sync
ran11:53:56–11:54:39Z with exit0. All canonical and1091 alias lookups succeed;
282 numeric DaddyLive fixture aliases and three Spanish bookmarks survive.

All seventeen retained rugby date contradictions are corrected. Brisbane/Carlton
has its May8 event date. The previous Handball/CFL fixtures are absent, so their
live retest is unavailable; disappeared historical MLB rows are consistent with
expiry but do not independently prove its cause. Replay claims remain internally
consistent. Of2643 missing dates,2629 are continuous channels and14 are undated
AK47 listings. Changing feed counts are not by themselves a mapping regression.

Leaf was explicitly unconfigured. WatchFooty DNS, DamiTV capacity/timeout,
AK47/MLB capacity and StreamedPk HTML failures remain visible. This six-file
archive includes catalog/hash, timing, sync streams and build output, but no
independent source SHA/tree or bundle hash. A filename containing7f64bc0 is a
label rather than proof of the executed source. No app HTTP, process cleanup or
player result is present. Accept this evidence within its scope; do not rerun
the same catalogue-only task or reconstruct missing original logs.

## Remaining operator acceptance and limits

Stage the exact final draft source and record the actual build hash. Complete
one isolated built-addon health/catalog/meta/stream and player/provider smoke,
with original sanitized evidence and owned PID/start-tick/descendant/listener
cleanup. Combine any needed private-cache ingestion with this run instead of
sending another catalogue-only report. Use authorized test media and legitimate
install configuration; mark unavailable cases NOT RUN.

`DASH_SIGN_SECRET` is separate from `APP_SECRET`. It must be at least sixteen
characters and match privately across involved workers; otherwise the DASH
signer uses per-process random keys. Never share either secret. `STREAM_URL`
controls publication hostname, not DNS proxy status, TLS provisioning or
Cloudflare's permission to deliver video. The public-domain restriction needs
its own operational resolution.

Earlier cache/TLS/lifecycle/rotation evidence stays accepted for unchanged
infrastructure. It does not establish the new addon/provider/player behavior.
The inherited DASH init/media path is separate from guarded metadata transport;
do not claim every DASH/media destination has the same DNS guard. Leaf's legacy
`d=` generator and broader HLS URI-attribute handling are inherited limits, not
new production passes. The normal provider emits `url=`. This review does not
prove real Leaf authorization, AK47 default/custom-UA parent/child/segment
playback, PPV status/fallback, WARP, arm64 or sustained load.

Keep both PRs draft, integrate PR59 before PR61, and review the final field
results before declaring merge readiness. No production or PM2/cache/key changes
and no merge are part of this source integration.
