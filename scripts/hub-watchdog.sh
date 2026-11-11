#!/usr/bin/env bash
# The hub's watchdog (SMA map: Watchdog and outage, Stop and restart). systemd restarts bb-server when it dies (Restart=always), not when it
# hangs with the process alive. This loop knocks on the door every 15 seconds and decides:
#   door answers                          -> ok; a lift that was going is reported «risen» (or «false alarm» when the same process answers)
#   door answers but the port is not ours -> «process unproven»: says so, never kills the other process
#   systemd says activating               -> still loading, wait
#   no MainPID                            -> no record: a stop; systemd lifts it itself, wait
#   same process as our last lift, young  -> false alarm, wait
#   8 silent knocks in a row (as on main; LP_WATCH_REFUSED_AFTER may shorten the count of refused ones) -> outage: «it fell» to Telegram,
#                                            kill the hung one first, start the lift, backoff counted from the log (30, 60, 120 s), at most
#                                            3 lifts; out of tries -> «lift failed», to the person
# The HTTP 200 of the version request alone says «the hub answers» (outage count, lift). When a bb is here the window's own board request
# (bb thread list --json) is a second, advisory reading: ok, auth (the CLI cannot sign in) or unknown; it is recorded and printed, and it
# never counts toward an outage, never triggers a lift and never fails status.
# Outages are appended to ~/.lane-pilot/outages.jsonl with their times: first_silence, outage, message_sent/_not_sent, lifts, risen.
#
# Usage (on the hub):  hub-watchdog.sh run | status [--force] | stop [--force] | restart [--force] | lift [--force] | install | daily | rotate | db-ready | outages | print-unit | selfcheck
#   lift       when the door already answers it does nothing (Door already answers — nothing)
#   install    a systemd unit with sudo; without admin a systemd --user unit (or an @reboot crontab line); on a Mac a LaunchAgent
#   daily      the lifts per day from the outage log (Daily lift log)
#   rotate     the outage log rotates by day, 14 days kept (Day of a log line, Day rotation)
#   db-ready   readiness is a real query: PRAGMA quick_check and the encoding of the hub databases, read-only (not an open port)
#   outages    the last outage as one block with times
#   print-unit the startup entry text for system|user|mac without registering anything (the task ships disabled until install runs)
#   selfcheck  verbs and host prerequisites by a list; the exit code is the number of failures
# Five lifts within an hour refuse the next one and call the person (Five restarts in a row); --force lifts anyway.
# A door that answers from a process proven outside the unit's cgroup refuses status/stop/restart/lift (--force goes on); a holder whose pid or
# cgroup cannot be read is «unknown»: printed, never a refusal.
# LP_WATCH_DRY=1 (drills) records instead of acting. LP_WATCH_SYSTEMCTL names the service-manager command (drills point it at a stub or a
# stand-in unit); LP_WATCH_USER=1 drops the sudo prefix and uses systemctl --user.
# Exit codes: 0 the machine is as asked, 1 failed or down, 2 a refusal a named flag would lift (--force for live work, the lift limit
# and a door answered from a foreign process).
# One watchdog at a time: a lock file (flock, or an atomic mkdir lock where flock is missing, e.g. a stock Mac); install writes a unit
# that runs `run` (Restart=always; the unit caps a fallen watchdog at five restarts an hour unless LP_WATCH_RESTART_CAP says otherwise,
# and the watchdog's own dying word goes to the owner, so the cap never leaves the hub silently unwatched). A second watchdog that finds the lock waits LP_WATCH_LOCK_HELD_SEC
# (60 s; not in a dry run) before it exits, so the cap is not spent on it.
set -uo pipefail
SERVICE="${LP_WATCH_SERVICE:-bb-server}"
DOOR="${LP_WATCH_DOOR:-http://127.0.0.1:38886/install/version}"
DOOR_PORT="${DOOR#*://}"; DOOR_PORT="${DOOR_PORT%%/*}"; DOOR_PORT="${DOOR_PORT##*:}"
if [ -z "$DOOR_PORT" ] || [ -n "${DOOR_PORT//[0-9]/}" ]; then case "$DOOR" in https:*) DOOR_PORT=443 ;; *) DOOR_PORT=80 ;; esac; fi
KNOCK_SEC="${LP_WATCH_KNOCK_SEC:-15}"
SUSPECT_AFTER="${LP_WATCH_SUSPECT_AFTER:-8}"
REFUSED_AFTER="${LP_WATCH_REFUSED_AFTER:-8}"
FIRST_SEC="${LP_WATCH_FIRST_SEC:-0}"  # main looks at once; a longer blind start is a setting
STOP_SEC="${LP_WATCH_STOP_SEC:-}"       # empty: the unit's own TimeoutStopUSec, 90 s when unreadable
RESTART_SETTLE_SEC="${LP_WATCH_RESTART_SETTLE_SEC:-10}"
LOCK_HELD_SEC="${LP_WATCH_LOCK_HELD_SEC:-60}"
KILL_HOLDER="${LP_WATCH_KILL_HOLDER:-0}"   # 1: a repeated lift also kills a port holder proven outside the unit; 0 (main): it is only named
BOARD_EVERY="${LP_WATCH_BOARD_EVERY:-0}"   # every N-th knock `run` also makes the board request (a CLI start each time); 0 (main): never
RESTART_CAP="${LP_WATCH_RESTART_CAP-5}"    # the unit's cap on restarts of a fallen watchdog per hour; 0 or empty: no cap (a capped watchdog that stays down warns the owner itself)
RESTART_WAIT_SEC="${LP_WATCH_RESTART_WAIT_SEC:-120}"
MAX_LIFTS="${LP_WATCH_MAX_LIFTS:-3}"
STATE_DIR="${LP_WATCH_STATE:-$HOME/.lane-pilot}"
LOG="$STATE_DIR/outages.jsonl"
LOCK="$STATE_DIR/hub-watchdog.lock"
TG_ENV="${LP_WATCH_TG_ENV:-$HOME/.config/lp-metrics/tg.env}"
TG_API="${LP_WATCH_TG_API:-https://api.telegram.org}"
DRY="${LP_WATCH_DRY:-0}"
LIFT_WINDOW_SEC="${LP_WATCH_LIFT_WINDOW_SEC:-3600}"
MAX_LIFTS_IN_WINDOW="${LP_WATCH_MAX_LIFTS_IN_WINDOW:-5}"
BB="${LP_WATCH_BB:-bb}"
LP_DB="${LP_WATCH_LP_DB:-$HOME/.bb/plugins/lane-pilot/data.db}"
PLATFORM="${LP_WATCH_PLATFORM:-$(uname -s)}"
SYSTEMCTL="${LP_WATCH_SYSTEMCTL:-systemctl}"
FORCE=0
mkdir -p "$STATE_DIR"
# The sudo prefix and the --user flag: a user service or a stub manager needs neither.
if [ "${LP_WATCH_USER:-0}" = 1 ] || [ "$SYSTEMCTL" != "systemctl" ]; then SUDO=""; SYSTYPE="--user"; else SUDO="sudo -n"; SYSTYPE=""; fi

