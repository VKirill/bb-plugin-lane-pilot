#!/usr/bin/env bash
# The hub's watchdog (SMA map: Watchdog and outage, Stop and restart). systemd restarts bb-server when it dies (Restart=always), not when it
# hangs with the process alive. This loop knocks on the door every 15 seconds and decides:
#   door answers                          -> ok; a lift that was going is reported «risen» (or «false alarm» when the same process answers)
#   door answers but the port is not ours -> «process unproven»: says so, never kills the other process
#   systemd says activating               -> still loading, wait
#   no MainPID                            -> no record: a stop; systemd lifts it itself, wait
#   same process as our last lift, young  -> false alarm, wait
#   3 refused knocks or 8 timeouts in a row -> outage: «it fell» to Telegram, kill the hung one first, start the lift,
#                                            backoff counted from the log (30, 60, 120 s), at most 3 lifts; out of tries -> «lift failed», to the person
# The knock is the window's own board request when a bb is here (bb thread list --json): a CLI that cannot sign in counts as unknown,
# never as silence, so a lost token cannot make the watchdog kill a healthy hub. Without a bb on PATH only the version request is made.
# Outages are appended to ~/.lane-pilot/outages.jsonl with their times: first_silence, outage, message_sent/_not_sent, lifts, risen.
#
# Usage (on the hub):  hub-watchdog.sh run | status | stop [--force] | restart [--force] | lift [--force] | install | daily | rotate | db-ready | outages | print-unit | selfcheck
#   lift       when the door already answers it does nothing (Door already answers — nothing)
#   install    a systemd unit with sudo; without admin a systemd --user unit (or an @reboot crontab line); on a Mac a LaunchAgent
#   daily      the lifts per day from the outage log (Daily lift log)
#   rotate     the outage log rotates by day, 14 days kept (Day of a log line, Day rotation)
#   db-ready   readiness is a real query: PRAGMA quick_check and the encoding of the hub databases, read-only (not an open port)
#   outages    the last outage as one block with times
#   print-unit the startup entry text for system|user|mac without registering anything (the task ships disabled until install runs)
#   selfcheck  verbs and host prerequisites by a list; the exit code is the number of failures
# Five lifts within an hour refuse the next one and call the person (Five restarts in a row); --force lifts anyway.
# LP_WATCH_DRY=1 (drills) records instead of acting. LP_WATCH_SYSTEMCTL names the service-manager command (drills point it at a stub or a
# stand-in unit); LP_WATCH_USER=1 drops the sudo prefix and uses systemctl --user.
# Exit codes: 0 the machine is as asked, 1 failed or down, 2 a refusal a named flag would lift (--force for live work and the lift limit).
# One watchdog at a time: a lock file (flock, or an atomic mkdir lock where flock is missing, e.g. a stock Mac); install writes a unit
# that runs `run` (Restart=always, capped at five restarts an hour, first look two minutes after start).
set -uo pipefail
SERVICE="${LP_WATCH_SERVICE:-bb-server}"
DOOR="${LP_WATCH_DOOR:-http://127.0.0.1:38886/install/version}"
DOOR_PORT="${DOOR#*://}"; DOOR_PORT="${DOOR_PORT%%/*}"; DOOR_PORT="${DOOR_PORT##*:}"
if [ -z "$DOOR_PORT" ] || [ -n "${DOOR_PORT//[0-9]/}" ]; then case "$DOOR" in https:*) DOOR_PORT=443 ;; *) DOOR_PORT=80 ;; esac; fi
KNOCK_SEC="${LP_WATCH_KNOCK_SEC:-15}"
SUSPECT_AFTER="${LP_WATCH_SUSPECT_AFTER:-8}"
REFUSED_AFTER="${LP_WATCH_REFUSED_AFTER:-3}"
FIRST_SEC="${LP_WATCH_FIRST_SEC:-120}"
STOP_SEC="${LP_WATCH_STOP_SEC:-30}"
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

