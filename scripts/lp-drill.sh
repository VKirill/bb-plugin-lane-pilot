#!/usr/bin/env bash
# Sandbox drill (E3): the live regression check run before every Lane Pilot deploy.
#
# In the sandbox project (proj_3tb652jpsi, folder /Users/vechkasov/lp-sandbox-rules on host_7sea4qaad8) it
#   1. spawns a cheap source thread and activates a Lane Pilot PM from it;
#   2. dispatches 3 parallel, non-overlapping tasks (risk high, so each one gets its own worktree);
#   3. polls the hub database read-only until every task has ended;
#   4. writes a receipt to .agents/runs/drills/<date>.json;
#   5. finishes the run and archives the threads it started.
# The drill passes when all 3 tasks were accepted, each in a worktree of its own, and their files are in the sandbox.
#
# Usage: scripts/lp-drill.sh [--dry-run]     --dry-run prints the three tasks and changes nothing.
# Exit: 0 pass, 1 drill failed (receipt says why), 2 could not start. Run it before bb-plugin-push lane-pilot.
# Settings (env): LP_DRILL_TIMEOUT_MIN (30), LP_DRILL_PROJECT, LP_DRILL_ENVIRONMENT, LP_DRILL_CWD, BB_CLI, BB_HUB_HOST, BB_HUB_KEY.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${LP_DRILL_PROJECT:-proj_3tb652jpsi}"
ENVIRONMENT="${LP_DRILL_ENVIRONMENT:-env_mybrzmx7nz}"
SANDBOX_CWD="${LP_DRILL_CWD:-/Users/vechkasov/lp-sandbox-rules}"
HUB="${BB_HUB_HOST:-ubuntu@10.8.0.1}"
KEY="${BB_HUB_KEY:-$HOME/.ssh/oracle_bb}"
HUB_DB="${LP_DRILL_HUB_DB:-/home/ubuntu/.bb/plugins/lane-pilot/data.db}"
BB="${BB_CLI:-bb}"
TIMEOUT_MIN="${LP_DRILL_TIMEOUT_MIN:-30}"
TASK_LETTERS=(a b c)

STAMP="$(date +%Y%m%d-%H%M%S)"
DATE="$(date +%F)"

# The three task-v2 documents: each writes one note of its own, so nothing overlaps.
make_task() {
  python3 - "$1" "$STAMP" "$SANDBOX_CWD" <<'PY'
import json, sys
letter, stamp, cwd = sys.argv[1:4]
path = f"notes/drill/{stamp}-{letter}.md"
print(json.dumps({
    "schema_version": 2,
    "id": f"drill-{stamp}-{letter}",
    "title": f"Drill {stamp} {letter}: one note",
    "risk": "high",
    "lane": "writer",
    "project_cwd": cwd,
    "read_first": [],
    "interfaces": [],
    "invariants": ["Touch no file except the one in expected_outputs."],
    "out_of_scope": ["Every other file of the project."],
    "expected_outputs": [path],
    "owns_paths": [path],
    "never_touch": ["src/**", "tests/**", "package.json"],
    "depends_on": [],
    "objective": f"Create the file {path} with exactly two lines. Line 1: `# Drill {stamp} {letter}`. Line 2: `ok: {letter}`. Nothing else.",
    "acceptance": [f"{path} exists, its first line is `# Drill {stamp} {letter}` and its second line is `ok: {letter}`."],
    "verify": "none",
    "verification": [],
}))
PY
}

if [ "${1:-}" = "--dry-run" ]; then
  echo "drill $STAMP in $PROJECT ($SANDBOX_CWD), hub db $HUB:$HUB_DB"
  for letter in "${TASK_LETTERS[@]}"; do make_task "$letter"; done
  exit 0
fi

TMP="$(mktemp -d)"
RECEIPT_DIR="$ROOT/.agents/runs/drills"
RECEIPT="$RECEIPT_DIR/$DATE.json"
[ -e "$RECEIPT" ] && RECEIPT="$RECEIPT_DIR/$DATE-${STAMP#*-}.json"
mkdir -p "$RECEIPT_DIR"
START_MS=$(python3 -c 'import time;print(int(time.time()*1000))')
SOURCE_THREAD=""; PM_THREAD=""; RUN_ID=""
declare -a PROBLEMS=()
STATE_JSON='[]'

