"""Writer scenarios: three parallel notes, a conflict, a moved main, a reload, the pipeline contract, no-code exits."""
from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from lp_drill.env import OPEN_STATES, PARALLEL3_TIMEOUT_MIN, ROOT, SANDBOX_PROJECTS, STAMP
from lp_drill.hub import bb, git, hubsql, log, run
from lp_drill.report import (commit_file, conflict_markers, latest_states, provider_problems, sandbox_sound, summarize, verdict)
from lp_drill.tasks import (conflict_path, note_task, task, task_moved, task_reload, tasks_conflict, tasks_no_code_exit,
                            tasks_parallel3)

def verification_ran(ctx: "Context", task_ids: list[str]) -> dict[str, bool]:
    """task id -> its verification receipt lists at least one command, every one with exit 0."""
    found = {task_id: False for task_id in task_ids}
    quoted = ",".join("'" + task_id.replace("'", "''") + "'" for task_id in task_ids)
    for row in hubsql(f"select task_id, result_json from lane_pilot_stage_receipt where run_id='{ctx.run_id}' and stage_id='verification' and state='passed' and task_id in ({quoted});"):
        try:
            checks = json.loads(row.get("result_json") or "{}").get("verification") or []
        except ValueError:
            continue
        found[row["task_id"]] = bool(checks) and all(isinstance(c, dict) and c.get("exitCode") == 0 for c in checks)
    return found


def worktree_leftovers(cwd: str, task: dict, registry: list[dict]) -> list[str]:
    """After a task was accepted and merged nothing of its worktree is left (docs/worktrees.md, SMA ta_cleanup): no entry in
    `git worktree list`, no branch lane/<attempt>, no folder, and every lane_pilot_worktree row of the attempt released.
    `registry` holds the attempt's rows (owner_id = attempt id) with path and released_at."""
    path, attempt, name = task.get("workspace"), task.get("attempt"), task.get("task")
    if task.get("state") != "accepted" or not path or not attempt:
        return []
    problems = []
    tops = [line[len("worktree "):] for line in git(cwd, "worktree", "list", "--porcelain").splitlines() if line.startswith("worktree ")]
    held = [top for top in tops[1:] if path == top or path.startswith(top.rstrip("/") + "/")]
    if held:
        problems.append(f"{name}: git worktree list still has {held[0]}")
    if git(cwd, "branch", "--list", f"lane/{attempt}"):
        problems.append(f"{name}: branch lane/{attempt} is still there after the merge")
    if Path(path).exists():
        problems.append(f"{name}: the folder {path} is still on disk after the merge")
    if not registry:
        problems.append(f"{name}: no lane_pilot_worktree row for attempt {attempt}")
    for row in registry:
        if not row.get("released_at"):
            problems.append(f"{name}: lane_pilot_worktree row of {row.get('path')} is not released")
    return problems


def worktree_registry(attempts: list[str]) -> dict[str, list[dict]]:
    """attempt id -> its lane_pilot_worktree rows."""
    known = [a for a in attempts if a]
    out: dict[str, list[dict]] = {a: [] for a in known}
    if not known:
        return out
    quoted = ",".join("'" + a.replace("'", "''") + "'" for a in known)
    for row in hubsql(f"select owner_id, path, released_at from lane_pilot_worktree where owner_kind='attempt' and owner_id in ({quoted});"):
        out.setdefault(row["owner_id"], []).append(row)
    return out


CLEANUP_SCHEDULES = ("system:worktree-cleanup-hourly", "system:worktree-cleanup-daily")


def cleanup_schedule_problems(rows: list[dict]) -> list[str]:
    """The janitor runs as two system schedules (docs/worktrees.md): each must exist and its last finished run must not have failed.
    0.1.562 shipped with both ending `start_failed` (a starter graph refused by the trigger) and the merge-time checks above stayed green.
    `rows`: one per system schedule (created_by, name, state) with its last finished run (status, reason, error), nulls if it never ran."""
    problems = []
    by = {row.get("created_by"): row for row in rows}
    for key in CLEANUP_SCHEDULES:
        row = by.get(key)
        if not row:
            problems.append(f"the system schedule {key} is not on the board")
            continue
        if row.get("status") == "failed":
            problems.append(f"«{row.get('name')}» last run failed ({row.get('reason') or 'no reason'}): {(row.get('error') or '')[:200]}")
    return problems