platform() { case "$PLATFORM" in Darwin|darwin) echo darwin ;; *) echo linux ;; esac; }
have_sudo() { [ -n "$SUDO" ] && sudo -n true 2>/dev/null; }

door_probe() { # ok | refused | timeout — the HTTP 200 of the version request alone, exactly as on main
  local code rc
  code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$DOOR" 2>/dev/null)"; rc=$?
  if [ "$code" = "200" ]; then echo "ok"; return; fi
  [ "$rc" = "7" ] && echo "refused" || echo "timeout"
}
door_answers() { [ "$(door_probe)" = "ok" ]; }
board_probe() { # ok | auth | unknown | none — the window's board request, advisory: only a clean answer or a clean sign-in refusal is named
  local out rc
  command -v "$BB" >/dev/null 2>&1 || { echo "none"; return; }
  if command -v timeout >/dev/null 2>&1; then out="$(timeout 15 "$BB" thread list --json 2>/dev/null)"; rc=$?; else out="$("$BB" thread list --json 2>/dev/null)"; rc=$?; fi
  if [ "$rc" = "0" ] && printf '%s' "$out" | python3 -c 'import json,sys; sys.exit(0 if isinstance(json.load(sys.stdin), list) else 1)' 2>/dev/null; then echo "ok"; return; fi
  [ "$rc" != "0" ] && printf '%s' "$out" | grep -qiE 'auth|sign.?in|log ?in|token|unauthorized' && { echo "auth"; return; }
  echo "unknown"
}

main_pid() {
  [ "$DRY" = 1 ] && { echo 4242; return; }
  if [ "$(platform)" = darwin ]; then
    launchctl print "gui/$(id -u)/$SERVICE" 2>/dev/null | awk -F'= *' '/^[[:space:]]*pid =/{print $2; exit}'
  else
    $SYSTEMCTL $SYSTYPE show -p MainPID --value "$SERVICE" 2>/dev/null
  fi
}
active_state() {
  [ "$DRY" = 1 ] && { echo active; return; }
  if [ "$(platform)" = darwin ]; then
    launchctl print "gui/$(id -u)/$SERVICE" 2>/dev/null | awk -F'= *' '/^[[:space:]]*state =/{s=$2} END{ if (s=="running") print "active"; else if (s!="") print "inactive" }'
  else
    $SYSTEMCTL $SYSTYPE show -p ActiveState --value "$SERVICE" 2>/dev/null
  fi
}
uptime_sec() {
  local pid up; pid="$(main_pid)"; [ "$DRY" = 1 ] && { echo 0; return; }
  if [ "$(platform)" = darwin ]; then
    up="$( [ -n "$pid" ] && [ "$pid" != "0" ] && ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')"
    python3 -c 'import sys,re; t=sys.argv[1]; m=re.fullmatch(r"(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)", t or ""); print(int(m.group(1) or 0)*86400+int(m.group(2) or 0)*3600+int(m.group(3))*60+int(m.group(4)) if m else 0)' "$up"
  else
    up="$( [ -n "$pid" ] && [ "$pid" != "0" ] && ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"; case "$up" in ''|*[!0-9]*) echo 0 ;; *) echo "$up" ;; esac
  fi
}

