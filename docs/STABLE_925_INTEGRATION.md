# Stable 925 integration

This draft integrates stable `92589e4c0bef327d7cc483c3fbe2d40908ba8e17`
with the previously published PR59 `3b34dee98b6d8a7395202c157db2c9484d6187b5`.
It supersedes the current-target portions of STABLE_D1_INTEGRATION.md and
PR59_VALIDATION.md. It is not a deployment or a merge approval.

## Resulting behavior

- Retain stable's manual-only deployment workflow and current provider changes.
  DamiTV remains enabled by default; `DAMITV_ENABLED=false` opts out.
- Proxied Dami `/c/` metadata uses curl through the existing authenticated guard
  proxy. The slot still owns public-IP checks, pinned dialing and SOCKS egress.
  Curl does not follow redirects, load curlrc, expand URL globs, skip TLS checks
  or fall back to a direct connection. Its headers, body, stderr and lifetime
  are bounded; cancellation waits for the owned child to close before reuse.
- Leaf retains install-config normalization, rate-limit backoff and mint-at-fetch
  state. Mint and manifest requests use guarded egress, including the configured
  Leaf-specific proxy. A missing signing key disables signed-state publication
  and resolution: use the existing shared APP_SECRET or LEAF_STATE_SECRET.
  There is no built-in public fallback key. Invalid, future or expired state
  fails closed. A requested slug cannot fall back to another channel.
- Leaf upstream denial, malformed media or notice playlists remain errors.
  The public state route does not force a fresh identity or bypass a denial.
  Legacy `url=` and synthetic `d=` routes remain compatibility surfaces; this
  change does not claim to redesign those routes or hide signed master-child
  URLs. The diagnostic reports metadata reachability, never player playback,
  and omits install paths, proxy credentials, JWT identities and signed URLs.
- Interactive resolution uses the canonical stored match ID, matching prewarm
  and recovery. A local destination-guard or capacity failure cannot trigger
  remint; genuine upstream expiry responses retain recovery behavior.
- Outage carry-forward uses eligible dates and unambiguous, compatible event
  identities. It cannot inject an old source into an unrelated alias match or
  resurrect an overlapping legacy card. Standalone rescue and backfill share
  the configured bound. Leaf's restored four-hour resolve TTL is preserved.
- Stable no longer offers relayed ClearKey/DASH sources. Producer filtering
  and the final stream policy enforce that choice, including wrapped MPD URLs,
  while preserving HLS proxies. Legacy DASH routes still exist; neither their
  presence nor pure cryptographic fixtures claim that relayed playback is an
  offered feature or that every legacy media route has the metadata guard.

## Validation and remaining acceptance

Run `node scripts/test-pr59-offline.cjs` with the locked dependencies. The
selection blocks actual worker construction, network connections and listeners.
Its mocked curl child tests do not execute curl. Build packaging includes the
new guarded client alongside the isolated worker dependencies. Actual results
and candidate identities are recorded in the final operator handoff.

Two independent reviews cover the merged guard/transport and compatibility
changes. PR61 must include this dependency and retain its stronger mapping and
cache identity rules. A passing offline selection is not a full repository or
real-provider playback result.

The previously accepted cache/TLS/restart/rotation evidence remains scoped to
its frozen builds. Do not repeat the entire matrix solely for this integration.
The new exact candidates need one resource-conscious isolated runtime smoke:
valid current pinned resolver identity, addon health and a controlled resolver
request; catalog/meta/stream; available representative real-player cases;
AK47 custom-UA parent/child/segment behavior; honest PPV status/fallback; and
owned-process shutdown evidence. Dami curl compatibility and configured Leaf
mint/manifest egress need targeted runtime evidence where available. Optional
unconfigured providers remain NOT RUN. Relayed DASH playback is not a required
acceptance case under the current offering policy.

The observed DaddyLive 124/19 addon HTTP404 cases remain unresolved until a
matching route/remint/upstream trace and working control classify them. The
local recovery fixes do not establish their upstream cause. No PNG format or
media decoding change is claimed without a verified sample.

Production, PM2, credentials and active caches are outside this draft update.
