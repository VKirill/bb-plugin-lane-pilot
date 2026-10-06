#!/usr/bin/env bash
# Prints Lane Pilot stability metrics from the hub database, read-only. Usage: scripts/lp-metrics.sh [days=7]
set -euo pipefail
days="${1:-7}"
[[ "$days" =~ ^[0-9]+$ ]] || { echo "days must be a number" >&2; exit 2; }
sql="$(cd "$(dirname "$0")" && pwd)/lp-metrics.sql"
{ echo ".parameter set :days $days"; cat "$sql"; } | ssh -i ~/.ssh/oracle_bb ubuntu@10.8.0.1 \
  "sqlite3 -readonly /home/ubuntu/.bb/plugins/lane-pilot/data.db"