# The lift command per platform, shared by the watchdog and the restart; it knows where to detach (restart calls it under setsid).
lift_cmd() {
  if [ "$(platform)" = darwin ]; then echo "launchctl kickstart -k gui/$(id -u)/$SERVICE";
  elif have_sudo; then echo "sudo -n $SYSTEMCTL restart $SERVICE"; else echo "$SYSTEMCTL --user restart $SERVICE"; fi
}
kill_cmd() {
  if [ "$(platform)" = darwin ]; then echo "launchctl kill SIGKILL gui/$(id -u)/$SERVICE";
  elif have_sudo; then echo "sudo -n $SYSTEMCTL kill -s SIGKILL $SERVICE"; else echo "$SYSTEMCTL --user kill -s SIGKILL $SERVICE"; fi
}
service_restart() { $(lift_cmd); } # the one lift command (SMA m_ctl_lift_cmd): the watchdog's lift and the restart share it
service_kill()    { [ "$(platform)" = darwin ] && launchctl kill SIGKILL "gui/$(id -u)/$SERVICE" || { have_sudo && $SUDO $SYSTEMCTL kill -s SIGKILL "$SERVICE" || $SYSTEMCTL --user kill -s SIGKILL "$SERVICE"; }; }
service_stop()    { [ "$(platform)" = darwin ] && launchctl bootout "gui/$(id -u)/$SERVICE" || { have_sudo && $SUDO $SYSTEMCTL stop --no-block "$SERVICE" || $SYSTEMCTL --user stop --no-block "$SERVICE"; }; }
service_result()  { [ "$(platform)" = linux ] && $SYSTEMCTL $SYSTYPE show -p Result -p ExecMainStatus --value "$SERVICE" 2>/dev/null; }

port_holders() { # pids listening on the door port
  if [ "$(platform)" = darwin ]; then lsof -nP -iTCP:"$DOOR_PORT" -sTCP:LISTEN -t 2>/dev/null;
  else ss -ltnpH "sport = :$DOOR_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u; fi
}
port_listener_seen() { # the port shows a local listener at all (a proxied or stubbed door shows none, and is nobody's to kill)
  if [ "$(platform)" = darwin ]; then lsof -nP -iTCP:"$DOOR_PORT" -sTCP:LISTEN 2>/dev/null | grep -q .;
  else ss -ltnH "sport = :$DOOR_PORT" 2>/dev/null | grep -q .; fi
}
port_holder_unreadable() { # a listener exists but no pid can be attributed to it
  port_listener_seen && [ -z "$(port_holders)" ]
}
proc_is_ours() { # the holder is the service's MainPID or its descendant
  local pid="$1" main; main="$(main_pid)"
  [ -n "$main" ] && [ "$main" != "0" ] || return 1
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ]; do
    [ "$pid" = "$main" ] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}
