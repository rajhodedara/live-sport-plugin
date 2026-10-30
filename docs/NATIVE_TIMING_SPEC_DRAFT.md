# Draft: timing measurements for guarded stream resolution

This is a review proposal accompanied by a partial experimental prototype. The
prototype is not ready for a production or load campaign. It adds opt-in
diagnostic logging and one opt-in IPC receipt event; it does not intentionally
change deadlines, admission, or public response formats. The definitions below
describe the target, not a claim that every event is implemented.
All events must be opt-in for an isolated test instance, bounded, sanitized,
and absent from public responses. Never log match identifiers, source URLs,
paths, headers, cookies, credentials, proxy addresses, or response bodies.
Source names are allowed only from a fixed allowlist; unknown names are
reported as `other`, never copied from cache keys into diagnostic output.

## Isolated validation only

Enable `STREAM_TIMING_EXPERIMENT=true` and `NATIVE_TIMING_DIAGNOSTICS=true`
together on an isolated instance. With the guarded native path enabled, these
turn on the partial stream/cache correlation and native timing events. They do
not turn on native isolation themselves. Keep production untouched.

After reviewing logs for sensitive content, run
`node scripts/summarize-native-timing.js <log-file>` against the isolated log.
The report currently covers selected queue and first-hop phases; it is not the
full agreed campaign report. Source-tree tests are not a substitute for a
packaged build, real Impit/WARP, deadline, shutdown, or load tests. The output
can be incomplete, its reported counters overlap, and a missing summary does
not establish that no events were lost. `completeness` remains `unknown`.

The resolver occupied-port ownership issue is separate and unresolved. The
warning introduced with this prototype only changes a misleading log message;
it does not stop traffic to an unverified port occupant. Do not merge on the
strength of this instrumentation or run the 4-vs-6 campaign until the schema,
packaging, loss behavior, and definitions have been reviewed.

## Relationships

Generate independent opaque random identifiers for each stream invocation,
source resolution, protected HTTP request and child process. A stream may
have many sources, and a source may make zero or many HTTP requests. Cache
single-flight can share one source resolution across stream invocations;
represent those relationships explicitly rather than assigning shared work to
whichever request happened to create it. A cache hit has no fabricated HTTP
or child timestamps. Do not infer provider extraction inside the child: it
performs guarded HTTP work, whereas provider resolution runs in its caller.

## Events and clocks

Use monotonic elapsed durations and identify the originating process. A
stream row records stream-resolution window start, response cutoff, outcome
and sources still unresolved at that cutoff. It must not imply that response
cutoff cancels background work. A separate source row records resolution
start, finish, and whether its result became available before the cutoff.

Each protected HTTP row starts before pool admission. Record enqueue, admission
or admission rejection, cancellation or timeout, and terminal HTTP outcome.
Time in queue consumes the existing HTTP budget. Each child row records spawn
attempt, observed spawn/error, termination request, and observed exit/close;
the slot is retained until exit or close. Child exit can occur after the HTTP
or stream response, so it needs a separate terminal event rather than editing
an already emitted record. Record null for phases never observed. Correlate
using opaque identifiers, not URLs or match/source IDs.

In the current prototype, `enqueued` means admission was attempted; a request
can be admitted or rejected immediately without entering the waiters array.
The report separates capacity rejections from timeouts and cancellations while
unadmitted. It does not treat any of these as completed queue waits.

Do not label `spawn` as child ready, a parent's receipt of a buffered response
as upstream TTFB, or a timeout as evidence that the native operation settled.
Actual child readiness, connect and response-header timestamps require explicit
events at the relevant boundaries and review of the real transport. Avoid
cross-process clock subtraction unless the clock's comparability is established;
prefer durations measured in the process that owns the interval.

## Reliability and analysis

The supervisor owns HTTP terminal records, including queue cancellation,
admission rejection, child failure, deadline expiry and successful response.
Terminal emission must occur once without depending on the child sending a
message. Separate cutoff observations from eventual outcomes. Since a process
may crash or be killed before logging, do not promise an absolute record for
every request; report missing terminal records and telemetry drops explicitly.
IPC backpressure must not block fetches or corrupt terminal-result routing.

For each phase, report total, completed, censored and missing counts and define
the population. A percentile of completed observations alone can be biased;
label it and show the censored share. Never treat response cutoff as an HTTP
failure or silently average unobserved phase durations as zero.