def cleanup_schedule_rows() -> list[dict]:
    quoted = ",".join("'" + key + "'" for key in CLEANUP_SCHEDULES)
    return hubsql(f"""select s.created_by, s.name, s.state, r.status, r.reason, r.error from lane_pilot_schedule s
      left join lane_pilot_schedule_run r on r.id = (select id from lane_pilot_schedule_run where schedule_id = s.id and finished_at is not null
        and status <> 'skipped' order by finished_at desc limit 1)
      where s.created_by in ({quoted});""")


def scenario_parallel3(ctx: Context) -> dict:
    specs = tasks_parallel3(ctx.cwd)
    with ThreadPoolExecutor(3) as pool:
        sent = list(pool.map(ctx.dispatch, specs))
    problems = ["a dispatch-bb call exited with an error (see receipt dispatch output)"] if not all(sent) else []
    ids = [s["id"] for s in specs]
    rows = ctx.wait_ended(ids, PARALLEL3_TIMEOUT_MIN)
    tasks = [summarize(rows, s["id"], ctx.cwd, s["expected_outputs"][0]) for s in specs]
    accepted = all(t["state"] == "accepted" for t in tasks)
    spaces = [t["workspace"] for t in tasks]
    own = all(spaces) and len(set(spaces)) == len(spaces) and ctx.cwd not in spaces
    merged = all(t["fileInSandbox"] for t in tasks)
    if not accepted:
        problems.append("not every task was accepted")
    if accepted and not own:
        problems.append("tasks did not each get a worktree of their own")
    if accepted and not merged:
        problems.append("an accepted task's file is not in the sandbox")
    # The verification stage must have run each task's own check, green (exit 0 in its receipt): «passed» on an empty list proves nothing.
    ran = verification_ran(ctx, ids)
    if accepted and not all(ran.values()):
        problems.append(f"the verification stage did not run the task's check with exit 0: {', '.join(t for t, ok in ran.items() if not ok)}")
    problems += provider_problems(tasks)
    # The merge removed what it merged: worktree, branch, folder, registry row (0.1.561; before it the default path left them to the janitor).
    registry = worktree_registry([t["attempt"] for t in tasks])
    leftovers = [p for t in tasks for p in worktree_leftovers(ctx.cwd, t, registry.get(t["attempt"] or "", []))]
    problems += leftovers
    # What the merge leaves is the janitor's: its two schedules must actually start and finish (they did not in 0.1.562).
    cleanup = cleanup_schedule_problems(cleanup_schedule_rows())
    problems += cleanup
    return verdict("parallel3", problems, tasks=tasks, checks={"allAccepted": accepted, "eachInOwnWorktree": own, "filesInSandbox": merged, "checksRan": all(ran.values()), "worktreesGone": accepted and not leftovers,
                   "cleanupSchedulesRun": not cleanup},
                   dispatch={s["id"]: ctx.dispatches.get(s["id"]) for s in specs})
def flow_contract_stages() -> set[str]:
    """Stage ids a receipt of the task pipeline may carry: the graph's agent/subworkflow nodes plus the writer node's own stages."""
    pipeline = json.loads((ROOT / "workflows" / "lp-task-pipeline.json").read_text())
    allowed: set[str] = set()
    for node in pipeline.get("nodes", []):
        if node.get("stages"):
            allowed.update(node["stages"])
        elif node.get("type") in ("agent", "subworkflow", "lp-task"):
            allowed.add(node["id"])
    return allowed


def flow_contract_problems(receipts: list[dict], allowed: set[str]) -> list[str]:
    """Receipt rows must name only stages the graph declares, and the code-decided writer stages must have passed."""
    problems = [f"receipt of a stage lp-task-pipeline.json does not declare: {row['stage_id']}={row['state']}"
                for row in receipts if row["stage_id"] not in allowed]
    states = {row["stage_id"]: row["state"] for row in receipts}
    for required in ("writer-agent", "verification", "acceptance-receipt"):
        if states.get(required) != "passed":
            problems.append(f"{required} was not passed: {states.get(required)!r}")
    return problems