unit_cgroup() { # the unit's control group path; empty when it cannot be read (no systemd, a Mac, a stub)
  [ "$(platform)" = darwin ] && return 0
  $SYSTEMCTL $SYSTYPE show -p ControlGroup --value "$SERVICE" 2>/dev/null | head -1
}
holder_place() { # inside | outside | unknown — only a pid that was read, in a cgroup file that was read, against a unit cgroup that was read, is outside
  local pid="$1" cg line path seen=0
  case "$pid" in ''|*[!0-9]*) echo unknown; return ;; esac
  cg="$(unit_cgroup)"
  [ -n "$cg" ] && [ -r "/proc/$pid/cgroup" ] || { echo unknown; return; }
  while IFS= read -r line; do
    path="${line#*:*:}"; seen=1
    case "$path" in "$cg"|"$cg"/*) echo inside; return ;; esac
  done < "/proc/$pid/cgroup"
  [ "$seen" = 1 ] && echo outside || echo unknown
}
never_killed() { [ "$1" = "1" ] || [ "$1" = "$$" ] || [ "$1" = "$PPID" ]; }
foreign_door_refusal() { # door answers from a process proven outside the unit: say so, never kill it; unreadable is «unknown», printed only
  local h bad="" unknown=""
  for h in $(port_holders); do
    case "$(holder_place "$h")" in
      outside) proc_is_ours "$h" || bad="$h" ;;
      unknown) unknown="$h" ;;
    esac
  done
  if [ -n "$bad" ]; then
    if [ "$FORCE" = 1 ]; then echo "door answers, process unproven: port $DOOR_PORT is held by pid $bad outside $SERVICE; --force given, going on"; return 1; fi
    echo "door answers, process unproven: port $DOOR_PORT is held by pid $bad, outside $SERVICE (pid $(main_pid)); nothing was touched (--force goes on)"
    return 0
  fi
  if [ -n "$unknown" ] || port_holder_unreadable; then echo "unknown: the holder of port $DOOR_PORT cannot be attributed to $SERVICE or to another process; going on"; fi
  return 1
}

live_work() { # the open attempts of Lane Pilot, "attempt task thread" per line; exit 2 when the database cannot be read
  local out
  [ -f "$LP_DB" ] && command -v sqlite3 >/dev/null 2>&1 || return 2
  # the repo's OPEN_ATTEMPT_STATES (src/rooms/contracts/state-machine.ts)
  out="$(sqlite3 -readonly "$LP_DB" "select a.id||' '||a.task_id||' '||coalesce(a.thread_id,'-') from lane_pilot_attempt a where a.state in ('queued','spawn_requested','spawn_unknown','running','cancel_requested');" 2>/dev/null)" || return 2
  printf '%s' "$out"
  [ -z "$out" ] || echo
}

say() { # Telegram, the same bot and topic as the daily report; a send that cannot happen names its reason in the log.
  local reason=""
  if [ ! -f "$TG_ENV" ]; then reason="no tg.env at $TG_ENV"
  else
    # shellcheck disable=SC1090
    . "$TG_ENV"
    [ -n "${TG_TOKEN:-}" ] || reason="TG_TOKEN empty in $TG_ENV"
    [ -n "$reason" ] || [ -n "${TG_CHAT:-}" ] || reason="TG_CHAT empty in $TG_ENV"
  fi
  if [ -z "$reason" ]; then
    local rc=0
    curl -fsS -m 20 -X POST "$TG_API/bot${TG_TOKEN}/sendMessage" -d chat_id="$TG_CHAT" ${TG_TOPIC:+-d message_thread_id="$TG_TOPIC"} --data-urlencode text="$1" >/dev/null 2>&1 || rc=$?
    [ "$rc" = "0" ] && { record "message_sent" "$1"; return 0; }
    reason="telegram refused (curl $rc)"
  fi
  record "message_not_sent" "$reason"
  echo "message not sent: $reason" >&2
  return 0
}

json_text() { # a JSON string body: quote to apostrophe, backslash, tab, CR, newline escaped, other control characters blanked (pure bash: macOS too)
  local t="$1"
  t="${t//\\/\\\\}"; t="${t//\"/\'}"; t="${t//$'\t'/\\t}"; t="${t//$'\r'/\\r}"; t="${t//$'\n'/\\n}"; t="${t//[[:cntrl:]]/ }"
  printf '%s' "$t"
}
record() { printf '{"at":%s,"event":"%s","detail":"%s"}\n' "$(date +%s)" "$1" "$(json_text "$2")" >> "$LOG"; }
record_at() { printf '{"at":%s,"event":"%s","detail":"%s"}\n' "$1" "$2" "$(json_text "$3")" >> "$LOG"; }

lifts_in_window() { local since=$(( $(date +%s) - LIFT_WINDOW_SEC )); [ -f "$LOG" ] && awk -v since="$since" -F'"at":' '/"event":"lift"/ { split($2, a, ","); if (a[1] + 0 >= since) n++ } END { print n + 0 }' "$LOG" || echo 0; }

backoff_sec() { # the next try's wait and the last recorded lift's time: counted from the log, so a watchdog restart keeps the doubling
  python3 - "$LOG" <<'EOF'
import json, sys
count = last = 0
try:
    for line in open(sys.argv[1]):
        try: row = json.loads(line)
        except ValueError: continue
        ev = row.get("event")
        if ev in ("risen", "false_alarm", "lift_skipped", "out_of_tries", "lift_refused"): count, last = 0, 0
        elif ev == "lift": count, last = count + 1, int(row.get("at", 0))
except OSError: pass
print(min(30 * 2 ** count, 120), last)
EOF
}

lift() { # kill the hung one first, then start; returns 0 when the door answers within the backoff
  local wait try pid h
  if door_answers; then
    foreign_door_refusal && return 2
    record "lift_skipped" "the door already answers"; echo "nothing to do: the door answers"; return 0
  fi
  if [ "$FORCE" != 1 ] && [ "$(lifts_in_window)" -ge "$MAX_LIFTS_IN_WINDOW" ]; then
    record "lift_refused" "$MAX_LIFTS_IN_WINDOW lifts within ${LIFT_WINDOW_SEC}s; --force would lift anyway"
    echo "refused: $MAX_LIFTS_IN_WINDOW lifts within ${LIFT_WINDOW_SEC}s; --force would lift anyway"
    say "Хаб BB: $MAX_LIFTS_IN_WINDOW подъёмов за час подряд — больше не поднимаю, нужен человек (journalctl -u $SERVICE -n 200, или --force)."
    return 2
  fi
  if [ "$DRY" = 1 ]; then record "lift" "dry: would kill ${SERVICE} and start it"; return 1; fi
  for try in $(seq 1 "$MAX_LIFTS"); do
    read -r wait _ <<< "$(backoff_sec)" # the log only picks which wait (30, 60, 120 s); the wait itself is whole, as on main
    case "$wait" in ''|*[!0-9]*) wait=$((30 << (try - 1))); [ "$wait" -gt 120 ] && wait=120 ;; esac # no python3, no log: main's doubling
    pid="$(main_pid)"
    record "lift" "try $try, killing pid ${pid:-none}"
    [ -n "$pid" ] && [ "$pid" != "0" ] && service_kill
    if [ "$try" -gt 1 ] && [ -n "$pid" ] && [ "$pid" != "0" ]; then
      # a repeated lift names a port holder proven outside the unit while the MainPID was read; it is killed only where
      # LP_WATCH_KILL_HOLDER=1 says so (main kills none, and a process that is not ours is never killed by a guess)
      for h in $(port_holders); do
        never_killed "$h" && continue
        [ "$(holder_place "$h")" = outside ] || continue
        if [ "$KILL_HOLDER" = 1 ]; then record "port_holder_killed" "killing port holder $h"; kill -9 "$h" 2>/dev/null
        else record "port_holder_seen" "port $DOOR_PORT is held by pid $h outside $SERVICE; not killed (LP_WATCH_KILL_HOLDER=1 would)"; fi
      done
    fi
    sleep 2
    { service_restart 2>&1 || true; service_result; } | grep -v '^$' | tail -n 3 > "$STATE_DIR/hub-watchdog.lift-reason"
    echo "$(main_pid)" > "$STATE_DIR/hub-watchdog.lifted-pid"
    local waited=0
    while [ "$waited" -lt "$wait" ]; do sleep 5; waited=$((waited + 5)); door_answers && return 0; done
    record "lift_without_outcome" "try $try, waited ${wait}s"
  done
  return 1
}

status() {
  local state; state="$(active_state)"
  [ -n "$state" ] || { echo "unknown: systemd does not answer for $SERVICE"; return 1; }
  if door_answers; then
    foreign_door_refusal && return 2
    echo "ok: $SERVICE $state, pid $(main_pid), up $(uptime_sec)s, the door answers"
    local board; board="$(board_probe)"; [ "$board" = none ] || echo "board request (advisory): $board"
    return 0
  fi
  if [ "$state" = "active" ]; then echo "down: $SERVICE is active (pid $(main_pid)) but the door does not answer — process unproven"; else echo "down: $SERVICE is $state"; fi
  return 1
}

stop_wait_sec() { # how long a graceful stop may take: LP_WATCH_STOP_SEC, else the unit's TimeoutStopUSec, 90 s when unreadable
  local raw sec
  if [ -n "$STOP_SEC" ]; then echo "$STOP_SEC"; return; fi
  [ "$(platform)" = linux ] && raw="$($SYSTEMCTL $SYSTYPE show -p TimeoutStopUSec --value "$SERVICE" 2>/dev/null | head -1)"
  sec="$(python3 - "${raw:-}" <<'PY'
import re, sys
raw = sys.argv[1].strip()
unit = {"d": 86400, "h": 3600, "min": 60, "m": 60, "s": 1, "ms": 0.001, "us": 0.000001}
total, seen = 0.0, False
for num, name in re.findall(r"(\d+(?:\.\d+)?)\s*(ms|us|min|d|h|m|s)", raw):
    total += float(num) * unit[name]; seen = True
if not seen and raw.isdigit(): total, seen = int(raw) / 1e6, True  # raw microseconds
print(int(total + 0.999) if seen and total > 0 else 90)
PY
)"
  case "$sec" in ''|*[!0-9]*) sec=90 ;; esac
  echo "$sec"
}

stop_guard() { # the refusals of stop and restart: a proven foreign door, live work actually read; 0 go on, 2 a refusal --force lifts
  if door_answers && foreign_door_refusal; then return 2; fi
  local workers rc
  workers="$(live_work)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "unknown live work: the Lane Pilot database cannot be read ($LP_DB); proceeding"
    record "stop_unknown_live_work" "database unreadable, proceeding"
  elif [ -n "$workers" ]; then
    if [ "$FORCE" != 1 ]; then
      echo "refused: live work holds the stop (--force would stop anyway):"; echo "$workers"
      record "stop_refused" "live work: $(echo "$workers" | tr '\n' ' ')"
      return 2
    fi
    record "stop_forced" "live work overridden: $(echo "$workers" | tr '\n' ' ')"
  fi
  return 0
}

stop_hub() { # the graceful stop: a proven foreign door or live work refuses (exit 2 names --force); a process that stays is killed hard
  stop_guard || return $?
  service_stop
  local waited=0 state="active" limit; limit="$(stop_wait_sec)"
  while [ "$waited" -lt "$limit" ]; do
    state="$(active_state)"
    case "$state" in inactive|dead|failed) break ;; esac
    sleep 1; waited=$((waited + 1))
  done
  case "$state" in
    inactive|dead|failed) echo "stopped: $SERVICE is $state" ;;
    *) service_kill; record "stopped_hard" "the process did not leave in ${limit}s"; echo "stopped hard: the process did not leave in ${limit}s and was killed" ;;
  esac
}

restart_hub() { # the refusals of stop stand; then what main does — the manager's own restart — started detached first, so a caller inside the unit survives
  stop_guard || return $?
  setsid nohup bash -c "$(lift_cmd)" >/dev/null 2>&1 &
  sleep "$RESTART_SETTLE_SEC" # the old process may still answer for a moment: main waited 10 s before it asked
  local waited="$RESTART_SETTLE_SEC"
  while [ "$waited" -lt "$RESTART_WAIT_SEC" ]; do
    door_answers && { echo "ok: the door answers after ${waited}s"; return 0; }
    sleep 3; waited=$((waited + 3))
  done
  door_answers && { echo "ok: the door answers after ${waited}s"; return 0; }
  echo "down: the door did not answer in ${RESTART_WAIT_SEC}s"; return 1
}

restart_cap_lines() { # the unit's cap on restarts of a fallen watchdog: only where LP_WATCH_RESTART_CAP names it (a capped watchdog that stays down leaves the hub unwatched)
  case "$RESTART_CAP" in ''|*[!0-9]*|0) return 0 ;; esac
  printf 'StartLimitIntervalSec=3600\nStartLimitBurst=%s\n' "$RESTART_CAP"
}

lock_held_exit() { # the unit restarts an exit at once: wait before leaving, so a second watchdog does not spin (and a restart cap, where set, is not spent); not in a dry run
  [ "$DRY" = 1 ] || sleep "$LOCK_HELD_SEC"
  exit 0
}

take_lock() { # one watchdog per machine: flock where it exists, an atomic mkdir lock where it does not (a stock Mac)
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK"
    flock -n 9 || { echo "another watchdog runs (lock $LOCK)"; lock_held_exit; }
  else
    local dir="$LOCK.d" holder
    if ! mkdir "$dir" 2>/dev/null; then
      holder="$(cat "$dir/pid" 2>/dev/null)"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$dir"; mkdir "$dir" 2>/dev/null || { echo "another watchdog runs (lock $dir)"; lock_held_exit; }
      else echo "another watchdog runs (lock $dir)"; lock_held_exit; fi
    fi
    echo $$ > "$dir/pid"
    trap 'rm -rf "$LOCK.d"' EXIT
  fi
}

run() {
  take_lock
  # A dead watchdog is relaunched by the unit at most five times an hour; a dying word (never on a stop signal or a clean leave,
  # which are 143/130/0) tells the owner, so the cap's give-up is never silent (SMA m_sp_watch_loop).
  trap 'rc=$?; case "$rc" in 0|130|143) ;; *) record "watchdog_exit" "the watchdog died with exit $rc"; say "Сторож хаба BB упал (код $rc). systemd поднимет его, но не больше 5 раз за час — потом хаб без присмотра: systemctl status lp-hub-watchdog, journalctl -u lp-hub-watchdog -n 100." ;; esac' EXIT
  record "start" "watchdog up; the first look waits ${FIRST_SEC}s"
  [ "$FIRST_SEC" -gt 0 ] && sleep "$FIRST_SEC"
  local silent=0 refused_run=0 down_since=0 silent_pid="" probe state pid board last_board="" knocks=0
  while true; do
    rotate >/dev/null
    probe="$(door_probe)"
    if [ "$probe" = "ok" ]; then
      if [ "$down_since" -gt 0 ]; then
        local minutes=$(( ($(date +%s) - down_since + 59) / 60 ))
        if [ -n "$silent_pid" ] && [ "$(main_pid)" = "$silent_pid" ]; then
          record "false_alarm" "the same process $silent_pid answers again"
          say "Хаб BB: тревога была ложной — тот же процесс отвечает снова (pid $silent_pid, молчал около $minutes мин)."
        else
          record "risen" "down about $minutes min"
          say "Хаб BB поднялся: не отвечал около $minutes мин."
        fi
        rm -f "$STATE_DIR/hub-watchdog.out-tries-said"
        down_since=0; silent_pid=""
      fi
      silent=0; refused_run=0
      # the board request is a second reading, advisory: recorded when it changes, never counted
      knocks=$((knocks + 1)); board="$last_board"
      [ "$BOARD_EVERY" -gt 0 ] 2>/dev/null && [ $((knocks % BOARD_EVERY)) -eq 0 ] && board="$(board_probe)"
      if [ "$board" != "$last_board" ]; then
        case "$board:$last_board" in none:*|ok:) ;; *) record "board_$board" "the board request says $board while the door answers" ;; esac
        last_board="$board"
      fi
    else
      state="$(active_state)"; pid="$(main_pid)"
      if [ "$state" = "activating" ] || [ "$state" = "reloading" ]; then silent=0; refused_run=0         # still loading — wait
      elif [ -z "$pid" ] || [ "$pid" = "0" ]; then silent=0; refused_run=0                               # no record — a stop; systemd lifts it
      elif [ "$pid" = "$(cat "$STATE_DIR/hub-watchdog.lifted-pid" 2>/dev/null)" ] && [ "$(uptime_sec)" -lt 120 ]; then silent=0; refused_run=0   # same process we lifted, still young: false alarm
      else                                                                                                # suspect: silence in a row, any kind, as on main
        silent=$((silent + 1))
        if [ "$probe" = "refused" ]; then refused_run=$((refused_run + 1)); else refused_run=0; fi
      fi
      if [ "$silent" -ge "$SUSPECT_AFTER" ] || { [ "$probe" = "refused" ] && [ "$refused_run" -ge "$REFUSED_AFTER" ]; }; then
        local count="$silent" kind="timeout"; [ "$probe" = "refused" ] && kind="refused"
        [ "$down_since" -eq 0 ] && rm -f "$STATE_DIR/hub-watchdog.out-tries-said" # a new outage gets its own «lift failed» word
        down_since=$(( $(date +%s) - count * KNOCK_SEC ))
        record_at "$down_since" "first_silence" "first knock without an answer ($kind)"
        record "outage" "$kind: no answer for $((count * KNOCK_SEC))s from pid $pid ($state)"
        silent_pid="$pid"
        say "Хаб BB упал: сервер не отвечает $((count * KNOCK_SEC)) с ($kind, процесс $pid висит). Поднимаю."
        if ! lift; then
          local reason; reason="$(grep -m1 . "$STATE_DIR/hub-watchdog.lift-reason" 2>/dev/null)"
          record "out_of_tries" "$MAX_LIFTS lifts without an answer${reason:+: $reason}"
          if [ ! -f "$STATE_DIR/hub-watchdog.out-tries-said" ]; then # the «lift failed» word once per outage
            say "Хаб BB не поднялся после $MAX_LIFTS попыток.${reason:+ Причина: $reason} Нужен человек: ssh ubuntu@10.8.0.1, journalctl -u $SERVICE -n 100."
            : > "$STATE_DIR/hub-watchdog.out-tries-said"
          fi
          sleep 600
        fi
        silent=0; refused_run=0
      fi
    fi
    sleep "$KNOCK_SEC"
  done
}

daily() { # lifts and outages per day, from the log and its rotated days
  cat "$STATE_DIR"/outages*.jsonl 2>/dev/null | python3 -c '
import collections, datetime, json, sys
count = collections.Counter()
for line in sys.stdin:
    try: row = json.loads(line)
    except ValueError: continue
    count[(datetime.date.fromtimestamp(int(row["at"])).isoformat(), row["event"])] += 1
for (day, event), n in sorted(count.items()): print(day, event, n)'
}

outages() { # the last outage as one block, each line with its time
  [ -f "$LOG" ] || { echo "no outages on record"; return 0; }
  python3 - "$LOG" <<'EOF'
import datetime, json, sys
rows = []
for line in open(sys.argv[1]):
    try: rows.append(json.loads(line))
    except ValueError: pass
start = next((i for i in range(len(rows) - 1, -1, -1) if rows[i].get("event") == "first_silence"), 0)
for r in rows[start:]:
    print(datetime.datetime.fromtimestamp(int(r["at"])).strftime("%Y-%m-%d %H:%M:%S"), r.get("event"), r.get("detail", ""))
EOF
}

rotate() { # a line belongs to its day: older lines go to outages-<day>.jsonl, 14 days kept
  [ -s "$LOG" ] || return 0
  local first day
  first="$(head -1 "$LOG" | sed -n 's/.*"at":\([0-9]*\).*/\1/p')"
  [ -n "$first" ] || return 0
  day="$(python3 -c 'import datetime,sys; print(datetime.date.fromtimestamp(int(sys.argv[1])).isoformat())' "$first")"
  [ "$day" = "$(date +%F)" ] && return 0
  mv "$LOG" "$STATE_DIR/outages-$day.jsonl" && : > "$LOG"
  ls -1t "$STATE_DIR"/outages-*.jsonl 2>/dev/null | tail -n +15 | while read -r old; do mv "$old" "$old.expired"; done
  echo "rotated: outages-$day.jsonl"
}