log() { echo "$(date +%T) drill: $*" >&2; }
hubsql() { ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 "$HUB" "sqlite3 -readonly -json '$HUB_DB'" <<<"$1"; }
json_get() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); d=d.get('thread',d) if isinstance(d,dict) else d; print(d.get(sys.argv[2]) or '')" "$1" "$2" 2>/dev/null; }
thread_status() { "$BB" thread get "$1" --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('thread',d).get('status','?'))" 2>/dev/null || echo "?"; }

write_receipt() {
  local end_ms; end_ms=$(python3 -c 'import time;print(int(time.time()*1000))')
  python3 - "$RECEIPT" "$DATE" "$STAMP" "$START_MS" "$end_ms" "$PROJECT" "$RUN_ID" "$PM_THREAD" "$SOURCE_THREAD" "$SANDBOX_CWD" "$TMP" "$STATE_JSON" "${PROBLEMS[@]+"${PROBLEMS[@]}"}" <<'PY'
import json, os, sys
(receipt, date, stamp, start, end, project, run, pm, source, cwd, tmp, state) = sys.argv[1:13]
problems = list(sys.argv[13:])
rows = json.loads(state or "[]")
tasks = []
for letter in "abc":
    task_id = f"drill-{stamp}-{letter}"
    mine = sorted((r for r in rows if r["task_id"] == task_id), key=lambda r: r["created_at"])
    last = mine[-1] if mine else None
    out = f"notes/drill/{stamp}-{letter}.md"
    tasks.append({
        "task": task_id, "attempts": len(mine), "state": last["state"] if last else None, "reason": last["reason"] if last else None,
        "attempt": last["id"] if last else None, "writerThread": last["thread_id"] if last else None, "workspace": last["workspace_path"] if last else None,
        "file": out, "fileInSandbox": os.path.isfile(os.path.join(cwd, out)),
    })
accepted = all(t["state"] == "accepted" for t in tasks)
spaces = [t["workspace"] for t in tasks]
own_worktrees = all(spaces) and len(set(spaces)) == len(spaces) and cwd not in spaces
merged = all(t["fileInSandbox"] for t in tasks)
if not accepted: problems.append("not every task was accepted")
if accepted and not own_worktrees: problems.append("tasks did not each get a worktree of their own")
if accepted and not merged: problems.append("an accepted task's file is not in the sandbox")
dispatch = {}
for letter in "abc":
    p = os.path.join(tmp, f"dispatch-{letter}.out")
    dispatch[letter] = open(p).read().strip()[:600] if os.path.exists(p) else None
data = {
    "kind": "lane-pilot-sandbox-drill", "date": date, "stamp": stamp, "startedAt": int(start), "finishedAt": int(end),
    "durationSec": round((int(end) - int(start)) / 1000), "project": project, "runId": run or None, "pmThread": pm or None, "sourceThread": source or None,
    "result": "pass" if not problems else "fail", "problems": problems,
    "checks": {"allAccepted": accepted, "eachInOwnWorktree": own_worktrees, "filesInSandbox": merged},
    "tasks": tasks, "dispatch": dispatch,
}
os.makedirs(os.path.dirname(receipt), exist_ok=True)
json.dump(data, open(receipt, "w"), ensure_ascii=False, indent=2)
open(receipt, "a").write("\n")
PY
}

cleanup() {
  # Finish the run (its PM may still have its own smoke attempt running: wait, then cancel), archive what the drill started.
  if [ -n "$RUN_ID" ]; then
    local tries=0 out
    while [ $tries -lt 30 ]; do
      out=$("$BB" lane-pilot finish "$PROJECT" 2>&1) && { log "run finished"; break; }
      if [ $tries -ge 12 ]; then
        for attempt in $(hubsql "select id from lane_pilot_attempt where run_id='$RUN_ID' and state in ('queued','spawn_requested','spawn_unknown','running');" | python3 -c "import json,sys; t=sys.stdin.read().strip(); print(' '.join(r['id'] for r in json.loads(t))) if t else None"); do
          log "cancelling $attempt"; "$BB" lane-pilot cancel "$attempt" >/dev/null 2>&1
        done
      fi
      tries=$((tries+1)); sleep 20
    done
    [ $tries -ge 30 ] && { log "run not finished: $out"; PROBLEMS+=("run could not be finished: $out"); }
  fi
  local writers=""
  [ -n "$RUN_ID" ] && writers=$(hubsql "select thread_id as t from lane_pilot_attempt where run_id='$RUN_ID' and thread_id is not null union select holder_thread_id from lane_pilot_attempt where run_id='$RUN_ID' and holder_thread_id is not null;" \
    | python3 -c "import json,sys; t=sys.stdin.read().strip(); print(' '.join(list(r.values())[0] for r in json.loads(t))) if t else None" 2>/dev/null)
  for thread in $PM_THREAD $writers $SOURCE_THREAD; do "$BB" thread archive "$thread" >/dev/null 2>&1 && log "archived $thread"; done
  write_receipt
  rm -rf "$TMP"
}

