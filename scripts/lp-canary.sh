#!/usr/bin/env bash
# Canary of the Lane Pilot version that runs on the hub (G7). Run from the Mac mini, by hand after a deploy
# or from launchd/cron:
#   scripts/lp-canary.sh                      summary; exit 0 ok, 1 canary tripped, 2 no answer
#   scripts/lp-canary.sh --json               the raw canary_status answer
#   scripts/lp-canary.sh --rollback <version> the commands that put <version> back (printed, never run)
# The plugin counts the attempts that finished under its version since it started and how many failed on Lane Pilot's own
# fault (failure class «harness»); it tells the PMs of those tasks once when the canary trips.
set -uo pipefail
export BB_SERVER_URL="${BB_SERVER_URL:-https://bb.vechkasov.pro}"
BB="${BB_CLI:-/Users/vechkasov/.bb-machines/vechkasov.getbb.app/npm/lib/node_modules/bb-app/host-daemon/dist/bb}"
REPO="${LP_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG="${LP_DEPLOY_LOG:-$HOME/.lane-pilot/deploys.log}"

if [ "${1:-}" = "--rollback" ]; then
  version="${2:-}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 --rollback <version, e.g. 0.1.177>" >&2; exit 2; }
  # deploys.log: time, day, version, sha, normal|flaky|failed|rolled_back|drill_red, reason; the last good deploy of that version.
  sha="$(awk -F'\t' -v v="$version" '$3==v && $5=="normal" {sha=$4} END {print sha}' "$LOG" 2>/dev/null)"
  [ -n "$sha" ] || { echo "no deploy of $version in $LOG; find its commit with: git -C $REPO log --oneline -S'\"version\": \"$version\"' -- package.json" >&2; exit 2; }
  cat <<EOF
# Roll back Lane Pilot to $version ($sha). Printed, not run; bb-plugin-push has no --rollback, it deploys a clean pushed HEAD.
cd "$REPO"
git fetch origin
git switch --detach $sha
bb-plugin-push lane-pilot
git switch main
EOF
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo '{}' > "$tmp/empty.json"
if ! "$BB" plugin rpc call lane-pilot canary_status --input-file "$tmp/empty.json" --json > "$tmp/status.json" 2> "$tmp/err.txt"; then
  echo "Lane Pilot does not answer canary_status: $(head -c 400 "$tmp/err.txt")" >&2
  exit 2
fi
if [ "${1:-}" = "--json" ]; then cat "$tmp/status.json"; fi
python3 - "$tmp/status.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
w = d["window"]
print(f"Lane Pilot {d['version']}: canary {d['faults']} own faults in {w['attempts']} attempts "
      f"({d['rate']*100:.0f}%), window {'open' if w['open'] else 'closed'} ({w['minutes']} min), "
      f"{'TRIPPED' if d['tripped'] else 'ok'}")
for s in d.get("samples", [])[:5]:
    print(f"  {s['taskId']}: {s['reason']}")
if d["tripped"] and d.get("rollback"):
    print(f"Roll back to {d['previousVersion']}: {d['rollback']}")
sys.exit(1 if d["tripped"] else 0)
PY
