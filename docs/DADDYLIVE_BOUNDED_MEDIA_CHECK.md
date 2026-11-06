# DaddyLive bounded media check

A decoded HLS URL can return a valid playlist while its video fragments return 404. DaddyLive now samples a candidate's media before accepting that candidate, so a confirmed miss can reach another folder during the same resolution.

## Validation flow

The first decoded candidate starts one **1200 ms validation phase**. This budget excludes the initial HTML discovery. Once started, it also covers queue wait, later folder/embed pages, nested extraction, redirects, playlist bodies and the segment sample. Later candidates receive the remaining time rather than a fresh budget. A deadline does not promise that every fallback folder will finish.

The checker reads a media playlist directly or follows the first normal rendition from a master, at most once. It samples the penultimate eligible complete `EXTINF` segment, or the only complete segment available. `GAP` entries, low-latency parts and preload hints are not samples. This avoids choosing the newest potentially unfinished fragment; it does not validate every rendition or the entire live window.

| Limit | Behavior |
| --- | --- |
| Playlist bodies | Retain at most 64 KiB per playlist; an incomplete capped body is inconclusive. |
| Segment sample | Request `Range: bytes=0-511`, retain at most 512 bytes and cancel when the prefix is full, including an exact-size response. |
| Transport | Use the existing guarded streaming path; destinations and redirects retain outbound validation. |
| Admission | At most two active checks and 32 queued checks **per Node process**. Queue time consumes the same deadline. |
| Physical work | A timed-out caller does not free capacity while an uncooperative request or body cancellation still runs. |
| Unsupported media | Encrypted, initialization-map or byte-range playlists are inconclusive; this check adds no decoder. |

Range may be ignored. The prefix limit bounds retained application bytes and requests prompt cancellation; it cannot guarantee a one-kilobyte socket/traffic ceiling. HTTP/TLS/TCP overhead and already-arrived transport chunks still consume traffic. This is a small probe with no bulk video relay, not zero bandwidth usage.

## Outcomes and caching

A received playlist/segment 404 or 410, or an invalid playlist, rejects the current candidate. It does not blacklist the channel or provider. Other uncertain outcomes, including capacity, timeout, cancellation and temporary upstream refusal, remain retryable. A hard outbound guard refusal remains hard. Parent cancellation stops further resolution work and prevents a new provider-cache publication.

An inconclusive resolution keeps a usable web fallback marked for a short retry. Both DaddyLive's internal decoded cache and the existing PR #72 resolve-cache path limit that temporary web result to two seconds. The mark is internal and is removed from public stream clones. A successfully checked direct result retains its existing normal, token-bounded cache lifetime.

Checks run when a fresh candidate is minted. Existing positive cache hits do not continuously recheck media and can remain until their existing TTL expires. Acceptance should use a freshly resolved entry. A successful small TS sample is neither a browser/CORS guarantee nor proof that subsequent fragments will remain available; cast fallbacks can still require client-supported headers.

## Offline regression checks

With dependencies installed and Node 22, run the two new suites from the repository root:

```sh
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=$PWD/tests/fixtures/pr59-offline-boundary.cjs" \
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath \
  tests/daddyLiveMediaCheck.test.js \
  tests/daddyLiveMediaRecovery.test.js
```

These suites inject transports or provider responses; they do not perform live playback. They cover playlist200/segment404 fallback, complete-segment selection, prefix cancellation, deadline/admission behavior, temporary outcome classification, later-folder reachability and recovery through the actual mint/cache path. Broader validation results belong in the PR acceptance record.