db_ready() { # a real query, read-only: quick_check and UTF-8, on the hub's databases
  local db status=0 check enc
  for db in ${LP_WATCH_DBS:-$HOME/.bb/bb.db $HOME/.bb/plugins/lane-pilot/data.db}; do
    [ -f "$db" ] || { echo "missing: $db"; status=1; continue; }
    check="$(sqlite3 -readonly "$db" 'PRAGMA quick_check;' 2>&1 | head -1)"; enc="$(sqlite3 -readonly "$db" 'PRAGMA encoding;' 2>&1)"
    if [ "$check" = "ok" ] && [ "$enc" = "UTF-8" ]; then echo "ready: $db"; else echo "not ready: $db ($check, $enc)"; status=1; fi
  done
  return $status
}

print_unit() { # the startup entry text for system|user|mac: the two-minute delay and the five-restart cap are part of it
  local self="$2"
  case "$1" in
    system) cat <<EOF
[Unit]
Description=Lane Pilot hub watchdog (knocks on bb-server, lifts a hung one)
After=bb-server.service
$(restart_cap_lines)
[Service]
Type=simple
User=$USER
Environment=LP_WATCH_FIRST_SEC=120
ExecStart=/bin/bash $self run
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
      ;;
    user) cat <<EOF
[Unit]
Description=Lane Pilot hub watchdog (user)
$(restart_cap_lines)
[Service]
Environment=LP_WATCH_FIRST_SEC=120
ExecStart=/bin/bash $self run
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
EOF
      ;;
    mac) cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>pro.vechkasov.lp-hub-watchdog</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$self</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>LP_WATCH_FIRST_SEC</key><string>120</string></dict>
  <!-- launchd has no hourly burst cap like systemd's; a 720 s throttle is the same ceiling: at most five relifts of a fallen watchdog in an hour -->
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>720</integer>
  <key>StandardOutPath</key><string>$STATE_DIR/hub-watchdog.log</string><key>StandardErrorPath</key><string>$STATE_DIR/hub-watchdog.log</string>