door_probe() { # ok | refused | timeout | unknown — the same board request the window makes, behind the same token, when a bb is here
  local code rc out
  code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$DOOR" 2>/dev/null)"; rc=$?
  if [ "$code" != "200" ]; then [ "$rc" = "7" ] && echo "refused" || echo "timeout"; return; fi
  command -v "$BB" >/dev/null 2>&1 || { echo "ok"; return; }
  if command -v timeout >/dev/null 2>&1; then out="$(timeout 15 "$BB" thread list --json 2>&1)"; rc=$?; else out="$("$BB" thread list --json 2>&1)"; rc=$?; fi
  if [ "$rc" = "0" ] && printf '%s' "$out" | python3 -c 'import json,sys; sys.exit(0 if isinstance(json.load(sys.stdin), list) else 1)' 2>/dev/null; then echo "ok"; return; fi
  # The CLI's own auth error is unknown, not silence: a lost token must not read as a dead hub.
  printf '%s' "$out" | grep -qiE 'auth|sign.?in|log ?in|token|unauthorized' && echo "unknown" || echo "timeout"
}
door_answers() { [ "$(door_probe)" = "ok" ]; }

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
service_restart() { [ "$(platform)" = darwin ] && launchctl kickstart -k "gui/$(id -u)/$SERVICE" || { have_sudo && $SUDO $SYSTEMCTL restart "$SERVICE" || $SYSTEMCTL --user restart "$SERVICE"; }; }
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
foreign_door_refusal() { # door answers but the listener is not the service's process: say so, never kill the other process
  local h bad=""
  for h in $(port_holders); do proc_is_ours "$h" || bad="$h"; done
  [ -n "$bad" ] || port_holder_unreadable || return 1
  echo "door answers, process unproven: port $DOOR_PORT is held by pid ${bad:-unknown}, not $SERVICE pid $(main_pid); nothing was touched"
  return 0
}

live_work() { # the open attempts of Lane Pilot, "attempt task thread" per line; exit 2 when the database cannot be read
  [ -f "$LP_DB" ] || return 2
  sqlite3 -readonly "$LP_DB" "select a.id||' '||a.task_id||' '||coalesce(a.thread_id,'-') from lane_pilot_attempt a where a.state in ('running','cancel_requested');" 2>/dev/null
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

record() { printf '{"at":%s,"event":"%s","detail":"%s"}\n' "$(date +%s)" "$1" "${2//\"/\'}" >> "$LOG"; }
record_at() { printf '{"at":%s,"event":"%s","detail":"%s"}\n' "$1" "$2" "${3//\"/\'}" >> "$LOG"; }

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
  local wait last_at try pid left h
  if door_answers; then
    foreign_door_refusal && return 1
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
    read -r wait prev_lift <<< "$(backoff_sec)"
    pid="$(main_pid)"
    record "lift" "try $try, killing pid ${pid:-none}"
    [ -n "$pid" ] && [ "$pid" != "0" ] && service_kill
    if [ "$try" -gt 1 ]; then # a repeated lift first kills whatever holds the port (a leftover child or a foreign process)
      for h in $(port_holders); do proc_is_ours "$h" || { record "port_holder_killed" "killing port holder $h"; kill -9 "$h" 2>/dev/null; }; done
    fi
    sleep 2
    { service_restart 2>&1 || true; service_result; } | grep -v '^$' | tail -n 3 > "$STATE_DIR/hub-watchdog.lift-reason"
    echo "$(main_pid)" > "$STATE_DIR/hub-watchdog.lifted-pid"
    # only the remainder since the last recorded attempt: a watchdog restart does not restart the backoff
    left=$wait
    [ "${prev_lift:-0}" != "0" ] && left=$(( wait - ($(date +%s) - prev_lift) ))
    [ "$left" -lt 0 ] && left=0
    local end=$(( $(date +%s) + left ))
    while [ "$(date +%s)" -lt "$end" ]; do sleep 5; door_answers && return 0; done
    record "lift_without_outcome" "try $try, waited ${wait}s"
  done
  return 1
}

status() {
  local state; state="$(active_state)"
  [ -n "$state" ] || { echo "unknown: systemd does not answer for $SERVICE"; return 1; }
  if door_answers; then
    foreign_door_refusal && return 1
    echo "ok: $SERVICE $state, pid $(main_pid), up $(uptime_sec)s, the door answers"; return 0
  fi
  if [ "$state" = "active" ]; then echo "down: $SERVICE is active (pid $(main_pid)) but the door does not answer — process unproven"; else echo "down: $SERVICE is $state"; fi
  return 1
}

