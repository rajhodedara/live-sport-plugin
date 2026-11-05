# Automatic daylight saving time and timezone maintenance

Store each known kickoff as a UTC instant (epoch or ISO with an explicit offset). Store the user's selection as an IANA name such as `America/Edmonton`, `America/New_York` or `Europe/London`. Format the event using its own date and that zone. The same zone can have different offsets for different dates; a fixed `GMT-7` value cannot represent this.

With current ICU timezone data, seasonal changes happen automatically. US and European transition dates differ; southern seasons are reversed, and Lord Howe changes by 30 minutes. No seasonal `.env` edit, clock adjustment or recurring restart is needed. Government rule changes require a reviewed data update; software cannot predict future legislation.

## What is configured

- `src/timezone.js` resolves naive provider clocks in the specified source zone. Repeated autumn clocks choose the earlier instant; nonexistent spring clocks shift forward by the size of the gap. Milliseconds are preserved. Providers should supply an epoch or explicit offset whenever available.
- Catalog kickoff times use the user's IANA zone and the event instant. Date-only replay buckets and ISO poster dates retain their UTC calendar date, independently of the server's zone.
- The configuration page saves IANA names and labels them without a misleading fixed offset.
- Official ICU drop-in data is pinned to IANA **2026f**, an immutable Unicode repository commit, file sizes and SHA-256 hashes in `config/timezone-data.json`. It supplements Node's ICU through `ICU_TIMEZONE_FILES_DIR`, read when the Node process starts. It does not replace the timezone conversion engine.
- `check:timezone` compares numeric calendar fields against independently compiled IANA fixtures, including regional transitions, historical rules, Alberta versus Denver, Morocco and Cuba's temporary rule. This is a finite regression set, not proof for every date in history.
- Candidate builds run the offline check first. The manual VPS workflow also checks before building, swapping artifacts or reloading. A failed check leaves the existing application running. There is no fatal check in application startup or requests.
- The `Timezone rules` workflow tests Node 22 and 24 with the pinned data and checks the official IANA release weekly. Scheduled workflows run from the repository's default branch and may need enabling in a fork. A newer release fails the maintenance check for review; it does not install anything or deploy.

## Local Node or a candidate checkout

Use the same Node executable that will run the application. The preparation command is an explicit network operation to the pinned official Unicode files; it honors the configured HTTP(S) proxy and CA trust. It does not read `.env`, provider credentials or the matches cache.

On a little-endian Linux/macOS host:

```sh
npm ci
npm run timezone:prepare
export ICU_TIMEZONE_FILES_DIR="$PWD/.timezone-data/2026f-le"
npm run check:timezone
npm run build
```

For a local run, keep that variable in the environment of `npm start` or `npm run dev`. In PowerShell, use `$env:ICU_TIMEZONE_FILES_DIR = Join-Path $PWD '.timezone-data/2026f-le'` before the check/build/start commands. The supplied data is little-endian; unsupported platforms fail preparation explicitly instead of guessing.

Preparation uses a separate staging directory, verifies every pinned file, then starts a **pure diagnostic child process** with the candidate data. Only a passing candidate is made available through an exclusively created versioned directory link; its verified target is retained alongside it. The link target is absolute: prepare data at its final location. A backup must preserve that absolute location, or the data must be prepared and verified again at its new location. An existing directory is verified without rewriting it. Corruption is a failure; do not replace files underneath running processes. `node scripts/prepare-timezone-data.cjs --check` verifies the default directory offline. `--directory /absolute/candidate/path` selects another directory for preparation or checking.

A fresh process must print `status: PASS` with no failed controls. Its report includes the actual `execPath`, Node, ICU and timezone-data versions. Setting `process.env.ICU_TIMEZONE_FILES_DIR` inside an already-running application is too late. Updating only the OS timezone package may leave Node's embedded ICU unchanged.

## Docker and PM2

The Dockerfile prepares the pinned data during image construction, sets its absolute path, then runs the build check with the image's Node executable. It performs no timezone downloads on container startup. Rebuild a candidate image to receive a reviewed change; restarting an old image does not update its data. This change has no device playback or arm64 runtime acceptance claim.

`ecosystem.config.js` supplies the versioned directory to new PM2 workers, allowing an explicit `ICU_TIMEZONE_FILES_DIR` override. Before any operator-approved rollout, prepare and verify the candidate with the **actual PM2 interpreter**. A shell's `node` may be different. Keep build, diagnostic and worker interpreters aligned. The manual deployment paths prepare/check the selected directory before building; the shell script also verifies and promotes `dist.next` before reload, retaining `dist.prev` for inspection; they do not update Node or its native dependencies.

No secret rotation, provider change, system-clock change or seasonal offset setting is required. This guide does not authorize a deployment, PM2 reload or cache sync.

After a validated runtime/data rollout, already-correct UTC instants display with the new rules. A naive provider clock converted earlier with stale rules may already have become an incorrect UTC instant in the catalog. Capture the source value and its timezone, then re-sync affected sources under the corrected runtime when authorized. Do not apply a bulk one-hour correction to all events.

## Future rule changes

Run `npm run check:timezone-release` when reviewing an update. It reads only the official IANA version endpoint, with bounded requests. A network failure is reported separately from a newer release. The application and offline build check never call this endpoint.

For a new release, review IANA's change notes, obtain the corresponding official ICU drop-in data, update the pinned manifest and all versioned path references, retain the Unicode notices, and independently regenerate the expected fixtures from that IANA release. Verify old history, the new rules, aliases, gap/fold behavior and the actual deployment interpreter before rollout. Use a new directory for a new version; keep the previous artifact available for a controlled rollback.

On a report of a one-hour discrepancy, collect only the event date, source/provider and raw timestamp, normalized UTC instant, selected IANA zone, deployed commit and the runtime-check JSON from the actual application interpreter. Do not request `.env`, tokens or signed playback URLs. A screenshot alone cannot identify whether the provider clock, normalization, runtime data or display caused the error.

Sources: [IANA timezone database](https://www.iana.org/time-zones), [ICU drop-in timezone updates](https://unicode-org.github.io/icu/userguide/datetime/timezone/#icu4c-tz-update-with-drop-in-res-files-icu-54-and-newer), [Node internationalization](https://nodejs.org/api/intl.html).
