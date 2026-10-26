#!/usr/bin/env python3
"""Sandbox drill (E3): the live regression check run before every Lane Pilot deploy. Entry point: scripts/lp-drill.sh.

Scenarios (each writes its verdict into the receipt, .agents/runs/drills/<date>.json):
  guard_hash     the installed shell guard (~/.agents/hooks/guard_shell.py and lib_payload.py) on the Mac mini, the MacBook and OVH
                 is byte for byte the repository's copy (lane-stack/hooks). A drifted or missing copy fails the drill and the
                 receipt lists the install command per machine; --repair-guard (or LP_DRILL_REPAIR_GUARD=1) installs the
                 repository copy and checks it again. A machine that cannot be reached is noted, not failed          [--quick]
  deferrals      the register of deferrals (`bb lane-pilot deferrals`): an entry whose term the owner gave has passed, or a skipped test
                 cites an entry the register lacks or holds closed, fails the drill and the receipt says how to close it. Entries
                 without a term (needs_owner_term) are counted, not failed                                           [--quick]
  checkers       checking the checkers (SMA «which of your key checks have you seen go red on purpose?», `bb lane-pilot checkers drill`): known
                 defects (an off-by-one, a file outside owns_paths, `|| true` on a check, a claimed acceptance item missing from the diff, a broken
                 import) are planted in two small accepted candidates, and each code checker (verification, ownership, contract lint, plan-fact)
                 must catch the class it is there for. A checker that lets one through, a code checker that flags a clean candidate, or a class
                 that cannot be planted fails the drill. The scenario also blinds the ownership checker on purpose and requires the drill to go
                 red: a drill that cannot fail proves nothing. It runs the checkout's code (bundled with esbuild), no hub, no model  [--quick]
  memory_paths   the memory delivery paths (SMA block 4, `bb lane-pilot memory-probe`): a token planted through the memory write door must
                 reach what each registered path hands its agent (writer brief, writer turn, PM, critics, council, terminal) -- the
                 probe's own table -- and the real thing: the first prompt of the drill's PM (planted before it started), the brief of a
                 real writer spawned for a probe task (cancelled once its thread exists) and a Lane Stack terminal (`lane-memory`,
                 when this host has it). Any path that does not deliver, or an unrelated query that pulls our records, fails the
                 drill (and so blocks the deploy). Records live a day at most and are removed at the end              [--quick]
  helper_providers one helper per provider in use (claude-code, codex, opencode2, and acp-cursor when a setting names it), each
                 started the way the pm-read stage starts its helper (`bb lane-pilot helper-probe`) with a prompt that asks for
                 one word: each must start and answer. A provider that refuses its helpers fails the drill (0.1.194 refused
                 every OpenCode helper for six minutes and the writer-only drill stayed green)                       [--quick]
  parallel3      3 parallel, non-overlapping tasks (risk high): each accepted, each in a worktree of its own        [--quick]
  phase_route    the phase route on the machine's own stages: a small phase is opened and nobody reports its stages; lp.analyze and lp.plan
                 (their helpers write the phase's folder and the plans folder) must carry it to execution with no `auto_failed` in its book
                 for repo_edited or a refused binary read, a pause at the first boundary holds (no stage starts), and so does stop_wave at
                 execution. Full set only: it waits for two model stages and two holds, 20-30 minutes
  conflict       two tasks own the same file and rewrite the same line: both end, both accepted, no conflict markers left
  main_moved     main gets a commit while a writer works: the merge is rebased and keeps both
  provider_limit a bad writer.model in the sandbox: the task still ends accepted through the next writer; the setting is restored
  reload         `bb plugin reload lane-pilot` while a writer works: the task still ends accepted (skipped when a non-sandbox
                 project has open attempts)
  provider       one task: its attempt runs on a BB environment of Lane Pilot's own worktree provider (environment_id set, no
                 holder thread, own worktree). A silent fallback to the old path fails it: a broken provider must not ship
  nogit          a project whose folder is not a git repo (live-folder mode): accepted, file in the folder, no .git created
  nogit_repo     a task over one git repository inside that folder (repo-a): it moves into the repository, works in its own
                 worktree and is merged into its main as a commit; the folder still has no .git

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
import shlex
import os
import re
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
ALL = ["guard_hash", "deferrals", "checkers", "watchdog", "memory_paths", "helper_providers", "parallel3", "conflict", "main_moved", "provider", "provider_limit", "live_word", "no_code_exit", "skills", "phase", "phase_route", "reload", "nogit", "nogit_repo"]
QUICK = ["guard_hash", "deferrals", "checkers", "memory_paths", "helper_providers", "parallel3"]
# What a provider runs when no setting of the sandbox project names a model for it.
PROVIDER_FALLBACK_MODEL = {"claude-code": "claude-sonnet-5-5", "codex": "gpt-6-luna", "opencode2": "zai-coding-plan/glm-5.3-flash"}
# Scenarios that need no PM and no run of their own: they run before the PM starts (guard_hash) or on a project of their own (nogit).
STANDALONE = ("guard_hash", "deferrals", "checkers", "watchdog", "nogit", "nogit_repo")


def log(message: str) -> None:
    print(f"{time.strftime('%T')} drill: {message}", file=sys.stderr, flush=True)


def run(args: list[str], stdin: str | None = None, timeout: int = 180, env: dict[str, str] | None = None) -> tuple[int, str, str]:
    try:
        done = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout, env=env)
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


def task(task_id: str, title: str, outputs: list[str], objective: str, acceptance: list[str], cwd: str, risk: str = "high", read_first: list[str] | None = None, verification: list[dict] | None = None) -> dict:
    return {
        # The task standard (the Tasks board). One area per task: tasks of one area run one at a time, and the drills run side by side.
        "schema_version": 2, "id": task_id, "title": title, "display_title": f"Учение: {title}"[:60], "kind": "chore", "area": f"drill:{task_id}", "risk": risk, "lane": "writer", "project_cwd": cwd,
        "read_first": read_first or [], "interfaces": [], "invariants": ["Touch no file except the ones in expected_outputs."],
        "out_of_scope": ["Every other file of the project."], "expected_outputs": outputs, "owns_paths": outputs,
        "never_touch": ["src/**", "tests/**", "package.json"], "depends_on": [], "objective": objective, "acceptance": acceptance,
        "verify": "none" if not verification else "smoke", "verification": verification or [],
    }


def note_task(task_id: str, path: str, text: str, cwd: str, before: str = "") -> dict:
    """A task that writes one two-line note; `before` is an instruction to do first (a sleep that holds the writer in its attempt)."""
    lead = f"{before} Then create" if before else "Create"
    return task(task_id, f"{text}: one note", [path], f"{lead} the file {path} with exactly two lines. Line 1: `# {text}`. Line 2: `ok: {text}`. Nothing else.",
                [f"{path} exists, its first line is `# {text}` and its second line is `ok: {text}`."], cwd,
                # A real check (SMA coverage: the drill's verification stage must not be vacuous): red on the base, green after the writer.
                verification=[{"command": f"test \"$(sed -n 1p {shlex.quote(path)})\" = {shlex.quote('# ' + text)} && test \"$(sed -n 2p {shlex.quote(path)})\" = {shlex.quote('ok: ' + text)}", "cwd": cwd}])


class Context:
    """One PM and one run in a sandbox project."""

    def __init__(self, spec: dict, tmp: Path):
        self.project, self.environment, self.cwd = spec["project"], spec["environment"], spec["cwd"]
        self.tmp = tmp
        self.source = self.pm = self.run_id = ""
        self.dispatches: dict[str, str] = {}
        # The report of `memory-probe --keep`, planted before the PM started (scenario memory_paths); None when that scenario is not run.
        self.memory_probe: dict | None = None

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


NOGIT_REPO = "repo-a"


def task_nogit_repo(cwd: str) -> dict:
    # Written from the folder without git, as the BB-сервис PM writes a plugin task.
    return note_task(f"drill-{STAMP}-nogit-repo", f"{NOGIT_REPO}/notes/drill-{STAMP}.md", f"Drill {STAMP} nogit repo", cwd) | {"risk": "low"}


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


MEMORY_ANCHOR = "lp-probe/memory"
LANE_MEMORY = os.environ.get("LP_DRILL_LANE_MEMORY", str(Path.home() / ".agents/bin/lane-memory"))


def task_memory(cwd: str) -> dict:
    """The task whose writer brief must carry the probe's note (it names the folder), core convention and rule. Cancelled once its thread exists."""
    rel = f"{MEMORY_ANCHOR}/{STAMP}.md"
    return note_task(f"drill-{STAMP}-memory", rel, f"Drill {STAMP} memory", cwd) | {"risk": "low"}