</dict></plist>
EOF
      ;;
    *) echo "usage: print-unit system|user|mac" >&2; return 2 ;;
  esac
}

selfcheck() { # verbs and host prerequisites by a list; the exit code is the number of failures
  local fails=0 tmp tool
  note() { if [ "$2" = 0 ]; then echo "ok: $1"; else echo "FAIL: $1"; fails=$((fails + 1)); fi; }
  for tool in bash curl python3 sqlite3 awk; do command -v "$tool" >/dev/null 2>&1; note "prerequisite: $tool" $?; done
  { command -v flock >/dev/null 2>&1 || [ "$(platform)" = darwin ]; }; note "prerequisite: a lock tool (flock, or mkdir on a Mac)" $?
  { command -v systemctl >/dev/null 2>&1 || command -v launchctl >/dev/null 2>&1; }; note "prerequisite: a service manager" $?
  tmp="$(mktemp -d)"
  [ -w "$tmp" ] && [ -d "$STATE_DIR" ] && [ -w "$STATE_DIR" ]; note "prerequisite: state dir writable" $?
  local verb rc
  for verb in status rotate daily db-ready outages; do
    LP_WATCH_STATE="$tmp" LP_WATCH_DRY=1 LP_WATCH_TG_ENV=/nonexistent LP_WATCH_DOOR="http://127.0.0.1:1/" LP_WATCH_FIRST_SEC=0 bash "$0" "$verb" >/dev/null 2>&1
    rc=$?; [ "$rc" -le 1 ]; note "verb: $verb" $?
  done
  rm -rf "$tmp"
  echo "selfcheck: $fails failure(s)"
  return "$fails"
}

