# Isolate cached match metadata by response type

The in-process meta cache reused the same entry for individual match requests with different response types. Request order could therefore return TV metadata to a series client, omitting its video list, or return series metadata to a TV/channel client with an episode-style default video ID.

**Changes**

- Include the effective response type in the meta cache key.
- Keep TV and channel requests together because both produce TV metadata.
- Keep replay hubs in their existing series response namespace.
- Encode cache-key fields as a JSON tuple to avoid delimiter ambiguity.

**Validation**

- Four regression tests failed before the fix and pass afterward.
- Cover TV/series and channel/series requests in both orders, checking type, poster shape, default video ID, video list and repeat requests.
- Full suite: **46 suites, 616 tests passed**.
- Existing replay hub and classification tests passed.
- `git diff --check` passed.

Based on upstream `main` at `776fdf7`; independent of the pending cache follow-ups. Cache capacity and TTLs are unchanged. This corrects server metadata response shapes; live playback and deployment were not tested.

Jest warned about pending asynchronous operations after the full run, then exited successfully without `--forceExit`.