def plant_memory_probe() -> dict:
    """`memory-probe --keep` before the PM starts, so the PM's first prompt can carry the probe rule. Exit 1 (a path red) still gives a report."""
    rc, out, err = bb("lane-pilot", "memory-probe", SANDBOX["project"], "--keep", timeout=180)
    try:
        report = json.loads(out)
    except ValueError:
        report = {}
    return {"rc": rc, "report": report if isinstance(report, dict) else {}, "error": (err or out).strip()[:300]}


def clean_memory_probe() -> None:
    bb("lane-pilot", "memory-probe", SANDBOX["project"], "--clean", timeout=120)


def thread_text(thread: str) -> str:
    """The thread's event log as raw JSON text: the first prompt an agent got is in it. Alphanumeric tokens survive JSON escaping."""
    if not thread:
        return ""
    rc, out, _ = bb("thread", "log", thread, "--json", "--limit", "100", timeout=90)
    return out if rc == 0 else ""


def memory_problems(report: dict, pm_text: str, writer_text: str | None, terminal: dict | None) -> list[str]:
    """What is wrong with the memory delivery: the probe's rows, then the real PM prompt, the real writer brief and the terminal."""
    problems: list[str] = []
    results = report.get("results") or []
    tokens = report.get("tokens") or {}
    if not results or not tokens:
        return ["the memory probe gave no report (is the plugin on the version that has memory-probe?)"]
    problems += [f"probe: {p}" for p in report.get("problems") or []]
    for row in results:
        if not row.get("found"):
            problems.append(f"path {row.get('path')} does not deliver: {row.get('detail')}")
        elif row.get("negativeOk") is False:
            problems.append(f"path {row.get('path')} pulled our records for an unrelated query: {row.get('detail')}")
    if tokens.get("rule") not in pm_text:
        problems.append("the drill's PM first prompt does not carry the probe rule (pm.start live)")
    if writer_text is None:
        problems.append("the probe task's writer thread did not start in time, so its brief could not be read")
    else:
        for kind in ("note", "core", "rule"):
            if tokens.get(kind) not in writer_text:
                problems.append(f"the real writer's first prompt does not carry the probe {kind} (writer.brief live)")
    if terminal is not None:
        if tokens.get("note") not in terminal.get("search", ""):
            problems.append("`lane-memory search` in the sandbox folder did not find the probe note (terminal.search live)")
        if tokens.get("core") not in terminal.get("core", ""):
            problems.append("`lane-memory core` in the sandbox folder did not list the probe core convention (terminal.core live)")
    return problems


