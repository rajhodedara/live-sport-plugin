# DaddyLive Prewarm Cron (VPS-side cache warming)

`scripts/prewarm-cron.js` warms the add-on's stream cache on a schedule so a user's
first click is near-instant instead of waiting on a cold DaddyLive token mint.

This document explains **why** the built-in prewarm leaves DaddyLive cold, what the
script actually does, and how to install it as a cron job or systemd timer.

> Nothing here changes runtime behaviour. The script is standalone; the app does not
> require it, and no `src/` file was modified to add it.

---

## 1. Why a manual cron is needed

Streams are minted lazily in `handleStream()` (`src/streams.js`) and cached in
`StreamResolveCache` (`src/services/StreamResolveCache.js`). That cache is:

* **in memory** — nothing is written to disk, so a restart starts cold; and
* **per worker** — under PM2 cluster (`pm2 start dist/index.js -i <WORKERS>`) each
  worker holds its **own** Map. A warm entry exists only in the worker that minted it.

The app already has a prewarm tick (`src/services/CronService.js` → `prewarmPopular`),
but it deliberately does **not** cover everything:

| Limitation | Effect on DaddyLive |
| :--- | :--- |
| `if (m.category === 'networks') return false;` | Every DaddyLive **24/7 channel** (`dlv_ch_*`) is never prewarmed. |
| `PREWARM_MAX_MATCHES` (default **12**) per tick | Only the first 12 live fixtures get warmed. Setting `0` acts as a master switch disabling all prewarm jobs and fire-aheads. |
| Runs only on worker 0 (`src/index.js`) | The other workers' caches stay cold. |

`scripts/prewarm-cron.js` closes those gaps: it warms **fixtures and 24/7 network
rows**, for as many targets as you like, on the schedule you choose — and by
repeating each target it can reach every worker.

---

## 2. What the script actually does

1. Reads the match list from `GET <base>/api/matches`.
2. Selects targets that carry a `daddylive` source. By default it skips replays and
   events that are not live yet (using the app's own `isMatchLive` / `isReplayMatch`
   from `src/catalog` when importable, else an equivalent local clock check).
   24/7 network rows are always included in the default scope.
3. **Slices** that pool to at most `--max` targets per run and **rotates** the slice
   between runs (see §2a), because the full catalog is too large to warm in one tick.
4. For each target it calls `GET <base>/stream/tv/nuvio_sport_<id>.json` — the exact
   same endpoint a client uses. That drives
   `resolveCache.getOrCreate → mintVerifiedSources → provider.resolveStream + verifyStreams`,
   populating the cache of whichever worker answers.
5. Reports per target whether a **real manifest URL** came back (`warmed`) or only the
   web-player link (`fallback-only` = **not warm**), then prints a summary.

### 2a. Why `--max` + rotation exist (read this)

On a real deployment the DaddyLive catalog is large: a representative run reported
**988 targets** (fixtures + 24/7 channels). At `--repeat 4` that is **~3952 requests** —
it cannot finish inside a 2-minute cron interval, so runs overlap and saturate the
resolver. The symptom is `The operation was aborted due to timeout` appearing for the
cron **and** for real users.

The defaults address this:

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `--max <n>` | **40** | Warm at most `n` targets per run. `0` = unlimited (manual sweeps only). |
| `--rotate` | **on** | Continue from the last run's position, so successive runs walk the whole pool. |
| `--no-rotate` | | Always warm the same first `--max` targets. |
| `--state <path>` | `<tmpdir>/nuvio-prewarm-cursor.json` | Where the rotation cursor is stored. |

Fixtures are ordered first (popular, then latest kickoff), so the time-critical content
is refreshed most often; evergreen 24/7 channels are covered over several rotations.

### Loopback is required

`GET /api/matches` is gated by `isLocalDirectRequest()` (`src/services/localRequest.js`):
it answers `403 {reason:"loopback_only"}` unless the caller is a **direct local hit**
with **no forwarding headers** (`x-forwarded-for`, `forwarded`, `x-real-ip`,
`cf-connecting-ip`) from a loopback/RFC1918 peer.

So the script defaults to `http://127.0.0.1:<PORT>` and **you should not point it at
`https://nuviosports.xyz`** — that request would traverse Cloudflare, trip the gate, and
403. Warms must go over loopback.

---

## 3. Options

```
node scripts/prewarm-cron.js [options]

  --base <url>         Default: $PREWARM_BASE_URL, else http://127.0.0.1:<PORT> (from .env)
  --max <n>            Target cap per run (default 40). 0 = unlimited
  --rotate             Continue from the last run's position (default ON)
  --no-rotate          Always warm the same first --max targets
  --state <path>       Rotation cursor file (default <tmpdir>/nuvio-prewarm-cursor.json)
  --all                Include every match, not just live/upcoming ones
  --networks           Only 24/7 network rows (dlv_ch_*)
  --fixtures           Only fixture rows (dlv_*)
  --repeat <n>         Requests per target (default 4). Set >= PM2 worker count
  --concurrency <n>    Targets in flight at once (default 2, hard cap 4)
  --delay-ms <n>       Delay between repeat requests per target (default 250)
  --timeout-ms <n>     Per-request timeout (default 20000)
  --source <name>      Only warm matches having this source (default daddylive)
  --dry-run            List targets + URLs, then stop (still reads the match list)
  --offline            With --dry-run: make no network calls at all
```

**Exit codes**

| Code | Meaning |
| :--- | :--- |
| `0` | Usable run: something warmed, **or** there were no targets (nothing to do). |
| `1` | Total failure: match list unreadable, or every target failed. |
| `2` | Bad usage (unknown flag / unparseable value). |

