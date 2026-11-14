"""The plan split scenario: depends_on decides the order of a plan, nothing else does."""
from __future__ import annotations

import json
import re
import shlex
import time
from typing import Callable

from lp_drill.env import STAMP, TIMEOUT_MIN
from lp_drill.hub import bb, git, hubsql, log
from lp_drill.report import verdict
from lp_drill.tasks import task

# What the scene reads from the hub, for the run id (`:run`) and the writer-stage of d-d (`:dd`). Shown in the receipt.
PLAN_SPLIT_SQL = """SELECT a.task_id, a.id AS attempt_id, a.state, a.reason,
  (SELECT min(at) FROM lane_pilot_attempt_transition t WHERE t.attempt_id=a.id AND t.to_state='spawn_requested') AS started,
  (SELECT min(at) FROM lane_pilot_attempt_transition t WHERE t.attempt_id=a.id AND t.to_state='accepted') AS accepted,
  c.base_sha, c.merge_commit, c.changed_json
FROM lane_pilot_attempt a LEFT JOIN lane_pilot_attempt_change c ON c.attempt_id=a.id
WHERE a.run_id=:run ORDER BY started;"""
PLAN_SPLIT_REASON_SQL = "SELECT reason FROM lane_pilot_stage_receipt WHERE run_id=:run AND task_id=:dd AND stage_id='writer-agent'"
PLAN_SPLIT_TIMEOUT_MIN = max(TIMEOUT_MIN, 40)
# The plan, in the order the scene sends it: short name -> (depends_on short names, file content).
PLAN_SPLIT_PLAN = {"a": ([], "A"), "e": ([], "E"), "b": (["a"], "A+B"), "c": (["a"], "A+C"), "d": (["b", "c"], "A+B+C+D"), "f": (["d"], "A+B+C+D+F")}
# The cycle variant: x waits for y, y waits for x.
PLAN_SPLIT_CYCLE = {"x": "y", "y": "x"}
PLAN_SPLIT_RED_TOKEN = f"redtoken-{STAMP}"
# The pairs (dependent, dependency) whose base must hold the dependency's merge; c is judged by its redispatch c2.
PLAN_SPLIT_EDGES = [("b", "a"), ("c2", "a"), ("d", "b"), ("d", "c2"), ("f", "d")]


def plan_split_ids() -> dict[str, str]:
    """short name -> task id. `c2` is the redispatch of c (the id convention is `<id>.2`)."""
    ids = {name: f"drill-{STAMP}-d-{name}" for name in [*PLAN_SPLIT_PLAN, *PLAN_SPLIT_CYCLE]}
    ids["c2"] = f"{ids['c']}.2"
    return ids


def plan_split_path(name: str) -> str:
    return f"notes/drill/{STAMP}-d-{name}.md"


def plan_split_task(cwd: str, name: str, fixed: bool = False) -> dict:
    """One task of the plan: its own file, its dependencies named in depends_on and checked by grep in its own worktree
    (relative path, cwd `.`: a worktree cut before the dependency merge lacks the file and the check is red). With `fixed`
    false, c carries one more check on a token its objective never mentions: it must end blocked."""
    ids = plan_split_ids()
    deps, text = PLAN_SPLIT_PLAN[name]
    own = plan_split_path(name)
    reads = "".join(f" Read {plan_split_path(dep)} first." for dep in deps)
    checks = [f"grep -qx {shlex.quote(PLAN_SPLIT_PLAN[dep][1])} {shlex.quote(plan_split_path(dep))}" for dep in deps]
    checks.append(f"test \"$(cat {shlex.quote(own)})\" = {shlex.quote(text)}")
    if name == "c" and not fixed:
        checks.append(f"grep -q {shlex.quote(PLAN_SPLIT_RED_TOKEN)} {shlex.quote(own)}")
    spec = task(ids["c2" if fixed else name], f"Drill {STAMP} plan split {name}: one note", [own],
                f"Create the file {own} with exactly one line: `{text}`.{reads} Nothing else.",
                [f"{own} exists and its only line is `{text}`."], cwd, risk="low",
                verification=[{"command": command, "cwd": "."} for command in checks])
    spec["depends_on"] = [ids[dep] for dep in deps]
    return spec