def terminal_memory(cwd: str, report: dict) -> dict | None:
    """What a Lane Stack terminal session in the sandbox folder gets from the hub; None when this host has no lane-memory."""
    if not Path(LANE_MEMORY).is_file():
        log(f"memory_paths: no {LANE_MEMORY} on this host, the terminal is not read live")
        return None
    query = "memory delivery check lp-probe"
    _, search, _ = run([LANE_MEMORY, "search", query, cwd], timeout=120)
    _, core, _ = run([LANE_MEMORY, "core", cwd], timeout=120)
    return {"search": search, "core": core}


def scenario_memory_paths(ctx: Context) -> dict:
    planted = ctx.memory_probe
    if not planted:
        return verdict("memory_paths", ["the probe was not planted before the PM started"])
    report = planted["report"]
    if not report:
        clean_memory_probe()
        return verdict("memory_paths", [f"memory-probe failed (exit {planted['rc']}): {planted['error'] or 'no output'}"])
    spec = task_memory(ctx.cwd)
    writer_text: str | None = None
    attempt = ""
    try:
        if not ctx.dispatch(spec):
            raise RuntimeError("dispatch-bb exited with an error")
        deadline = time.time() + 5 * 60
        while time.time() < deadline and writer_text is None:
            try:
                rows = [r for r in ctx.rows([spec["id"]]) if r.get("thread_id")]
            except RuntimeError as cause:
                log(str(cause))
                rows = []
            if rows:
                attempt = rows[-1]["id"]
                writer_text = thread_text(rows[-1]["thread_id"])
                break
            time.sleep(5)
        ctx.quiet()
        problems = memory_problems(report, thread_text(ctx.pm), writer_text, terminal_memory(ctx.cwd, report))
    except RuntimeError as cause:
        problems = [str(cause)]
    finally:
        clean_memory_probe()
    return verdict("memory_paths", problems, token=report.get("token"), lpVersion=report.get("lpVersion"), paths=report.get("results"), skipped=report.get("skipped"),
                   unanswered=report.get("unanswered"), writerAttempt=attempt or None, dispatch=ctx.dispatches.get(spec["id"]))


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
        rc, out, err = run([BB, "plugin", "rpc", "call", "lane-pilot", method, "--input-file", handle.name, "--json"], timeout=60)
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


