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
# Usage (on the hub):  hub-watchdog.sh run | status | stop | restart | lift | install
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
mkdir -p "$STATE_DIR"

door_answers() { [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$DOOR" 2>/dev/null)" = "200" ]; }
main_pid() { systemctl show -p MainPID --value "$SERVICE" 2>/dev/null; }
active_state() { systemctl show -p ActiveState --value "$SERVICE" 2>/dev/null; }
uptime_sec() { local pid; pid="$(main_pid)"; [ -n "$pid" ] && [ "$pid" != "0" ] && ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || echo 0; }

say() { # Telegram, the same bot and topic as the daily report; no address, silence.
  [ -f "$TG_ENV" ] || return 0
  # shellcheck disable=SC1090
  . "$TG_ENV"
  [ -n "${TG_TOKEN:-}" ] && [ -n "${TG_CHAT:-}" ] || return 0
  curl -fsS -m 20 -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" -d chat_id="$TG_CHAT" ${TG_TOPIC:+-d message_thread_id="$TG_TOPIC"} --data-urlencode text="$1" >/dev/null 2>&1 || true
}

record() { printf '{"at":%s,"event":"%s","detail":"%s"}\n' "$(date +%s)" "$1" "${2//\"/\'}" >> "$LOG"; }

lift() { # kill the hung one first, then start; returns 0 when the door answers within the backoff
  local wait=30 try pid
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

install_unit() {
  local self; self="$(readlink -f "$0")"
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
  *) echo "usage: $0 run|status|stop|restart|lift|install" >&2; exit 2 ;;
esac