Exit `1` is intentionally reserved for total failure so a partially-successful cron run
does not spam you with mail.

---

## 4. Install

Pick **one** of the two methods.

### 4a. Cron (simplest)

```bash
# edit root's crontab
crontab -e
```

Add (adjust the path and `--repeat` to your worker count — see §5). The `flock` wrapper
is **strongly recommended**: it makes the job skip its turn if the previous run is still
going, so a slow run can never pile onto the next one.

```cron
*/2 * * * * flock -n /var/lock/nuvio-prewarm.lock -c 'cd /root/nuvio-live-sports && /usr/bin/node scripts/prewarm-cron.js --max 40 --repeat 4' >> /var/log/nuvio-prewarm.log 2>&1
```

`flock` ships with `util-linux`, present on standard Ubuntu/Debian images. If you omit it,
the `--max` cap alone still bounds each run — but overlap becomes possible on a slow day.

Reload/verify:

```bash
crontab -l
tail -f /var/log/nuvio-prewarm.log     # watch a run
```

> Use the absolute path to `node`. Find it with `which node`.
> Keep the log small: add a weekly truncate, e.g.
> `0 4 * * 0 truncate -s 0 /var/log/nuvio-prewarm.log`.

### 4b. systemd timer (more robust)

`/etc/systemd/system/nuvio-prewarm.service`:

```ini
[Unit]
Description=Nuvio DaddyLive prewarm
After=network.target

[Service]
Type=oneshot
WorkingDirectory=/root/nuvio-live-sports
ExecStart=/usr/bin/node scripts/prewarm-cron.js --max 40 --repeat 4
User=root
```

`/etc/systemd/system/nuvio-prewarm.timer`:

```ini
[Unit]
Description=Run Nuvio DaddyLive prewarm every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=15s

[Install]
WantedBy=timers.target
```

Enable and verify:

```bash
systemctl daemon-reload
systemctl enable --now nuvio-prewarm.timer
systemctl list-timers | grep prewarm
journalctl -u nuvio-prewarm -n 50 --no-pager   # last run's output
```

Run it once by hand at any time:

```bash
systemctl start nuvio-prewarm.service
```

---

## 5. Sizing `--repeat` to your cluster

PM2 round-robins connections across workers, and each worker has its own cache. One
request per target may warm only one worker. Set `--repeat` to **at least the worker
count** (a bit more is fine):

```bash
pm2 ls          # count the processes named nuvio-sports
# e.g. 4 workers -> --repeat 4
```

Recommended starting schedule: **every 2 minutes** with `--max 40 --repeat <workers>`.
Because the cache TTL is 60 s–10 min, a 2-minute cadence keeps hot targets comfortably
warm while rotation walks the rest of the catalog over time. Do not go below `*/1`, do not
raise `--concurrency` above 4, and keep `--max` low enough that a run finishes well inside
the interval (40 targets at `--repeat 4` is roughly 60–90 s in the common case).

If runs still overlap, either lower `--max` or increase the interval — do **not** raise
`--concurrency`.

---

## 6. Verify it worked

**Dry run first** — shows exactly what would be hit, without warming:

```bash
cd /root/nuvio-live-sports
node scripts/prewarm-cron.js --dry-run
```

Expect a `selected: N target(s)` line and one `would warm …` line per target. If you see
`HTTP 403 … loopback_only`, you pointed it at the public host — switch to `127.0.0.1`.

**Confirm a target is genuinely warm** — call the stream endpoint twice and compare:

```bash
# first call may mint (slower)
time curl -s http://127.0.0.1:<APP_PORT>/stream/tv/nuvio_sport_<matchId>.json | head -c 300
# second call should be fast and already contain /api/manifest?
time curl -s http://127.0.0.1:<APP_PORT>/stream/tv/nuvio_sport_<matchId>.json | head -c 300
```

A response containing an `"url":"…/api/manifest?…"` entry means the token was minted
(that stream is playable). A response containing only `"externalUrl":"/watch?…"` is the
web-player fallback — the mint failed and the target is **not** warm.

**Read a scheduled run's log:**

```bash
# cron
tail -n 40 /var/log/nuvio-prewarm.log
# systemd
journalctl -u nuvio-prewarm -n 40 --no-pager
```

Look for the summary line, e.g.:

```
[prewarm] targets: 24  warmed: 21  fallback-only: 3  failed: 0   (18.4s)
```

`fallback-only > 0` on a channel means the provider served the web-player link instead
of a manifest for that target; that specific target is not warm.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
| :--- | :--- |
| `FATAL: … HTTP 403` + `loopback_only` | Base URL is not loopback. Use `--base http://127.0.0.1:<PORT>`. |
| `FATAL: could not reach …` | App not running, or wrong port. Check `pm2 ls` and `PORT` in `.env`. |
| `selected: 0 target(s)` | No live DaddyLive matches right now. Try `--all` or `--networks`. |
| Many `failed … aborted due to timeout` | The run is too heavy. Lower `--max` and/or `--concurrency`, and make sure `flock` is in the cron line so runs cannot overlap. |
| Everything `fallback-only` | The DaddyLive decode/verify step is failing upstream (site structure change, or the VPS IP is being blocked). Run `node scripts/debug-vps-daddylive.js` to locate the failing stage. |
| Warming works by hand, not from cron | Cron's PATH/`node` differs. Use the absolute `node` path and `cd` into the repo first. |
| Warm entries vanish within minutes | Expected with a 60 s–10 min TTL; that is exactly why the cron repeats. |
