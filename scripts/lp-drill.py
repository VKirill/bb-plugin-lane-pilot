#!/usr/bin/env python3
"""Sandbox drill (E3): the live regression check run before every Lane Pilot deploy. Entry point: scripts/lp-drill.sh.

Scenarios (each writes its verdict into the receipt, .agents/runs/drills/<date>.json):
  guard_hash     the installed shell guard (~/.agents/hooks/guard_shell.py and lib_payload.py) on the Mac mini, the MacBook and OVH
                 is byte for byte the repository's copy (lane-stack/hooks). A drifted or missing copy fails the drill and the
                 receipt lists the install command per machine; --repair-guard (or LP_DRILL_REPAIR_GUARD=1) installs the
                 repository copy and checks it again. A machine that cannot be reached is noted, not failed          [--quick]
  helper_providers one helper per provider in use (claude-code, codex, acp-opencode, and acp-cursor when a setting names it), each
                 started the way the pm-read stage starts its helper (`bb lane-pilot helper-probe`) with a prompt that asks for
                 one word: each must start and answer. A provider that refuses its helpers fails the drill (0.1.194 refused
                 every OpenCode helper for six minutes and the writer-only drill stayed green)                       [--quick]
  parallel3      3 parallel, non-overlapping tasks (risk high): each accepted, each in a worktree of its own        [--quick]
  conflict       two tasks own the same file and rewrite the same line: both end, both accepted, no conflict markers left
  main_moved     main gets a commit while a writer works: the merge is rebased and keeps both
  provider_limit a bad writer.model in the sandbox: the task still ends accepted through the next writer; the setting is restored
  reload         `bb plugin reload lane-pilot` while a writer works: the task still ends accepted (skipped when a non-sandbox
                 project has open attempts)
  provider       one task: its attempt runs on a BB environment of Lane Pilot's own worktree provider (environment_id set, no
                 holder thread, own worktree). A silent fallback to the old path fails it: a broken provider must not ship
  nogit          a project whose folder is not a git repo (live-folder mode): accepted, file in the folder, no .git created

Usage: scripts/lp-drill.sh [--quick] [--scenario a,b] [--dry-run] [--repair-guard]
  --quick      the scenarios marked [--quick] (what bb-plugin-push runs before a deploy)
  --scenario   only the named scenarios
  --dry-run    print the tasks, change nothing
Exit: 0 pass, 1 a scenario failed (the receipt says why), 2 could not start. The last stdout line is `RECEIPT=<path>`.
Settings (env): LP_DRILL_TIMEOUT_MIN (20, per scenario), LP_DRILL_PROJECT, LP_DRILL_ENVIRONMENT, LP_DRILL_CWD,
LP_DRILL_PROVIDERS (`provider=model,...` instead of the providers read from the sandbox project's settings), LP_DRILL_GUARD_HOSTS (JSON list of machines for guard_hash), LP_DRILL_RECEIPT_DIR, LP_DRILL_NOGIT_PROJECT, LP_DRILL_NOGIT_ENVIRONMENT, LP_DRILL_NOGIT_CWD, LP_DRILL_BAD_MODEL, BB_CLI, BB_HUB_HOST, BB_HUB_KEY.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BB = os.environ.get("BB_CLI", "bb")
HUB = os.environ.get("BB_HUB_HOST", "ubuntu@10.8.0.1")
KEY = os.environ.get("BB_HUB_KEY", str(Path.home() / ".ssh/oracle_bb"))
HUB_DB = os.environ.get("LP_DRILL_HUB_DB", "/home/ubuntu/.bb/plugins/lane-pilot/data.db")
TIMEOUT_MIN = int(os.environ.get("LP_DRILL_TIMEOUT_MIN", "20"))
POLL_SEC = int(os.environ.get("LP_DRILL_POLL_SEC", "20"))
BAD_MODEL = os.environ.get("LP_DRILL_BAD_MODEL", "lp-drill-model-that-does-not-exist")
SANDBOX = dict(project=os.environ.get("LP_DRILL_PROJECT", "proj_3tb652jpsi"),
               environment=os.environ.get("LP_DRILL_ENVIRONMENT", "env_mybrzmx7nz"),
               cwd=os.environ.get("LP_DRILL_CWD", "/Users/vechkasov/lp-sandbox-rules"))
NOGIT = dict(project=os.environ.get("LP_DRILL_NOGIT_PROJECT", "proj_mzm4k9xd4c"),
             environment=os.environ.get("LP_DRILL_NOGIT_ENVIRONMENT", "env_ncxmcqyh99"),
             cwd=os.environ.get("LP_DRILL_NOGIT_CWD", "/Users/vechkasov/lp-sandbox-layouts/n-nogit"))
SANDBOX_PROJECTS = {SANDBOX["project"], NOGIT["project"]}
OPEN_STATES = ("queued", "spawn_requested", "spawn_unknown", "running")
TERMINAL = ("accepted", "blocked", "canceled")
STAMP = time.strftime("%Y%m%d-%H%M%S")
DATE = time.strftime("%Y-%m-%d")
ALL = ["guard_hash", "helper_providers", "parallel3", "conflict", "main_moved", "provider", "provider_limit", "reload", "nogit"]
QUICK = ["guard_hash", "helper_providers", "parallel3"]
# What a provider runs when no setting of the sandbox project names a model for it.
PROVIDER_FALLBACK_MODEL = {"claude-code": "claude-sonnet-5-5", "codex": "gpt-6-luna", "acp-opencode": "zai-coding-plan/glm-5.3-flash"}
# Scenarios that need no PM and no run of their own: they run before the PM starts (guard_hash) or on a project of their own (nogit).
STANDALONE = ("guard_hash", "nogit")


def log(message: str) -> None:
    print(f"{time.strftime('%T')} drill: {message}", file=sys.stderr, flush=True)


def run(args: list[str], stdin: str | None = None, timeout: int = 180) -> tuple[int, str, str]:
    try:
        done = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout)
        return done.returncode, done.stdout, done.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s: {' '.join(args[:3])}"


def bb(*args: str, timeout: int = 180) -> tuple[int, str, str]:
    return run([BB, *args], timeout=timeout)


def hubsql(sql: str) -> list[dict]:
    rc, out, err = run(["ssh", "-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HUB, f"sqlite3 -readonly -json '{HUB_DB}'"], stdin=sql, timeout=60)
    if rc != 0:
        raise RuntimeError(f"hub query failed: {err.strip()[:200]}")
    return json.loads(out) if out.strip() else []


def git(cwd: str, *args: str) -> str:
    rc, out, err = run(["git", "-C", cwd, *args], timeout=60)
    if rc != 0:
        raise RuntimeError(f"git {' '.join(args)}: {err.strip()[:200]}")
    return out.strip()


def thread_field(raw: str, name: str) -> str:
    try:
        data = json.loads(raw)
    except ValueError:
        return ""
    data = data.get("thread", data) if isinstance(data, dict) else {}
    return str(data.get(name) or "")


def thread_status(thread: str) -> str:
    rc, out, _ = bb("thread", "get", thread, "--json", timeout=60)
    return thread_field(out, "status") or "?" if rc == 0 else "?"


def task(task_id: str, title: str, outputs: list[str], objective: str, acceptance: list[str], cwd: str, risk: str = "high", read_first: list[str] | None = None) -> dict:
    return {
        "schema_version": 2, "id": task_id, "title": title, "risk": risk, "lane": "writer", "project_cwd": cwd,
        "read_first": read_first or [], "interfaces": [], "invariants": ["Touch no file except the ones in expected_outputs."],
        "out_of_scope": ["Every other file of the project."], "expected_outputs": outputs, "owns_paths": outputs,
        "never_touch": ["src/**", "tests/**", "package.json"], "depends_on": [], "objective": objective, "acceptance": acceptance,
        "verify": "none", "verification": [],
    }


def note_task(task_id: str, path: str, text: str, cwd: str, before: str = "") -> dict:
    """A task that writes one two-line note; `before` is an instruction to do first (a sleep that holds the writer in its attempt)."""
    lead = f"{before} Then create" if before else "Create"
    return task(task_id, f"{text}: one note", [path], f"{lead} the file {path} with exactly two lines. Line 1: `# {text}`. Line 2: `ok: {text}`. Nothing else.",
                [f"{path} exists, its first line is `# {text}` and its second line is `ok: {text}`."], cwd)


class Context:
    """One PM and one run in a sandbox project."""

    def __init__(self, spec: dict, tmp: Path):
        self.project, self.environment, self.cwd = spec["project"], spec["environment"], spec["cwd"]
        self.tmp = tmp
        self.source = self.pm = self.run_id = ""
        self.dispatches: dict[str, str] = {}

    def start(self) -> None:
        rc, out, err = bb("thread", "spawn", "--project", self.project, "--environment", self.environment, "--provider", "codex", "--model", "gpt-6-luna",
                          "--prompt", "Reply with OK only.", "--json")
        self.source = thread_field(out, "id") if rc == 0 else ""
        if not self.source:
            raise RuntimeError(f"source thread did not start: {err.strip()[:300] or out[:300]}")
        log(f"source thread {self.source}")
        for _ in range(36):
            if thread_status(self.source) == "idle":
                break
            time.sleep(5)
        else:
            raise RuntimeError("source thread did not settle")
        rc, out, err = bb("lane-pilot", "activate", self.project, self.source)
        self.pm, self.run_id = thread_field(out, "threadId"), thread_field(out, "runId")
        if rc != 0 or not self.pm or not self.run_id:
            raise RuntimeError(f"activate failed: {(err.strip() or out)[:300]}")
        log(f"PM {self.pm}, run {self.run_id} ({self.project})")

    def dispatch(self, spec: dict) -> bool:
        rc, out, err = bb("lane-pilot", "dispatch-bb", self.project, self.pm, json.dumps(spec))
        self.dispatches[spec["id"]] = (out + err).strip()[:600]
        if rc != 0:
            log(f"dispatch of {spec['id']} failed: {self.dispatches[spec['id']][:200]}")
        return rc == 0

    def rows(self, ids: list[str]) -> list[dict]:
        quoted = ",".join("'" + i.replace("'", "''") + "'" for i in ids)
        return hubsql(f"select id, task_id, state, reason, thread_id, workspace_path, environment_id, holder_thread_id, created_at from lane_pilot_attempt where run_id='{self.run_id}' and task_id in ({quoted});")

    def wait_ended(self, ids: list[str], timeout_min: int = TIMEOUT_MIN) -> list[dict]:
        """Rows once every task's latest attempt is accepted, blocked or canceled, twice in a row; the last rows seen on timeout."""
        deadline, settled, rows = time.time() + timeout_min * 60, 0, []
        while time.time() < deadline:
            try:
                rows = self.rows(ids)
            except RuntimeError as cause:
                log(str(cause))
                time.sleep(POLL_SEC)
                continue
            latest = latest_states(rows)
            ended = sum(1 for i in ids if latest.get(i) in TERMINAL)
            log(f"ended {ended} of {len(ids)}")
            settled = settled + 1 if ended == len(ids) else 0
            if settled >= 2:
                return rows
            time.sleep(POLL_SEC)
        return rows

    def wait_state(self, task_id: str, state: str, timeout_min: int = 10) -> bool:
        deadline = time.time() + timeout_min * 60
        while time.time() < deadline:
            try:
                if any(r["state"] == state for r in self.rows([task_id])):
                    return True
            except RuntimeError as cause:
                log(str(cause))
            time.sleep(5)
        return False

    def open_attempts(self) -> list[str]:
        return [r["id"] for r in hubsql(f"select id from lane_pilot_attempt where run_id='{self.run_id}' and state in ({','.join(repr(s) for s in OPEN_STATES)});")]

    def quiet(self) -> None:
        """Nothing of this scenario may run on into the next one."""
        for attempt in self.open_attempts():
            log(f"cancelling {attempt}")
            bb("lane-pilot", "cancel", attempt)

    def finish(self) -> list[str]:
        problems: list[str] = []
        out = err = ""
        for tries in range(30 if self.run_id else 0):
            rc, out, err = bb("lane-pilot", "finish", self.project)
            if rc == 0:
                log("run finished")
                break
            if tries >= 12:
                self.quiet()
            time.sleep(20)
        else:
            if self.run_id:
                problems.append(f"run could not be finished: {(out + err).strip()[:200]}")
        try:
            if not self.run_id:
                raise RuntimeError("no run")
            rows = hubsql(f"select thread_id as t from lane_pilot_attempt where run_id='{self.run_id}' and thread_id is not null union select holder_thread_id from lane_pilot_attempt where run_id='{self.run_id}' and holder_thread_id is not null;")
            writers = [next(iter(r.values())) for r in rows]
        except RuntimeError:
            writers = []
        for thread in [self.pm, *writers, self.source]:
            if thread and bb("thread", "archive", thread)[0] == 0:
                log(f"archived {thread}")
        return problems


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