def scenario_flow_contract(ctx: Context) -> dict:
    """One probe task in the sandbox; its stage receipts must match the nodes of lp-task-pipeline.json (audit 2026-10-30 F19)."""
    spec = note_task(f"drill-{STAMP}-flow", f"notes/drill/{STAMP}-flow.md", f"Drill {STAMP} flow", ctx.cwd)
    problems = [] if ctx.dispatch(spec) else ["dispatch-bb exited with an error"]
    rows = ctx.wait_ended([spec["id"]])
    row = summarize(rows, spec["id"], ctx.cwd, spec["expected_outputs"][0])
    if row["state"] != "accepted":
        problems.append(f"the probe task did not end accepted: {row['states']} {row['reason']}")
    receipts = hubsql(f"select stage_id, state from lane_pilot_stage_receipt where run_id='{ctx.run_id}' and task_id='{spec['id']}';")
    problems += flow_contract_problems(receipts, flow_contract_stages())
    return verdict("flow_contract", problems, stages={r["stage_id"]: r["state"] for r in receipts}, task=row)
def scenario_conflict(ctx: Context) -> dict:
    rel = conflict_path()
    commit_file(ctx.cwd, rel, f"# Drill {STAMP} conflict\nline: base\nend\n", f"drill {STAMP}: seed for the same-line conflict")
    specs = tasks_conflict(ctx.cwd)
    with ThreadPoolExecutor(2) as pool:
        sent = list(pool.map(ctx.dispatch, specs))
    problems = [] if all(sent) else ["a dispatch-bb call exited with an error"]
    rows = ctx.wait_ended([s["id"] for s in specs])
    tasks = [summarize(rows, s["id"], ctx.cwd) for s in specs]
    if not all(t["state"] == "accepted" for t in tasks):
        problems.append("the two tasks on the same line did not both end accepted: " + ", ".join(f"{t['task']}={t['state']}" for t in tasks))
    if conflict_markers(ctx.cwd, rel):
        problems.append("conflict markers were left in the file on main")
    lines = (Path(ctx.cwd) / rel).read_text().splitlines() if (Path(ctx.cwd) / rel).is_file() else []
    if len(lines) < 2 or lines[1] not in ("line: X", "line: Y"):
        problems.append(f"line 2 on main is neither task's text: {lines[1] if len(lines) > 1 else None!r}")
    problems += sandbox_sound(ctx.cwd)
    return verdict("conflict", problems, tasks=tasks, line2=lines[1] if len(lines) > 1 else None)


def scenario_main_moved(ctx: Context) -> dict:
    moved_rel = f"notes/drill/{STAMP}-main-commit.md"
    spec = task_moved(ctx.cwd)
    out = spec["expected_outputs"][0]
    problems = [] if ctx.dispatch(spec) else ["dispatch-bb exited with an error"]
    if not ctx.wait_state(spec["id"], "running"):
        problems.append("the writer never started running")
        moved = None
    else:
        moved = commit_file(ctx.cwd, moved_rel, f"main moved during drill {STAMP}\n", f"drill {STAMP}: main moves while a writer works")
        log(f"main moved: {moved[:12]}")
    rows = ctx.wait_ended([spec["id"]])
    row = summarize(rows, spec["id"], ctx.cwd, out)
    if row["state"] != "accepted":
        problems.append(f"the task was not accepted after main moved: {row['state']} {row['reason']}")
    if not row["fileInSandbox"]:
        problems.append("the task's file is not on main")
    if moved:
        try:
            git(ctx.cwd, "merge-base", "--is-ancestor", moved, "HEAD")
        except RuntimeError:
            problems.append("the commit made on main during the attempt is not in main's history any more")
        if not (Path(ctx.cwd) / moved_rel).is_file():
            problems.append("the file of the commit made on main during the attempt is gone")
    problems += sandbox_sound(ctx.cwd)
    return verdict("main_moved", problems, tasks=[row], mainCommit=moved)