def plan_split_tasks(cwd: str) -> dict[str, dict]:
    """The six tasks of the plan, by short name; the fixed contract of c is `c2` (same file and objective, a check that can pass)."""
    return {**{name: plan_split_task(cwd, name) for name in PLAN_SPLIT_PLAN}, "c2": plan_split_task(cwd, "c", fixed=True)}


def plan_split_cycle_tasks(cwd: str) -> dict[str, dict]:
    """d-x (depends_on d-y) and d-y (depends_on d-x): the second one sent makes a cycle."""
    ids = plan_split_ids()
    out = {}
    for name, other in PLAN_SPLIT_CYCLE.items():
        own = plan_split_path(name)
        out[name] = task(ids[name], f"Drill {STAMP} plan split cycle {name}", [own], f"Create the file {own} with exactly one line: `{name}`. Nothing else.",
                         [f"{own} exists and its only line is `{name}`."], cwd, risk="low") | {"depends_on": [ids[other]]}
    return out


def plan_split_sql(template: str, **values: str) -> str:
    """The template with `:name` replaced by the quoted value; a value that is no plain id is refused."""
    for name, value in values.items():
        if not re.fullmatch(r"[A-Za-z0-9_.:-]+", value):
            raise ValueError(f"not a plain id for the query: {value!r}")
        template = template.replace(f":{name}", "'" + value + "'")
    return template


def _ts(value):
    """A transition time as a comparable number (or the text when it is not one); None stays None."""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return str(value)


def _paths(raw) -> set[str]:
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except ValueError:
        return set()
    return {str(item.get("path") if isinstance(item, dict) else item) for item in data if item} if isinstance(data, list) else set()


def _family(task_id: str) -> str:
    return re.sub(r"\.\d+$", "", task_id)


