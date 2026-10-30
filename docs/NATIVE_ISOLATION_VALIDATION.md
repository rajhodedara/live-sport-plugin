# Native isolation candidate: validation notes

This is an experimental, opt-in candidate in the integration checkout. It has
not been verified against a real native client, proxy, provider or production
build. The isolation flag is `GUARDED_NATIVE_ISOLATION=true`; without it, the
existing guarded native transport remains selected. Do not interpret passing
mocked tests as confirmation that the production problem is fixed.

The candidate starts a child per native request and caps tracked children at
four per pool by default; `GUARDED_NATIVE_MAX_SLOTS` may select 1–8 per pool.
On completion or cancellation, it requests child termination;
capacity is returned only when child exit or close is observed. A child that
does not exit remains counted. This deliberately avoids exceeding the cap,
but cannot promise recovery if the OS never confirms the child has ended.
An exit hook and child watchdog provide best-effort cleanup; neither replaces
real shutdown testing, particularly if the child's event loop is blocked.

When the pool is full, the candidate queues up to 128 requests for at most
five seconds, within each request's original deadline. A small portion of
queue capacity is reserved for proxied and tagged catalog requests. Waiting
proxy requests are admitted first, followed by tagged catalog requests, when a
child exits. A saturated queue or sustained load can still cause capacity
errors; repeated higher-priority traffic can delay other work.
Local capacity failures do not count as DamiTV circuit-breaker failures, so a
subsequent sync can try the provider again.

Before requesting real-event validation, review the candidate and its build
packaging, then arrange controlled checks in an isolated environment:

- Build with the project's normal production tooling and verify the child
  script and its guarded dependencies are present and load from the bundle.
- Confirm a hung native request is terminated at its deadline, the child exit
  is observed, and a later request can use the recovered slot. Repeat with four
  hung requests; ensure a fifth cannot start until an exit is observed and
  that its wait respects the admission and request deadlines.
- Exercise the startup sync with more work than there are slots. Check queue
  waits and capacity errors, whether DamiTV is admitted via WARP, and whether
  direct providers also make progress. Sustained traffic can exhaust the queue.
- Verify blocked targets and redirects stay blocked, including at connection
  time, and that errors do not expose URLs, tokens or proxy credentials.
- Verify DamitTV uses the configured WARP SOCKS proxy, including redirects,
  and that a proxy failure or 403 cannot trigger a direct fallback.
- Compare representative direct and proxied provider results with the known
  working instance. Measure request latency, throughput, child churn, CPU and
  peak RSS under realistic concurrency; process-per-request overhead may be
  unacceptable even if the recovery mechanism works.
- Confirm shutdown leaves no children and that a new pool cannot start while
  an old pool's children remain alive. Keep production unchanged during tests.

For diagnosis, collect pool/slot identifiers, state, phase, age and error
codes, plus timestamps and aggregate counts. Remove URL paths, query strings,
cookies, authorization headers, tokens, proxy credentials and private IPs
before sharing logs. Record which build and isolation setting produced them.