def scenario_reload(ctx: Context) -> dict:
    placeholders = ",".join(repr(s) for s in OPEN_STATES)
    foreign = hubsql(f"select r.project_id as p, count(*) as n from lane_pilot_attempt a join lane_pilot_run r on r.id=a.run_id where a.state in ({placeholders}) group by r.project_id;")
    busy = {row["p"]: row["n"] for row in foreign if row["p"] not in SANDBOX_PROJECTS}
    if busy:
        return {"name": "reload", "result": "skipped", "problems": [], "note": f"projects with open attempts would be hit by a reload: {busy}"}
    spec = task_reload(ctx.cwd)
    out = spec["expected_outputs"][0]
    problems = [] if ctx.dispatch(spec) else ["dispatch-bb exited with an error"]
    if not ctx.wait_state(spec["id"], "running"):
        problems.append("the writer never started running")
    else:
        rc, _, err = bb("plugin", "reload", "lane-pilot", timeout=240)
        log(f"plugin reloaded (exit {rc})")
        if rc != 0:
            problems.append(f"bb plugin reload failed: {err.strip()[:200]}")
    rows = ctx.wait_ended([spec["id"]])
    row = summarize(rows, spec["id"], ctx.cwd, out)
    if row["state"] != "accepted":
        problems.append(f"the task was not accepted after the reload: {row['states']} {row['reason']}")
    if not row["fileInSandbox"]:
        problems.append("the task's file is not on main")
    return verdict("reload", problems, tasks=[row])
def scenario_no_code_exit(ctx: "Context") -> dict:
    """No-code exit drill (SMA): a writer that cannot do the task without the owner ends with NEEDS_HUMAN, changes nothing, and the task is
    held with its question instead of a forced change. Under --series (LP_DRILL_SERIES=1) edit-free work must also close on its answer
    the first time and code work must not."""
    series = os.environ.get("LP_DRILL_SERIES") == "1"
    specs = tasks_no_code_exit(ctx.cwd, series)
    with ThreadPoolExecutor(len(specs)) as pool:
        sent = list(pool.map(ctx.dispatch, specs))
    problems = [] if all(sent) else ["a dispatch-bb call exited with an error"]
    rows = ctx.wait_ended([s["id"] for s in specs])
    path = f"drills/needs-human-{STAMP}.md"
    tasks = [summarize(rows, s["id"], ctx.cwd, path) if s["id"] == f"drill-human-{STAMP}" else summarize(rows, s["id"], ctx.cwd) for s in specs]
    by_id = {s["id"]: row for s, row in zip(specs, tasks)}
    question = by_id[f"drill-human-{STAMP}"]
    if question["state"] == "accepted":
        problems.append("a writer that asked a question was accepted")
    if "needs_human" not in str(question.get("reason") or "").lower() and "needs human" not in str(question.get("reason") or "").lower():
        problems.append(f"the task did not end with the writer's question: {question['states']} {question['reason']}")
    if question.get("fileInSandbox"):
        problems.append("a file was written although the writer had a question")
    if series:
        answer = by_id[f"drill-answer-{STAMP}"]
        if answer["state"] != "accepted":
            problems.append(f"edit-free answer work did not close on its answer the first time: {answer['states']} {answer['reason']}")
        else:
            if answer["attempts"] != 1:
                problems.append(f"edit-free answer work needed {answer['attempts']} attempts to close on its answer")
            receipts = hubsql(f"select count(*) as n from lane_pilot_stage_receipt where run_id='{ctx.run_id}' and task_id='{f'drill-answer-{STAMP}'}' and stage_id='writer-agent' and state='passed';")
            if not receipts or not receipts[0]["n"]:
                problems.append("the answer task was accepted with no answer on record (no writer-agent receipt)")
            if list(Path(ctx.cwd).glob(f"drills/answer-{STAMP}*")):
                problems.append("edit-free answer work left a file in the sandbox")
        if by_id[f"drill-noedit-{STAMP}"]["state"] == "accepted":
            problems.append("code work told to change nothing was accepted")
    return verdict("no_code_exit", problems, tasks=tasks)
