#!/usr/bin/env bash
# Finds (and optionally stops) orphaned helper processes: node children whose
# parent died and that have been running for a long time (run_gasm_india.js,
# leftover `node -e` / `node -` debug runs, /tmp/*.js scripts).
#
# REPORT ONLY by default. Nothing is stopped unless you pass --kill.
# Never touches: pm2 daemons, the cluster workers (dist/index.js), the resolver
# (dist/src/server.js, dist.next/src/server.js), pm2-logrotate, caddy, warp.
#
#   reap-orphans.sh                 report candidates
#   reap-orphans.sh --count         print only the number of candidates
#   reap-orphans.sh --kill          SIGTERM, wait, then SIGKILL the candidates
#   reap-orphans.sh --min-age=7200  only processes older than 2 h (default 3600 s)
#
# Env: REAP_MIN_AGE_SECONDS, REAP_ORPHAN_PPID (default 1), REAP_GRACE_SECONDS (default 5)
set -u -o pipefail

MIN_AGE=${REAP_MIN_AGE_SECONDS:-3600}
ORPHAN_PPID=${REAP_ORPHAN_PPID:-1}
GRACE=${REAP_GRACE_SECONDS:-5}
KILL=0
COUNT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --kill) KILL=1 ;;
    --count) COUNT_ONLY=1 ;;
    --min-age=*) MIN_AGE=${arg#*=} ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
case "$MIN_AGE$GRACE" in *[!0-9]*) echo "numeric values expected" >&2; exit 2 ;; esac

CANDIDATE='run_gasm_india\.js|(^| )node -e |(^| )node -( |$)|(^| )node /tmp/[^ ]+\.js'
PROTECT='God Daemon|dist/index\.js|dist/src/server\.js|dist\.next/src/server\.js|pm2-logrotate|/usr/bin/caddy|warp-svc'

# Printing the full command line could leak tokens that ride in arguments.
label() {
  case "$1" in
    *run_gasm_india.js*) echo "run_gasm_india.js" ;;
    *"node -e "*) echo "node -e <inline script>" ;;
    *"node -") echo "node - <stdin script>" ;;
    *"node - "*) echo "node - <stdin script>" ;;
    *) set -- $1; echo "node ${2##*/}" ;;
  esac
}

candidates=$(ps -eo pid=,ppid=,etimes=,rss=,args= | while read -r pid ppid age rss args; do
  [ "$pid" = "$$" ] && continue
  [ "$ppid" = "$ORPHAN_PPID" ] || continue
  [ "$age" -ge "$MIN_AGE" ] 2>/dev/null || continue
  printf '%s' "$args" | grep -Eq "$PROTECT" && continue
  printf '%s' "$args" | grep -Eq "$CANDIDATE" || continue
  echo "$pid $age $rss $(label "$args")"
done)

n=0; rss_total=0
if [ -n "$candidates" ]; then
  n=$(printf '%s\n' "$candidates" | wc -l)
  rss_total=$(printf '%s\n' "$candidates" | awk '{s+=$3} END{print int(s/1024)}')
fi

if [ "$COUNT_ONLY" = 1 ]; then echo "$n"; exit 0; fi

echo "orphan candidates: $n (about ${rss_total} MB RSS), min age ${MIN_AGE}s, parent pid ${ORPHAN_PPID}"
[ "$n" -gt 0 ] && printf '%s\n' "$candidates" | awk '{printf "  pid=%-8s age=%-9s rss=%5dMB  ", $1, $2 "s", $3/1024; $1=$2=$3=""; sub(/^ +/,""); print}'

if [ "$KILL" = 1 ] && [ "$n" -gt 0 ]; then
  echo "stopping candidates (SIGTERM, ${GRACE}s grace, then SIGKILL)"
  printf '%s\n' "$candidates" | while read -r pid _; do
    # Re-check right before acting: the pid must still be an orphan.
    [ "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$ORPHAN_PPID" ] || { echo "  skip $pid (changed)"; continue; }
    kill -TERM "$pid" 2>/dev/null
  done
  sleep "$GRACE"
  printf '%s\n' "$candidates" | while read -r pid _; do
    # A zombie (state Z) is already dead; it only waits for its parent to reap it.
    case "$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')" in ""|Z*) continue ;; esac
    if kill -0 "$pid" 2>/dev/null && [ "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$ORPHAN_PPID" ]; then
      kill -KILL "$pid" 2>/dev/null && echo "  killed $pid"
    fi
  done
fi
exit 0
