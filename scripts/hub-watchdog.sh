#!/usr/bin/env bash
# The hub's watchdog (SMA map: Watchdog and outage, Stop and restart). systemd restarts bb-server when it dies (Restart=always), not when it
# hangs with the process alive. This loop knocks on the door every 15 seconds (the server's /install/version) and decides:
#   door answers                          -> ok; a lift that was going is reported «risen»
#   systemd says activating               -> still loading, wait
#   no MainPID                            -> no record: a stop; systemd lifts it itself, wait
#   same process as our last lift, young  -> false alarm, wait
#   silence 8 knocks in a row (2 min)     -> outage: «it fell» to Telegram, kill the hung one first, start the lift,
#                                            backoff doubles (30, 60, 120 s), at most 3 lifts; out of tries -> «lift failed», to the person
# Outages are appended to ~/.lane-pilot/outages.jsonl with their times (Outage record with times / Outage receipt).
#
# Usage (on the hub):  hub-watchdog.sh run | status | stop | restart | lift | install | daily | rotate | db-ready
#   lift       when the door already answers it does nothing (Door already answers — nothing)
#   install    a systemd unit with sudo; without admin a systemd --user unit (or an @reboot crontab line); on a Mac a LaunchAgent
#   daily      the lifts per day from the outage log (Daily lift log)
#   rotate     the outage log rotates by day, 14 days kept (Day of a log line, Day rotation)
#   db-ready   readiness is a real query: PRAGMA quick_check and the encoding of the hub databases, read-only (not an open port)
# Five lifts within an hour stop the lifting and call the person (Five restarts in a row). LP_WATCH_DRY=1 (drills) records instead of acting.
# Exit codes (status): 0 the door answers, 1 down or not running, 2 unknown (cannot ask systemd).
# One watchdog at a time: a lock file; install writes a systemd unit that runs `run` (Restart=always, never two).
set -uo pipefail
SERVICE="${LP_WATCH_SERVICE:-bb-server}"
DOOR="${LP_WATCH_DOOR:-http://127.0.0.1:38886/install/version}"
KNOCK_SEC="${LP_WATCH_KNOCK_SEC:-15}"
SUSPECT_AFTER="${LP_WATCH_SUSPECT_AFTER:-8}"
MAX_LIFTS="${LP_WATCH_MAX_LIFTS:-3}"
STATE_DIR="${LP_WATCH_STATE:-$HOME/.lane-pilot}"
LOG="$STATE_DIR/outages.jsonl"
LOCK="$STATE_DIR/hub-watchdog.lock"
TG_ENV="${LP_WATCH_TG_ENV:-$HOME/.config/lp-metrics/tg.env}"
DRY="${LP_WATCH_DRY:-0}"
LIFT_WINDOW_SEC="${LP_WATCH_LIFT_WINDOW_SEC:-3600}"
MAX_LIFTS_IN_WINDOW="${LP_WATCH_MAX_LIFTS_IN_WINDOW:-5}"
mkdir -p "$STATE_DIR"

door_answers() { [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$DOOR" 2>/dev/null)" = "200" ]; }
main_pid() { [ "$DRY" = 1 ] && { echo 4242; return; }; systemctl show -p MainPID --value "$SERVICE" 2>/dev/null; }
active_state() { [ "$DRY" = 1 ] && { echo active; return; }; systemctl show -p ActiveState --value "$SERVICE" 2>/dev/null; }
uptime_sec() { local pid up; pid="$(main_pid)"; [ "$DRY" = 1 ] && { echo 0; return; }; up="$( [ -n "$pid" ] && [ "$pid" != "0" ] && ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"; case "$up" in ''|*[!0-9]*) echo 0 ;; *) echo "$up" ;; esac; }

