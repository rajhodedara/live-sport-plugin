# PR59 target transport and rollout review

Decision for the intended target: **pinned Unix-domain TLS**. Do not silently
restore unauthenticated TCP to resolve test failures. This is a design/runbook
for operator review, not authorization or proof of a production migration.

Both addon workers need the same public identity and configuration:

```dotenv
RESOLVER_TRANSPORT=systemd-unix-tls
RESOLVER_SOCKET_PATH=/run/<private-instance>/resolver.sock
RESOLVER_CERT_DIR=/run/<public-identity-directory>
RESOLVER_TLS_SERVERNAME=resolver.internal
RESOLVER_PORT=7003
RESOLVER_TRUST_LEGACY_TCP=false
```

The paths are placeholders to be selected for the deployment. The certificate
must be valid for the chosen server name. The worker must receive only the
public certificate; keep the resolver private key in the operator's credential
store. RESOLVER_PORT constrains the cache adapter's legacy-form URL; it is not
a plaintext fallback in this mode.

The repository provides examples/resolver-isolated/nuvio-resolver-test@.socket
and .service, and scripts/provision-isolated-resolver.js. The provisioning helper
is for short-lived isolated tests, not a production credential lifecycle. Review
paths, service identity, directory ownership/permissions, Node and build paths,
LoadCredential sources, socket activation and private-key storage on the target
host. The example units must not be copied blindly into a production service.

Ordered operator checks on a fresh isolated instance:

1. Build the frozen SHA and configure the socket/service with a fresh test
   identity. Verify presented certificate and expected hostname.
2. Start both addon workers with the same public certificate. Compare each
   worker fingerprint to the presented certificate, and verify both can use the
   resolver proxy and shared L2 cache through the socket.
3. Exercise missing/wrong pins, wrong hostname, resolver restart and deliberate
   identity rotation. Confirm failures never contact a plaintext listener.
4. Stop the isolated processes and report exact SHA, config categories and
   sanitized results. See RESOLVER_ISOLATED_TEST_PLAN.md for detailed commands,
   shutdown and rotation checks. Old SHAs' results do not validate this SHA.
5. Only after acceptance, the operator plans a coordinated resolver/worker
   rollout with an explicit rollback to the previous build and configuration.
   Existing workers retain the certificate loaded at startup: restart both
   workers when switching identities. No zero-downtime rotation is promised.

The cache correction also requires the resolver and both workers from the same
candidate. New workers use publication revisions and conditional PATCH to avoid
deleting a newer shared result. Old workers still send unconditional DELETE;
a mixed-version rollout does not provide the new invalidation guarantee. New
workers safely skip invalidation of older snapshots without revisions, and an
older resolver rejects PATCH after a rollback. Those entries may remain until
their existing TTL expires. Test this compatibility behavior on the isolated
instance before choosing a rollout or rollback sequence.

On an unmigrated installation, the addon can still perform local provider
resolution/cache, but resolver-proxied APIs return 503 and no TCP resolver is
spawned or adopted. Invalid explicitly selected TLS config fails startup rather
than downgrading. An emergency compatibility choice is exact
RESOLVER_TRUST_LEGACY_TCP=true with transport unset, but this trusts local
processes and provides no authenticated ownership. It is outside the selected
pinned-TLS target and must be a conscious operator decision.

No production process, PM2 state, listener or credential is changed by this note.
