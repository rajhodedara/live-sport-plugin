# Resolver port ownership: local review draft

This is a design and test contract, not an implemented fix. PR #59 remains a
draft. No existing occupant may be killed merely because it owns the port.

Local partial change: if the resolver child exits with its documented
EADDRINUSE code 98, the manager pauses automatic restarts for the lifetime of
that worker and reports the conflict. After that observation, the same worker
blocks new public proxy requests and falls back to local cache; in-flight
shared-cache requests receive an abort signal, and the proxy attempts to destroy
its active upstream request. A shared-cache response arriving after that worker
detects a conflict is discarded even if the adapter ignored cancellation. Data
already sent cannot be retracted, and an
adapter might not honor cancellation. The proxy behavior has only been tested
with simulated requests, not a real socket or packaged build. A worker restart is currently required to try
again. This does not cover an initial HTTP response from an unrelated listener
or coordinate conflict state between workers. Other workers and requests
started before the observation may still contact the occupant. This is not a
complete fix for the issue.

The local cache prototype also accepts an optional `sharedResolver` adapter.
When present but unavailable or malformed, all L2 reads, claims, writes,
deletes and pruning fall back to local cache without calling raw `fetch`. The
adapter must itself bind requests to a verified peer; `available()` alone is
not authentication and cannot close the verify/connect race. The default
legacy cache and proxy paths remain unverified. An opt-in local experiment now
provides a pinned Unix/TLS adapter; it is not a completed security fix.

## Observed behavior

The manager currently accepts any HTTP response, including an error response,
as proof of a healthy resolver. Raj's isolated test showed that an unrelated
HTTP server remains alive but is treated as the resolver. The same loopback
port is used by the public stream proxy and by the shared L2 resolve cache.
Preventing a false readiness log alone does not prevent either route from
contacting an unrelated listener.

A local characterization test uses a mocked endpoint that returns plausible
cache-miss and claim responses. Under those conditions the current shared-cache
code sends the generated stream object, including any proxy header hints, to
that endpoint. This demonstrates a conditional data-exposure path; it does not
claim Raj's decoy actually received those objects. The test documents the defect
and is not proof of a fix.

## Required behavior

- Before sending resolver requests, every worker must have evidence that the
  endpoint belongs to the intended resolver instance. A successful health
  response, a matching process name, or a PID file alone is not that evidence.
- On an unverified occupied port, do not kill, adopt, retry indefinitely, or
  pass requests to the occupant. Surface a bounded, explicit conflict. The
  conflict must not introduce an uncontrolled restart loop.
- A worker unable to use the shared cache must retain local-cache behavior;
  resolver-dependent proxy requests must fail clearly without contacting the
  unverified listener. Do not expose URLs, headers, cookies, or credentials in
  the conflict diagnostic.
- Support the current two-worker shared resolver, staggered startup, restart,
  owner exit, and independent deployment instances. Do not claim correctness
  for multiple workers until the mechanism is validated across processes.
- Process handles establish identity for a directly spawned child; sharing
  trustworthy ownership evidence across workers is a separate requirement.
  Health checks are readiness checks after ownership is established, not proof
  of ownership. Metadata and process-tree observations must account for stale
  state and PID reuse. A check followed by a connection also has a race; the
  design must state how it prevents or limits that race.

## Before proposing an implementation

Choose and document the process coordination and platform scope, including
reload behavior and what happens if the owner dies. The project currently runs
two PM2 workers; a single-worker-only solution must not be presented as a full
fix. Avoid new native dependencies unless their installation and platform
behavior are reviewed. Do not infer a process belongs to us from a response it
controls. Do not silently adopt a pre-existing orphan.

## Coordination options to investigate