say() { # Telegram, the same bot and topic as the daily report; no address, silence.
  [ -f "$TG_ENV" ] || return 0
  # shellcheck disable=SC1090
  . "$TG_ENV"
  [ -n "${TG_TOKEN:-}" ] && [ -n "${TG_CHAT:-}" ] || return 0
  curl -fsS -m 20 -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" -d chat_id="$TG_CHAT" ${TG_TOPIC:+-d message_thread_id="$TG_TOPIC"} --data-urlencode text="$1" >/dev/null 2>&1 || true
}

record() { printf '{"at":%s,"event":"%s","detail":"%s"}\n' "$(date +%s)" "$1" "${2//\"/\'}" >> "$LOG"; }

lifts_in_window() { local since=$(( $(date +%s) - LIFT_WINDOW_SEC )); [ -f "$LOG" ] && awk -v since="$since" -F'"at":' '/"event":"lift"/ { split($2, a, ","); if (a[1] + 0 >= since) n++ } END { print n + 0 }' "$LOG" || echo 0; }

lift() { # kill the hung one first, then start; returns 0 when the door answers within the backoff
  local wait=30 try pid
  if door_answers; then record "lift_skipped" "the door already answers"; echo "nothing to do: the door answers"; return 0; fi
  if [ "$(lifts_in_window)" -ge "$MAX_LIFTS_IN_WINDOW" ]; then
    record "lift_refused" "$MAX_LIFTS_IN_WINDOW lifts within ${LIFT_WINDOW_SEC}s"
    say "Хаб BB: $MAX_LIFTS_IN_WINDOW подъёмов за час подряд — больше не поднимаю, нужен человек (journalctl -u $SERVICE -n 200)."
    return 1
  fi
  if [ "$DRY" = 1 ]; then record "lift" "dry: would kill ${SERVICE} and start it"; return 1; fi
  for try in $(seq 1 "$MAX_LIFTS"); do
    pid="$(main_pid)"
    record "lift" "try $try, killing pid ${pid:-none}"
    [ -n "$pid" ] && [ "$pid" != "0" ] && sudo -n systemctl kill -s SIGKILL "$SERVICE" 2>/dev/null
    sleep 2
    sudo -n systemctl restart "$SERVICE" 2>/dev/null || systemctl --user restart "$SERVICE" 2>/dev/null
    echo "$(main_pid)" > "$STATE_DIR/hub-watchdog.lifted-pid"
    for _ in $(seq 1 $((wait / 5))); do sleep 5; door_answers && return 0; done
    record "lift_without_outcome" "try $try, waited ${wait}s"
    wait=$((wait * 2))
  done
  return 1
}

status() {
  local state; state="$(active_state)"
  [ -n "$state" ] || { echo "unknown: systemd does not answer for $SERVICE"; return 2; }
  if door_answers; then echo "ok: $SERVICE $state, pid $(main_pid), up $(uptime_sec)s, the door answers"; return 0; fi
  if [ "$state" = "active" ]; then echo "down: $SERVICE is active (pid $(main_pid)) but the door does not answer — process unproven"; else echo "down: $SERVICE is $state"; fi
  return 1
}

