# Refresh cached metadata when match snapshots change

Cached match details and replay hubs could remain stale after the match snapshot changed. A removed fixture could keep its old details, and replay hubs could omit newly added matches until their metadata TTL expired. Cache hits also skipped the background schedule freshness check.

**Changes**

- Record the match-cache revision alongside each cached metadata response.
- Reject entries from older revisions.
- Poll through the existing read-only cache API before trusting a metadata hit, allowing cross-worker disk updates to be detected.
- Run the background freshness check on metadata cache hits.
- Preserve the revision observed before building a response so delayed sync results are not tagged as a newer snapshot.

**Validation**

- Seven regression tests fail on upstream code and pass with the fix.
- Cover updated/removed matches, sport/date replay hubs, cross-worker file updates, cache-hit refresh checks and delayed sync results.
- Full standalone suite: **46 suites, 619 tests passed**.
- `git diff --check` passed.

Based on upstream `main` at `776fdf7`; independent of the other pending follow-ups. Metadata TTLs and cache capacity are unchanged. Disk refresh follows the existing CacheService polling policy; the empty-cache polling improvement in PR #22 remains relevant to its efficiency.

This invalidates server-side metadata. Previously cached client/CDN responses may still live until their own TTLs expire. Live playback and deployment were not tested.

Jest warned about pending asynchronous operations, then exited successfully without `--forceExit`.