| Option | Potential benefit | Open questions |
| --- | --- | --- |
| Explicit application supervisor with IPC | A supervisor can keep an owned child handle and distribute verified state to workers. | PM2 currently owns cluster lifecycle. Determine how to integrate without unsupported internals; test owner death and reload. |
| System-managed socket and resolver service | A service manager can own and pass a listening socket to the resolver. | This changes deployment architecture and is systemd-specific. Determine how workers establish trust, how restart behaves, and what non-systemd installations do. |
| Per-worker resolver endpoints | Each worker can keep its own child handle instead of adopting a listener. | Changes resource costs and shared L2 caching; preserving cross-worker cache requires a separate design. |

Node's cluster API can pass handles through a primary process, but the project
does not currently control PM2's primary. A documented Node capability alone
does not prove that an application-owned supervisor can be inserted into the
existing deployment. An unverified HTTP response, a lock file, or a command
line alone is not sufficient identity evidence.

### Local experiment: systemd socket activation

For the isolated Linux deployment Raj described, an opt-in experiment allows
the resolver to listen on descriptor 3 when `RESOLVER_SYSTEMD_SOCKET=true` and
systemd supplies matching `LISTEN_PID` and exactly one descriptor. Invalid
activation metadata fails startup. The default TCP mode is unchanged. Only the
metadata parser and syntax have been tested locally; no real systemd service,
socket, worker connection, restart, or ncc bundle has been tested.

This is a server-side building block, not an ownership fix. The local opt-in
worker mode selects Unix/TLS and skips the legacy TCP probe and spawn, while
the default mode still uses the legacy path. Service configuration, failure
and reload semantics, and removal of unverified adoption in the default mode
remain unimplemented.
An inherited descriptor proves neither client-side peer identity nor safety
against another process running as the same privileged user. A private Unix
socket pathname can also be replaced if its parent directory is writable by an
attacker; any proposed deployment must state that trust boundary and address
the connection race. Do not enable this experiment in the running instance.

A separate local client adapter prepares an Undici `socketPath` dispatcher and
an HTTP proxy target with a socket path. The cache adapter restricts requests to
the expected loopback cache URL and disables redirect following. Only mocked
contract tests have passed: the real installed proxy and Undici must be tested
against an actual Unix socket, including shutdown and missing socket behavior.
The unauthenticated version is not wired into workers and does not authenticate the server.
`available()` means only that the local adapter has not been closed.
The installed Undici and proxy middleware have now also been exercised with
in-memory duplex connections: both selected the configured socket path and
reached a simulated HTTP server. A simulated missing socket caused both cache
and proxy requests to fail without attempting TCP. This does not test actual Unix socket or
systemd behavior. An isolated real-socket test exists in `tests/resolverUnixSocket.node.cjs` but
the local environment rejected `listen()` on the Unix socket with EPERM, so
the test did not exercise either client and is not a passing integration test.
It must run in an environment that permits local Unix socket listeners.
A second isolated test, `tests/resolverUnixTlsSocket.node.cjs`, creates a real
TLS Unix socket and checks the cache and proxy clients as well as a rejected
certificate. It has only passed syntax checking locally because this runtime
rejects Unix socket listeners. It does not test systemd activation or workers.
Two independent cache objects in the same process have also successfully
shared a simulated resolver over the in-memory transport in a sequential test.
This does not establish cross-process coordination, concurrent claim behavior,
resolver ownership or restart safety.

The local adapter now has a separate pinned-TLS constructor for the Unix
socket transport. It requires a certificate and hostname, configures both
cache and proxy clients to verify the same pin, and has no HTTP fallback.
Tests now exercise real Node TLS handshakes for both installed clients over
in-memory streams configured with the socket path. A mismatched pin is rejected
before HTTP data reaches the simulated peer. The fixture injects a trusted CA
so this negative case reaches the pin callback. The local resolver now has an
experimental TLS branch that reads systemd credential files only when both
activation and TLS are explicitly enabled; missing or invalid configuration
fails startup rather than falling back to HTTP. A fixture test constructs an
HTTPS server, and a separate in-memory test connects the pinned cache client
to an HTTPS server built from those credential options. Neither starts a real
systemd service or uses an actual socket. A TLS
handshake over an actual Unix socket, key provisioning and rotation, and
the opt-in worker integration have not been validated in a real deployment. The original
unauthenticated Unix adapter is a transport experiment
only and must not be used as an ownership guarantee.

