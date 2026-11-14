"""The run_home scenario: a workflow-graph run keeps its artifacts in a folder of its own and nothing new lands in the shared folders
(docs/task-folder.md «The run folder»; audit handoff-map §5.3, the step 2 proof). Sibling of task_home.

The graph is the built-in `note-add` (no model, one `fs.write` into `.agents/todos/notes/{{date}}-{{run_id}}/`), started twice on the same day
through `bb lane-pilot workflow-trigger`. After both ended: each run's `.agents/runs/<run-id>/manifest.json` (lp.run-manifest/1) lists every file
its node wrote, each listed file is on disk, the two runs wrote different folders, and a `find` of the shared folders before and after shows no
new file except the two manifests, the files they list and the documented PM-chat spill (`.bb/chats/<pm>/artifacts/wf-<run>/`)."""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from lp_drill.env import POLL_SEC, STAMP
from lp_drill.hub import bb, hubsql, log
from lp_drill.prove import Proofs
from lp_drill.report import sandbox_sound

RUN_MANIFEST_SCHEMA = "lp.run-manifest/1"
RUN_GRAPH = "note-add"
RUN_ENDED = ("succeeded", "failed", "blocked", "interrupted", "canceled", "not_verified")
# The shared folders a run of this graph must leave alone (the `find` of the audit §5.6). `.agents/todos` is the graph's own domain root:
# only the run-keyed folder inside it is its own.
RUN_SHARED_ROOTS = (".agents/plans", ".agents/planning", ".agents/todos", ".agents/runs", ".bb/chats")


def run_snapshot(cwd: str) -> set[str]:
    """Every file under the shared folders (`find <root> -type f`), repository-relative. A missing root is empty."""
    roots = [root for root in RUN_SHARED_ROOTS if (Path(cwd) / root).is_dir()]
    if not roots:
        return set()
    res = subprocess.run(["find", *roots, "-type", "f"], cwd=cwd, capture_output=True, text=True, timeout=120)
    return {line.strip().removeprefix("./") for line in res.stdout.splitlines() if line.strip()}