# --- scenarios ----------------------------------------------------------------------------------------------------------

def tasks_parallel3(cwd: str) -> list[dict]:
    return [task(f"drill-{STAMP}-{letter}", f"Drill {STAMP} {letter}: one note", [f"notes/drill/{STAMP}-{letter}.md"],
                 f"Create the file notes/drill/{STAMP}-{letter}.md with exactly two lines. Line 1: `# Drill {STAMP} {letter}`. Line 2: `ok: {letter}`. Nothing else.",
                 [f"notes/drill/{STAMP}-{letter}.md exists, its first line is `# Drill {STAMP} {letter}` and its second line is `ok: {letter}`."], cwd)
            for letter in "abc"]


def conflict_path() -> str:
    return f"notes/drill/{STAMP}-conflict.md"


def tasks_conflict(cwd: str) -> list[dict]:
    rel = conflict_path()
    return [task(f"drill-{STAMP}-conflict-{side}", f"Drill {STAMP}: line 2 becomes {side}", [rel],
                 f"In {rel} replace line 2 (`line: base` or whatever it says now) with `line: {side}`. Keep lines 1 and 3 as they are. Nothing else.",
                 [f"Line 2 of {rel} is `line: {side}`, line 1 is `# Drill {STAMP} conflict` and line 3 is `end`."], cwd, read_first=[rel]) for side in ("X", "Y")]