References: Node cluster documentation https://nodejs.org/api/cluster.html;
systemd socket documentation https://www.freedesktop.org/software/systemd/man/254/systemd.socket.html.

## Candidate: a separately authenticated TLS connection

An experimental local callback compares the hostname and the exact certificate
with a configured pin. It does not by itself authenticate a connection: the actual TLS client must also
verify the certificate chain and validity with `rejectUnauthorized` enabled.
Node's HTTPS documentation illustrates using hostname validation together with
pinning: https://nodejs.org/docs/latest-v24.x/api/https.html.

This could protect each connection against a listener lacking the private key,
including after a port replacement, but it proves possession of that key rather
than kernel process identity. The design must establish how the expected public
certificate is distributed to both workers, how the private key is protected,
how keys rotate across reloads, and how different supervisor instances avoid
sharing the same credential. Same-user access to key material is an explicit
threat-model limitation. Failing TLS validation must not fall back to HTTP or
contact the endpoint through the existing permissive TLS fallback agent.

The lockfile pins the external `undici` dependency to 8.10.0. Its maintainers
document an issue affecting an `Agent` with function-valued TLS options passed
via `tls`; the stated workaround is to pass them through `connect`, or upgrade
to a patched version: https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx.
This is a design constraint for a future TLS adapter, not a claim that the
existing code exercises that advisory's vulnerable configuration. The actual
external and Node-bundled Undici versions, connector options, and live handshake
must be tested in the deployment environment. No TLS identity scheme has been
approved or enabled by this draft.

An additional local prototype constructs a dedicated HTTPS proxy agent and an
Undici cache dispatcher with CA verification, hostname verification and the
same certificate pin. It rejects redirects and non-loopback cache destinations.
The tests include Node TLS handshakes over in-memory duplex streams, including
mismatched pin, CA and hostname. Separate tests use the locally installed
Undici dispatcher and the HTTPS agent over an injected in-memory TLS socket;
they verify that a mismatched pin prevents HTTP data from being sent. For that
negative test, the fixture CA is explicitly injected so the handshake reaches
the pin callback. A separate `node --test` case exercises the installed proxy
middleware over an in-memory TLS connection: the correct pin permits the request,
and a wrong pin raises a TLS error before upstream HTTP data is sent. An additional
case exercises the middleware's configured error handler with a simulated Express
response and verifies a generic 502. Another uses a real Express/Node HTTP server
over in-memory duplex streams to check the serialized 502 and confirm the query
token is absent from the response. These tests do not cover real sockets,
WARP, the packaged application, or the runtime on Raj's host. The pinned TCP
prototype is not wired into the application; credential provisioning and
rotation are unresolved.

An in-memory middleware test also confirms that the proxy does not itself
follow an upstream 302 with these prototype options. It forwards the 302 to
the caller; whether a caller follows it and whether exposing such redirects is
acceptable are separate questions that this test does not resolve.

### Identity lifecycle still needed for clustered workers

The checked-in PM2 configuration uses two clustered workers. Only worker 0
starts a resolver; both workers send it traffic. Worker 1 does not possess the
child handle and the existing HTTP health probe establishes only reachability.
The current per-worker conflict flag is not an inter-worker ownership signal.

Before wiring the TLS prototype, a deployment-specific design must establish:

* A fresh resolver identity for each ownership epoch, generated and delivered
  to the resolver and both workers through an authenticated channel. Sharing a
  long-lived certificate across launches would let an old resolver pass the pin.
* Atomic publication of readiness only after the intended resolver binds and
  authenticated traffic succeeds; workers without a trusted identity must fail
  closed for the proxy and use the documented cache fallback.
* Explicit behavior during PM2 reload and worker-0 replacement, including old
  and new generations overlapping, loss of the owner, and re-distribution to a
  restarted worker. There must be no HTTP downgrade or automatic trust of the
  process already listening on the port.
