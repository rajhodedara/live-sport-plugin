# Resolver socket/TLS: isolated test plan (review draft)

This plan is for review before execution. It is not an instruction to deploy,
modify production, change the existing PM2 daemon, run `pm2 save`, or enable
the examples at boot. Keep #59 in draft. Freeze and record the tested SHA.
The default TCP path still has an unresolved unverified-listener issue.

## Preconditions and safety boundary

* Use a separate isolated build and PM2 home, non-production port, instance
  name, socket and runtime directory. Confirm no existing resource occupies
  them; do not kill or unlink an unverified occupant.
* The example paths under `/opt/nuvio-isolated/<id>` and
  `/run/nuvio-resolver-test-<id>` are placeholders. Confirm Node, OpenSSL,
  source helper, built resolver, dependencies, credentials and systemd PATH on
  the actual host. Verify the archive against every commit blob before build.
  Check the actual Node binary and built entry point: `dist.next` in the example
  is a staging path, not necessarily the deployed `dist` entry point.
* The test identity lasts one day and is not a production credential. All
  example processes run as root; a process with access to the key can impersonate
  the resolver. Directory checks and pinning do not defend against malicious
  same-user/root access or eliminate filesystem check/use races.
* Review diagnostics for URLs, headers, cookies, proxy credentials and tokens
  before sharing. Retain a complete sanitized capture from start to shutdown.

## Local preparation to review

The example script `scripts/provision-isolated-resolver.js <id>` creates a new
instance-specific runtime directory and test certificate, and refuses to reuse
an existing name. It writes to `/run` when actually invoked; do not invoke it
against an existing instance or production. Failures leave the new directory for
inspection. The service reads `identity/resolver.crt` and `identity/resolver.key`
via systemd credentials; workers need only the same public certificate. Confirm
both workers receive identical public certificate bytes and never log the key.
This is not yet enforced by the application: establish a trusted delivery path
for each worker and record the SHA-256 fingerprint of each worker's public
certificate and the certificate actually presented by the resolver over the
isolated socket. Compare all three before accepting the run; also exercise a
connection from each worker. Do not infer the loaded certificate solely from
the source file: an already-running worker can retain an earlier pin. For this
isolated run only, `RESOLVER_IDENTITY_DIAGNOSTICS=true` emits one worker startup
record with PID and SHA-256 of the DER certificate used to configure its
transport. Compare each record to the SHA-256 fingerprint of the certificate
presented by the resolver on an actual TLS handshake, and verify both workers
can connect. Compare DER hashes (64 hexadecimal characters, case-insensitive);
OpenSSL's colon-separated SHA-256 fingerprint must be normalized before comparing.
Worker logs may retain records from earlier process generations. Compare each
current worker PID and its startup record; old records do not indicate that the
new workers loaded multiple certificates. Match the PID to the current process,
and consider log timestamps and possible PID reuse.
An independent probe must validate the expected certificate and server name;
an unverified fingerprint alone is not proof of ownership. The record is best
effort, so a missing record is inconclusive;
it does not prove that a request or handshake succeeded. The reader currently
does not check file owner or mode. Never publish private key material.

The example socket precheck requires the runtime directory to be owned by the
service user with mode 0700 and rejects a pre-existing `resolver.sock` path.
`RemoveOnStop=no` is deliberate; a later start may fail until a verified stale
path is handled by the operator. Never automatically remove an unverified path.
After reboot `/run` is cleared: provision a fresh isolated identity and runtime
directory before starting, using a fresh instance name if the prior state cannot
be verified. Do not assume this happens automatically.
The example units are manually controlled, are not installed automatically and
have not been run under systemd. Review their paths, restart limits and ordering
with Raj before using them. No AF_UNIX-only or private-network isolation is set,
since the resolver needs external egress.

For both workers, the experimental configuration must select
`RESOLVER_TRANSPORT=systemd-unix-tls`, set `RESOLVER_SOCKET_PATH` to the
isolated socket, `RESOLVER_CERT_DIR` to the public certificate directory,
`RESOLVER_TLS_SERVERNAME=resolver.internal`, and use the isolated
`RESOLVER_PORT` as the cache adapter's legacy URL constraint. An invalid or
missing identity must not fall back to TCP. These settings do not automatically
provision, reload or rotate credentials.

## Ordered checks

1. On the isolated source checkout run the synthetic tests and the real socket
   tests `node --test tests/resolverUnixSocket.node.cjs tests/resolverUnixTlsSocket.node.cjs`.
   Record the exact commands, platform, results and failures. Passing these is
   not evidence that the packaged server or systemd activation works.
2. After unit and path review, verify the directory owner/mode and isolated
   socket unit before starting the isolated resolver. Confirm the
   resolver receives exactly one activated FD and the intended credentials;
   verify the presented certificate and confirm the provisioned certificate
   name matches `RESOLVER_TLS_SERVERNAME`; check no
   unexpected service, port, process or production daemon changed. A template
   verification warning about a missing instance name must be distinguished
   from a failure of the instantiated unit.
3. Start both isolated workers and compare each startup fingerprint with the
   verified resolver certificate as described above. Verify cache sharing and
   proxy resolution over the intended socket. A foreign TCP listener and a Unix peer with a different
   certificate must receive no sensitive request; missing or stale credentials
   must fail without TCP fallback. Record the peer and listener state without
   killing or unlinking unverified processes.
4. Exercise clean shutdown, abrupt resolver termination, recovery, restart-rate
   limits, worker restart and repeated stop/start. Capture process roles,
   PID/PPID/state, socket owner/path and shutdown markers. Test a new certificate
   generation: stop the isolated workers, provision a new identity under a
   separately verified path, and test the transition deliberately. `LoadCredential`
   is a service-start snapshot, and each worker reads its configured public
   file when its transport is initialized. Replacing that file does not update
   an existing worker transport; workers started at different times can hold
   different pins. Do not assume either side reloads automatically.
   Use a controlled isolated test client with the new pin against the old
   resolver and assert failure without TCP fallback. Configure the isolated
   service credential paths for the new identity before restarting it; merely
   creating a new directory does not switch its `LoadCredential` source.
   Restart the resolver with the new credential snapshot, verify its presented
   fingerprint, then restart both workers with the new pin and verify each works.
   Also verify an old pin fails against the new resolver. No automatic or
   zero-downtime rotation is claimed. If the service hits its start limit, the
   socket may remain active while connections queue or fail; capture both unit
   states. If a stale socket path remains, stop and inspect the isolated units,
   verify the path and its ownership and absence of a live listener, and only
   then arrange operator removal; do not run a generic unlink command.
5. Under any proposed sandbox, validate DNS, golf, streamed and goat routes,
   a real playlist and CDN segment relay, credential loading and an incorrect
   certificate. `ProtectHome` may hide `/root` paths; file-write needs of
   dependencies, including reads from `/root`, are not ruled out by inspecting
   only resolver source. Before considering `ProtectHome`, verify the actual
   isolated dependency tree is readable outside the protected paths. Do not
   claim the settings are safe until exercised under the exact unit.

Stop the experiment on an unexpected production change, unverified listener
contact, leaked secret, restart storm, or an unexplained failure. Report results
per step and SHA. A passing isolated run is evidence for this candidate, not
automatic approval to merge or deploy.