Before the 4-vs-6 campaign, Raj should review the schema and boundary
definitions. Validate with simulated concurrency, shared cache, queue timeout,
child exit after response, redaction and telemetry backpressure. Real child,
Impit/WARP and heavy-load validation remains separate and must use an isolated
instance; production remains untouched.

## Prototype boundaries currently implemented locally

When explicitly enabled, the child sends a best-effort request-received event,
and up to three events per redirect hop: immediately before the native client's
fetch, immediately after it returns a response, and after the guarded body read
completes. Phase timestamps are elapsed within the child; the parent preserves
them without subtracting clocks across processes. A missing event is unknown,
not a zero duration. Redirect responses do not emit a body-read-end event.
The response event is the client API's response boundary, not an independently
verified wire-level TTFB. Socket connect and response flushing are not measured.
IPC messages and process termination can lose events. The prototype uses a
bounded stdout writer that rejects new events while the writable reports
backpressure and reports accepted, rejected and callback-failed counts. A write
accepted by Node is not proof of delivery. There is also a per-recorder lifetime
cap of 100,000 events. Output can be lost on forced shutdown, may block depending
on the stdout destination, and has not been load-tested; this remains unsuitable
for the campaign until those limitations are measured and reviewed.
Rows carry an opaque writer-session ID as well as PID, so the report does not
merge unrelated processes when a PID is reused. The source-tree tests share a
writer; whether the bundled build shares the same writer across all timing
modules still needs validation with the actual build tools.

The local queue report retains only selected queue-related fields and caps the
number of retained events. Invalid loss snapshots are counted separately and
never treated as proof of zero loss. Lines outside the expected format are
ignored, and the input stream still must allocate each line before the size
check. The report does not yet parse all phases or validate PM2 log prefixes.
It summarizes the spawn call, observed spawn, child receipt, and first-hop
response/body intervals by source. `unavailable` combines stages not reached,
lost events, ambiguous duplicates and invalid ordering; it is not a count of
network failures. Percentiles describe observed samples only and must be read
with unavailable counts. Redirects after the first hop are not summarized.

The experimental diagnostic components emit
best-effort cumulative snapshots every 30 seconds, in addition to the existing
close/exit summaries. The timers do not keep the process alive and the pool
timer stops on close. A short capture can still have no snapshots; stdout or
forced exit may lose them, and counters cannot prove delivery. The impact of
periodic console output and actual packaged/PM2 behavior still require isolated
validation before the campaign. If no valid snapshot of a given kind is seen,
its loss counters are reported as null rather than zero. Repeated cumulative
snapshots are grouped per writer (and pool where applicable); even a present
snapshot does not prove that every writer or the end of capture was observed.
The report separates the number of writer/pool series (`snapshots`) from valid
snapshot lines (`snapshotObservations`). `repeatedSnapshots` counts additional
lines in existing series; it does not claim that those lines are duplicates.
Without unique snapshot IDs, an identical repeated line can be either a genuine
duplicate or an unchanged periodic observation.

The experimental report also aggregates observed
`stream_resolution_window_end` events, including windows with unsettled sources
and observed duration p95. Invalid and duplicate windows are excluded and
counted. An observed end is not proof of deadline cutoff, and missing starts,
lost events and missing windows remain unknown. This is not a per-request outcome
or a complete censoring report; it does not establish completeness.
The local follow-up now records a fixed reason at the end of the resolution
wait: all sources settled, early return, priority wait completed, hard-wait
timer won, or the remaining budget was already exhausted. These describe the
resolution wait, not HTTP response transmission or cancellation of background
work. Old records without a reason remain unknown; timers and completion can
race near a boundary, and unavailable events still cannot be inferred.
The local queue report additionally counts terminal events with no work ID,
an invalid work ID, an unmatched mint start, conflicting source labels, and
a source attribution. These are observed categories, not reasons: traffic
outside a mint may legitimately lack a work ID, and missing mint starts can
also reflect loss, incomplete capture or session mismatch. The parser maps
non-string and overlong work IDs to null before categorization.
The local candidate tags native terminal events with the existing fixed owner
labels `catalog`, `manifest`, `wasm` or `other`, and reports these for records
without a work ID. The labels are not provider identities: callers without an
explicit tag fall into `other`, including any untagged catalog traffic. Old
captures do not have this field and remain `unknown` for this breakdown.