install_mac() { # the watchdog agent on a Mac: a LaunchAgent, at login and kept alive
  local self="$1" plist="$HOME/Library/LaunchAgents/pro.vechkasov.lp-hub-watchdog.plist"
  print_unit mac "$self" > "$plist"
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "installed: LaunchAgent pro.vechkasov.lp-hub-watchdog"
  # First Mac check: verbs and host prerequisites by a list; the exit code is the number of failures.
  selfcheck
}

install_user() { # watchdog install without admin: a user unit, or the crontab when there is no user systemd
  local self="$1"
  if systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    print_unit user "$self" > "$HOME/.config/systemd/user/lp-hub-watchdog.service"
    systemctl --user daemon-reload && systemctl --user enable --now lp-hub-watchdog.service && echo "installed: user unit lp-hub-watchdog.service (loginctl enable-linger $USER keeps it after logout)"
  else
    echo "no user systemd here: using an @reboot crontab line"
    ( crontab -l 2>/dev/null | grep -v hub-watchdog; echo "@reboot /bin/bash $self run >> $STATE_DIR/hub-watchdog.log 2>&1" ) | crontab - && echo "installed: @reboot crontab line"
  fi
}

install_unit() {
  local self; self="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$0")"
  [ "$(platform)" = darwin ] && { install_mac "$self"; return $?; }
  sudo -n true 2>/dev/null || { echo "no administrator rights (sudo -n refused): installing a user service instead"; install_user "$self"; return $?; }
  print_unit system "$self" | sudo -n tee /etc/systemd/system/lp-hub-watchdog.service >/dev/null
  sudo -n systemctl daemon-reload && sudo -n systemctl enable --now lp-hub-watchdog.service && echo "installed: lp-hub-watchdog.service"
}

case "${1:-status}" in
  run) run ;;
  status) [ "${2:-}" = "--force" ] && FORCE=1; status; exit $? ;;
  stop) [ "${2:-}" = "--force" ] && FORCE=1; stop_hub; rc=$?; [ "$rc" -eq 0 ] && { status || true; }; exit "$rc" ;;
  restart) [ "${2:-}" = "--force" ] && FORCE=1; restart_hub; exit $? ;;
  lift) [ "${2:-}" = "--force" ] && FORCE=1; lift && { status; exit 0; } || exit $? ;;
  install) install_unit ;;
  daily) daily ;;
  rotate) rotate ;;
  db-ready) db_ready; exit $? ;;
  outages) outages; exit $? ;;
  print-unit) print_unit "${2:-system}" "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$0")"; exit $? ;;
  selfcheck) selfcheck; exit $? ;;
  *) echo "usage: $0 run|status|stop|restart|lift|install|daily|rotate|db-ready|outages|print-unit|selfcheck" >&2; exit 2 ;;
esac