stop_hub() { # the graceful stop: live work or a foreign door refuses (exit 2 names --force); a process that stays is killed hard
  if door_answers && foreign_door_refusal; then return 1; fi
  local workers
  if workers="$(live_work)"; then
    if [ -n "$workers" ] && [ "$FORCE" != 1 ]; then
      echo "refused: live work holds the stop (--force would stop anyway):"; echo "$workers"
      record "stop_refused" "live work: $(echo "$workers" | tr '\n' ' ')"
      return 2
    fi
    [ -n "$workers" ] && record "stop_forced" "live work overridden: $(echo "$workers" | tr '\n' ' ')"
  else
    if [ "$FORCE" != 1 ]; then
      echo "refused: unknown live work — the database cannot be read; --force would stop anyway"
      record "stop_refused" "unknown live work"
      return 2
    fi
    record "stop_forced" "unknown live work overridden"
  fi
  service_stop
  local waited=0 state="active"
  while [ "$waited" -lt "$STOP_SEC" ]; do
    state="$(active_state)"
    case "$state" in inactive|dead|failed) break ;; esac
    sleep 1; waited=$((waited + 1))
  done
  case "$state" in
    inactive|dead|failed) echo "stopped: $SERVICE is $state" ;;
    *) service_kill; record "stopped_hard" "the process did not leave in ${STOP_SEC}s"; echo "stopped hard: the process did not leave in ${STOP_SEC}s and was killed" ;;
  esac
}

restart_hub() { # stop (its refusals stand), the platform lift detached, then a wait on the door
  stop_hub || return $?
  setsid nohup bash -c "$(lift_cmd)" >/dev/null 2>&1 &
  local waited=0
  while [ "$waited" -lt "$RESTART_WAIT_SEC" ]; do
    door_answers && { echo "ok: the door answers after ${waited}s"; return 0; }
    sleep 3; waited=$((waited + 3))
  done
  echo "down: the door did not answer in ${RESTART_WAIT_SEC}s"; return 1
}

take_lock() { # one watchdog per machine: flock where it exists, an atomic mkdir lock where it does not (a stock Mac)
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK"
    flock -n 9 || { echo "another watchdog runs (lock $LOCK)"; exit 0; }
  else
    local dir="$LOCK.d" holder
    if ! mkdir "$dir" 2>/dev/null; then
      holder="$(cat "$dir/pid" 2>/dev/null)"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$dir"; mkdir "$dir" 2>/dev/null || { echo "another watchdog runs (lock $dir)"; exit 0; }
      else echo "another watchdog runs (lock $dir)"; exit 0; fi
    fi
    echo $$ > "$dir/pid"
    trap 'rm -rf "$LOCK.d"' EXIT
  fi
}

run() {
  take_lock
  record "start" "watchdog up; the first look waits ${FIRST_SEC}s so a booting server is not judged"
  sleep "$FIRST_SEC"
  local refused=0 timeouts=0 down_since=0 silent_pid="" probe state pid
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
      refused=0; timeouts=0
    elif [ "$probe" = "unknown" ]; then : # the CLI cannot sign in: not the hub's silence, the counters hold
    else
      state="$(active_state)"; pid="$(main_pid)"
      if [ "$state" = "activating" ] || [ "$state" = "reloading" ]; then refused=0; timeouts=0          # still loading — wait
      elif [ -z "$pid" ] || [ "$pid" = "0" ]; then refused=0; timeouts=0                                # no record — a stop; systemd lifts it
      elif [ "$pid" = "$(cat "$STATE_DIR/hub-watchdog.lifted-pid" 2>/dev/null)" ] && [ "$(uptime_sec)" -lt 120 ]; then refused=0; timeouts=0   # same process we lifted, still young: false alarm
      elif [ "$probe" = "refused" ]; then refused=$((refused + 1)); timeouts=0                          # suspect: refused connections in a row
      else timeouts=$((timeouts + 1)); refused=0                                                        # suspect: timeouts in a row
      fi
      if { [ "$probe" = "refused" ] && [ "$refused" -ge "$REFUSED_AFTER" ]; } || { [ "$probe" != "refused" ] && [ "$timeouts" -ge "$SUSPECT_AFTER" ]; }; then
        local count kind; if [ "$probe" = "refused" ]; then count=$refused; kind="refused"; else count=$timeouts; kind="timeout"; fi
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
        refused=0; timeouts=0
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
StartLimitIntervalSec=3600
StartLimitBurst=5

[Service]
Type=simple
User=$USER
# the first look waits 120 s (LP_WATCH_FIRST_SEC inside run), so a booting server is not judged
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
StartLimitIntervalSec=3600
StartLimitBurst=5

[Service]
# the first look waits 120 s (LP_WATCH_FIRST_SEC inside run), so a booting server is not judged
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
  <!-- the first look waits 120 s (LP_WATCH_FIRST_SEC inside run); launchd keeps the relift at least 30 s away -->
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
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
  status) status; exit $? ;;
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
