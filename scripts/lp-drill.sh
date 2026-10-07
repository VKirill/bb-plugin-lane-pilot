#!/usr/bin/env bash
# Sandbox drill (E3): the live regression check run before every Lane Pilot deploy.
# The scenarios, the receipt and the settings are described in scripts/lp-drill.py (python3 -I scripts/lp-drill.py --help).
#
# Usage: scripts/lp-drill.sh [--quick] [--scenario a,b] [--dry-run]
#   --quick      only the 3-parallel-tasks scenario (what bb-plugin-push runs before a deploy)
#   (no flag)    every scenario: parallel3, conflict, main_moved, provider_limit, reload, nogit
#   --dry-run    prints the tasks and changes nothing
# Exit: 0 pass, 1 a scenario failed (the receipt in .agents/runs/drills/ says why), 2 could not start. The last stdout line is RECEIPT=<path>.
exec python3 "$(dirname "$0")/lp-drill.py" "$@"
