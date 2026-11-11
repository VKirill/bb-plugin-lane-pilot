"""The no-git scenarios: a plugin task in a folder without git, and in a repo inside it."""
from __future__ import annotations

import json
import os
from pathlib import Path

from lp_drill.context import Context
from lp_drill.env import NOGIT, STAMP
from lp_drill.hub import bb, git, hubsql, log
from lp_drill.report import summarize, verdict
from lp_drill.tasks import NOGIT_REPO, task_nogit, task_nogit_repo

def ensure_prototype_config(spec: dict) -> bool:
    """`bb lane-pilot activate` needs the project's prototype config (host, folders, PM and writer models). The sandbox project that has no git
    gets it once, from the same values as the main sandbox project; it stays (the plugin has no way to remove it). True when this call set it."""
    have = hubsql(f"select count(*) as n from lane_pilot_project_settings where project_id='{spec['project']}' and binding_id='' and key='writerWorkspacePath';")
    if have and int(have[0]["n"]) > 0:
        return False
    config = {"projectId": spec["project"], "hostId": os.environ.get("LP_DRILL_HOST", "host_7sea4qaad8"), "pmWorkspacePath": spec["cwd"], "writerWorkspacePath": spec["cwd"],
              "pmProviderId": "claude-code", "pmModel": "claude-sonnet-5-5", "writerProviderId": "codex", "writerModel": "gpt-6-luna"}
    rc, out, err = bb("lane-pilot", "configure", json.dumps(config))
    if rc != 0:
        raise RuntimeError(f"could not configure {spec['project']}: {(err or out).strip()[:200]}")
    log(f"configured {spec['project']} for the drill")
    return True


def scenario_nogit(tmp: Path) -> dict:
    cwd = NOGIT["cwd"]
    if not Path(cwd).is_dir():
        # A missing sandbox is a red drill, not a quiet skip: from 2026-10-23 to 10-27 both scenarios were skipped unseen (project deleted).
        return verdict("nogit", [f"the sandbox folder {cwd} is missing: recreate it (a folder without git) and its BB project (LP_DRILL_NOGIT_PROJECT)"])
    if (Path(cwd) / ".git").exists():
        return verdict("nogit", [f"{cwd} is a git repo: this scenario needs a folder without git"])
    ctx = Context(NOGIT, tmp)
    spec = task_nogit(cwd)
    out = spec["expected_outputs"][0]
    problems: list[str] = []
    row: dict = {}
    configured = False
    try:
        configured = ensure_prototype_config(NOGIT)
        ctx.start()
        if not ctx.dispatch(spec):
            problems.append("dispatch-bb exited with an error")
        rows = ctx.wait_ended([spec["id"]])
        row = summarize(rows, spec["id"], cwd, out)
        if row["state"] != "accepted":
            problems.append(f"the task was not accepted in the folder without git: {row['states']} {row['reason']}")
        if not row["fileInSandbox"]:
            problems.append("the task's file is not in the folder")
        if (Path(cwd) / ".git").exists():
            problems.append("Lane Pilot created .git in a folder that had none")
    except RuntimeError as cause:
        problems.append(str(cause))
    finally:
        if ctx.run_id:
            ctx.quiet()
        problems += ctx.finish()
        (Path(cwd) / out).unlink(missing_ok=True)
    return verdict("nogit", problems, tasks=[row] if row else [], project=NOGIT["project"], runId=ctx.run_id or None, configuredByDrill=configured)


def scenario_nogit_repo(tmp: Path) -> dict:
    cwd = NOGIT["cwd"]
    if not Path(cwd).is_dir():
        # A missing sandbox is a red drill, not a quiet skip: from 2026-10-23 to 10-27 both scenarios were skipped unseen (project deleted).
        return verdict("nogit_repo", [f"the sandbox folder {cwd} is missing: recreate it (a folder without git) and its BB project (LP_DRILL_NOGIT_PROJECT)"])
    if (Path(cwd) / ".git").exists():
        return verdict("nogit_repo", [f"{cwd} is a git repo: this scenario needs a folder without git"])
    repo = Path(cwd) / NOGIT_REPO
    if not (repo / ".git").exists():
        repo.mkdir(parents=True, exist_ok=True)
        (repo / "README.md").write_text("A git repository inside the drill's folder without git (scenario nogit_repo).\n")
        git(str(repo), "init", "-q", "-b", "main")
        git(str(repo), "add", "README.md")
        git(str(repo), "-c", "user.name=Lane Pilot drill", "-c", "user.email=drill@local.invalid", "commit", "-q", "-m", "drill repository")
    ctx = Context(NOGIT, tmp)
    spec = task_nogit_repo(cwd)
    out = spec["expected_outputs"][0]
    inside = out.removeprefix(f"{NOGIT_REPO}/")
    problems: list[str] = []
    row: dict = {}
    configured = False
    try:
        configured = ensure_prototype_config(NOGIT)
        ctx.start()
        if not ctx.dispatch(spec):
            problems.append("dispatch-bb exited with an error")
        rows = ctx.wait_ended([spec["id"]])
        row = summarize(rows, spec["id"], cwd, out)
        if row["state"] != "accepted":
            problems.append(f"the task was not accepted: {row['states']} {row['reason']}")
        if not row["fileInSandbox"]:
            problems.append(f"{out} is not in the repository's checkout")
        if row["workspace"] and Path(row["workspace"]).resolve() in (Path(cwd).resolve(), repo.resolve()):
            problems.append(f"the writer worked in {row['workspace']}, not in a worktree of the repository")
        # Lane Pilot merges with a merge commit, whose own file list is empty: the file must be tracked on main.
        if not git(str(repo), "ls-files", "--", inside):
            problems.append(f"{inside} is not tracked on the main of {NOGIT_REPO}: the work was not merged into it")
        if git(str(repo), "status", "--porcelain", "--", inside):
            problems.append(f"{inside} is uncommitted in {NOGIT_REPO}")
        if (Path(cwd) / ".git").exists():
            problems.append("Lane Pilot created .git in a folder that had none")
    except RuntimeError as cause:
        problems.append(str(cause))
    finally:
        if ctx.run_id:
            ctx.quiet()
        problems += ctx.finish()
        if git(str(repo), "ls-files", "--", inside):
            git(str(repo), "rm", "-q", "--", inside)
            git(str(repo), "-c", "user.name=Lane Pilot drill", "-c", "user.email=drill@local.invalid", "commit", "-q", "-m", f"drill {STAMP}: clean up")
        # An untracked file (the task did not land in the repository) is a finding, not a crash of the cleanup that hides it.
        (repo / inside).unlink(missing_ok=True)
    return verdict("nogit_repo", problems, tasks=[row] if row else [], project=NOGIT["project"], runId=ctx.run_id or None, configuredByDrill=configured)
