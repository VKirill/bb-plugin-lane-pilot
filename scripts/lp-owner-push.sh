#!/bin/bash
# «Ждут владельца» → Telegram topic BB-сервис: a short message when NEW owner-only items appear (SMA D0-3). Runs on the hub every 30 minutes
# (a BB automation, like lp-metrics-daily.sh). The decisions are the plugin's, in code (src/rooms/owner-waiting/push.ts): only items that wake the
# owner, one message per item, silence in quiet hours (setting, default 23:00-08:00 Europe/Madrid), items held in quiet hours go out together
# afterwards. This script only carries the text: it asks `owner_waiting_digest`, sends it with the same bot as the daily report and, after a
# successful send, tells `owner_waiting_ack` the keys; a failed send is not acknowledged, so the next run tries again.
# Install: copy this file to ~/.config/lp-metrics/owner-push.sh on the hub (tg.env is the daily report's). DRY_RUN=1 prints the text, sends and acknowledges nothing.
# Settings: bb lane-pilot waiting config [enabled=on|off] [quiet=HH:MM-HH:MM] [timezone=Europe/Madrid]
set -euo pipefail
[ -n "${DRY_RUN:-}" ] || . "$HOME/.config/lp-metrics/tg.env"
BB="${BB_CLI:-bb}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
call() { # method, input json -> the result object
  printf '%s' "$2" > "$tmp/in.json"
  "$BB" plugin rpc call lane-pilot "$1" --input-file "$tmp/in.json" --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get("result", d) if isinstance(d, dict) else {}))'
}
field() { python3 -c 'import json,sys; v=json.loads(sys.argv[1]).get(sys.argv[2]); print(json.dumps(v) if isinstance(v,(list,dict)) else ("" if v is None else v))' "$1" "$2"; }
digest="$(call owner_waiting_digest '{}')"
[ "$(field "$digest" send)" = "True" ] || { echo "nothing to send ($(field "$digest" reason))"; exit 0; }
text="$(field "$digest" text)"
if [ -n "${DRY_RUN:-}" ]; then echo "$text"; exit 0; fi
curl -fsS -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" -d chat_id="$TG_CHAT" -d message_thread_id="$TG_TOPIC" --data-urlencode text="$text" >/dev/null
call owner_waiting_ack "$(python3 -c 'import json,sys; print(json.dumps({"keys": json.loads(sys.argv[1])}))' "$(field "$digest" keys)")" >/dev/null
echo "$text"