* A threat model for the credentials and their access permissions. A certificate
  pin establishes possession of the private key, not kernel-backed PID ownership;
  a process able to read that key can impersonate the resolver.

No authenticated cross-worker distribution mechanism is currently implemented.
Environment variables inherited independently by PM2 workers are not proof of
an ownership epoch, and a shared file or IPC endpoint must not be treated as
trusted without defining its creation, permissions, replacement and cleanup.
The in-memory TLS tests validate a transport building block only; they do not
establish safe startup, reload or ownership across workers.
The prototype's `available()` reports only that its local adapter has not been
closed. It performs no connection and must never be interpreted as resolver
readiness or successful authentication.

A local public-identity reader validates and returns only `resolver.crt`, so a
worker does not need to read `resolver.key`. Mocked tests exercise two loads,
invalid certificates and failure redaction. It does not establish that the
credential directory is trusted, distribute identities, coordinate generations,
or reload certificates. Workers use this reader only when the local experimental
mode is explicitly configured.

A local isolated-test helper can generate a fresh one-day certificate/key pair
using OpenSSL in a newly created 0700 directory, with key permissions 0600. A
real local generation test verifies that the new pin rejects the previous
generation and that failed generation removes its own directory. This helper
is not wired to systemd or worker startup, does not validate the trustworthiness
of its parent directory, and offers no protection from same-user/root access.
It is not a production provisioning or rotation mechanism. Workers holding an
old certificate must not silently reconnect to a new generation; restart and
credential delivery policy remains to be designed and tested.
An in-memory TLS test now creates two real test generations: a client holding
the old pin is rejected before HTTP, while one holding the new pin succeeds.
The fixture supplies the new certificate as trusted CA even to the old client
to specifically exercise the pin check. This is not a real worker restart,
automatic identity distribution, or a test of Unix-socket replacement.

### Isolated lifecycle proposal — not installed or tested

1. Under a trusted, instance-specific runtime parent, generate a fresh test
   generation using the local helper. Do not reuse production's PM2 home,
   socket, credentials, paths, or resolver port. Do not log the private key.
2. An instance-specific systemd socket unit with `Accept=no` owns one Unix
   listening socket. Its resolver service receives the descriptor directly,
   enables both experimental server flags, and receives `resolver.crt` and
   `resolver.key` through its own systemd credentials. No service is started
   by a PM2 worker in this mode.
3. Both isolated PM2 workers receive the same public certificate for that
   generation, the same Unix socket path, and the matching expected hostname.
   They select `systemd-unix-tls`, skip the legacy TCP health probe and spawn,
   and use the pinned connection for both proxy and shared cache. No shared
   private key is passed as a worker environment variable.
4. For rotation in this first experiment, stop the isolated workers and resolver,
   generate a new identity in a new directory, update both units to reference
   the same new generation, then start the isolated services again. This is a
   deliberate stop/start procedure, not automatic or zero-downtime rotation.
   Test that a worker retaining the old pin fails without sending HTTP data.
5. The isolated test must cover a foreign TCP listener, a replaced Unix-socket
   listener with a different key, both workers, missing/expired credentials,
   service restart, shutdown, and repeated cycles. Confirm errors are bounded,
   no secrets are logged, and neither TCP fallback nor unrelated process killing
   occurs. An unrelated same-user/root process able to read the private key can
   impersonate the resolver: it is outside the protection offered by the pin.

This is a reviewable test plan, not executable configuration or proof of
correctness. systemd credential paths, unit ordering, dynamic runtime paths,
failure handling, PM2 environment delivery and real socket behavior must be
verified in isolation before selecting it for deployment.

`examples/resolver-isolated/` contains local systemd socket and service
examples for review. `systemd-analyze verify` accepted their syntax locally;
that does not start them or establish that the example Node executable, build
path, identity paths, permissions, credentials, or service ordering exist on
Raj's host. The example identity path must be prepared explicitly and must
refer to the same generation used by both workers. The examples must not be
installed or used for production.