def task_moved(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-moved", f"notes/drill/{STAMP}-moved.md", f"Drill {STAMP} moved", cwd, before="First run `sleep 45` with Bash and wait for it.")


def task_limit(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-limit", f"notes/drill/{STAMP}-limit.md", f"Drill {STAMP} limit", cwd)


def task_reload(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-reload", f"notes/drill/{STAMP}-reload.md", f"Drill {STAMP} reload", cwd, before="First run `sleep 60` with Bash and wait for it.")


def task_nogit(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-nogit", f"drill-{STAMP}-nogit.md", f"Drill {STAMP} nogit", cwd) | {"risk": "low"}


def scenario_parallel3(ctx: Context) -> dict:
    specs = tasks_parallel3(ctx.cwd)
    with ThreadPoolExecutor(3) as pool:
        sent = list(pool.map(ctx.dispatch, specs))
    problems = ["a dispatch-bb call exited with an error (see receipt dispatch output)"] if not all(sent) else []
    ids = [s["id"] for s in specs]
    rows = ctx.wait_ended(ids)
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
    problems += provider_problems(tasks)
    return verdict("parallel3", problems, tasks=tasks, checks={"allAccepted": accepted, "eachInOwnWorktree": own, "filesInSandbox": merged},
                   dispatch={s["id"]: ctx.dispatches.get(s["id"]) for s in specs})


def providers_in_use(project: str) -> dict[str, str]:
    """provider id -> a model it runs in this project: the pairs of the project's settings (`<stage>.provider` with `<stage>.model`,
    the PM model, the writer), then a fallback model for the three providers every install has. acp-cursor only when a setting names it."""
    override = os.environ.get("LP_DRILL_PROVIDERS", "").strip()
    if override:
        return dict(pair.split("=", 1) for pair in override.split(",") if "=" in pair)
    rows = hubsql(f"select key, value from lane_pilot_project_settings where project_id='{project}' and binding_id='' and (key like '%.provider' or key like '%.model' or key in ('pmModel', 'writerProviderId', 'writerModel', 'pmProviderId'));")
    values = {}
    for row in rows:
        try:
            values[row["key"]] = json.loads(row["value"])
        except ValueError:
            continue
    found: dict[str, str] = {}

    def add(provider: object, model: object) -> None:
        if isinstance(provider, str) and provider and isinstance(model, str) and model:
            found.setdefault(provider, model)

    for key, value in values.items():
        if key.endswith(".provider"):
            add(value, values.get(key[: -len(".provider")] + ".model"))
    add(values.get("pmProviderId", "claude-code"), values.get("pmModel"))
    add(values.get("writerProviderId"), values.get("writerModel"))
    for provider, model in PROVIDER_FALLBACK_MODEL.items():
        found.setdefault(provider, model)
    return found


def scenario_helper_providers(ctx: Context) -> dict:
    """A helper on each provider in use starts and answers (audit 2026-10-08 round 3, P0-7)."""
    pairs = providers_in_use(ctx.project)

    def probe(item: tuple[str, str]) -> dict:
        provider, model = item
        rc, out, err = bb("lane-pilot", "helper-probe", ctx.project, ctx.run_id, provider, model, timeout=240)
        try:
            answer = json.loads(out)
        except ValueError:
            answer = {}
        if not isinstance(answer, dict) or "ok" not in answer:
            answer = {"ok": False, "started": False, "answered": False, "reason": (err or out).strip()[:300] or f"exit {rc}"}
        return {"provider": provider, "model": model, **{k: answer.get(k) for k in ("ok", "started", "answered", "threadId", "output", "reason", "ms")}}

    with ThreadPoolExecutor(max(1, len(pairs))) as pool:
        results = list(pool.map(probe, pairs.items()))
    problems = []
    for item in results:
        log(f"helper on {item['provider']} ({item['model']}): started={item['started']} answered={item['answered']} {item['reason'] or ''}")
        if not item["ok"]:
            what = "did not start" if not item["started"] else "started but did not answer"
            problems.append(f"{item['provider']} ({item['model']}): a helper {what}: {item['reason'] or 'no reason given'}")
    return verdict("helper_providers", problems, providers=results)


def task_provider(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-provider", f"notes/drill/{STAMP}-provider.md", f"Drill {STAMP} provider", cwd)


def scenario_provider(ctx: Context) -> dict:
    spec = task_provider(ctx.cwd)
    problems = [] if ctx.dispatch(spec) else ["dispatch-bb exited with an error"]
    rows = ctx.wait_ended([spec["id"]])
    row = summarize(rows, spec["id"], ctx.cwd, spec["expected_outputs"][0])
    if row["state"] != "accepted":
        problems.append(f"the task did not end accepted: {row['states']} {row['reason']}")
    elif not row["fileInSandbox"]:
        problems.append("the accepted task's file is not on main")
    if row["workspace"] == ctx.cwd:
        problems.append("the attempt ran in the sandbox folder, not in a worktree")
    problems += provider_problems([row])
    return verdict("provider", problems, tasks=[row])


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


def setting_rpc(method: str, payload: dict) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(payload, handle)
    try:
        rc, out, err = bb("plugin", "rpc", "call", "lane-pilot", method, "--input-file", handle.name, "--json", timeout=60)
    finally:
        os.unlink(handle.name)
    if rc != 0:
        raise RuntimeError(f"{method} failed: {(err or out).strip()[:200]}")
    data = json.loads(out)
    return data.get("result", data) if isinstance(data, dict) else {}


def scenario_provider_limit(ctx: Context) -> dict:
    key = "writer.model"
    saved = hubsql(f"select value, version from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='{key}';")
    original, version = (json.loads(saved[0]["value"]), int(saved[0]["version"])) if saved else (None, 0)
    problems: list[str] = []
    row: dict = {}
    try:
        changed = setting_rpc("save_setting", {"projectId": ctx.project, "key": key, "value": BAD_MODEL, "expectedVersion": version})
        if not changed.get("ok"):
            return verdict("provider_limit", [f"could not set {key}: {json.dumps(changed)[:200]}"])
        version = int(changed["version"])
        spec = task_limit(ctx.cwd)
        if not ctx.dispatch(spec):
            problems.append("dispatch-bb exited with an error")
        rows = ctx.wait_ended([spec["id"]])
        row = summarize(rows, spec["id"], ctx.cwd, spec["expected_outputs"][0])
        if row["state"] != "accepted":
            problems.append(f"the task did not end accepted through the next writer: {row['states']} {row['reason']}")
        elif row["attempts"] < 2:
            problems.append("the bad model was never tried (one attempt only): the drill did not exercise the chain")
        if row["state"] == "accepted" and not row["fileInSandbox"]:
            problems.append("the accepted task's file is not on main")
    finally:
        if original is None:
            back = setting_rpc("reset_project_settings", {"projectId": ctx.project, "keys": [key], "expectedVersions": {key: version}})
        else:
            back = setting_rpc("save_setting", {"projectId": ctx.project, "key": key, "value": original, "expectedVersion": version})
        now = hubsql(f"select value from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='{key}';")
        restored = (json.loads(now[0]["value"]) if now else None) == original
        if not (back.get("ok") and restored):
            problems.append(f"{key} was NOT restored to {original!r}: {json.dumps(back)[:200]}")
    return verdict("provider_limit", problems, tasks=[row] if row else [], badModel=BAD_MODEL, restored=original)


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


GUARD_FILES = ("guard_shell.py", "lib_payload.py")
GUARD_REPO = ROOT / "lane-stack" / "hooks"


def guard_machines() -> list[dict]:
    """The machines whose installed guard is compared with the repository's. kind: local (this machine), bb (bb file read/write --host), ssh."""
    raw = os.environ.get("LP_DRILL_GUARD_HOSTS")
    if raw:
        return json.loads(raw)
    return [
        {"name": "mac-mini", "kind": "local", "home": str(Path.home())},
        {"name": "macbook", "kind": "bb", "host": os.environ.get("LP_DRILL_MACBOOK_HOST", "host_p7jhrgsapq"), "home": os.environ.get("LP_DRILL_MACBOOK_HOME", "/Users/vechkasov")},
        {"name": "ovh", "kind": "ssh", "host": os.environ.get("LP_DRILL_OVH_SSH", "ovh-main")},
    ]


def sha256_of(data: bytes) -> str:
    import hashlib
    return hashlib.sha256(data).hexdigest()


GONE = ("enoent", "no such file", "not found", "does not exist")


def guard_read(machine: dict, name: str) -> tuple[bytes | None, str | None]:
    """(content, None) when read, (None, 'missing') when the machine answers that the file is not there, (None, why) when it cannot be asked."""
    kind = machine["kind"]
    if kind == "local":
        try:
            return (Path(machine["home"]) / ".agents/hooks" / name).read_bytes(), None
        except FileNotFoundError:
            return None, "missing"
        except OSError as cause:
            return None, str(cause)
    if kind == "bb":
        rc, out, err = bb("file", "read", "--host", machine["host"], f"{machine['home']}/.agents/hooks/{name}", "--json", timeout=60)
        if rc == 0:
            try:
                return str(json.loads(out)["content"]).encode(), None
            except (ValueError, KeyError, TypeError):
                return None, f"unreadable answer: {out[:120]}"
        text = (err + out).lower()
        return None, "missing" if any(word in text for word in GONE) else (err or out).strip()[:200] or f"exit {rc}"
    rc, out, err = run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", machine["host"], f"cat ~/.agents/hooks/{name}"], timeout=60)
    if rc == 0:
        return out.encode(), None
    if rc != 255 and any(word in err.lower() for word in GONE):
        return None, "missing"
    return None, err.strip()[:200] or f"exit {rc}"


def guard_install_command(machine: dict, name: str) -> str:
    src = GUARD_REPO / name
    if machine["kind"] == "local":
        dest = f"{machine['home']}/.agents/hooks/{name}"
        return f"cp -p {dest} {dest}.bak-{DATE}; install -m 755 {src} {dest}"
    if machine["kind"] == "bb":
        return f"bb file write --host {machine['host']} --stdin --create-parents {machine['home']}/.agents/hooks/{name} < {src}"
    return f"scp {src} {machine['host']}:.agents/hooks/{name} && ssh {machine['host']} chmod 755 .agents/hooks/{name}"


def guard_install(machine: dict, name: str) -> str | None:
    """Puts the repository's file on the machine (the old one is kept as .bak-<date>); None when done, the reason when not."""
    data = (GUARD_REPO / name).read_bytes()
    if machine["kind"] == "local":
        dest = Path(machine["home"]) / ".agents/hooks" / name
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                shutil.copy2(dest, dest.with_name(f"{name}.bak-{DATE}"))
            tmp = dest.with_name(f".{name}.{os.getpid()}.tmp")
            tmp.write_bytes(data)
            tmp.chmod(0o755)
            tmp.replace(dest)
        except OSError as cause:
            return str(cause)
        return None
    if machine["kind"] == "bb":
        path = f"{machine['home']}/.agents/hooks/{name}"
        done = subprocess.run([BB, "file", "write", "--host", machine["host"], "--stdin", "--create-parents", path, "--json"], input=data.decode(), capture_output=True, text=True, timeout=90)
        return None if done.returncode == 0 else (done.stderr or done.stdout).strip()[:200]
    host = machine["host"]
    done = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, f"cd ~/.agents/hooks && [ ! -e {name} ] || cp -p {name} {name}.bak-{DATE}; cat > .{name}.tmp && chmod 755 .{name}.tmp && mv .{name}.tmp {name}"],
                          input=data.decode(), capture_output=True, text=True, timeout=90)
    return None if done.returncode == 0 else done.stderr.strip()[:200]


def scenario_guard_hash(tmp: Path, repair: bool = False) -> dict:
    """The guard that actually runs is the installed copy on each machine (audit 2026-10-08 round 3, P0-3): it must be the repository's."""
    problems: list[str] = []
    expected = {}
    for name in GUARD_FILES:
        try:
            expected[name] = sha256_of((GUARD_REPO / name).read_bytes())
        except OSError as cause:
            return verdict("guard_hash", [f"the repository has no {GUARD_REPO / name}: {cause}"])
    machines: list[dict] = []
    for machine in guard_machines():
        entry: dict = {"machine": machine["name"], "files": {}}
        machines.append(entry)
        for name in GUARD_FILES:
            data, why = guard_read(machine, name)
            state, installed = "ok", sha256_of(data) if data is not None else None
            if data is None and why != "missing":
                state = "unreachable"
                log(f"guard_hash: {machine['name']}: {name}: {why}")
            elif installed != expected[name]:
                state = "missing" if data is None else "drift"
                if repair:
                    failure = guard_install(machine, name)
                    again, _ = guard_read(machine, name)
                    if failure is None and again is not None and sha256_of(again) == expected[name]:
                        state, installed = "repaired", expected[name]
                    else:
                        state = f"{state}, repair failed: {failure or 'the file read back differs'}"
                if state != "repaired":
                    problems.append(f"{machine['name']}: {name} {'is missing' if state.startswith('missing') else 'differs from the repository'} (installed {str(installed)[:12] if installed else 'none'}, repository {expected[name][:12]}); install: {guard_install_command(machine, name)}")
            entry["files"][name] = {"state": state, "installed": installed, "expected": expected[name]}
        entry["reachable"] = any(f["state"] != "unreachable" for f in entry["files"].values())
    unreachable = [m["machine"] for m in machines if not m["reachable"]]
    return verdict("guard_hash", problems, machines=machines, expected=expected, unreachable=unreachable, repaired=repair)


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
        return {"name": "nogit", "result": "skipped", "problems": [], "note": f"no folder {cwd}"}
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


# --- main ---------------------------------------------------------------------------------------------------------------

def dry_run(names: list[str]) -> None:
    print(f"drill {STAMP} in {SANDBOX['project']} ({SANDBOX['cwd']}), no-git {NOGIT['project']} ({NOGIT['cwd']}), hub db {HUB}:{HUB_DB}; scenarios: {', '.join(names)}")
    if "parallel3" in names:
        for spec in tasks_parallel3(SANDBOX["cwd"]):
            print(json.dumps(spec))
    cwd = SANDBOX["cwd"]
    documents = {"conflict": tasks_conflict(cwd), "main_moved": [task_moved(cwd)], "provider": [task_provider(cwd)], "provider_limit": [task_limit(cwd)], "reload": [task_reload(cwd)], "nogit": [task_nogit(NOGIT["cwd"])]}
    for name in names:
        for spec in documents.get(name, []):
            print(f"scenario {name}: {json.dumps(spec)}")


def write_receipt(path: Path, start: float, scenarios: list[dict], ctx: Context | None, problems: list[str], names: list[str]) -> str:
    first = next((s for s in scenarios if s["name"] == "parallel3"), None)
    failed = [s["name"] for s in scenarios if s["result"] == "fail"]
    result = "pass" if not problems and not failed and scenarios else "fail"
    data = {
        "kind": "lane-pilot-sandbox-drill", "date": DATE, "stamp": STAMP, "startedAt": int(start * 1000), "finishedAt": int(time.time() * 1000),
        "durationSec": round(time.time() - start), "project": SANDBOX["project"], "runId": (ctx.run_id or None) if ctx else None, "pmThread": (ctx.pm or None) if ctx else None,
        "sourceThread": (ctx.source or None) if ctx else None, "mode": "quick" if names == QUICK else "full", "scenarioNames": names,
        "result": result, "problems": problems + [f"{s['name']}: {p}" for s in scenarios for p in s["problems"]],
        "checks": first.get("checks") if first else None, "tasks": first.get("tasks") if first else None, "dispatch": first.get("dispatch") if first else None,
        "scenarios": scenarios,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True, description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--scenario", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--repair-guard", action="store_true")
    args = parser.parse_args()
    names = QUICK if args.quick else [n for n in args.scenario.split(",") if n] or ALL
    repair_guard = args.repair_guard or os.environ.get("LP_DRILL_REPAIR_GUARD") == "1"
    unknown = [n for n in names if n not in ALL]
    if unknown:
        print(f"unknown scenario: {', '.join(unknown)} (known: {', '.join(ALL)})", file=sys.stderr)
        return 2
    if args.dry_run:
        dry_run(names)
        return 0

    lock = Path(tempfile.gettempdir()) / "lp-drill.lock"
    try:
        lock.mkdir()
    except FileExistsError:
        print(f"another drill is running ({lock}); remove it if it is stale", file=sys.stderr)
        return 2
    start = time.time()
    tmp = Path(tempfile.mkdtemp(prefix="lp-drill-"))
    receipt_dir = Path(os.environ.get("LP_DRILL_RECEIPT_DIR") or ROOT / ".agents/runs/drills")
    receipt = receipt_dir / f"{DATE}.json"
    if receipt.exists():
        receipt = receipt_dir / f"{DATE}-{STAMP.split('-')[1]}.json"
    scenarios: list[dict] = []
    problems: list[str] = []
    ctx: Context | None = None
    try:
        if "guard_hash" in names:
            log("scenario guard_hash")
            try:
                scenarios.append(scenario_guard_hash(tmp, repair_guard))
            except Exception as cause:
                scenarios.append(verdict("guard_hash", [f"scenario raised: {cause}"]))
            log(f"scenario guard_hash: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
        main_names = [n for n in names if n not in STANDALONE]
        if main_names:
            ctx = Context(SANDBOX, tmp)
            try:
                ctx.start()
            except RuntimeError as cause:
                problems.append(str(cause))
                log(str(cause))
        for name in main_names:
            if ctx is None or not ctx.run_id:
                break
            log(f"scenario {name}")
            try:
                scenarios.append(globals()[f"scenario_{name}"](ctx))
            except Exception as cause:  # a scenario that breaks is a failed scenario, the rest still run
                scenarios.append(verdict(name, [f"scenario raised: {cause}"]))
            log(f"scenario {name}: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
            ctx.quiet()
        if "nogit" in names and not problems:
            log("scenario nogit")
            try:
                scenarios.append(scenario_nogit(tmp))
            except Exception as cause:
                scenarios.append(verdict("nogit", [f"scenario raised: {cause}"]))
            log(f"scenario nogit: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
        if ctx and ctx.run_id:
            problems += ctx.finish()
    finally:
        result = write_receipt(receipt, start, scenarios, ctx, problems, names)
        shutil.rmtree(tmp, ignore_errors=True)
        lock.rmdir()
    log(f"receipt: {receipt}")
    print(f"RECEIPT={receipt}")
    log("PASS" if result == "pass" else f"FAIL: see {receipt}")
    if result == "pass":
        return 0
    return 2 if not scenarios else 1


if __name__ == "__main__":
    sys.exit(main())
