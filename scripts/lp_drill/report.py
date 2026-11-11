"""Row reading and verdicts: states, summaries, sandbox soundness, note commits."""
from __future__ import annotations

import json
import os
from pathlib import Path

from lp_drill.hub import git

def latest_states(rows: list[dict]) -> dict[str, str]:
    latest: dict[str, str] = {}
    for row in sorted(rows, key=lambda r: r["created_at"]):
        latest[row["task_id"]] = row["state"]
    return latest


def summarize(rows: list[dict], task_id: str, cwd: str, output: str | None = None) -> dict:
    mine = sorted((r for r in rows if r["task_id"] == task_id), key=lambda r: r["created_at"])
    last = mine[-1] if mine else None
    out = {"task": task_id, "attempts": len(mine), "states": [r["state"] for r in mine], "state": last["state"] if last else None,
           "reason": (last["reason"] or "")[:200] if last else None, "attempt": last["id"] if last else None,
           "writerThread": last["thread_id"] if last else None, "workspace": last["workspace_path"] if last else None,
           "environment": last.get("environment_id") if last else None, "holder": last.get("holder_thread_id") if last else None}
    if output:
        out["file"] = output
        out["fileInSandbox"] = (Path(cwd) / output).is_file()
    return out


def verdict(name: str, problems: list[str], **details) -> dict:
    return {"name": name, "result": "pass" if not problems else "fail", "problems": problems, **details}


def provider_problems(tasks: list[dict]) -> list[str]:
    """The accepted attempts ran on the worktree provider: an environment of its own, no holder thread (the old path's model turn)."""
    problems = []
    for t in tasks:
        # LP_DRILL_REQUIRE_PROVIDER=0 only for the drill of the first build that has the provider: the deployed one has none yet.
        if t["state"] != "accepted" or os.environ.get("LP_DRILL_REQUIRE_PROVIDER", "1") == "0":
            continue
        if not t["environment"]:
            problems.append(f"{t['task']}: no BB environment on the attempt, so the worktree provider was not used (it fell back to the old path)")
        if t["holder"]:
            problems.append(f"{t['task']}: a holder thread {t['holder']} was spawned for the worktree")
    return problems


def conflict_markers(cwd: str, rel: str) -> bool:
    try:
        text = (Path(cwd) / rel).read_text()
    except OSError:
        return False
    return any(line.startswith(("<<<<<<<", "=======", ">>>>>>>")) for line in text.splitlines())


def sandbox_sound(cwd: str) -> list[str]:
    """The sandbox main checkout holds no half-done merge or rebase."""
    problems = []
    gitdir = Path(cwd) / ".git"
    for marker in ("MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"):
        if (gitdir / marker).exists():
            problems.append(f"the sandbox is left mid-operation: .git/{marker}")
    if any(line[:2] in ("UU", "AA", "DD", "AU", "UA", "DU", "UD") for line in git(cwd, "status", "--porcelain").splitlines()):
        problems.append("the sandbox has unmerged paths")
    return problems


def commit_file(cwd: str, rel: str, text: str, message: str) -> str:
    path = Path(cwd) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    git(cwd, "add", rel)
    git(cwd, "-c", "user.name=Lane Pilot drill", "-c", "user.email=drill@local.invalid", "commit", "-m", message, "--", rel)
    return git(cwd, "rev-parse", "HEAD")