abort() { log "$1"; PROBLEMS+=("$1"); cleanup; log "receipt: $RECEIPT"; exit "${2:-2}"; }

# 1. A cheap source thread, then the PM.
"$BB" thread spawn --project "$PROJECT" --environment "$ENVIRONMENT" --provider codex --model gpt-6-luna --prompt "Reply with OK only." --json >"$TMP/source.json" 2>"$TMP/source.err" \
  || abort "source thread did not start: $(head -c 300 "$TMP/source.err")"
SOURCE_THREAD=$(json_get "$TMP/source.json" id)
[ -n "$SOURCE_THREAD" ] || abort "source thread id missing"
log "source thread $SOURCE_THREAD"
for _ in $(seq 1 36); do [ "$(thread_status "$SOURCE_THREAD")" = idle ] && break; sleep 5; done
[ "$(thread_status "$SOURCE_THREAD")" = idle ] || abort "source thread did not settle"

"$BB" lane-pilot activate "$PROJECT" "$SOURCE_THREAD" >"$TMP/activate.json" 2>"$TMP/activate.err" || abort "activate failed: $(head -c 300 "$TMP/activate.err")"
PM_THREAD=$(json_get "$TMP/activate.json" threadId); RUN_ID=$(json_get "$TMP/activate.json" runId)
[ -n "$PM_THREAD" ] && [ -n "$RUN_ID" ] || abort "activate gave no PM thread or run: $(head -c 300 "$TMP/activate.json")"
log "PM $PM_THREAD, run $RUN_ID"

# 2. Three tasks at once.
declare -a PIDS=()
for letter in "${TASK_LETTERS[@]}"; do
  make_task "$letter" >"$TMP/task-$letter.json"
  "$BB" lane-pilot dispatch-bb "$PROJECT" "$PM_THREAD" "$(cat "$TMP/task-$letter.json")" >"$TMP/dispatch-$letter.out" 2>&1 &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid" || PROBLEMS+=("a dispatch-bb call exited with an error (see receipt dispatch output)"); done
log "dispatched ${#TASK_LETTERS[@]} tasks"

# 3. Wait on the hub database until every task has ended (its latest attempt accepted, blocked or canceled), twice in a row.
ids="'drill-$STAMP-a','drill-$STAMP-b','drill-$STAMP-c'"
deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 )); settled=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  STATE_JSON=$(hubsql "select id, task_id, state, reason, thread_id, workspace_path, created_at from lane_pilot_attempt where run_id='$RUN_ID' and task_id in ($ids);" 2>/dev/null)
  [ -n "$STATE_JSON" ] || STATE_JSON='[]'
  ended=$(python3 - "$STATE_JSON" <<'PY'
import json, sys
rows = json.loads(sys.argv[1])
latest = {}
for r in sorted(rows, key=lambda r: r["created_at"]): latest[r["task_id"]] = r["state"]
print(sum(1 for s in latest.values() if s in ("accepted", "blocked", "canceled")), len(latest))
PY
)
  log "ended/seen: ${ended:-? ?} of ${#TASK_LETTERS[@]}"
  if [ "${ended%% *}" = "${#TASK_LETTERS[@]}" ]; then settled=$((settled+1)); [ $settled -ge 2 ] && break; else settled=0; fi
  sleep 20
done
[ $settled -ge 2 ] || PROBLEMS+=("tasks did not all end within $TIMEOUT_MIN min")

# 4-5. Receipt, finish, archive.
cleanup
log "receipt: $RECEIPT"
if [ ${#PROBLEMS[@]} -eq 0 ] && python3 -c "import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))['result']=='pass' else 1)" "$RECEIPT"; then
  log "PASS"; exit 0
fi
log "FAIL: see $RECEIPT"; exit 1
