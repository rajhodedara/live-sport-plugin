#!/usr/bin/env bash
# Lightweight health check for the VPS with Discord alerts. Meant for cron
# (for example every 5 minutes). It only READS: it never restarts or kills.
#
# Checks: /health answer and latency, available RAM, swap use, disk use,
# pm2 restart counter growth, orphaned helper processes, core dump size.
# Each problem alerts once, then stays quiet for the cooldown, and a single
# "resolved" message is sent when it clears.
#
# The webhook is a secret: put it OUTSIDE the repo, for example
#   echo 'NUVIO_ALERT_WEBHOOK=https://discord.com/api/webhooks/...' > /root/.nuvio-alert.env
#   chmod 600 /root/.nuvio-alert.env
# With no webhook (or --dry-run) it only prints what it would send.
#
#   health-alert.sh [--dry-run] [--test]
#
# Env (defaults): NUVIO_BASE_URL (http://127.0.0.1:7000), NUVIO_ALERT_ENV
# (/root/.nuvio-alert.env), NUVIO_ALERT_STATE (/var/tmp/nuvio-alert),
# NUVIO_ALERT_COOLDOWN (1800 s), NUVIO_ALERT_AVAIL_MB_WARN (250),
# NUVIO_ALERT_SWAP_PCT_WARN (70), NUVIO_ALERT_DISK_PCT_WARN (85),
# NUVIO_ALERT_HEALTH_MS_WARN (5000), NUVIO_ALERT_ORPHANS_WARN (10),
# NUVIO_ALERT_CORES_DIR (/root/cores), NUVIO_ALERT_CORES_MB_WARN (3000)
set -u -o pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${NUVIO_ALERT_ENV:-/root/.nuvio-alert.env}
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

BASE=${NUVIO_BASE_URL:-http://127.0.0.1:7000}
STATE=${NUVIO_ALERT_STATE:-/var/tmp/nuvio-alert}
COOLDOWN=${NUVIO_ALERT_COOLDOWN:-1800}
AVAIL_MB_WARN=${NUVIO_ALERT_AVAIL_MB_WARN:-250}
SWAP_PCT_WARN=${NUVIO_ALERT_SWAP_PCT_WARN:-70}
DISK_PCT_WARN=${NUVIO_ALERT_DISK_PCT_WARN:-85}
HEALTH_MS_WARN=${NUVIO_ALERT_HEALTH_MS_WARN:-5000}
ORPHANS_WARN=${NUVIO_ALERT_ORPHANS_WARN:-10}
CORES_DIR=${NUVIO_ALERT_CORES_DIR:-/root/cores}
CORES_MB_WARN=${NUVIO_ALERT_CORES_MB_WARN:-3000}
WEBHOOK=${NUVIO_ALERT_WEBHOOK:-}
DRY=0; TEST=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --test) TEST=1 ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
[ -z "$WEBHOOK" ] && DRY=1
mkdir -p "$STATE" 2>/dev/null || { echo "cannot create $STATE" >&2; exit 0; }
HOST=$(hostname 2>/dev/null || echo vps)

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS="\\n"} {print}' ; }

send() {
  local text="$1"
  if [ "$DRY" = 1 ]; then echo "[dry-run] $text"; return 0; fi
  curl -s -o /dev/null --max-time 10 -H 'Content-Type: application/json' \
    -d "{\"content\":\"$(json_escape "$text")\"}" "$WEBHOOK" || echo "webhook post failed" >&2
}

now() { date +%s; }

# problem KEY MESSAGE: alert once per cooldown. ok KEY: send "resolved" if it was alerting.
problem() {
  local key="$1" msg="$2" f="$STATE/$1.alert" last
  echo "PROBLEM $key: $msg"
  last=$(cat "$f" 2>/dev/null || echo 0)
  if [ $(( $(now) - last )) -ge "$COOLDOWN" ]; then
    send ":warning: [$HOST] $msg"
    now > "$f"
  fi
}
ok() {
  local key="$1" f="$STATE/$1.alert"
  if [ -f "$f" ]; then send ":white_check_mark: [$HOST] resolved: $key"; rm -f "$f"; fi
}

[ "$TEST" = 1 ] && send ":wrench: [$HOST] test message from health-alert.sh"

# 1. /health
read -r code secs < <(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 10 "$BASE/health" 2>/dev/null || echo "000 0")
ms=$(awk -v s="${secs:-0}" 'BEGIN{printf "%d", s*1000}')
if [ "${code:-000}" != "200" ]; then problem health "/health answered HTTP ${code:-000}"
elif [ "$ms" -gt "$HEALTH_MS_WARN" ]; then problem health "/health slow: ${ms} ms"
else ok health; fi

# 2. RAM available and swap
avail_mb=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)
if [ "${avail_mb:-0}" -lt "$AVAIL_MB_WARN" ]; then problem memory "low available RAM: ${avail_mb} MB"; else ok memory; fi
swap_pct=$(awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{ if (t>0) printf "%d", (t-f)*100/t; else print 0 }' /proc/meminfo)
if [ "${swap_pct:-0}" -gt "$SWAP_PCT_WARN" ]; then problem swap "swap ${swap_pct}% used"; else ok swap; fi

# 3. Disk
disk_pct=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
if [ "${disk_pct:-0}" -gt "$DISK_PCT_WARN" ]; then problem disk "root disk ${disk_pct}% used"; else ok disk; fi

# 4. pm2 restarts since the last run (needs pm2 and node on PATH)
if command -v pm2 >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  total=$(pm2 jlist 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d.slice(d.search(/\[\s*[{\]]/)));console.log(a.reduce((n,p)=>n+((p.pm2_env&&p.pm2_env.restart_time)||0),0))}catch(e){console.log("")}})')
  if [ -n "$total" ]; then
    prev=$(cat "$STATE/restarts" 2>/dev/null || echo "$total")
    echo "$total" > "$STATE/restarts"
    if [ "$total" -gt "$prev" ]; then problem restarts "pm2 restarts grew: $prev -> $total"; else ok restarts; fi
  fi
fi

# 5. Orphaned helpers (reuses reap-orphans.sh in count mode)
if [ -x "$HERE/reap-orphans.sh" ]; then
  orphans=$("$HERE/reap-orphans.sh" --count 2>/dev/null || echo 0)
  if [ "${orphans:-0}" -gt "$ORPHANS_WARN" ]; then problem orphans "$orphans orphaned helper processes (run scripts/ops/reap-orphans.sh)"; else ok orphans; fi
fi

# 6. Core dumps
if [ -d "$CORES_DIR" ]; then
  cores_mb=$(du -sk "$CORES_DIR" 2>/dev/null | awk '{printf "%d", $1/1024}')
  if [ "${cores_mb:-0}" -gt "$CORES_MB_WARN" ]; then problem cores "core dumps use ${cores_mb} MB in $CORES_DIR"; else ok cores; fi
fi
exit 0
