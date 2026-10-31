# Stable a71e49f integration and remaining acceptance

Both PR candidates now include upstream stable
`a71e49f377a64a76f83104a2fdc03823df43cc84`. The reviewed starting heads were
PR59 e91e9b9 and PR61 c952b58. This closes the previously recorded stable
reconciliation task; neither PR is being merged into stable or deployed here.

The upstream delta from94042c2 contains only:

- TimStreamsProvider API and initial embed Referer move from timst.top to
  tim-streams.com.
- publish-ghcr.yml sets up QEMU before Buildx and includes linux/amd64 plus
  linux/arm64 in its image publication platforms.

Both merged cleanly. PR59 guard/trust/revision-cache behavior and PR61 mapping,
provider parsing, PPV fallback and AK47 playback context remain preserved.
PR61 also retains its TimStreams malformed-feed isolation. The workflow still
runs on pushes to main or manual dispatch, not on these draft-branch updates.
No image was published or arm64 runtime validated in this work.

The existing TimStreams decryption case now exercises the real provider API
wrapper, embed decoding and token decryption with simulated responses. It
asserts API→embed→token call order, the new first-hop Referer and the token
hop's embed-specific Referer/Origin. Its existing8-case suite was added to the
PR59 offline command; no previously selected suite was removed.

## Validation on the merged code

| Candidate | Node22.23.2 and Node24.19.0, Jest29.7.0 |
| --- | --- |
| PR59 |55 Jest suites,523 passed,1 existing TODO |
| PR61 including PR59 |108 Jest suites,923 passed,7 additional Node tests,1 existing TODO |

Commands: `node scripts/test-pr59-offline.cjs` for PR59 and
`node scripts/test-pr61-offline.cjs` for PR61, with the corresponding Node binary.
Both `npm run build` commands completed successfully. The offline preload still
blocks Worker construction, socket connects and listeners. Responses are
controlled fixtures; these are not live-provider, native/WASM or player tests.
Two read-only reviews found no blocking integration issue. Whitespace checks
pass. This is selected validation, not the full repository suite or CI status.

## Acceptance still pending

- Full stable-vs-PR runs under identical locked dependencies/configuration,
  supplying both raw JSONs. The latest locked stable report is still missing.
- Corrected real HTTP/native/cancellation suites and actual arm64 image checks.
- Isolated pinned Unix/TLS matrix: successful controls, explicit wrong-pin/CA/
  hostname failures, both worker identities, restart/rotation and fail-closed
  behavior. In-memory TLS tests do not replace the deployed socket checks.
- Real Stremio/Exo/Nuvio playback, AK47 default/custom-UA segment requests,
  PPV upstream403, DRM/device compatibility and WARP where configured.
- The reported missing TimStreams card needs its actual UTC kickoff, category,
  configuration and complete catalogue/search requests. Provider4-hour retention
  versus football catalogue2.5-hour expiry is still a hypothesis. No live-window
  policy was changed just to make that record appear.

Keep both PRs draft until remaining results are reviewed. A new test SHA
supersedes earlier heads; reports must distinguish their targets. No production
process, PM2 state, cache, credential or live configuration was modified.