def read_run_manifest(cwd: str, run_id: str) -> dict:
    """The run's manifest.json as written in the checkout; {} when it is missing or unreadable."""
    try:
        return json.loads((Path(cwd) / ".agents" / "runs" / run_id / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def run_manifest_rows(manifest: dict) -> list[dict]:
    return [row for row in manifest.get("files") or [] if isinstance(row, dict)]


def run_manifest_problems(cwd: str, run_id: str, workflow: str = RUN_GRAPH) -> list[str]:
    """What the run's folder misses: its manifest, the graph's name, an output row from a node, a listed file on disk, a hash and a version."""
    manifest = read_run_manifest(cwd, run_id)
    if not manifest:
        return [f"{run_id}: no readable .agents/runs/{run_id}/manifest.json"]
    problems = []
    if manifest.get("schema") != RUN_MANIFEST_SCHEMA or manifest.get("run_id") != run_id or manifest.get("workflow_id") != workflow:
        problems.append(f"{run_id}: the manifest is not {RUN_MANIFEST_SCHEMA} of this {workflow} run (schema {manifest.get('schema')!r}, run {manifest.get('run_id')!r}, graph {manifest.get('workflow_id')!r})")
    rows = run_manifest_rows(manifest)
    if not any(row.get("kind") == "output" for row in rows):
        problems.append(f"{run_id}: the manifest lists no output file (the node wrote one)")
    for row in rows:
        path = str(row.get("path") or "")
        if not path or path.startswith("/") or ".." in path.split("/") or not (Path(cwd) / path).is_file():
            problems.append(f"{run_id}: {path or '(no path)'} ({row.get('kind')}) is listed but not on disk")
        if not row.get("sha256") or not (row.get("produced_by") or {}).get("node") or not row.get("plugin_version"):
            problems.append(f"{run_id}: {path} has no sha256, producing node or plugin version")
        if row.get("kind") == "output" and run_id not in path:
            problems.append(f"{run_id}: {path} is not in a folder keyed by this run")
    return problems


def run_shared_leaks(before: set[str], after: set[str], run_ids: list[str], cwd: str) -> list[str]:
    """New files in the shared folders that belong to none of the runs: not the run's manifest, not a file its manifest lists, not its
    PM-chat spill (`.bb/chats/<pm>/artifacts/wf-<first 24 of the run id>/`)."""
    own: set[str] = set()
    spills: list[str] = []
    for run_id in run_ids:
        own.add(f".agents/runs/{run_id}/manifest.json")
        own.update(str(row.get("path")) for row in run_manifest_rows(read_run_manifest(cwd, run_id)))
        spills.append(f"/artifacts/wf-{run_id[:24]}/")
    return [path for path in sorted(after - before) if path not in own and not any(spill in path for spill in spills)]


def run_distinct_problems(cwd: str, run_ids: list[str]) -> list[str]:
    """Two runs of one graph on one day wrote different files: no path is listed by two runs, and none replaced the other's."""
    seen: dict[str, str] = {}
    problems = []
    for run_id in run_ids:
        for row in run_manifest_rows(read_run_manifest(cwd, run_id)):
            path = str(row.get("path"))
            if path in seen:
                problems.append(f"{path} was written by both {seen[path]} and {run_id}")
            if row.get("replaces"):
                problems.append(f"{run_id} replaced {row['replaces']}")
            seen[path] = run_id
    return problems


def run_home_inputs(letter: str) -> dict:
    return {"text": f"Drill {STAMP} run home {letter}: the note of one run."}


def wait_run_home_runs(keys_text: str, timeout_min: int = 10) -> list[dict]:
    """The note-add runs of this drill (found by their text) once every one ended; the last rows seen on timeout."""
    rows: list[dict] = []
    deadline = time.time() + timeout_min * 60
    while time.time() < deadline:
        rows = hubsql(f"select id, status from lane_pilot_wf_run where workflow_id='{RUN_GRAPH}' and inputs_json like '%{keys_text}%' order by created_at;")
        if len(rows) >= 2 and all(row.get("status") in RUN_ENDED for row in rows):
            return rows
        time.sleep(POLL_SEC)
    return rows


def scenario_run_home(ctx: "Context") -> dict:
    """Two runs of note-add on one day (n233 as the graph-run analogue: one folder per run, every artifact in it)."""
    problems: list[str] = []
    before = run_snapshot(ctx.cwd)
    for letter in "ab":
        rc, out, err = bb("lane-pilot", "workflow-trigger", ctx.project, RUN_GRAPH, json.dumps(run_home_inputs(letter)), f"drill-{STAMP}-run-home-{letter}")
        if rc != 0:
            problems.append(f"workflow-trigger of {RUN_GRAPH} ({letter}) failed: {(out + err).strip()[:200]}")
            log(f"workflow-trigger {letter}: {(out + err).strip()[:200]}")
    runs = wait_run_home_runs(f"Drill {STAMP} run home")
    run_ids = [str(row["id"]) for row in runs]
    if len(run_ids) != 2:
        problems.append(f"expected two {RUN_GRAPH} runs of this drill, found {len(run_ids)}")
    problems += [f"run {row['id']} ended {row['status']}" for row in runs if row.get("status") != "succeeded"]
    after = run_snapshot(ctx.cwd)
    leaks = run_shared_leaks(before, after, run_ids, ctx.cwd)
    problems += [f"a new file in a shared folder: {path}" for path in leaks]
    for run_id in run_ids:
        problems += run_manifest_problems(ctx.cwd, run_id)
    clashes = run_distinct_problems(ctx.cwd, run_ids)
    problems += clashes
    listed = {run_id: run_manifest_rows(read_run_manifest(ctx.cwd, run_id)) for run_id in run_ids}
    proofs = Proofs()
    proofs.prove("n233", len(run_ids) == 2 and all(listed[r] and not run_manifest_problems(ctx.cwd, r) for r in run_ids) and not clashes,
                 f"each graph run's .agents/runs/<id>/manifest.json lists {[len(listed[r]) for r in run_ids]} files, all on disk, in folders keyed by the run; clashes {clashes}")
    return proofs.verdict("run_home", problems + sandbox_sound(ctx.cwd), runs=runs)
