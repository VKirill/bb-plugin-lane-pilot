#!/usr/bin/env bash
# Client side of the one-door memory import (M1): reads the JSONL here, sends it to the hub's RPC memory_import, keeps the receipt here.
# Usage: memory-import.sh <bb-memory|claude-files|agentmemory> <file.jsonl> <project-id> [--dry-run]
#        memory-import.sh eval <report.json>
set -euo pipefail
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
if [ "${1:-}" = eval ]; then
  jq -c '{report: .}' "$2" > "$tmp"
  bb plugin rpc call lane-pilot memory_import_eval --input-file "$tmp" --json | jq -r '.result.summary // .summary'
  exit 0
fi
source=$1 file=$2 project=$3 dry=false
[ "${4:-}" = --dry-run ] && dry=true
jq -n --arg s "$source" --arg p "$project" --rawfile j "$file" --argjson d "$dry" '{source: $s, projectId: $p, jsonl: $j, dryRun: $d}' > "$tmp"
report="${file%.jsonl}.report$([ "$dry" = true ] && echo .dry).json"
bb plugin rpc call lane-pilot memory_import --input-file "$tmp" --json | jq '.result // .' > "$report"
jq -r '.summary' "$report"; echo "receipt: $report"
