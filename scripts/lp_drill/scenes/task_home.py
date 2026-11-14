"""The task_home scenario: one task's every file lands in its own home `.agents/tasks/<id>/` and nothing new in the shared folders
(docs/task-folder.md; audit handoff-map §5.6, the proof of the owner's rule 4б.4)."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import STAMP
from lp_drill.prove import Proofs
from lp_drill.report import sandbox_sound, summarize
from lp_drill.tasks import note_task

MANIFEST_SCHEMA = "lp.task-manifest/1"
# Every kind one task that passes plan critique, the writer, checks, code critique and acceptance leaves in its home. A kind added to
# TASK_FILE_KINDS that the main path writes is added here too (src/rooms/storage/task-manifest.ts).
EXPECTED_KINDS = ("contract", "plan", "plan-source", "plan-critique", "brief", "writer-report", "checks", "plan-fact", "barrier-input",
                  "code-critique", "acceptance", "receipt", "outcome", "lesson")
# The kinds plugin code reads through the resolver today (pm-read and plan-critique read PLAN.md, plan-fact and lessons the report, lessons
# the acceptance): their `read_by` must not be empty. The other kinds are read by agents, whose reads step 2 records.
READ_KINDS = ("plan", "writer-report", "acceptance")
# The shared folders the task must leave alone. `.bb/chats` holds the PM's own chat folder too: there only a path naming the task counts.
SHARED_ROOTS = (".agents/plans", ".agents/planning", ".agents/runs", ".bb/chats")


def snapshot(cwd: str) -> set[str]:
    """Every file under the shared folders (`find <root> -type f`), repository-relative. A missing root is empty."""
    roots = [root for root in SHARED_ROOTS if (Path(cwd) / root).is_dir()]
    if not roots:
        return set()
    res = subprocess.run(["find", *roots, "-type", "f"], cwd=cwd, capture_output=True, text=True, timeout=120)
    return {line.strip().removeprefix("./") for line in res.stdout.splitlines() if line.strip()}


def shared_leaks(before: set[str], after: set[str], task_ids: list[str], run_id: str) -> list[str]:
    """The files that appeared in the shared folders for these tasks: anything new under `.agents/plans/` (items included) or
    `.agents/planning/`, under the run's `artifacts/<task>/`, and a `.bb/chats/` path that names one of the tasks."""
    leaks = []
    for path in sorted(after - before):
        named = any(task_id in path for task_id in task_ids)
        if path.startswith((".agents/plans/", ".agents/planning/")):
            leaks.append(path)
        elif path.startswith(".agents/runs/") and "/artifacts/" in path and (named or (run_id and path.startswith(f".agents/runs/{run_id}/artifacts/"))):
            leaks.append(path)
        elif path.startswith(".bb/chats/") and named:
            leaks.append(path)
    return leaks