def scenario_watchdog(tmp: Path) -> dict:
    """Outage and lift drills, dry (SMA: Outage drill, Lift drill, Day rotation drill): the hub watchdog against a door that never answers
    records the outage and a (dry) lift; against a door that answers, a lift does nothing; an old log rotates to its day."""
    state = tmp / "watchdog"
    state.mkdir()
    env = {**os.environ, "LP_WATCH_STATE": str(state), "LP_WATCH_DRY": "1", "LP_WATCH_TG_ENV": "/nonexistent", "LP_WATCH_KNOCK_SEC": "1", "LP_WATCH_SUSPECT_AFTER": "2"}
    script = str(ROOT / "scripts" / "hub-watchdog.sh")
    problems: list[str] = []
    proc = subprocess.Popen(["bash", script, "run"], env={**env, "LP_WATCH_DOOR": "http://127.0.0.1:9/"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(8)
    proc.terminate()
    proc.wait(timeout=10)
    events = [json.loads(line).get("event") for line in (state / "outages.jsonl").read_text().splitlines() if line.strip()] if (state / "outages.jsonl").exists() else []
    if "outage" not in events:
        problems.append(f"no outage recorded against a silent door: {events}")
    if "lift" not in events:
        problems.append("no lift after the outage")
    rc, out, _ = run(["bash", script, "lift"], env={**env, "LP_WATCH_DOOR": "https://bb.vechkasov.pro/install/version"}, timeout=60)
    if "nothing to do" not in out:
        problems.append(f"a lift with the door answering did something: {out.strip()[:200]}")
    (state / "outages.jsonl").write_text('{"at":1700000000,"event":"lift","detail":"old"}\n')
    run(["bash", script, "rotate"], env=env, timeout=30)
    if not (state / "outages-2023-11-14.jsonl").exists():
        problems.append("an old log did not rotate to its day")
    return verdict("watchdog", problems, events=events)


def owner_words(ctx: "Context", value: str) -> tuple[object, int]:
    saved = hubsql(f"select value, version from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='owner.words';")
    original, version = (json.loads(saved[0]["value"]), int(saved[0]["version"])) if saved else (None, 0)
    changed = setting_rpc("save_setting", {"projectId": ctx.project, "key": "owner.words", "value": value, "expectedVersion": version})
    return original, int(changed["version"])


def scenario_live_word(ctx: "Context") -> dict:
    """Live word drill (SMA: Live word drill, Approval drill): with owner.words on, a verified task waits for the owner's word, and lands once
    the word is given (here through the task_word RPC, the path of the screen and the CLI)."""
    original, version = owner_words(ctx, "on")
    problems: list[str] = []
    row: dict = {}
    try:
        spec = note_task(f"drill-word-{STAMP}", f"drills/word-{STAMP}.md", "owner word", ctx.cwd)
        if not ctx.dispatch(spec):
            problems.append("dispatch-bb exited with an error")
        deadline, waiting = time.time() + 15 * 60, False
        while time.time() < deadline and not waiting:
            waiting = "waits for the owner's word before it lands" in thread_text(ctx.pm)
            if not waiting:
                time.sleep(POLL_SEC)
        if not waiting:
            problems.append("the verified task never said it waits for the owner's word")
        else:
            setting_rpc("task_word", {"runId": ctx.run_id, "taskId": spec["id"], "decision": "yes", "text": "да"})
        rows = ctx.wait_ended([spec["id"]])
        row = summarize(rows, spec["id"], ctx.cwd, spec["expected_outputs"][0])
        if row["state"] != "accepted":
            problems.append(f"the task did not land after the word: {row['states']} {row['reason']}")
    finally:
        if original is None:
            setting_rpc("reset_project_settings", {"projectId": ctx.project, "keys": ["owner.words"], "expectedVersions": {"owner.words": version}})
        else:
            setting_rpc("save_setting", {"projectId": ctx.project, "key": "owner.words", "value": original, "expectedVersion": version})
    return verdict("live_word", problems, tasks=[row] if row else [])


def scenario_no_code_exit(ctx: "Context") -> dict:
    """No-code exit drill (SMA): a writer that cannot do the task without the owner ends with NEEDS_HUMAN, changes nothing, and the task is
    held with its question instead of a forced change."""
    path = f"drills/needs-human-{STAMP}.md"
    spec = task(f"drill-human-{STAMP}", "a question for the owner", [path],
                f"Do not create or change any file. Your whole final report is one line: `NEEDS_HUMAN: which colour should {path} use?`",
                [f"{path} exists"], ctx.cwd)
    problems = [] if ctx.dispatch(spec) else ["dispatch-bb exited with an error"]
    rows = ctx.wait_ended([spec["id"]])
    row = summarize(rows, spec["id"], ctx.cwd, path)
    if row["state"] == "accepted":
        problems.append("a writer that asked a question was accepted")
    if "needs_human" not in str(row.get("reason") or "").lower() and "needs human" not in str(row.get("reason") or "").lower():
        problems.append(f"the task did not end with the writer's question: {row['states']} {row['reason']}")
    if row.get("fileInSandbox"):
        problems.append("a file was written although the writer had a question")
    return verdict("no_code_exit", problems, tasks=[row])


def scenario_phase(ctx: "Context") -> dict:
    """Three tasks, two batches, a phase (SMA: Graph release series): a phase opened, its context signed, a plan of three pieces in two waves
    checked and admitted; the driver issues wave 1, then wave 2 after wave 1 is accepted, and the phase reaches verification."""
    problems: list[str] = []
    act = lambda action, phase_id=None, **payload: setting_rpc("phase_act", {"action": action, "projectId": ctx.project, "pmThreadId": ctx.pm, **({"phaseId": phase_id} if phase_id else {}), "payload": payload})
    doc = f"drills/phase-{STAMP}-CONTEXT.md"
    commit_file(ctx.cwd, doc, f"# Context\n\nLocked: three notes in two waves (drill {STAMP}).\n", f"drill: phase context {STAMP}")
    opened = act("open", title=f"Drill phase {STAMP}", goal="three notes exist, written in two waves")
    phase_id = opened["phase"]["id"]
    try:
        act("context", phase_id, docs=[doc], risks={"technical": "none", "product": "none", "operations": "none", "security": "none"})
        notes = [note_task(f"drill-ph{n}-{STAMP}", f"drills/phase-{STAMP}-{n}.md", f"phase piece {n}", ctx.cwd) for n in (1, 2, 3)]
        notes[2]["depends_on"] = [notes[0]["id"]]
        items = [{"id": spec["id"], "title": spec["title"], "wave": 1 if n < 2 else 2, "task": spec,
                  "promise": {"given": "the sandbox", "when": "the piece runs", "then": f"{spec['expected_outputs'][0]} holds its two lines"}} for n, spec in enumerate(notes)]
        act("plan", phase_id, items=items)
        act("plan_check", phase_id, decision="approve", by="lp-drill", summary="drill plan")
        deadline, stage = time.time() + TIMEOUT_MIN * 60, ""
        while time.time() < deadline:
            stage = setting_rpc("phase_get", {"phaseId": phase_id})["phase"]["stage"]
            if stage in ("verification", "acceptance", "lessons", "closed"):
                break
            time.sleep(POLL_SEC)
        if stage not in ("verification", "acceptance", "lessons", "closed"):
            problems.append(f"the phase did not reach verification: it is at {stage}")
        book = setting_rpc("phase_get", {"phaseId": phase_id}).get("book", "")
        if "wave 2" not in book or "wave_table" not in book and "| piece |" not in book:
            problems.append("the book has no wave table for wave 2")
    finally:
        setting_rpc("phase_control", {"phaseId": phase_id, "action": "close", "note": "drill done"})
    return verdict("phase", problems, phaseId=phase_id)


ROUTE_REACHED = ("execution", "verification", "acceptance", "lessons", "closed")
ROUTE_HOLD_SEC = int(os.environ.get("LP_DRILL_ROUTE_HOLD_SEC", "150"))
BOOK_LINE = re.compile(r"^- \S+ \S+ \*\*([^*]+)\*\* — (.*)$")


def book_parts(book: str) -> list[tuple[str, str]]:
    """(kind, text) of every part line of a rendered phase book."""
    return [(m.group(1), m.group(2)) for m in (BOOK_LINE.match(line) for line in book.splitlines()) if m]


def route_problems(book: str, reached: str) -> list[str]:
    """What the phase route owes: no stage of the machine failed for editing its own files or reading the drawing, and the phase got to execution."""
    problems = [f"a stage failed on what it writes or reads: {text[:240]}" for kind, text in book_parts(book)
                if kind == "auto_failed" and ("repo_edited" in text or "lane_pilot_read_binary_rejected" in text)]
    if reached not in ROUTE_REACHED:
        problems.append(f"the machine's stages did not carry the phase to execution: it is at {reached}")
    return problems


def hold_problems(label: str, before: dict, after: dict) -> list[str]:
    """A pause or a stopped wave holds when the phase stays paused and starts no stage and issues no piece. Snapshot: state, auto_started, issued."""
    problems = []
    if after["state"] not in ("paused", "pause_requested"):
        problems.append(f"{label}: the phase did not stay paused ({after['state']})")
    if after["auto_started"] > before["auto_started"]:
        problems.append(f"{label}: a stage was started while the phase was held")
    if after["issued"] > before["issued"]:
        problems.append(f"{label}: a piece was issued while the phase was held")
    return problems


def route_snapshot(phase_id: str) -> dict:
    got = setting_rpc("phase_get", {"phaseId": phase_id})
    phase = got["phase"]
    return {"stage": phase["stage"], "state": phase["state"], "book": got.get("book", ""),
            "auto_started": sum(1 for kind, _ in book_parts(got.get("book", "")) if kind == "auto_started"),
            "issued": len((phase.get("record", {}).get("execution") or {}).get("issued") or {})}


def scenario_phase_route(ctx: "Context") -> dict:
    """The phase route on the machine's own stages (fable review 2026-10-27 §2.1: the train never reached its end on a real project): a small
    phase is opened and no one reports its stages. Its analysis and plan run as workflows whose helpers write the phase's folder and the plans
    folder; the book must hold no auto_failed for repo_edited or a refused binary read. A pause at the first boundary, and stop_wave at
    execution, hold: no stage starts and no piece is issued while the phase is held."""
    problems: list[str] = []
    act = lambda action, phase_id=None, **payload: setting_rpc("phase_act", {"action": action, "projectId": ctx.project, "pmThreadId": ctx.pm, **({"phaseId": phase_id} if phase_id else {}), "payload": payload})
    control = lambda phase_id, action, **extra: setting_rpc("phase_control", {"phaseId": phase_id, "action": action, **extra})

    def wait_stage(phase_id: str, stages: tuple[str, ...]) -> dict:
        deadline, snap = time.time() + TIMEOUT_MIN * 60, route_snapshot(phase_id)
        while time.time() < deadline and snap["stage"] not in stages:
            time.sleep(5)
            snap = route_snapshot(phase_id)
        return snap

    opened = act("open", title=f"Drill route {STAMP}", goal=f"A new file drills/route-{STAMP}.md exists in the repository and its first line is '# route {STAMP}'.")
    phase_id = opened["phase"]["id"]
    snap: dict = {}
    try:
        # Boundary 1: the analysis is done and signed, the plan is next. Pause here.
        snap = wait_stage(phase_id, ("planning", "design", *ROUTE_REACHED))
        if snap["stage"] == "discussion":
            problems.append("lp.analyze did not carry the phase out of discussion")
        else:
            control(phase_id, "pause")
            held = route_snapshot(phase_id)
            time.sleep(ROUTE_HOLD_SEC)
            problems += hold_problems("pause at the first boundary", held, route_snapshot(phase_id))
            control(phase_id, "resume")
            snap = wait_stage(phase_id, ROUTE_REACHED)
            if snap["stage"] == "execution":
                control(phase_id, "stop_wave")
                held = route_snapshot(phase_id)
                time.sleep(ROUTE_HOLD_SEC)
                problems += hold_problems("stop_wave at execution", held, route_snapshot(phase_id))
        snap = route_snapshot(phase_id)
        problems += route_problems(snap["book"], snap["stage"])
    finally:
        setting_rpc("phase_control", {"phaseId": phase_id, "action": "close", "note": "drill done"})
    return verdict("phase_route", problems, phaseId=phase_id, stage=snap.get("stage"), autoStarted=snap.get("auto_started"))


def scenario_skills(ctx: "Context") -> dict:
    """Skills drill (SMA): a skill the PM names on a task reaches the writer's brief."""
    spec = note_task(f"drill-skill-{STAMP}", f"drills/skill-{STAMP}.md", "skill check", ctx.cwd)
    spec["skills"] = ["ru-text"]
    problems = [] if ctx.dispatch(spec) else ["dispatch-bb exited with an error"]
    rows = ctx.wait_ended([spec["id"]])
    row = summarize(rows, spec["id"], ctx.cwd, spec["expected_outputs"][0])
    writer = next((r.get("thread_id") for r in rows if r.get("thread_id")), None)
    if not writer or "ru-text" not in thread_text(writer):
        problems.append("the named skill ru-text is not in the writer's thread")
    if row["state"] != "accepted":
        problems.append(f"the task was not accepted: {row['states']} {row['reason']}")
    return verdict("skills", problems, tasks=[row])


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


DEFERRAL_MARK = re.compile(r"//\s*deferral:(dfr_[A-Za-z0-9_]+)")
# Words a BB core answers with when the plugin does not (yet) register an RPC method: the register is not deployed, which is not a failure.
RPC_MISSING = re.compile(r"unknown (rpc )?method|method not found|no such (rpc )?method|not registered|unsupported", re.I)


def cited_deferrals() -> list[str]:
    """Every `// deferral:<id>` written in tests/ and packages/*/tests/ of this checkout (a skipped test names the entry that excuses it)."""
    found: set[str] = set()
    folders = [ROOT / "tests", *sorted((ROOT / "packages").glob("*/tests"))]
    for folder in folders:
        for path in folder.rglob("*"):
            if path.suffix not in (".ts", ".tsx", ".mts") or "node_modules" in path.parts:
                continue
            found.update(DEFERRAL_MARK.findall(path.read_text(encoding="utf-8", errors="replace")))
    return sorted(found)


def scenario_deferrals(tmp: Path) -> dict:
    """The register of deferrals (SMA rule 5): an entry whose term has passed, or a skipped test citing an entry the register does not hold
    or holds closed, fails the drill. Every entry has a term (the default of 14 days, an agent's with its reason, or one an owner's message named)."""
    cited = cited_deferrals()
    try:
        data = setting_rpc("deferral_list", {"refs": cited})
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return verdict("deferrals", [], registerDeployed=False, note=f"the running plugin has no register yet: {str(cause)[:160]}")
        return verdict("deferrals", [f"the register of deferrals could not be read: {str(cause)[:200]}"])
    problems: list[str] = []
    for item in data.get("overdue", []):
        problems.append(f"overdue deferral {item['id']} ({item['kind']}: {item['what'][:100]}): its term {item['due']} passed. "
                        f"Do one of: do it and close it with evidence (bb lane-pilot defer-close {item['id']} --evidence \"<commit, test run, link>\"), "
                        f"or give it a new term with the reason (bb lane-pilot defer {item['id']} --due <day, at most 30 days ahead> --reason \"<what it waits for>\")")
    for ref in data.get("badRefs", []):
        why = "is not in the register" if ref["problem"] == "unknown" else "is closed, so the skip it excuses is no longer deferred (run the test or remove the skip)"
        problems.append(f"a skipped test cites deferral:{ref['id']}, which {why}")
    counts = data.get("counts", {})
    return verdict("deferrals", problems, registerDeployed=True, counts=counts, cited=len(cited), needsOwnerTerm=len(data.get("needsOwnerTerm", [])))


def scenario_checkers(tmp: Path) -> dict:
    """The checker drill (src/rooms/checkers): planted defects, the code checkers must catch the class they are for. The checkout's own code is
    bundled and run, so a change that makes a checker blind turns the drill red before it is deployed. Then the same drill with the ownership
    checker blinded must come out red, or the drill proves nothing."""
    esbuild = ROOT / "node_modules/.bin/esbuild"
    command = [str(esbuild)] if esbuild.exists() else ["npx", "--no-install", "esbuild"]
    out = ROOT / "node_modules/.cache/lp-checkers-drill.mjs"
    out.parent.mkdir(parents=True, exist_ok=True)
    banner = "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"
    rc, stdout, stderr = run([*command, str(ROOT / "scripts/lp-checkers.ts"), "--bundle", "--platform=node", "--format=esm", f"--outfile={out}",
                              "--external:better-sqlite3", "--external:@get-bb/plugin-sdk", f"--banner:js={banner}"], timeout=120)
    if rc != 0:
        return verdict("checkers", [f"the checker drill could not be built: {(stderr or stdout).strip()[:300]}"])
    problems: list[str] = []
    details: dict = {}
    for blind in (None, "ownership"):
        args = ["node", str(out), "drill", "--json"] + (["--blind", blind] if blind else [])
        rc, stdout, stderr = run(args, timeout=180)
        try:
            report = json.loads(stdout)
        except ValueError:
            problems.append(f"the checker drill{' (blind: ' + blind + ')' if blind else ''} gave no report: {(stderr or stdout).strip()[:300]}")
            continue
        if not blind:
            details = {"checked": report.get("checked")}
            if not report.get("ok"):
                problems += [f"checker drill: {p}" for p in report.get("problems", [])] or ["the checker drill is red without saying why"]
        elif report.get("ok") or not any(blind in p for p in report.get("problems", [])):
            problems.append(f"the checker drill stayed green with the {blind} checker blinded: the drill can no longer fail, so it proves nothing")
    return verdict("checkers", problems, **details)


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


def scenario_nogit_repo(tmp: Path) -> dict:
    cwd = NOGIT["cwd"]
    if not Path(cwd).is_dir():
        return {"name": "nogit_repo", "result": "skipped", "problems": [], "note": f"no folder {cwd}"}
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
        if (repo / inside).exists():
            git(str(repo), "rm", "-q", "--", inside)
            git(str(repo), "-c", "user.name=Lane Pilot drill", "-c", "user.email=drill@local.invalid", "commit", "-q", "-m", f"drill {STAMP}: clean up")
    return verdict("nogit_repo", problems, tasks=[row] if row else [], project=NOGIT["project"], runId=ctx.run_id or None, configuredByDrill=configured)


# --- main ---------------------------------------------------------------------------------------------------------------

def dry_run(names: list[str]) -> None:
    print(f"drill {STAMP} in {SANDBOX['project']} ({SANDBOX['cwd']}), no-git {NOGIT['project']} ({NOGIT['cwd']}), hub db {HUB}:{HUB_DB}; scenarios: {', '.join(names)}")
    if "parallel3" in names:
        for spec in tasks_parallel3(SANDBOX["cwd"]):
            print(json.dumps(spec))
    cwd = SANDBOX["cwd"]
    documents = {"memory_paths": [task_memory(cwd)], "conflict": tasks_conflict(cwd), "main_moved": [task_moved(cwd)], "provider": [task_provider(cwd)], "provider_limit": [task_limit(cwd)], "reload": [task_reload(cwd)], "nogit": [task_nogit(NOGIT["cwd"])], "nogit_repo": [task_nogit_repo(NOGIT["cwd"])]}
    for name in names:
        for spec in documents.get(name, []):
            print(f"scenario {name}: {json.dumps(spec)}")


def evidence_seen(run_id: str) -> dict | None:
    """What the drill's run left on the hub: stage receipts (stage -> state -> n), gate evaluations (gate -> status -> n) and attempt moves
    ("from>to" -> n). `bb lane-pilot coverage --receipt` checks the registry's «covered live» claims against it (src/rooms/coverage)."""
    try:
        stages = hubsql(f"select stage_id as k, state as v, count(*) as n from lane_pilot_stage_receipt where run_id='{run_id}' group by 1, 2;")
        gates = hubsql(f"select gate as k, status as v, count(*) as n from lane_pilot_gate_event where run_id='{run_id}' group by 1, 2;")
        moves = hubsql(f"select t.from_state||'>'||t.to_state as k, case t.refused when 1 then 'refused' else 'ok' end as v, count(*) as n from lane_pilot_attempt_transition t join lane_pilot_attempt a on a.id=t.attempt_id where a.run_id='{run_id}' group by 1, 2;")
    except Exception as cause:  # the hub could not be read: the receipt says so instead of failing the drill
        log(f"evidence of the run not recorded: {cause}")
        return None
    nest = lambda rows: {k: {r["v"]: r["n"] for r in rows if r["k"] == k} for k in sorted({r["k"] for r in rows})}
    return {"stages": nest(stages), "gates": nest(gates), "moves": nest(moves)}


def judge_scenario(scenario: dict) -> dict:
    """Suite report judge: a pass counts only with evidence — the tasks it ran, the events it saw or the details it checked."""
    evidence = [key for key, value in scenario.items() if key not in ("name", "result", "problems") and value not in (None, [], {}, "")]
    verdict_of = "pass" if scenario["result"] == "pass" and (evidence or scenario.get("note")) else "skipped" if scenario["result"] == "skipped" else "fail"
    return {"name": scenario["name"], "verdict": verdict_of, "evidence": evidence, "why": "" if verdict_of != "fail" else "; ".join(scenario["problems"]) or "a pass without evidence"}


def judge_series(judged: list[dict], names: list[str]) -> dict:
    """Series judge: every scenario asked for has a verdict, none failed, and the skipped ones say why."""
    missing = [name for name in names if name not in {row["name"] for row in judged}]
    failed = [row["name"] for row in judged if row["verdict"] == "fail"]
    return {"verdict": "pass" if not missing and not failed else "fail", "missing": missing, "failed": failed, "skipped": [row["name"] for row in judged if row["verdict"] == "skipped"]}


def scout() -> dict:
    """Scout of named suites: every scenario_* in this file is named in ALL, and every name in ALL has its function."""
    defined = sorted(name[len("scenario_"):] for name in globals() if name.startswith("scenario_"))
    return {"defined": defined, "unlisted": [name for name in defined if name not in ALL], "undefined": [name for name in ALL if name not in defined]}


def series_preparation() -> dict:
    """Series preparation: what the series runs against — the plugin version and commit, the scout, a clean sandbox."""
    commit = git(str(ROOT), "rev-parse", "HEAD")
    version = json.loads((ROOT / "package.json").read_text()).get("version")
    dirty = git(SANDBOX["cwd"], "status", "--porcelain")
    return {"commit": commit, "version": version, "scout": scout(), "sandboxClean": not dirty.strip()}


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
        "seen": evidence_seen(ctx.run_id) if ctx and ctx.run_id else None,
    }
    data["judged"] = [judge_scenario(row) for row in scenarios]
    data["series"] = judge_series(data["judged"], names)
    if data["series"]["verdict"] == "fail" and result == "pass":
        result = data["result"] = "fail"
        data["problems"].append(f"series judge: {data['series']}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True, description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--scenario", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--repair-guard", action="store_true")
    parser.add_argument("--series", action="store_true", help="the release series: preparation, every scenario in a process of its own, the judges")
    parser.add_argument("--scout", action="store_true", help="only list the named suites against the scenario functions")
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
    if args.scout:
        print(json.dumps(scout(), indent=1))
        return 0
    if args.series:
        # One process per scene: each scenario runs in its own interpreter, so one that wedges or leaks state cannot spoil the next.
        prep = series_preparation()
        log(f"series: {json.dumps(prep)[:300]}")
        if prep["scout"]["unlisted"] or prep["scout"]["undefined"]:
            log(f"scout: {prep['scout']}")
        receipts = []
        for name in names:
            rc, out, _ = run([sys.executable, "-I", __file__, "--scenario", name], timeout=TIMEOUT_MIN * 60 * 3)
            receipts.append({"name": name, "exit": rc, "receipt": next((line.split("=", 1)[1] for line in out.splitlines() if line.startswith("RECEIPT=")), None)})
        manifest = Path(os.environ.get("LP_DRILL_RECEIPT_DIR") or ROOT / ".agents/runs/drills") / f"series-{STAMP}.json"
        manifest.parent.mkdir(parents=True, exist_ok=True)
        verdict_all = "pass" if all(row["exit"] == 0 for row in receipts) else "fail"
        manifest.write_text(json.dumps({"kind": "lane-pilot-release-series", "stamp": STAMP, "preparation": prep, "scenes": receipts, "verdict": verdict_all}, indent=2) + "\n")
        print(f"SERIES={manifest}")
        return 0 if verdict_all == "pass" else 1

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
        if "deferrals" in names:
            log("scenario deferrals")
            try:
                scenarios.append(scenario_deferrals(tmp))
            except Exception as cause:
                scenarios.append(verdict("deferrals", [f"scenario raised: {cause}"]))
            log(f"scenario deferrals: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
        if "watchdog" in names:
            log("scenario watchdog")
            try:
                scenarios.append(scenario_watchdog(tmp))
            except Exception as cause:
                scenarios.append(verdict("watchdog", [f"scenario raised: {cause}"]))
            log(f"scenario watchdog: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
        if "checkers" in names:
            log("scenario checkers")
            try:
                scenarios.append(scenario_checkers(tmp))
            except Exception as cause:
                scenarios.append(verdict("checkers", [f"scenario raised: {cause}"]))
            log(f"scenario checkers: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
        # memory_paths first: its records are planted before the PM starts (its first prompt must carry the probe rule) and removed before
        # the writers of the other scenarios start.
        main_names = sorted((n for n in names if n not in STANDALONE), key=lambda n: n != "memory_paths")
        if main_names:
            ctx = Context(SANDBOX, tmp)
            if "memory_paths" in main_names:
                log("planting the memory probe before the PM starts")
                ctx.memory_probe = plant_memory_probe()
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
        if "nogit_repo" in names and not problems:
            log("scenario nogit_repo")
            try:
                scenarios.append(scenario_nogit_repo(tmp))
            except Exception as cause:
                scenarios.append(verdict("nogit_repo", [f"scenario raised: {cause}"]))
            log(f"scenario nogit_repo: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
        if ctx and ctx.run_id:
            problems += ctx.finish()
    finally:
        if ctx and ctx.memory_probe:
            clean_memory_probe()  # also when the PM did not start or a scenario broke: a probe rule must not outlive the drill
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