run() {
  exec 9>"$LOCK"
  flock -n 9 || { echo "another watchdog runs (lock $LOCK)"; exit 0; }
  local silent=0 down_since=0
  while true; do
    rotate >/dev/null
    if door_answers; then
      if [ "$down_since" -gt 0 ]; then
        local minutes=$(( ($(date +%s) - down_since + 59) / 60 ))
        record "risen" "down about $minutes min"
        say "Хаб BB поднялся: не отвечал около $minutes мин."
        down_since=0
      fi
      silent=0
    else
      local state pid young
      state="$(active_state)"; pid="$(main_pid)"
      if [ "$state" = "activating" ] || [ "$state" = "reloading" ]; then silent=0          # still loading — wait
      elif [ -z "$pid" ] || [ "$pid" = "0" ]; then silent=0                                  # no record — a stop; systemd lifts it
      elif [ "$pid" = "$(cat "$STATE_DIR/hub-watchdog.lifted-pid" 2>/dev/null)" ] && [ "$(uptime_sec)" -lt 120 ]; then silent=0   # same process we lifted, still young: false alarm
      else silent=$((silent + 1))                                                           # suspect: silence in a row
      fi
      if [ "$silent" -ge "$SUSPECT_AFTER" ]; then
        down_since=$(( $(date +%s) - silent * KNOCK_SEC ))
        record "outage" "no answer for $((silent * KNOCK_SEC))s from pid $pid ($state)"
        say "Хаб BB упал: сервер не отвечает $((silent * KNOCK_SEC)) с (процесс $pid висит). Поднимаю."
        if ! lift; then
          record "out_of_tries" "$MAX_LIFTS lifts without an answer"
          say "Хаб BB не поднялся после $MAX_LIFTS попыток. Нужен человек: ssh ubuntu@10.8.0.1, journalctl -u $SERVICE -n 100."
          sleep 600
        fi
        silent=0
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

install_mac() { # the watchdog agent on a Mac: a LaunchAgent, at login and kept alive
  local self="$1" plist="$HOME/Library/LaunchAgents/pro.vechkasov.lp-hub-watchdog.plist"
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0"><dict>' '  <key>Label</key><string>pro.vechkasov.lp-hub-watchdog</string>' \
    "  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$self</string><string>run</string></array>" \
    '  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>' \
    "  <key>StandardOutPath</key><string>$STATE_DIR/hub-watchdog.log</string><key>StandardErrorPath</key><string>$STATE_DIR/hub-watchdog.log</string>" \
    '</dict></plist>' > "$plist"
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" "$plist"
  # First Mac check: the agent is listed.
  launchctl list | grep -q pro.vechkasov.lp-hub-watchdog && echo "installed: LaunchAgent pro.vechkasov.lp-hub-watchdog" || { echo "the LaunchAgent did not load"; return 1; }
}

install_user() { # watchdog install without admin: a user unit, or the crontab when there is no user systemd
  local self="$1"
  if systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    printf '[Unit]\nDescription=Lane Pilot hub watchdog (user)\n\n[Service]\nExecStart=/bin/bash %s run\nRestart=always\nRestartSec=30\n\n[Install]\nWantedBy=default.target\n' "$self" > "$HOME/.config/systemd/user/lp-hub-watchdog.service"
    systemctl --user daemon-reload && systemctl --user enable --now lp-hub-watchdog.service && echo "installed: user unit lp-hub-watchdog.service (loginctl enable-linger $USER keeps it after logout)"
  else
    ( crontab -l 2>/dev/null | grep -v hub-watchdog; echo "@reboot /bin/bash $self run >> $STATE_DIR/hub-watchdog.log 2>&1" ) | crontab - && echo "installed: @reboot crontab line"
  fi
}

install_unit() {
  local self; self="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$0")"
  [ "$(uname -s)" = "Darwin" ] && { install_mac "$self"; return $?; }
  sudo -n true 2>/dev/null || { install_user "$self"; return $?; }
  sudo -n tee /etc/systemd/system/lp-hub-watchdog.service >/dev/null <<EOF
[Unit]
Description=Lane Pilot hub watchdog (knocks on bb-server, lifts a hung one)
After=bb-server.service

[Service]
Type=simple
User=$USER
ExecStart=/bin/bash $self run
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
  sudo -n systemctl daemon-reload && sudo -n systemctl enable --now lp-hub-watchdog.service && echo "installed: lp-hub-watchdog.service"
}

case "${1:-status}" in
  run) run ;;
  status) status; exit $? ;;
  stop) sudo -n systemctl stop "$SERVICE"; status; [ $? -eq 1 ] && exit 0 || exit 1 ;;
  restart) sudo -n systemctl restart "$SERVICE"; sleep 10; status; exit $? ;;
  lift) lift && { status; exit 0; } || exit 1 ;;
  install) install_unit ;;
  daily) daily ;;
  rotate) rotate ;;
  db-ready) db_ready; exit $? ;;
  *) echo "usage: $0 run|status|stop|restart|lift|install|daily|rotate|db-ready" >&2; exit 2 ;;
esac