def manifest_problems(cwd: str, task_id: str, expected: tuple[str, ...] = EXPECTED_KINDS) -> list[str]:
    """What the task's home misses: its manifest, a kind of the expected set, a listed file on disk (after the worktree went), a read."""
    home = Path(cwd) / ".agents" / "tasks" / task_id
    try:
        manifest = json.loads((home / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as cause:
        return [f"{task_id}: no readable .agents/tasks/{task_id}/manifest.json ({cause.__class__.__name__})"]
    problems = []
    if manifest.get("schema") != MANIFEST_SCHEMA or manifest.get("task_id") != task_id:
        problems.append(f"{task_id}: the manifest is not {MANIFEST_SCHEMA} of this task (schema {manifest.get('schema')!r}, task {manifest.get('task_id')!r})")
    files = [row for row in manifest.get("files") or [] if isinstance(row, dict)]
    kinds = {row.get("kind") for row in files}
    missing = [kind for kind in expected if kind not in kinds]
    if missing:
        problems.append(f"{task_id}: the manifest lists no {', '.join(missing)}")
    for row in files:
        path = str(row.get("path") or "")
        if not path or path.startswith("/") or ".." in path.split("/") or not (home / path).is_file():
            problems.append(f"{task_id}: {path or '(no path)'} ({row.get('kind')}) is listed but not in the home")
    for kind in READ_KINDS:
        if kind in kinds and not any(row.get("read_by") for row in files if row.get("kind") == kind):
            problems.append(f"{task_id}: no node read its {kind} through the manifest (read_by is empty)")
    if manifest.get("legacy"):
        problems.append(f"{task_id}: a task with a home read old-layout files: {[row.get('path') for row in manifest['legacy']]}")
    return problems


def neighbour_problems(cwd: str, rows: list[dict], task_ids: list[str]) -> list[str]:
    """No worktree still on disk holds another task's home, and no merge committed a task home to main."""
    problems = []
    for row in rows:
        workspace = row.get("workspace_path")
        if not workspace or workspace == cwd or not Path(workspace).is_dir():
            continue
        for other in task_ids:
            if other != row.get("task_id") and (Path(workspace) / ".agents" / "tasks" / other).exists():
                problems.append(f"the worktree of {row.get('task_id')} holds the home of {other}")
    res = subprocess.run(["git", "ls-tree", "-r", "--name-only", "HEAD", "--", ".agents/tasks"], cwd=cwd, capture_output=True, text=True, timeout=60)
    if res.returncode == 0 and res.stdout.strip():
        problems.append(f"a task home was committed to main: {res.stdout.split()[0]}")
    return problems


def read_manifest(cwd: str, task_id: str) -> dict:
    """The task's manifest.json as written in the base checkout; {} when it is missing or unreadable."""
    try:
        return json.loads((Path(cwd) / ".agents" / "tasks" / task_id / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


# The attempt-scoped kinds: they live under attempts/<attempt-id>/ of the home (SMA n233 «One folder per attempt»).
ATTEMPT_KINDS = ("writer-report", "checks", "barrier-input", "code-critique")


def node_proofs(cwd: str, task_ids: list[str], rows: list[dict], leaks: list[str], rel_plan: str) -> list[tuple[str, bool, str]]:
    """The map nodes this scene checks by its own observation (docs/sma-evidence.md), one (node, ok, detail) each, folded over both tasks.
    n67 (phase reference) and n132 (ambiguity refused) are not exercised here: the scene runs no phase and resolves no ambiguous name."""
    homes = {task_id: Path(cwd) / ".agents" / "tasks" / task_id for task_id in task_ids}
    manifests = {task_id: read_manifest(cwd, task_id) for task_id in task_ids}
    files = {task_id: [row for row in manifests[task_id].get("files") or [] if isinstance(row, dict)] for task_id in task_ids}

    def on_disk(task_id: str, kind: str) -> list[str]:
        return [str(row.get("path")) for row in files[task_id] if row.get("kind") == kind and row.get("path") and (homes[task_id] / str(row["path"])).is_file()]

    stray = [f"{t}:{row.get('path')}" for t in task_ids for row in files[t]
             if row.get("kind") in ATTEMPT_KINDS and not str(row.get("path") or "").startswith(f"attempts/{row.get('attempt_id')}/")]
    attempt_kinds = all(on_disk(t, kind) for t in task_ids for kind in ATTEMPT_KINDS)
    sources = {t: "".join((homes[t] / p).read_text(encoding="utf-8") for p in on_disk(t, "plan-source")) for t in task_ids}
    worktrees = [row["workspace_path"] for row in rows if row.get("task_id") in task_ids and row.get("workspace_path") and row.get("workspace_path") != cwd]
    left = [w for w in worktrees if Path(w).is_dir()]
    neighbours = neighbour_problems(cwd, rows, task_ids)
    unsigned = [f"{t}:{row.get('path')}" for t in task_ids for row in files[t] if not row.get("sha256") or not (row.get("produced_by") or {}).get("node")]
    return [
        ("n233", attempt_kinds and not stray, f"attempt kinds on disk for both tasks: {attempt_kinds}; outside attempts/<id>/: {stray}"),
        ("n236", all(f"source_path: {rel_plan}" in sources[t] and "sha256" in sources[t] for t in task_ids),
         f"context/plan-source.md names {rel_plan} with its sha256 in {[t for t in task_ids if rel_plan in sources[t]]}"),
        ("n294", bool(worktrees) and not left and all(on_disk(t, "acceptance") and on_disk(t, "receipt") for t in task_ids),
         f"worktrees still on disk {left} of {len(worktrees)}; acceptance and receipt in each home: {[bool(on_disk(t, 'acceptance') and on_disk(t, 'receipt')) for t in task_ids]}"),
        ("n397", not neighbours and all(on_disk(t, "brief") and on_disk(t, "writer-report") for t in task_ids),
         f"brief and writer report in each home: {[bool(on_disk(t, 'brief') and on_disk(t, 'writer-report')) for t in task_ids]}; neighbour problems {neighbours}"),
        ("n405", not leaks, f"new files in shared folders for these tasks: {leaks}"),
        ("n1616", all(on_disk(t, "plan") and on_disk(t, "outcome") for t in task_ids),
         f"plan and outcome in each home: {[(t, on_disk(t, 'plan'), on_disk(t, 'outcome')) for t in task_ids]}"),
        ("n1691", all(manifests[t].get("schema") == MANIFEST_SCHEMA and files[t] for t in task_ids) and not unsigned,
         f"{sum(len(f) for f in files.values())} manifest rows; rows without sha256 or producer: {unsigned}"),
    ]


def shared_plan(cwd: str) -> tuple[str, str]:
    """The PM's shared plan the drill puts in `.agents/plans/` before the snapshot: the task's plan names it, so its dispatch snapshots it."""
    rel = f".agents/plans/drill-{STAMP}-shared.md"
    return rel, f"# Drill {STAMP} shared plan\n\n1. Each drill note task writes exactly its one note.\n"


def task_home_specs(cwd: str) -> list[dict]:
    """The two note tasks of the scene. Their plan (the objective, which the dispatch takes as the plan) names the shared plan file."""
    rel_plan, _ = shared_plan(cwd)
    specs = [note_task(f"drill-{STAMP}-home-{letter}", f"notes/drill/{STAMP}-home-{letter}.md", f"Drill {STAMP} home {letter}", cwd) for letter in "ab"]
    for spec in specs:
        spec["objective"] = f"Follow the shared plan {rel_plan}. {spec['objective']}"
    return specs


def scenario_task_home(ctx: "Context") -> dict:
    """Two note tasks side by side through the whole main path (SMA n233, n397, n1616): each task's home holds every expected kind per its
    manifest, the files are there after the worktrees went, neither worktree held the other's home, and nothing new appeared in the shared
    folders. Each task's plan names a shared `.agents/plans/` file, which its home snapshots as context/plan-source.md."""
    rel_plan, plan_text = shared_plan(ctx.cwd)
    plan_path = Path(ctx.cwd) / rel_plan
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    plan_path.write_text(plan_text, encoding="utf-8")
    specs = task_home_specs(ctx.cwd)
    ids = [spec["id"] for spec in specs]
    try:
        before = snapshot(ctx.cwd)
        problems = [f"dispatch-bb of {spec['id']} exited with an error" for spec in specs if not ctx.dispatch(spec)]
        rows = ctx.wait_ended(ids)
        tasks = [summarize(rows, task_id, ctx.cwd, spec["expected_outputs"][0]) for task_id, spec in zip(ids, specs)]
        for row in tasks:
            if row["state"] != "accepted":
                problems.append(f"{row['task']} was not accepted: {row['states']} {row['reason']}")
        after = snapshot(ctx.cwd)
        leaks = shared_leaks(before, after, ids, ctx.run_id)
        problems += [f"a new file in a shared folder: {path}" for path in leaks]
        for task_id in ids:
            problems += manifest_problems(ctx.cwd, task_id)
        problems += neighbour_problems(ctx.cwd, rows, ids)
        proofs = Proofs()
        for node, ok, detail in node_proofs(ctx.cwd, ids, rows, leaks, rel_plan):
            proofs.prove(node, ok, detail)
        return proofs.verdict("task_home", problems + sandbox_sound(ctx.cwd), tasks=tasks)
    finally:
        plan_path.unlink(missing_ok=True)