def plan_split_problems(rows: list[dict], ids: dict[str, str], is_ancestor: Callable[[str, str], bool], dd_reason: str = "",
                        cycle_reply: str = "", cycle_rows: list[dict] | None = None) -> list[str]:
    """What the plan split rule owes, as named problems over the attempt rows (PLAN_SPLIT_SQL): dependents start after their dependencies
    are accepted, independents do not wait, d-d waited naming d-c while it was blocked, every dependent's base holds its dependencies'
    merge commits (`is_ancestor(merge, base)`, git in the sandbox), no two tasks changed the same path, no merge conflict, and the cycle
    was refused with depends_cycle without an attempt. An empty list is green."""
    problems: list[str] = []
    by_task: dict[str, list[dict]] = {}
    for row in rows:
        by_task.setdefault(row["task_id"], []).append(row)

    def started(name: str):
        times = [t for t in (_ts(r.get("started")) for r in by_task.get(ids[name], [])) if t is not None]
        return min(times) if times else None

    def accepted_row(name: str) -> dict | None:
        done = [r for r in by_task.get(ids[name], []) if r.get("state") == "accepted"]
        return max(done, key=lambda r: _ts(r.get("accepted")) or 0) if done else None

    def accepted(name: str):
        row = accepted_row(name)
        return _ts(row.get("accepted")) if row else None

    def need(label: str, name: str, value) -> bool:
        if value is None:
            problems.append(f"missing_{label}: {ids[name]} has no {label} time")
        return value is not None

    for name in ("a", "b", "c2", "d", "e", "f"):
        need("accepted", name, accepted(name))
    for name in ("a", "b", "c", "d", "e", "f"):
        need("started", name, started(name))
    if any(r.get("state") == "accepted" for r in by_task.get(ids["c"], [])):
        problems.append(f"c_first_not_blocked: {ids['c']} was accepted although its check is red on purpose")
    elif by_task.get(ids["c"]) and not any(r.get("state") == "blocked" for r in by_task[ids["c"]]):
        problems.append(f"c_first_not_blocked: {ids['c']} did not end blocked: {[r.get('state') for r in by_task[ids['c']]]}")

    a_acc, b_acc, c2_acc, d_acc = accepted("a"), accepted("b"), accepted("c2"), accepted("d")
    if a_acc is not None:
        for name in ("b", "c"):
            if started(name) is not None and started(name) < a_acc:
                problems.append(f"started_before_dependency_accepted: {ids[name]} started at {started(name)}, {ids['a']} was accepted at {a_acc}")
        if started("e") is not None and not started("e") < a_acc:
            problems.append(f"independent_waited: {ids['e']} started at {started('e')}, not before {ids['a']} was accepted at {a_acc}")
    if b_acc is not None and c2_acc is not None and started("d") is not None and started("d") < max(b_acc, c2_acc):
        problems.append(f"started_before_dependency_accepted: {ids['d']} started at {started('d')}, its dependencies were accepted at {b_acc} ({ids['b']}) and {c2_acc} ({ids['c2']})")
    if d_acc is not None and started("f") is not None and started("f") < d_acc:
        problems.append(f"started_before_dependency_accepted: {ids['f']} started at {started('f')}, {ids['d']} was accepted at {d_acc}")
    if "waiting for depends_on:" not in dd_reason or ids["c"] not in dd_reason:
        problems.append(f"dependent_did_not_wait_for_failed: the writer stage of {ids['d']} while {ids['c']} was blocked said {dd_reason!r}, not `waiting for depends_on:` naming {ids['c']}")
    if c2_acc is not None:
        for name in ("b", "e"):
            if accepted(name) is not None and not accepted(name) < c2_acc:
                problems.append(f"independent_waited_for_failure: {ids[name]} was accepted at {accepted(name)}, not before {ids['c2']} at {c2_acc}")

    for dependent, dependency in PLAN_SPLIT_EDGES:
        merged, based = accepted_row(dependency), accepted_row(dependent)
        if based is None:  # a dependent that never ended accepted is judged on its latest attempt that has a base
            based = next((r for r in reversed(by_task.get(ids[dependent], [])) if r.get("base_sha")), None)
        merge, base = (merged or {}).get("merge_commit"), (based or {}).get("base_sha")
        if not merge:
            problems.append(f"no_merge_commit: {ids[dependency]} has no merge commit on record")
        elif not base:
            problems.append(f"no_base_sha: {ids[dependent]} has no base commit on record")
        elif not is_ancestor(merge, base):
            problems.append(f"base_lacks_dependency_merge: the worktree of {ids[dependent]} was cut from {base[:12]}, which does not hold the merge {merge[:12]} of {ids[dependency]}")

    changed: dict[str, set[str]] = {}
    for row in rows:
        changed.setdefault(_family(row["task_id"]), set()).update(_paths(row.get("changed_json")))
        if str(row.get("reason") or "").startswith("merge_conflict"):
            problems.append(f"merge_conflict: {row['task_id']} attempt {row.get('attempt_id')}: {str(row['reason'])[:160]}")
    families = sorted(changed)
    for i, left in enumerate(families):
        for right in families[i + 1:]:
            if changed[left] & changed[right]:
                problems.append(f"changed_paths_overlap: {left} and {right} both changed {sorted(changed[left] & changed[right])}")

    if cycle_rows:
        problems.append(f"cycle_attempt_exists: {ids['y']} has {len(cycle_rows)} attempt(s) although it closes a cycle")
    if "depends_cycle" not in cycle_reply:
        problems.append(f"cycle_not_refused: the reply to {ids['y']} does not name depends_cycle: {cycle_reply[:200]!r}")
    if "validation_failed" not in cycle_reply:
        problems.append(f"cycle_not_validation_failed: the reply to {ids['y']} is not state validation_failed: {cycle_reply[:200]!r}")
    return problems