Local follow-up after Raj's review (not yet validated on his host):

* An isolated-only provisioning script prepares `/run/nuvio-resolver-test-<id>`
  and an `identity` directory matching the example unit paths. It rejects an
  existing instance rather than overwriting it and leaves a failed newly created
  directory for inspection. Tests use a temporary parent and a real OpenSSL test
  identity; the CLI and `/run` setup have not been exercised on Raj's host.
  Rotation remains an explicit stop/start process, not an automatic update.
* The socket's `ExecStartPre` checks that the pre-existing runtime directory
  is a real directory, owned by the invoking user, with exact mode 0700. The
  example intentionally requires provisioning first; `DirectoryMode` alone
  does not repair permissions on an existing directory. The precheck also
  refuses any existing `resolver.sock` path, including a dangling symlink; it
  never unlinks it. These checks are not atomic with systemd's subsequent bind
  and do not protect against a malicious same-user process.
* The service explicitly references and orders after its socket, and has an
  `on-failure` restart with a bounded start rate. These declarations do not
  establish readiness; direct start, crash recovery, retry exhaustion and
  socket activation must be exercised on the isolated systemd instance.
* `RemoveOnStop=no` is explicit. Stale paths must be handled by an isolated
  operator after verifying ownership; automated cleanup must not unlink an
  unverified occupant. This example deliberately has no `[Install]` section
  and is intended for manually controlled isolated tests, not boot enablement.
* No `PrivateNetwork` or AF_UNIX-only restriction is configured: the resolver
  also makes outbound network calls. Any hardening must preserve and test those
  calls. The example uses `/usr/bin/env node`; Raj must verify the systemd PATH,
  the checkout's helper script path and the built resolver path on his host.

Raj's egress review further identifies golf, streamed, goat and relay fetches,
including playlist-selected CDN hosts. In this checkout the streamed API file is
`resolver/src/streamed/api.js`. Proposed filesystem and address-family
restrictions remain candidates, not proven-safe settings: `ProtectHome` may
hide a build or dependency installed under `/root`, and write requirements of
dependencies or future changes cannot be ruled out by inspecting only resolver
source. Verify DNS, all four egress families, a real relay segment, credential
loading, build/module paths and the negative pin case under the exact proposed
unit before applying sandbox hardening. Do not add `MemoryDenyWriteExecute`
without proving Node/V8 and the resolver's WASM worker function correctly.
Sandbox settings do not establish socket-peer identity or replace TLS pinning.

Neither example has been installed or started, and successful unit syntax
checking does not establish actual systemd activation, FD delivery, credential
delivery or restart behavior.

An additional local configuration factory composes this reader with the pinned
Unix client only for the explicit `systemd-unix-tls` mode. It returns no adapter
when no mode is selected and rejects unknown modes or missing identity without
creating an HTTP client. The local experiment wires this mode to the worker
cache and proxy and skips the legacy resolver probe; default behavior remains
legacy. Tests use in-memory connections and injected collaborators; trusted
provisioning, cross-process restart, socket replacement and real deployment
remain unverified. Do not enable this mode outside an isolated test instance.

## Required checks

1. A foreign listener returning 200 and one returning 404 both remain untouched;
   neither receives stream or shared-cache requests. The conflict is clear.
2. Two workers started in either order use the same verified resolver; neither
   silently adopts an unrelated listener or creates a restart storm.
3. Test stale ownership state, PID reuse, resolver exit and port replacement
   between verification and request, and restart during initialization.
4. Test a prior orphan and an occupant belonging to another live supervisor;
   neither is signaled without verified ownership. Distinguish explicit
   operator cleanup from the automated startup path.
5. Test the normal cache fallback and public proxy failure paths, including no
   sensitive request details in logs. Run simulated tests first and repeat in
   a real isolated instance before claiming the behavior is fixed.
