#!/usr/bin/env bash
# Prints Lane Pilot stability metrics from the hub database, read-only, for the real projects (sandbox and drill traffic is one separate line).
# Usage: scripts/lp-metrics.sh [days=7]. The daily Telegram automation on the hub (~/.config/lp-metrics/daily.sh) reads the same views.
set -euo pipefail
days="${1:-7}"
[[ "$days" =~ ^[0-9]+$ ]] || { echo "days must be a number" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
{
  echo "attach 'file:/home/ubuntu/.bb/bb.db?mode=ro' as core;"
  echo "create temp table lp_params(days integer); insert into lp_params values ($days);"
  cat "$here/lp-metrics-views.sql" "$here/lp-metrics.sql"
} | ssh -i ~/.ssh/oracle_bb ubuntu@10.8.0.1 "sqlite3 -readonly /home/ubuntu/.bb/plugins/lane-pilot/data.db"
