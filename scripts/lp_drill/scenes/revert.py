"""The revert scenario: a merged change is judged and reverted in the sandbox."""
from __future__ import annotations

import time

from lp_drill.env import POLL_SEC, SANDBOX_PROJECTS, STAMP
from lp_drill.hub import bb
from lp_drill.report import conflict_markers, sandbox_sound, summarize, verdict
from lp_drill.tasks import note_task

def revert_merged(changes_json: str) -> bool:
    """Whether `bb lane-pilot changes <task>` records the revert merge: a receipt of kind `revert` in state `merged` (the rollback
    store's append-only ledger). The word «revert» elsewhere in the output (a summary, a dry-run or refused receipt) does not count."""
    try:
        data = json.loads(changes_json)
    except ValueError:
        return False
    receipts = data.get("receipts") if isinstance(data, dict) else None
    return any(isinstance(r, dict) and r.get("kind") == "revert" and r.get("state") == "merged" for r in receipts or [])


def revert_judged(ctx: "Context", task_id: str, rel: str) -> list[str]:
    """What the revert owes (SMA m_sd_merge): a merge receipt on record, the note gone from main, no conflict markers, a sound sandbox."""
    problems: list[str] = []
    deadline, receipt = time.time() + 10 * 60, False
    while time.time() < deadline and not receipt:
        # `changes` takes no flags and always answers JSON.
        rc, out, _ = bb("lane-pilot", "changes", task_id, timeout=60)
        if rc == 0 and revert_merged(out):
            receipt = True
        else:
            time.sleep(POLL_SEC)
    if not receipt:
        problems.append("the revert left no merge receipt (bb lane-pilot changes shows no revert receipt in state merged)")
    if (Path(ctx.cwd) / rel).exists():
        problems.append(f"{rel} is still on main after the revert")
    if conflict_markers(ctx.cwd, rel):
        problems.append("conflict markers were left on main")
    return problems + sandbox_sound(ctx.cwd)


def scenario_revert(ctx: "Context") -> dict:
    """Terminal merge drill (SMA m_sd_merge): the command-line merge verb `bb lane-pilot revert` enters the same ritual as the
    daemon's door — its result lands on main through the merge queue, and refuses with the next step when later commits
    touch the same lines. It rewrites the sandbox main, so it runs nowhere else."""
    if ctx.project not in SANDBOX_PROJECTS:
        return verdict("revert", [f"the revert drill rewrites main: it runs on the sandbox project only, not {ctx.project}"])
    rel = f"notes/drill/{STAMP}-revert.md"
    first = note_task(f"drill-{STAMP}-revert-a", rel, f"Drill {STAMP} revert a", ctx.cwd)
    second = note_task(f"drill-{STAMP}-revert-b", rel, f"Drill {STAMP} revert b", ctx.cwd)
    problems = [] if ctx.dispatch(first) else ["dispatch-bb exited with an error"]
    rows = ctx.wait_ended([first["id"]])
    row_a = summarize(rows, first["id"], ctx.cwd, rel)
    if row_a["state"] != "accepted":
        return verdict("revert", problems + [f"the note task was not accepted, nothing to revert: {row_a['states']} {row_a['reason']}"], tasks=[row_a])
    rc, out, err = bb("lane-pilot", "revert", first["id"], timeout=600)
    if rc != 0:
        problems.append(f"bb lane-pilot revert exited {rc}: {(err or out).strip()[:300]}")
    problems += revert_judged(ctx, first["id"], rel)
    if not ctx.dispatch(second):
        problems.append("the second dispatch-bb exited with an error")
    rows = ctx.wait_ended([second["id"]])
    row_b = summarize(rows, second["id"], ctx.cwd, rel)
    if row_b["state"] == "accepted":
        rc, out, err = bb("lane-pilot", "revert", first["id"], "--dry-run", timeout=120)
        if rc == 0:
            problems.append("revert --dry-run did not refuse although a later commit touches the same lines")
    return verdict("revert", problems, tasks=[row_a, row_b])
