#!/usr/bin/env bash
# Prints Lane Pilot stability metrics from the hub database, read-only: real projects on the current version and newer (the headline),
# real projects on older versions (one line for comparison), sandbox and drill traffic (one separate line).
# Usage: scripts/lp-metrics.sh [days=7] [--since-version X.Y.Z]. Default since-version: the version of the newest attempt on the hub
# (the running one), never below 0.1.193. The daily Telegram automation on the hub (~/.config/lp-metrics/daily.sh) reads the same views.
set -euo pipefail
days=7; since=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since-version) since="${2:-}"; shift 2 ;;
    --since-version=*) since="${1#*=}"; shift ;;
    *) days="$1"; shift ;;
  esac
done
[[ "$days" =~ ^[0-9]+$ ]] || { echo "days must be a number" >&2; exit 2; }
[[ -z "$since" || "$since" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "since-version must look like 0.1.193" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
{
  echo "attach 'file:/home/ubuntu/.bb/bb.db?mode=ro' as core;"
  echo "create temp table lp_params(days integer, since_version text); insert into lp_params values ($days, '$since');"
  cat "$here/lp-metrics-views.sql" "$here/lp-metrics.sql"
} | ssh -i ~/.ssh/oracle_bb ubuntu@10.8.0.1 "sqlite3 -readonly /home/ubuntu/.bb/plugins/lane-pilot/data.db"