def plan_split_ancestor(cwd: str) -> Callable[[str, str], bool]:
    """`git merge-base --is-ancestor` in the sandbox checkout; a commit it does not know counts as not an ancestor."""
    def is_ancestor(merge: str, base: str) -> bool:
        try:
            git(cwd, "merge-base", "--is-ancestor", merge, base)
            return True
        except RuntimeError:
            return False
    return is_ancestor


def scenario_plan_split(ctx: "Context") -> dict:
    """Plan split drill: six tasks in one run (a; b and c after a; d after b and c; e alone; f after d), c red on purpose first and
    sent again as c.2, plus a dependency cycle (x and y) that the contract lint refuses with depends_cycle. A dependency is only
    the explicit depends_on; a task starts when its dependencies are accepted and merged and its worktree is cut from that main;
    a failed task holds its dependents and nobody else. Judged by plan_split_problems over the query PLAN_SPLIT_SQL (printed below; :run is
    the run id) plus the writer-stage reason of d-d while d-c is blocked (PLAN_SPLIT_REASON_SQL). Full set only."""
    ids, specs = plan_split_ids(), plan_split_tasks(ctx.cwd)
    problems: list[str] = []
    for name in PLAN_SPLIT_PLAN:
        if not ctx.dispatch(specs[name]):
            problems.append(f"dispatch-bb of {ids[name]} exited with an error")
    cycle = plan_split_cycle_tasks(ctx.cwd)
    reply = ""
    for name in ("x", "y"):
        rc, out, err = bb("lane-pilot", "dispatch-bb", ctx.project, ctx.pm, json.dumps(cycle[name]), timeout=180)
        reply = (out + err).strip()
        log(f"cycle dispatch of {ids[name]}: exit {rc} {reply[:200]}")
    if not ctx.wait_state(ids["c"], "blocked", PLAN_SPLIT_TIMEOUT_MIN):
        problems.append(f"{ids['c']} never ended blocked")
    dd_reason = ""
    for _ in range(8):  # d-d keeps waiting while d-c is blocked; its stage says whom it waits for
        reasons = hubsql(plan_split_sql(PLAN_SPLIT_REASON_SQL, run=ctx.run_id, dd=ids["d"]))
        dd_reason = str(reasons[0]["reason"] or "") if reasons else ""
        if "waiting for depends_on:" in dd_reason and ids["c"] in dd_reason:
            break
        time.sleep(15)
    if not ctx.dispatch(specs["c2"]):
        problems.append(f"dispatch-bb of {ids['c2']} exited with an error")
    ended = [ids[name] for name in ("a", "b", "c2", "d", "e", "f")]
    ctx.wait_ended(ended, PLAN_SPLIT_TIMEOUT_MIN)
    rows = hubsql(plan_split_sql(PLAN_SPLIT_SQL, run=ctx.run_id))
    cycle_rows = [r for r in rows if r["task_id"] == ids["y"]]
    for row in (r for r in rows if r["task_id"] == ids["x"] and r["state"] in ("queued", "spawn_requested", "spawn_unknown", "running")):
        bb("lane-pilot", "cancel", row["attempt_id"])  # d-x would block after two minutes with «no such task»
    problems += plan_split_problems(rows, ids, plan_split_ancestor(ctx.cwd), dd_reason, reply, cycle_rows)
    return verdict("plan_split", problems, runId=ctx.run_id, sql=PLAN_SPLIT_SQL, rows=rows, ddReason=dd_reason, cycleReply=reply[:600],
                   dispatch={ids[name]: ctx.dispatches.get(ids[name]) for name in (*PLAN_SPLIT_PLAN, "c2")})


scenario_plan_split.__doc__ = f"{scenario_plan_split.__doc__}\nPLAN_SPLIT_SQL:\n{PLAN_SPLIT_SQL}\nPLAN_SPLIT_REASON_SQL:\n{PLAN_SPLIT_REASON_SQL}\n"
