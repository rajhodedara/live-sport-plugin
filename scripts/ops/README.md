# scripts/ops

Small, read-mostly operations helpers for the VPS. **Nothing here is installed or scheduled by the repo**; the operator decides what to run and when.

| Script | What it does | Changes anything? |
|---|---|---|
| `health-alert.sh` | Checks `/health`, available RAM, swap, disk, pm2 restart growth, orphaned helpers and core-dump size; posts to a Discord webhook once per problem (cooldown) and once when it clears. | No. Only sends the webhook. |
| `reap-orphans.sh` | Lists orphaned helper processes (`run_gasm_india.js`, old `node -e` / `node -` runs, `/tmp/*.js`). | Report only. `--kill` stops them (SIGTERM, grace, SIGKILL). |

## Setup (operator)
```bash
# 1. webhook lives outside the repo
echo 'NUVIO_ALERT_WEBHOOK=https://discord.com/api/webhooks/...' > /root/.nuvio-alert.env
chmod 600 /root/.nuvio-alert.env

# 2. try it without sending anything
scripts/ops/health-alert.sh --dry-run
scripts/ops/reap-orphans.sh

# 3. then schedule (example crontab lines)
*/5 * * * * flock -n /var/lock/nuvio-health-alert.lock /root/nuvio-live-sports/scripts/ops/health-alert.sh >> /var/log/nuvio-health-alert.log 2>&1
17 * * * *  /root/nuvio-live-sports/scripts/ops/reap-orphans.sh >> /var/log/nuvio-reap.log 2>&1
```

## Safety notes
- `reap-orphans.sh` only considers processes whose parent is pid 1, older than `REAP_MIN_AGE_SECONDS` (default 3600), whose command line matches a known helper pattern. It never touches pm2 daemons, the cluster workers (`dist/index.js`), the resolver (`dist/src/server.js`, `dist.next/src/server.js`), pm2-logrotate, caddy or warp. It prints a label, not the full command line, because arguments can carry tokens.
- It does not match `bash -c ... | node` wrappers; those need a manual look.
- A process in state `Z` (zombie) is already dead; killing it does nothing, it disappears when its parent is reaped.
- Thresholds are environment variables; see the header of `health-alert.sh`.
- The alert messages contain only metrics (counts, MB, percentages, HTTP code), never URLs or env values.
