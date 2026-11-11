#!/usr/bin/env python3
"""Sandbox drill (E3): the live regression check run before every Lane Pilot deploy. Entry point: scripts/lp-drill.sh.

Scenarios (each writes its verdict into the receipt, .agents/runs/drills/<date>.json):
  guard_hash     the installed shell guard (~/.agents/lane-pilot/pm/guard_shell.py and lib_payload.py) on the Mac mini, the MacBook and OVH
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
                 reach what each registered path hands its agent (writer brief, writer turn, PM, critics, council) -- the
                 probe's own table -- and the real thing: the first prompt of the drill's PM (planted before it started) and the brief of a
                 real writer spawned for a probe task (cancelled once its thread exists). Any path that does not deliver, or an unrelated query that pulls our records, fails the
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

Usage: scripts/lp-drill.sh [--quick] [--quick-all] [--scenario a,b] [--dry-run] [--repair-guard]
  --quick      the scenarios marked [--quick] (what bb-plugin-push runs after a deploy), minus the live ones (memory_paths,
               helper_providers, parallel3) whose code did not change since that scenario last passed here and that passed within
               a day: their models and five minutes are not spent on a change they do not read (owner 2026-10-29). The receipt
               lists each skipped one with its reason; LP_DRILL_SELECT=0 runs them all
  --quick-all  every [--quick] scenario
  --scenario   only the named scenarios
  --dry-run    print the tasks, change nothing
Exit: 0 pass, 1 a scenario failed (the receipt says why), 2 could not start. The last stdout line is `RECEIPT=<path>`.
Settings (env): LP_DRILL_TIMEOUT_MIN (20, per scenario), LP_DRILL_PARALLEL3_TIMEOUT_MIN (10), LP_DRILL_SELECT (0: --quick runs every live scenario), LP_DRILL_PROJECT, LP_DRILL_ENVIRONMENT, LP_DRILL_CWD,
LP_DRILL_PROVIDERS (`provider=model,...` instead of the providers read from the sandbox project's settings), LP_DRILL_GUARD_HOSTS (JSON list of machines for guard_hash), LP_DRILL_RECEIPT_DIR, LP_DRILL_NOGIT_PROJECT, LP_DRILL_NOGIT_ENVIRONMENT, LP_DRILL_NOGIT_CWD, LP_DRILL_BAD_MODEL, BB_CLI, BB_HUB_HOST, BB_HUB_KEY.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import shlex
import os
import socket
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# The code lives in scripts/lp_drill/ (one module per responsibility); the door re-exports every name the file had as
# one file, so tests still load it alone. Its folder goes first on sys.path: under python3 -I it is not there by itself.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import lp_drill.env
import lp_drill.hub

for _mod in (lp_drill.env, lp_drill.hub,):
    for _name in dir(_mod):
        if not _name.startswith("__"):
            _value = getattr(_mod, _name)
            if not isinstance(_value, types.ModuleType):
                globals()[_name] = _value


def _rehome(fn):
    """Rebind a moved-out function's globals to this door's: this file's names keep one home here, so a test that
    replaces a module global (m.run = ..., m.hubsql = ...) is seen by the code that moved into lp_drill/."""
    moved = types.FunctionType(fn.__code__, globals(), fn.__name__, fn.__defaults__, fn.__closure__)
    moved.__kwdefaults__ = fn.__kwdefaults__
    moved.__dict__.update(fn.__dict__)
    moved.__annotations__ = fn.__annotations__
    moved.__qualname__ = fn.__qualname__
    moved.__module__ = fn.__module__
    moved.__doc__ = fn.__doc__
    return moved


for _name, _value in list(globals().items()):
    if type(_value) is types.FunctionType and str(_value.__module__ or "").startswith("lp_drill"):
        globals()[_name] = _rehome(_value)
    elif isinstance(_value, type) and str(_value.__module__ or "").startswith("lp_drill"):
        for _mname, _member in list(vars(_value).items()):
            _wrap = type(_member) if isinstance(_member, (staticmethod, classmethod)) else None
            _fn = _member.__func__ if _wrap else _member
            if type(_fn) is types.FunctionType:
                setattr(_value, _mname, _wrap(_rehome(_fn)) if _wrap else _rehome(_fn))

del _mod, _name, _value
for _tmp in ("_mname", "_member", "_wrap", "_fn"):
    globals().pop(_tmp, None)
del _tmp
ALL = ["guard_hash", "deferrals", "checkers", "watchdog", "memory_paths", "helper_providers", "parallel3", "conflict", "main_moved", "provider", "provider_limit", "live_word", "no_code_exit", "skills", "phase", "phase_route", "reload", "nogit", "nogit_repo", "flow_contract", "lead_shadow", "episodes", "memory_thread"]
# Scenes that run only by name (--scenario) or under --series: the deploy drill (--quick) and a plain run never reach them.
EXTRA = ["skills_screen", "revert"]
QUICK = ["guard_hash", "deferrals", "checkers", "memory_paths", "helper_providers", "parallel3", "lead_shadow", "episodes"]
# The release series as named suites (SMA rl_suites): task, batch, phase, release, window, worker, lockstep, wiring,
# metrics. A `vitest:` entry runs its story file as the suite's scene; `metrics` holds no scenario — series_metrics
# judges the archive last, after every other suite.
SUITES = {
    "task": ["parallel3", "conflict", "main_moved", "provider", "provider_limit", "reload", "nogit", "nogit_repo", "revert"],
    "batch": ["helper_providers", "flow_contract", "live_word"],
    "phase": ["phase", "phase_route", "no_code_exit"],
    "release": ["guard_hash", "deferrals", "checkers", "watchdog"],
    "window": ["vitest:tests/release-stories-window.test.tsx"],
    "worker": ["vitest:tests/release-stories-worker.test.ts"],
    "lockstep": ["lead_shadow", "episodes"],
    "wiring": ["memory_paths", "memory_thread", "skills", "skills_screen"],
    "metrics": [],
}
# What a provider runs when no setting of the sandbox project names a model for it.
PROVIDER_FALLBACK_MODEL = {"claude-code": "claude-sonnet-5-5", "codex": "gpt-6-luna", "opencode2": "zai-coding-plan/glm-5.3-flash"}
# Scenarios that need no PM and no run of their own: they run before the PM starts (guard_hash) or on a project of their own (nogit).
# Scenarios that run only when named (--scenario outage_live): never in ALL, so no full drill and no deploy starts them.
BY_NAME = ["outage_live"]
STANDALONE = ("guard_hash", "deferrals", "checkers", "watchdog", "outage_live", "nogit", "nogit_repo", "lead_shadow", "episodes", "memory_thread")

# Which changed files a live scenario reads. A path no live scenario reads (NOT_LIVE) starts none; a shared one (FOUNDATION, and anything
# outside src/ and packages/ that is not NOT_LIVE) starts every one; else parallel3 runs unless the path is in a room it does not pass
# through, and the narrow scenarios run only for their own code. Unsure means run: a wrong row costs one more drill, not a missed one,
# and every live scenario runs at least once a day (LIVE_MAX_AGE_SEC) whatever changed.
LIVE = ("memory_paths", "helper_providers", "parallel3")
LIVE_MAX_AGE_SEC = 24 * 3600
NOT_LIVE = ["docs/**", "tests/**", ".agents/**", ".bb/**", "**/*.md", "src/**/ui/**", "src/**/*.tsx", "src/rooms/sma-map/**",
            "src/rooms/world/**", "src/rooms/ui-shell/**", "packages/i18n/**", "packages/ui-kit/**", "packages/pixel-world/**",
            "packages/world-sim/**", "scripts/**", "vitest*", "tsconfig*", ".gitignore", ".gitnexus/**", "CLAUDE.md", "AGENTS.md"]
FOUNDATION = ["scripts/lp-drill.py", "scripts/lp-drill.sh", "package-lock.json", "src/rooms/core/**", "src/rooms/storage/**", "src/rooms/contracts/**",
              "src/rooms/settings/**", "packages/contracts/**", "packages/kit/**", "packages/settings-catalog/**", "packages/host-calls/**", "packages/models/**"]
# Rooms a writer task's road (dispatch, writer, checks, merge, acceptance) does not pass through.
PARALLEL3_SKIP = [f"src/rooms/{room}/**" for room in ("phase", "council", "cockpit", "night", "night-graphs", "hypotheses", "bench", "forge", "money",
                  "forecast", "coverage", "docs", "backlog", "anamnesis", "twins", "outbound", "owner-presence", "memory-eval", "design-eval", "deferral", "checkers")]
SCENARIO_CODE = {
    "episodes": ["src/rooms/errands/**", "src/rooms/qa/server/errand*", "src/rooms/workflow/server/workflow.ts", "packages/harness-core/src/trajectory.ts"],
    "helper_providers": ["src/rooms/native-agent/**", "src/rooms/runs/server/run-routing*", "src/rooms/stability/server/probes.ts", "src/rooms/tools/server/cli*",
                         "src/rooms/critique/pm-read.ts", "packages/thread-observe/**"],
    "memory_paths": ["src/rooms/memory/**", "src/rooms/memory-probe/**", "src/rooms/memory-tiers/**", "packages/memory-core/**", "src/rooms/native-agent/**",
                     "src/rooms/writer/server/writer-task.ts", "src/rooms/writer/server/writer-knowledge.ts", "src/rooms/critique/**", "src/rooms/council/server/**"],
}


def glob_match(path: str, pattern: str) -> bool:
    """owns_paths-style globs: `**` spans folders, `*` stays inside one; a pattern without a slash matches the file name at any depth."""
    if "/" not in pattern:
        return fnmatch.fnmatchcase(path.rsplit("/", 1)[-1], pattern)
    regex = re.escape(pattern).replace(r"\*\*/", "(?:.*/)?").replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
    return re.fullmatch(regex, path) is not None


def live_reads(name: str, path: str) -> bool:
    """Does the live scenario `name` read the changed file `path`?"""
    if any(glob_match(path, pattern) for pattern in FOUNDATION):
        return True
    if any(glob_match(path, pattern) for pattern in NOT_LIVE):
        return False
    if not path.startswith(("src/", "packages/")):
        return True
    if name == "parallel3":
        return not any(glob_match(path, pattern) for pattern in PARALLEL3_SKIP)
    return any(glob_match(path, pattern) for pattern in SCENARIO_CODE[name])


def changed_since(commit: str, head: str = "HEAD") -> list[str] | None:
    """Files changed from `commit` to `head` in this checkout; None when the commit is not in its history. package.json and its lock
    whose only change is the plugin's own version do not count: every deploy bumps it (a dependency's version line still counts)."""
    rc, _, _ = run(["git", "-C", str(ROOT), "merge-base", "--is-ancestor", commit, head], timeout=30)
    if rc != 0:
        return None
    rc, out, _ = run(["git", "-C", str(ROOT), "diff", "--name-only", commit, head], timeout=60)
    if rc != 0:
        return None
    files = [line for line in out.splitlines() if line]
    versions = set()
    for ref in (commit, head):
        _, text, _ = run(["git", "-C", str(ROOT), "show", f"{ref}:package.json"], timeout=30)
        try:
            versions.add(json.loads(text).get("version"))
        except ValueError:
            pass
    for name in ("package.json", "package-lock.json"):
        if name not in files:
            continue
        _, diff, _ = run(["git", "-C", str(ROOT), "diff", "-U0", commit, head, "--", name], timeout=30)
        lines = [line for line in diff.splitlines() if line[:1] in "+-" and not line.startswith(("+++", "---"))]
        own = [re.match(r'^[+-]\s*"version":\s*"([^"]+)",?\s*$', line) for line in lines]
        if all(match and match.group(1) in versions for match in own):
            files.remove(name)
    return files


def last_passed(name: str, receipt_dir: Path) -> tuple[str, float] | None:
    """The commit and finish time of the newest receipt here in which `name` ran and passed."""
    for path in sorted(receipt_dir.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or not data.get("commit"):
            continue
        if any(row.get("name") == name and row.get("result") == "pass" for row in data.get("scenarios") or []):
            return data["commit"], (data.get("finishedAt") or 0) / 1000
    return None


def select_quick(receipt_dir: Path, now: float | None = None) -> tuple[list[str], dict[str, str]]:
    """The --quick scenarios this deploy needs, and why each live one left out is left out."""
    now = time.time() if now is None else now
    names, skipped = [], {}
    for name in QUICK:
        if name not in LIVE:
            names.append(name)
            continue
        last = last_passed(name, receipt_dir)
        if not last or now - last[1] > LIVE_MAX_AGE_SEC:
            names.append(name)
            continue
        files = changed_since(last[0])
        reads = [path for path in files if live_reads(name, path)] if files is not None else None
        if reads is None or reads:
            names.append(name)
            continue
        skipped[name] = f"passed at {last[0][:12]} {round((now - last[1]) / 3600, 1)} h ago; none of the {len(files)} file(s) changed since is its code"
    return names, skipped


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
        self.free_sandbox()
        rc, out, err = bb("lane-pilot", "activate", self.project, self.source)
        self.pm, self.run_id = thread_field(out, "threadId"), thread_field(out, "runId")
        if rc != 0 or not self.pm or not self.run_id:
            raise RuntimeError(f"activate failed: {(err.strip() or out)[:300]}")
        log(f"PM {self.pm}, run {self.run_id} ({self.project})")

    def free_sandbox(self) -> None:
        """An earlier drill that died (a full disk, a killed deploy) can leave an open run in the sandbox project, which holds the
        project's activation: cancel its open attempts and finish it, so this drill can start its PM (live 2026-10-27)."""
        try:
            left = hubsql(f"select id from lane_pilot_run where project_id='{self.project}' and closed_at is null and state in ('pending','running','blocked');")
        except RuntimeError as cause:
            log(f"sandbox check skipped: {cause}")
            return
        for row in left:
            run = row["id"]
            for attempt in hubsql(f"select id from lane_pilot_attempt where run_id='{run}' and state in ({','.join(repr(s) for s in OPEN_STATES)});"):
                log(f"leftover run {run}: cancelling {attempt['id']}")
                bb("lane-pilot", "cancel", attempt["id"])
        for row in left:
            rc, out, err = bb("lane-pilot", "finish", self.project, row["id"])
            log(f"leftover run {row['id']}: finish {'ok' if rc == 0 else (out + err).strip()[:200]}")

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
    # Each task carries a real check, red on the base and green only with the writer's file: the quick drill that gates a deploy ran
    # these with an empty verification, so its «verification passed» proved nothing about running a project's checks (audit 2026-10-28).
    def check(letter: str) -> list[dict]:
        path = f"notes/drill/{STAMP}-{letter}.md"
        return [{"command": f"test \"$(sed -n 1p {shlex.quote(path)})\" = {shlex.quote(f'# Drill {STAMP} {letter}')} && test \"$(sed -n 2p {shlex.quote(path)})\" = {shlex.quote(f'ok: {letter}')}", "cwd": cwd}]
    return [task(f"drill-{STAMP}-{letter}", f"Drill {STAMP} {letter}: one note", [f"notes/drill/{STAMP}-{letter}.md"],
                 f"Create the file notes/drill/{STAMP}-{letter}.md with exactly two lines. Line 1: `# Drill {STAMP} {letter}`. Line 2: `ok: {letter}`. Nothing else.",
                 [f"notes/drill/{STAMP}-{letter}.md exists, its first line is `# Drill {STAMP} {letter}` and its second line is `ok: {letter}`."], cwd,
                 verification=check(letter))
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
    spec = note_task(f"drill-{STAMP}-nogit-repo", f"{NOGIT_REPO}/notes/drill-{STAMP}.md", f"Drill {STAMP} nogit repo", cwd) | {"risk": "low"}
    # The check runs inside the repository, as a plugin task's does: a check with cwd in the folder without git keeps the task out of the
    # repository (it cannot run in the repository's worktree), and Lane Pilot sends such a task back (2026-10-27: the task ran in the live folder).
    text, inside = f"Drill {STAMP} nogit repo", f"notes/drill-{STAMP}.md"
    spec["verification"] = [{"command": f"test \"$(sed -n 1p {shlex.quote(inside)})\" = {shlex.quote('# ' + text)} && test \"$(sed -n 2p {shlex.quote(inside)})\" = {shlex.quote('ok: ' + text)}",
                             "cwd": str(Path(cwd) / NOGIT_REPO)}]
    return spec


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
    return verdict("parallel3", problems, tasks=tasks, checks={"allAccepted": accepted, "eachInOwnWorktree": own, "filesInSandbox": merged, "checksRan": all(ran.values())},
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


HOST_START_FAILURE = re.compile(r"thread_command_failed|exited unexpectedly")


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

    def probe_twice(item: tuple[str, str]) -> dict:
        # One more probe when only the host's thread start broke: a provider process killed once (SIGTERM on the hub, 2026-10-31,
        # deploy of 0.1.406) is not a broken provider; a broken one fails the second probe too.
        first = probe(item)
        if first["ok"] or not HOST_START_FAILURE.search(first["reason"] or ""):
            return first
        log(f"helper on {item[0]} ({item[1]}): the host's thread start failed ({first['reason']}), probing once more")
        return {**probe(item), "firstReason": first["reason"]}

    with ThreadPoolExecutor(max(1, len(pairs))) as pool:
        results = list(pool.map(probe_twice, pairs.items()))
    for item in results:
        log(f"helper on {item['provider']} ({item['model']}): started={item['started']} answered={item['answered']} {item['reason'] or ''}")
    problems, quota = helper_problems(results)
    return verdict("helper_providers", problems, providers=results, quotaExhausted=quota)


# A provider's plan ran out (opencode2 zai-coding-plan on 2026-11-01: «Weekly/Monthly Limit Exhausted. Your limit will reset at …»).
PROVIDER_QUOTA = re.compile(r"limit exhausted|insufficient_quota|usage limit|quota|rate.?limit", re.I)


def helper_problems(results: list[dict]) -> tuple[list[str], list[str]]:
    """What makes helper_providers red, and which providers only ran out of plan. A helper that started and was refused by its
    provider's quota is not a broken spawn path: it is a note on the receipt, and red only when no provider answered at all."""
    problems, quota = [], []
    for item in results:
        if item["ok"]:
            continue
        reason = item["reason"] or ""
        if item["started"] and PROVIDER_QUOTA.search(reason):
            quota.append(f"{item['provider']} ({item['model']}): {reason}")
            continue
        what = "did not start" if not item["started"] else "started but did not answer"
        problems.append(f"{item['provider']} ({item['model']}): a helper {what}: {reason or 'no reason given'}")
    if quota and not any(item["ok"] for item in results):
        problems.append("no provider answered, every one is out of plan: " + "; ".join(quota))
    return problems, quota


MEMORY_ANCHOR = "lp-probe/memory"


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


def memory_problems(report: dict, pm_text: str, writer_text: str | None) -> list[str]:
    """What is wrong with the memory delivery: the probe's rows, then the real PM prompt and the real writer brief. (2026-10-29) no terminal lane-memory."""
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
    return problems


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
        problems = memory_problems(report, thread_text(ctx.pm), writer_text)
    except RuntimeError as cause:
        problems = [str(cause)]
    finally:
        clean_memory_probe()
    return verdict("memory_paths", problems, token=report.get("token"), lpVersion=report.get("lpVersion"), paths=report.get("results"), skipped=report.get("skipped"),
                   unanswered=report.get("unanswered"), writerAttempt=attempt or None, dispatch=ctx.dispatches.get(spec["id"]))


def task_provider(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-provider", f"notes/drill/{STAMP}-provider.md", f"Drill {STAMP} provider", cwd)


def flow_contract_stages() -> set[str]:
    """Stage ids a receipt of the task pipeline may carry: the graph's agent/subworkflow nodes plus the writer node's own stages."""
    pipeline = json.loads((Path(__file__).parent.parent / "workflows" / "lp-task-pipeline.json").read_text())
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


def scenario_provider_limit(ctx: Context) -> dict:
    key = "writer.model"
    saved = hubsql(f"select value, version from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='{key}';")
    original, version = (json.loads(saved[0]["value"]), int(saved[0]["version"])) if saved else (None, 0)
    problems: list[str] = []
    row: dict = {}
    try:
        changed = setting_rpc("save_setting", {"projectId": ctx.project, "key": key, "value": BAD_MODEL, "expectedVersion": version})
        if not changed.get("ok") and changed.get("conflict"):
            # A reset row keeps its version generation (the settings table has no row, the RPC still knows version N): take the version
            # the refusal names and save once more (live 2026-10-27: version 28, value null).
            version = int(changed.get("version") or 0)
            changed = setting_rpc("save_setting", {"projectId": ctx.project, "key": key, "value": BAD_MODEL, "expectedVersion": version})
        if not changed.get("ok"):
            return verdict("provider_limit", [f"could not set {key}: {json.dumps(changed)[:200]}"])
        version = int(changed["version"])
        # Jev picks a writer per task and would never try the project's writer.model (live 2026-10-27: «the bad model was never tried»).
        pick_off = put_setting(ctx.project, "writer.pick", "off")
        if not pick_off.get("ok"):
            problems.append(f"could not turn writer.pick off: {json.dumps(pick_off)[:200]}")
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
        put_setting(ctx.project, "writer.pick", "on")  # reset refuses a non-catalog key; "on" is the default
        back = put_setting(ctx.project, key, original)
        now = hubsql(f"select value from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='{key}';")
        restored = (json.loads(now[0]["value"]) if now else None) == original
        if not restored:
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


STAND_DOOR = """import http.server, sqlite3, sys, threading, time
port, db = int(sys.argv[1]), sys.argv[2]
if db != "-":
    con = sqlite3.connect(db)
    con.execute("pragma journal_mode=WAL"); con.execute("create table if not exists beats(n integer)")
    def beat():
        while True:
            con.execute("insert into beats values (1)"); con.commit(); time.sleep(0.05)
    threading.Thread(target=beat, daemon=True).start()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"v")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
"""

STAND_BOT = """import http.server, sys
log = open(sys.argv[2], "ab")
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); body = self.rfile.read(n)
        log.write(b"%s %s\\n" % (self.path.encode(), body)); log.flush()
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
"""


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _stand_up(state: Path, port: int, db: Path | None) -> list[str]:
    """A throwaway user service lp-drill-door serving /install/version (and, with db, committing a row a second into a WAL SQLite)."""
    (state / "stand_door.py").write_text(STAND_DOOR)
    unit = Path.home() / ".config/systemd/user/lp-drill-door.service"
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text(f"[Service]\nExecStart={sys.executable} {state / 'stand_door.py'} {port} {db or '-'}\nRestart=no\n")
    run(["systemctl", "--user", "daemon-reload"], timeout=30)
    rc, _, err = run(["systemctl", "--user", "restart", "lp-drill-door"], timeout=30)
    return [] if rc == 0 else [f"could not start the stand-in service: {err.strip()[:200]}"]


def _stand_down() -> None:
    run(["systemctl", "--user", "stop", "lp-drill-door"], timeout=30)
    (Path.home() / ".config/systemd/user/lp-drill-door.service").unlink(missing_ok=True)
    run(["systemctl", "--user", "daemon-reload"], timeout=30)


def _db_census(script: str, env: dict, db: Path) -> dict:
    """Rows committed in the stand-in database and what db-ready says of it."""
    rc, out, _ = run(["sqlite3", "-readonly", str(db), "select count(*) from beats;"], timeout=15)
    rows = int(out.strip()) if rc == 0 and out.strip().isdigit() else -1
    rc2, ready, _ = run(["bash", script, "db-ready"], env={**env, "LP_WATCH_DBS": str(db)}, timeout=30)
    return {"rows": rows, "ready": rc2 == 0 and "ready:" in ready}


def _watchdog_live(tmp: Path, with_bot: bool, census: bool) -> tuple[list[str], dict]:
    """The real (non-dry) watchdog against the stand-in service lp-drill-door: hang it with SIGSTOP so the process lives but the door is
    silent, let the watchdog declare, lift and see it rise; then read the record and the stand-in bot's posts. Never the real hub."""
    problems: list[str] = []
    state = tmp / "watchdog-live"
    state.mkdir(exist_ok=True)
    port, bot_port = free_port(), free_port()
    db = state / "stand.db" if census else None
    problems += _stand_up(state, port, db)
    if problems:
        _stand_down()
        return problems, {}
    bot = None
    tg_log = state / "tg-posts.log"
    tg_env = state / "tg.env"
    tg_env.write_text("TG_TOKEN=drill\nTG_CHAT=1\n")
    env = {**os.environ,
           "LP_WATCH_USER": "1", "LP_WATCH_SERVICE": "lp-drill-door",
           "LP_WATCH_DOOR": f"http://127.0.0.1:{port}/install/version",
           "LP_WATCH_STATE": str(state), "LP_WATCH_TG_ENV": str(tg_env),
           "LP_WATCH_TG_API": f"http://127.0.0.1:{bot_port}",
           "LP_WATCH_KNOCK_SEC": "1", "LP_WATCH_SUSPECT_AFTER": "2", "LP_WATCH_REFUSED_AFTER": "2",
           "LP_WATCH_FIRST_SEC": "0", "LP_WATCH_BB": "/nonexistent"}
    script = str(ROOT / "scripts" / "hub-watchdog.sh")
    proc = None
    try:
        if with_bot:
            (state / "stand_bot.py").write_text(STAND_BOT)
            bot = subprocess.Popen([sys.executable, str(state / "stand_bot.py"), str(bot_port), str(tg_log)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 30
        while time.time() < deadline:
            _, code, _ = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "2", f"http://127.0.0.1:{port}/install/version"], timeout=10)
            if code.strip() == "200":
                break
            time.sleep(0.5)
        else:
            _stand_down()
            return ["the stand-in door never answered"], {}
        _, pid, _ = run(["systemctl", "--user", "show", "-p", "MainPID", "--value", "lp-drill-door"], timeout=15)
        pid = pid.strip()
        census_before = _db_census(script, env, db) if db else None
        if not pid.isdigit() or int(pid) <= 1:  # 0 would signal the drill's own process group, 1 is init
            _stand_down()
            return [f"the stand-in service has no usable main pid (read {pid!r}); nothing was signalled"], {}
        os.kill(int(pid), signal.SIGSTOP)  # hung: the process lives, the door is silent
        proc = subprocess.Popen(["bash", script, "run"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log_path = state / "outages.jsonl"
        deadline = time.time() + 120
        events: list[str] = []
        while time.time() < deadline:
            if log_path.exists():
                events = [json.loads(line).get("event") for line in log_path.read_text().splitlines() if line.strip()]
                if "risen" in events or "out_of_tries" in events:
                    break
            time.sleep(2)
        details = {"events": events, "pid": pid}
        rows = [json.loads(line) for line in log_path.read_text().splitlines() if line.strip()] if log_path.exists() else []
        if "outage" not in events:
            problems.append(f"no outage recorded for the hung stand-in: {events}")
        if not any(pid in (row.get("detail") or "") for row in rows if row.get("event") == "lift"):
            problems.append(f"no lift line names the killed pid {pid}")
        if "risen" not in events and "lift_without_outcome" not in events:
            problems.append("the lift's own lines are missing after the kill")
        if db is not None:
            census_after = _db_census(script, env, db)
            details["census"] = {"before": census_before, "after": census_after}
            if census_before and census_after["rows"] < census_before["rows"]:
                problems.append(f"the census shrank over the kill: {census_before} -> {census_after}")
            if not census_after["ready"]:
                problems.append("db-ready does not call the stand-in database ready after the kill")
        if with_bot:
            posts = tg_log.read_text().splitlines() if tg_log.exists() else []
            details["posts"] = posts
            if len(posts) != 2:
                problems.append(f"the stand-in bot got {len(posts)} posts, expected 2 (the fall and the return)")
        return problems, details
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if bot:
            bot.terminate()
        _stand_down()


def scenario_outage_live(tmp: Path) -> dict:
    """Outage drill, live (SMA: Outage drill): a real stand-in daemon is killed (hung, then SIGKILLed by the lift) and the fall, the lift,
    the return and both messages land — the messages on a stand-in bot (LP_WATCH_TG_API), never on telegram.org. The scenario refuses to
    drive any service but its own stand-in unit."""
    named = os.environ.get("LP_WATCH_SERVICE", "lp-drill-door")
    if named != "lp-drill-door":
        return {"name": "outage_live", "result": "skipped", "problems": [],
                "note": f"refuses to run a non-dry watchdog against {named}: only its own stand-in unit lp-drill-door may be killed"}
    if os.environ.get("LP_DRILL_WATCHDOG_LIVE") != "1":
        return {"name": "outage_live", "result": "skipped", "problems": [], "note": "the live pass writes a user unit and hangs a stand-in process: it runs only with LP_DRILL_WATCHDOG_LIVE=1"}
    problems, details = _watchdog_live(tmp, with_bot=True, census=False)
    return verdict("outage_live", problems, **details)


def scenario_watchdog(tmp: Path) -> dict:
    """Outage and lift drills (SMA: Outage drill, Lift drill, Day rotation drill): the hub watchdog against a door that never answers
    records the outage and a (dry) lift; against a door that answers, a lift does nothing; an old log rotates to its day. The live pass
    runs the real lift against a hung stand-in service and counts the stand-in database's rows before and after the kill."""
    state = tmp / "watchdog"
    state.mkdir()
    env = {**os.environ, "LP_WATCH_STATE": str(state), "LP_WATCH_DRY": "1", "LP_WATCH_TG_ENV": "/nonexistent", "LP_WATCH_KNOCK_SEC": "1", "LP_WATCH_SUSPECT_AFTER": "2", "LP_WATCH_FIRST_SEC": "0", "LP_WATCH_BB": "/nonexistent"}
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
    if os.environ.get("LP_DRILL_WATCHDOG_LIVE") == "1" and shutil.which("systemctl"):
        live_problems, live = _watchdog_live(tmp, with_bot=False, census=True)
        problems += live_problems
    else:
        live = {"note": "live pass off (it runs only with LP_DRILL_WATCHDOG_LIVE=1) or no systemd --user here"}
    return verdict("watchdog", problems, events=events, live=live)


def owner_words(ctx: "Context", value: str) -> tuple[object, int]:
    saved = hubsql(f"select value, version from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='owner.words';")
    original, version = (json.loads(saved[0]["value"]), int(saved[0]["version"])) if saved else (None, 0)
    changed = setting_rpc("save_setting", {"projectId": ctx.project, "key": "owner.words", "value": value, "expectedVersion": version})
    if not changed.get("ok") and changed.get("conflict"):
        version = int(changed.get("version") or 0)
        changed = setting_rpc("save_setting", {"projectId": ctx.project, "key": "owner.words", "value": value, "expectedVersion": version})
    return original, int(changed["version"])


def restore_owner_words(ctx: "Context", original: object, version: int) -> list[str]:
    """Puts owner.words back after the live word drill and says so when it could not. The key is not a catalog setting, so
    reset_project_settings refuses it (silently, as ok:false): live 2026-10-27 the drill left it «on» and every later task, phase and the
    reload task waited six hours for the owner's word. The sandbox project's own value is «off»; a stale «on» is a leftover of an earlier drill, not a choice."""
    value = original if isinstance(original, str) and original != "on" else "off"
    saved = setting_rpc("save_setting", {"projectId": ctx.project, "key": "owner.words", "value": value, "expectedVersion": version})
    if not saved.get("ok") and saved.get("conflict"):
        saved = setting_rpc("save_setting", {"projectId": ctx.project, "key": "owner.words", "value": value, "expectedVersion": int(saved.get("version") or 0)})
    return [] if saved.get("ok") else [f"could not put owner.words back to {value}: {saved}"]


def clear_stale_owner_words(ctx: "Context") -> list[str]:
    """Before the scenarios: the sandbox project runs the machine path without the owner, so its owner.words is «off» in so many words.
    Unset means on since 2026-10-29 (src/rooms/tasks/words.ts), and a leftover «on» of an earlier drill made every task wait for the owner."""
    saved = hubsql(f"select value, version from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='owner.words';")
    if saved and json.loads(saved[0]["value"]) == "off":
        return []
    log("owner.words of the sandbox project is not off: setting it to off")
    return restore_owner_words(ctx, "off", int(saved[0]["version"]) if saved else 0)


def window_url() -> str | None:
    """The window the scenes open: the address named in LP_DRILL_UI_URL, None when no window is named. The hub's own port
    (BB_SERVER_URL) is not a window: BB answers 403 to a browser's navigation there (checked on the hub on 2026-11-11), so a
    press needs an address a signed-in browser may open."""
    base = os.environ.get("LP_DRILL_UI_URL", "").strip()
    return base.rstrip("/") + "/" if base else None


def live_word_scene(run_id: str) -> dict:
    """The scene lp-ui-drive plays for the approve press (SMA m_sd_approve): open the owner-waiting board (scope-nav-waiting) and
    click the yes button of this drill's own task. The button's test id carries the item key `task-word:<run>:<family>:...`, so
    tying the selector to the run id keeps the press off a real project's task on the same board."""
    return {"url": window_url() or "http://127.0.0.1:4173/", "widths": [1280],
            "steps": [{"wait": 1500}, {"click": '[data-testid="scope-nav-waiting"]'}, {"wait": 1000},
                      {"click": f'[data-testid^="owner-run-task-word:{run_id}:"][data-testid$="-yes"]'}],
            "asserts": [], "judge": "The owner's word landed the task."}


def live_press() -> bool:
    """The approve press through the window runs wherever a window is named (LP_DRILL_UI_URL), with no second switch;
    LP_DRILL_LIVE_PRESS=1 asks for it on the dev-window default, =0 opts out and leaves the RPC word path."""
    asked = os.environ.get("LP_DRILL_LIVE_PRESS", "")
    return asked != "0" and (asked == "1" or window_url() is not None)


def scenario_live_word(ctx: "Context") -> dict:
    """Live word drill (SMA: Live word drill, Approval drill): with owner.words on, a verified task waits for the owner's word, and lands once
    the word is given (here through the task_word RPC, the path of the screen and the CLI). Where a window is named
    (LP_DRILL_UI_URL) the word is a real press of the Approve button (LP_DRILL_LIVE_PRESS=0 opts out), and a task whose check
    fails ends blocked, offers no owner item, and an RPC yes does not land it. A window that does not open (no browser, a
    refused page) skips the press, says why in the note, and the word goes through the RPC, as without the press."""
    live = live_press()
    original, version = owner_words(ctx, "on")
    problems: list[str] = []
    press_note = ""
    row: dict = {}
    red_row: dict = {}
    try:
        spec = note_task(f"drill-word-{STAMP}", f"drills/word-{STAMP}.md", "owner word", ctx.cwd)
        specs = [spec]
        red: dict = {}
        if live:
            red = note_task(f"drill-word-red-{STAMP}", f"drills/word-red-{STAMP}.md", "owner word red", ctx.cwd)
            red["verification"] = [{"command": "exit 1", "cwd": ctx.cwd}]
            specs.append(red)
        if live:
            with ThreadPoolExecutor(2) as pool:
                sent = list(pool.map(ctx.dispatch, specs))
            if not all(sent):
                problems.append("a dispatch-bb call exited with an error")
        elif not ctx.dispatch(spec):
            problems.append("dispatch-bb exited with an error")
        deadline, waiting = time.time() + 15 * 60, False
        while time.time() < deadline and not waiting:
            waiting = "waits for the owner's word before it lands" in thread_text(ctx.pm)
            if not waiting:
                time.sleep(POLL_SEC)
        if not waiting:
            problems.append("the verified task never said it waits for the owner's word")
        elif live:
            scene = ctx.tmp / f"approve-{STAMP}.json"
            scene.write_text(json.dumps(live_word_scene(ctx.run_id)))
            rc, out, err = run(["node", str(ROOT / "scripts" / "lp-ui-drive.mjs"), str(scene)], timeout=300)
            if rc == 2:
                press_note = f"press skipped, the window did not open: {(err or out).strip()[:160]}"
                setting_rpc("task_word", {"runId": ctx.run_id, "taskId": spec["id"], "decision": "yes", "text": "да"})
            elif rc != 0:
                problems.append(f"the approve press through the window failed (exit {rc}): {(err or out).strip()[:300]}")
        else:
            setting_rpc("task_word", {"runId": ctx.run_id, "taskId": spec["id"], "decision": "yes", "text": "да"})
        rows = ctx.wait_ended([spec["id"]])
        row = summarize(rows, spec["id"], ctx.cwd, spec["expected_outputs"][0])
        if row["state"] != "accepted":
            problems.append(f"the task did not land after the word: {row['states']} {row['reason']}")
        if live:
            rows = ctx.wait_ended([red["id"]])
            red_row = summarize(rows, red["id"], ctx.cwd, red["expected_outputs"][0])
            if red_row["state"] == "accepted":
                problems.append("a task whose check failed was accepted without a word")
            red_items = hubsql(f"select count(*) as n from lane_pilot_owner_item where state='open' and key like '%{red['id']}%';")
            if red_items and red_items[0]["n"]:
                problems.append("the red task offered an owner item anyway")
            try:
                setting_rpc("task_word", {"runId": ctx.run_id, "taskId": red["id"], "decision": "yes", "text": "да"})
            except Exception:
                pass
            time.sleep(POLL_SEC)
            if latest_states(ctx.rows([red["id"]])).get(red["id"]) == "accepted":
                problems.append("an RPC yes landed the red task")
    finally:
        problems.extend(restore_owner_words(ctx, original, version))
    return verdict("live_word", problems, tasks=[t for t in (row, red_row) if t], **({"note": press_note} if press_note else {}))


def tasks_no_code_exit(cwd: str, series: bool = False) -> list[dict]:
    """The no-code tasks. The owner's question always; under --series (SMA m_sd_answer) also answer-only research and code work
    told to change nothing."""
    path = f"drills/needs-human-{STAMP}.md"
    question = task(f"drill-human-{STAMP}", "a question for the owner", [path],
                    f"Do not create or change any file. Your whole final report is one line: `NEEDS_HUMAN: which colour should {path} use?`",
                    [f"{path} exists"], cwd)
    if not series:
        return [question]
    answer = task(f"drill-answer-{STAMP}", "one question, no files", ["the answer in the writer's report"],
                  "Answer one question in your report and change no file: which stage closes a task that only asks? Say it in one line.",
                  ["the report answers the question"], cwd)
    answer["kind"] = "research"
    code = task(f"drill-noedit-{STAMP}", "a fix told to change nothing", [f"drills/noedit-{STAMP}.md"],
                f"The contract's output is drills/noedit-{STAMP}.md, but change nothing: create or edit no file. Report the task done anyway.",
                [f"drills/noedit-{STAMP}.md exists"], cwd)
    code["kind"] = "fix"
    return [question, answer, code]


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


def scenario_phase(ctx: "Context") -> dict:
    """A phase carried to its verification by the machine's own stages: opened with a goal of two notes and nothing reported by hand —
    lp.analyze signs the context, lp.plan plans and its critic approves, the driver issues the pieces, and the phase reaches
    verification. (The plan gate asks for an independent lp.plan run, an objective and a pre-mortem, so a plan reported by the drill
    under its own name is refused: the scene that did so could no longer pass.) LP_DRILL_PHASE_UNTIL=acceptance waits one stage
    further, so the verification stage itself runs."""
    problems: list[str] = []
    act = lambda action, phase_id=None, **payload: setting_rpc("phase_act", {"action": action, "projectId": ctx.project, "pmThreadId": ctx.pm, **({"phaseId": phase_id} if phase_id else {}), "payload": payload})
    stages = ("verification", "acceptance", "lessons", "closed")
    reached = stages[stages.index(os.environ.get("LP_DRILL_PHASE_UNTIL", "verification")):] if os.environ.get("LP_DRILL_PHASE_UNTIL", "verification") in stages else stages
    opened = act("open", title=f"Drill phase {STAMP}",
                 goal=f"Two new files exist in the repository: drills/phase-{STAMP}-1.md whose first line is '# phase {STAMP} 1', and drills/phase-{STAMP}-2.md whose first line is '# phase {STAMP} 2'.")
    phase_id = opened["phase"]["id"]
    snap: dict = {}
    try:
        # Analysis, plan, the writers and an lp.review per wave: the phase gets its own limit (live 2026-10-27: 20 minutes left it 7 s short).
        deadline, snap = time.time() + max(TIMEOUT_MIN, PHASE_TIMEOUT_MIN) * 60, route_snapshot(phase_id)
        while time.time() < deadline and snap["stage"] not in reached:
            time.sleep(POLL_SEC)
            snap = route_snapshot(phase_id)
        problems += route_problems(snap["book"], snap["stage"])
        if snap["stage"] not in reached:
            problems.append(f"the phase did not reach {reached[0]}: it is at {snap['stage']} ({snap['state']})")
        if not any(kind == "admitted" for kind, _ in book_parts(snap["book"])):
            problems.append("the book has no admitted plan")
    finally:
        setting_rpc("phase_control", {"phaseId": phase_id, "action": "close", "note": "drill done"})
    return verdict("phase", problems, phaseId=phase_id, stage=snap.get("stage"), autoStarted=snap.get("auto_started"), issued=snap.get("issued"))


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


def skills_screen_problems(report: dict) -> list[str]:
    """Window, door and disk (SMA m_sd_skills): the door lists the skill catalog, the window lists skills or explains the empty
    list, every skill file on disk survives the press, and the press narrows what a role may load."""
    problems: list[str] = []
    door = report.get("door") or {}
    if not door.get("catalog"):
        problems.append("the door (agent-access view) listed no skills")
    window = report.get("window") or {}
    if not window.get("listed") and not window.get("emptyExplained"):
        problems.append("the window showed neither skills nor the empty-list explanation")
    before, after = report.get("diskBefore") or {}, report.get("diskAfter") or {}
    changed = [path for path in set(before) | set(after) if before.get(path) != after.get(path)]
    if changed:
        problems.append(f"skill files changed after the press: {', '.join(changed[:5])}")
    if door.get("catalog") and not door.get("narrowed"):
        problems.append("the door view showed no change after a skill was removed")
    return problems


def access_skill_count(view: object) -> tuple[int, int]:
    """(skills in the catalog, skills the roles load together): a role whose skill list is open (names null) loads the whole catalog."""
    view = view if isinstance(view, dict) else {}
    catalog = len((view.get("catalog") or {}).get("skills") or [])
    loaded = 0
    for role in view.get("roles") or []:
        names = (((role or {}).get("groups") or {}).get("skills") or {}).get("names")
        loaded += catalog if names is None else len(names)
    return catalog, loaded


def access_page_url(project: str) -> str | None:
    """The window's access page of one project: LP_DRILL_UI_ACCESS_URL with `{project}` when it is set, else the team's access
    tab of the Lane Pilot page on the named window (`<LP_DRILL_UI_URL>/plugins/lane-pilot/lane-pilot/<project>/access`); None when
    no window is named. The project is always in the address: a press on the window root could change a real project."""
    template = os.environ.get("LP_DRILL_UI_ACCESS_URL", "")
    if "{project}" in template:
        return template.replace("{project}", project)
    window = window_url()
    return f"{window}plugins/lane-pilot/lane-pilot/{project}/access" if window else None


def restore_access_roles(project: str, before: list[dict]) -> list[str]:
    """Put every role's access row back to what it was (a row that did not exist is removed): the press must leave no trace."""
    problems: list[str] = []
    try:
        now = {r.get("key"): r for r in (setting_rpc("helper_access_view", {"projectId": project}).get("roles") or [])}
    except Exception as cause:
        return [f"could not read the access roles to restore them: {str(cause)[:160]}"]
    for role in before:
        current = now.get(role.get("key"))
        if current is None or (current.get("value") == role.get("value") and current.get("version") == role.get("version")):
            continue
        try:
            # A row that did not exist is removed (a stored null would hide the level below).
            if role.get("value") is None:
                saved = setting_rpc("reset_project_settings", {"projectId": project, "keys": [role["key"]], "expectedVersions": {role["key"]: current.get("version", 0)}})
            else:
                saved = setting_rpc("save_setting", {"projectId": project, "key": role["key"], "value": role.get("value"), "expectedVersion": current.get("version", 0)})
            if not saved.get("ok"):
                problems.append(f"could not restore {role['key']}: {saved}")
        except Exception as cause:
            problems.append(f"could not restore {role['key']}: {str(cause)[:160]}")
    return problems


def scenario_skills_screen(ctx: "Context") -> dict:
    """Skills screen drill (SMA m_sd_skills): the skills screen at the window, the door and on disk — an empty list is
    explained, and pressing the panel does not touch the files. The window is opened on the access page of the drill's own project
    (access_page_url: LP_DRILL_UI_ACCESS_URL, else the page's own address on the window named in LP_DRILL_UI_URL); with no
    window named nothing is clicked and the scene is reported «not run». The access rows are read first and put back in a `finally`."""
    url = access_page_url(ctx.project)
    if url is None:
        return {"name": "skills_screen", "result": "skipped", "problems": [],
                "note": f"not run: no window is named (LP_DRILL_UI_URL, or LP_DRILL_UI_ACCESS_URL with {{project}}), so no press was made on {ctx.project}"}
    report: dict = {"door": {}, "window": {}, "diskBefore": {}, "diskAfter": {}}
    problems: list[str] = []
    skills_dir = Path(ctx.cwd) / ".agents" / "skills"

    def hashes() -> dict:
        return {str(p.relative_to(skills_dir)): sha256_of(p.read_bytes()) for p in sorted(skills_dir.rglob("*")) if p.is_file()} if skills_dir.is_dir() else {}

    report["diskBefore"] = hashes()
    try:
        view = setting_rpc("helper_access_view", {"projectId": ctx.project})
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return {"name": "skills_screen", "result": "skipped", "problems": [], "note": f"not run: the access view is not deployed: {str(cause)[:160]}"}
        return verdict("skills_screen", [f"the door view could not be read: {str(cause)[:200]}"])
    catalog, loaded = access_skill_count(view)
    report["door"] = {"catalog": catalog, "loaded": loaded}
    roles_before = [dict(role) for role in (view.get("roles") or [])]
    try:
        if catalog:
            scene = ctx.tmp / f"skills-{STAMP}.json"
            scene.write_text(json.dumps({"url": url, "widths": [1280],
                                         "steps": [{"wait": 1500}, {"click": '[data-testid*="skill"] >> nth=0'}, {"wait": 500}, {"click": "text=Сохранить"}],
                                         "asserts": [], "judge": "The skills list is shown or the empty-list explanation is."}))
            rc, out, err = run(["node", str(ROOT / "scripts" / "lp-ui-drive.mjs"), str(scene)], timeout=300)
            report["window"] = {"listed": rc == 0, "emptyExplained": "empty" in (out + err).lower() or "пуст" in (out + err).lower()}
            if rc == 2:
                report["window"]["error"] = (err or out).strip()[:200]
            try:
                _, again = access_skill_count(setting_rpc("helper_access_view", {"projectId": ctx.project}))
                report["door"]["loadedAfter"] = again
                report["door"]["narrowed"] = again < loaded
            except Exception as cause:
                problems.append(f"the door view could not be read after the press: {str(cause)[:160]}")
    finally:
        problems += restore_access_roles(ctx.project, roles_before)
    report["diskAfter"] = hashes()
    problems += skills_screen_problems(report)
    return verdict("skills_screen", problems, door=report["door"], window=report["window"], diskChanged=[p for p in set(report["diskBefore"]) | set(report["diskAfter"]) if report["diskBefore"].get(p) != report["diskAfter"].get(p)])


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
# Lane Pilot's own guard (guard-apply.ts GUARD_RELATIVE_PATH); ~/.agents/hooks was Claude Lane's and is moved aside (2026-10-30).


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
            return (Path(machine["home"]) / ".agents/lane-pilot/pm" / name).read_bytes(), None
        except FileNotFoundError:
            return None, "missing"
        except OSError as cause:
            return None, str(cause)
    if kind == "bb":
        rc, out, err = bb("file", "read", "--host", machine["host"], f"{machine['home']}/.agents/lane-pilot/pm/{name}", "--json", timeout=60)
        if rc == 0:
            try:
                return str(json.loads(out)["content"]).encode(), None
            except (ValueError, KeyError, TypeError):
                return None, f"unreadable answer: {out[:120]}"
        text = (err + out).lower()
        return None, "missing" if any(word in text for word in GONE) else (err or out).strip()[:200] or f"exit {rc}"
    rc, out, err = run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", machine["host"], f"cat ~/.agents/lane-pilot/pm/{name}"], timeout=60)
    if rc == 0:
        return out.encode(), None
    if rc != 255 and any(word in err.lower() for word in GONE):
        return None, "missing"
    return None, err.strip()[:200] or f"exit {rc}"


def guard_install_command(machine: dict, name: str) -> str:
    src = GUARD_REPO / name
    if machine["kind"] == "local":
        dest = f"{machine['home']}/.agents/lane-pilot/pm/{name}"
        return f"cp -p {dest} {dest}.bak-{DATE}; install -m 755 {src} {dest}"
    if machine["kind"] == "bb":
        return f"bb file write --host {machine['host']} --stdin --create-parents {machine['home']}/.agents/lane-pilot/pm/{name} < {src}"
    return f"scp {src} {machine['host']}:.agents/lane-pilot/pm/{name} && ssh {machine['host']} chmod 755 .agents/lane-pilot/pm/{name}"


def guard_install(machine: dict, name: str) -> str | None:
    """Puts the repository's file on the machine (the old one is kept as .bak-<date>); None when done, the reason when not."""
    data = (GUARD_REPO / name).read_bytes()
    if machine["kind"] == "local":
        dest = Path(machine["home"]) / ".agents/lane-pilot/pm" / name
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
        path = f"{machine['home']}/.agents/lane-pilot/pm/{name}"
        done = subprocess.run([BB, "file", "write", "--host", machine["host"], "--stdin", "--create-parents", path, "--json"], input=data.decode(), capture_output=True, text=True, timeout=90)
        return None if done.returncode == 0 else (done.stderr or done.stdout).strip()[:200]
    host = machine["host"]
    done = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, f"mkdir -p ~/.agents/lane-pilot/pm && cd ~/.agents/lane-pilot/pm && [ ! -e {name} ] || cp -p {name} {name}.bak-{DATE}; cat > .{name}.tmp && chmod 755 .{name}.tmp && mv .{name}.tmp {name}"],
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
    or holds closed, fails the drill. Only a term an owner's message named can pass: an entry without one is «open, no term» and never overdue."""
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
                        f"or take a new date from the owner (bb lane-pilot defer {item['id']} --owner-msg <threadId>#<seq>)")
    for ref in data.get("badRefs", []):
        why = "is not in the register" if ref["problem"] == "unknown" else "is closed, so the skip it excuses is no longer deferred (run the test or remove the skip)"
        problems.append(f"a skipped test cites deferral:{ref['id']}, which {why}")
    counts = data.get("counts", {})
    return verdict("deferrals", problems, registerDeployed=True, counts=counts, cited=len(cited), needsOwnerTerm=len(data.get("needsOwnerTerm", [])))


def scenario_lead_shadow(tmp: Path) -> dict:
    """The lead («Штурман») in shadow (roadmap WP3/WP4 acceptance): the running plugin answers lead_state; the drill never switches
    lead.enabled on, so no tick runs by itself here; no class decides without an exam row or a policy start at decides, and money / external stay owner_only;
    the CLI's status, rights, exam and road read the same rows without an error. A tick's own run needs an agent and is checked on the live hub."""
    try:
        state = setting_rpc("lead_state", {})
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return verdict("lead_shadow", [], leadDeployed=False, note=f"the running plugin has no lead yet: {str(cause)[:160]}")
        return verdict("lead_shadow", [f"lead_state failed: {str(cause)[:200]}"])
    problems: list[str] = []
    rights = state.get("rights") or []
    tiers = {row.get("class"): row.get("tier") for row in rights}
    if len(rights) < 7:
        problems.append(f"the rights table lists {len(rights)} classes, the policy has 7")
    for row in rights:
        # Policy v2 (owner's word 2026-11-02) starts the safe classes at decides; a class may decide without an exam only
        # when the policy file starts it there — the exam alone must not open one the file keeps at proposes.
        if row.get("tier") == "decides" and not row.get("exam") and row.get("start") != "decides":
            problems.append(f"class {row.get('class')} decides without an exam row behind it or a policy start at decides")
    for cls in ("money", "external"):
        if tiers.get(cls) != "owner_only":
            problems.append(f"class {cls} is {tiers.get(cls)}, the policy keeps it owner_only")
    for args in (("status",), ("rights",), ("exam",), ("road", "--tree", "--history"), ("ticks",)):
        rc, out, err = bb("lane-pilot", "lead", *args)
        if rc != 0:
            problems.append(f"bb lane-pilot lead {' '.join(args)} exited {rc}: {(err or out).strip()[:160]}")
    settings = state.get("settings") or {}
    return verdict("lead_shadow", problems, leadDeployed=True, enabled=bool(settings.get("enabled")), tickCron=settings.get("tickCron"),
                   ticks=len(state.get("ticks") or []), proposalsOpen=state.get("proposalsOpen"), journal=state.get("journal"), tiers=tiers)


def scenario_episodes(tmp: Path) -> dict:
    """Errand episodes (stage 1 R1/R3/R5/R7): every errand run that ended after the episodes shipped has its episode row (the recorder
    hangs off the engine's onEvent, so a missing row is a dropped hook); a done run carries a parsed `verified`; the sweep moves rows out
    of pending within two hours; the diagnosis command answers. Reads the live hub, starts nothing."""
    try:
        first = hubsql("SELECT MIN(created_at) AS at FROM lane_pilot_errand_episode")
    except RuntimeError as cause:
        if "no such table" in str(cause):
            return verdict("episodes", [], episodesDeployed=False, note="the running plugin has no episode table yet")
        return verdict("episodes", [f"hub query failed: {str(cause)[:200]}"])
    since = (first[0] or {}).get("at") if first else None
    if not since:
        return verdict("episodes", [], episodesDeployed=True, note="no episode written yet: no errand ended since the deploy")
    problems: list[str] = []
    missing = hubsql(f"""SELECT r.id FROM lane_pilot_wf_run r WHERE r.workflow_id='errand' AND r.status IN
        ('succeeded','failed','canceled','blocked','interrupted','not_verified') AND r.updated_at >= {int(since)}
        AND NOT EXISTS (SELECT 1 FROM lane_pilot_errand_episode e WHERE e.run_id=r.id) LIMIT 5""")
    if missing:
        problems.append(f"{len(missing)}+ ended errand runs have no episode, e.g. {missing[0].get('id')}")
    # Recent = the errand RUN started after the first episode row and within 3 days: a backfilled row is new but its run predates
    # the `CHECK:` lines, so it has no verdict to parse. A pending row is stale only when the sweep enriched nothing for 2 h — a
    # backfill queues 100+ rows that the 10-per-hour sweep takes hours to clear.
    counts = hubsql(f"""SELECT COUNT(*) AS n,
        SUM(e.outcome='done' AND e.verified IS NULL AND r.created_at >= {int(since)} AND r.created_at > strftime('%s','now','-3 days')*1000) AS doneNoVerdict,
        SUM(e.enrichment_state='pending' AND e.created_at < (strftime('%s','now')-7200)*1000) AS stalePending,
        (SELECT COUNT(*) FROM lane_pilot_errand_episode WHERE enriched_at > (strftime('%s','now')-7200)*1000) AS enrichedRecently,
        SUM(e.enrichment_state='held') AS held
        FROM lane_pilot_errand_episode e LEFT JOIN lane_pilot_wf_run r ON r.id=e.run_id""")[0]
    if counts.get("doneNoVerdict"):
        problems.append(f"{counts['doneNoVerdict']} recent done episodes have no parsed verified outcome")
    if counts.get("stalePending") and not counts.get("enrichedRecently"):
        problems.append(f"{counts['stalePending']} episodes stayed pending for over 2 h: the sweep lp.episodes is not running")
    rc, out, err = bb("lane-pilot", "errands", "diagnose", "--json")
    if rc != 0:
        problems.append(f"bb lane-pilot errands diagnose exited {rc}: {(err or out).strip()[:160]}")
    return verdict("episodes", problems, episodesDeployed=True, episodes=counts.get("n"), held=counts.get("held"), since=since)


def scenario_memory_thread(tmp: Path) -> dict:
    """M2: every ordinary BB thread of the project gets the L1 memory block (contributeInstructions); the drill reads the same
    block over the plugin RPC. A core fact written through the one door must be in it, another project's must not, and a PM
    thread gets nothing (its own resume block stays). Reads and writes the sandbox project only; the fact is deleted after."""
    project = SANDBOX["project"]
    thread = "drill-memory-thread"
    try:
        block = setting_rpc("memory_thread_block", {"projectId": project, "threadId": thread}).get("block")
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return verdict("memory_thread", [], deployed=False, note=f"the running plugin has no memory_thread_block yet: {str(cause)[:160]}")
        return verdict("memory_thread", [f"memory_thread_block failed: {str(cause)[:200]}"])
    problems: list[str] = []
    record_id = None
    try:
        if block is None:
            problems.append("an ordinary thread got no memory block")
        else:
            if len(block) > 1200:
                problems.append(f"the block is {len(block)} chars, over the 1200 cap")
            for needle in ("lane-memory search", "lane-memory write", "не в файлы"):
                if needle not in block:
                    problems.append(f"the block misses «{needle}»")
        token = f"drill-memory-{STAMP}"
        wrote = setting_rpc("session_memory_write", {"projectId": project, "kind": "core", "source": "drill",
                                                   "content": f"Drill fact {token}: the sandbox keeps one memory.", "concepts": ["drill"]})
        record_id = wrote.get("id")
        if not wrote.get("stored") and not record_id:
            problems.append(f"the drill fact was not stored: {wrote.get('reason')}")
        else:
            again = setting_rpc("memory_thread_block", {"projectId": project, "threadId": thread}).get("block") or ""
            if token not in again:
                problems.append("a core fact written through the door is not in the thread block")
            other = next((row["project_id"] for row in hubsql("select distinct project_id from lane_pilot_run limit 50") if row["project_id"] != project), None)
            if other:
                foreign = setting_rpc("memory_thread_block", {"projectId": other, "threadId": thread}).get("block") or ""
                if token in foreign:
                    problems.append("the block of another project carries this project's fact")
        pm = hubsql(f"select pm_thread_id as t from lane_pilot_run where project_id='{project}' and pm_thread_id is not null order by created_at desc limit 1")
        if pm:
            got = setting_rpc("memory_thread_block", {"projectId": project, "threadId": pm[0]["t"]}).get("block")
            if got is not None:
                problems.append("a PM thread got the ordinary-thread memory block")
    finally:
        if record_id:
            try:
                setting_rpc("memory_record_delete", {"projectId": project, "id": record_id})
            except Exception as cause:
                log(f"drill fact {record_id} was not deleted: {str(cause)[:160]}")
    return verdict("memory_thread", problems, deployed=True, chars=len(block or ""), fact=bool(record_id))


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


# --- main ---------------------------------------------------------------------------------------------------------------

def dry_run(names: list[str], series: bool = False) -> None:
    print(f"drill {STAMP} in {SANDBOX['project']} ({SANDBOX['cwd']}), no-git {NOGIT['project']} ({NOGIT['cwd']}), hub db {HUB}:{HUB_DB}; scenarios: {', '.join(names)}")
    if "parallel3" in names:
        for spec in tasks_parallel3(SANDBOX["cwd"]):
            print(json.dumps(spec))
    cwd = SANDBOX["cwd"]
    documents = {"memory_paths": [task_memory(cwd)], "conflict": tasks_conflict(cwd), "main_moved": [task_moved(cwd)], "provider": [task_provider(cwd)], "provider_limit": [task_limit(cwd)], "reload": [task_reload(cwd)], "nogit": [task_nogit(NOGIT["cwd"])], "nogit_repo": [task_nogit_repo(NOGIT["cwd"])]}
    expects: dict[str, dict] = {}
    # What a default run prints is main's. The additions belong to the scenes that are new (revert) and to the extended forms
    # of old ones (--series for no_code_exit, LP_DRILL_LIVE_PRESS=1 for live_word).
    documents["revert"] = [note_task(f"drill-{STAMP}-revert-a", f"notes/drill/{STAMP}-revert.md", f"Drill {STAMP} revert a", cwd), note_task(f"drill-{STAMP}-revert-b", f"notes/drill/{STAMP}-revert.md", f"Drill {STAMP} revert b", cwd)]
    expects["revert"] = {"scenario": "in EXTRA (by name or --series)", "judge": "revert_judged"}
    if series:
        documents["no_code_exit"] = tasks_no_code_exit(cwd, True)
        expects["no_code_exit"] = {f"drill-answer-{STAMP}": "accepted_first_attempt", f"drill-human-{STAMP}": "held_with_question", f"drill-noedit-{STAMP}": "not_accepted"}
    if live_press():
        documents["live_word"] = [note_task(f"drill-word-{STAMP}", f"drills/word-{STAMP}.md", "owner word", cwd), note_task(f"drill-word-red-{STAMP}", f"drills/word-red-{STAMP}.md", "owner word red", cwd)]
        expects["live_word"] = {"green": f"drill-word-{STAMP}: accepted after the yes button click", "red": f"drill-word-red-{STAMP}: blocked, no owner item"}
    for name in names:
        for spec in documents.get(name, []):
            print(f"scenario {name}: {json.dumps(spec)}")
        if name in expects:
            print(f"expects {name}: {json.dumps(expects[name])}")
        if name == "live_word" and live_press():
            print(f"scene live_word: {json.dumps(live_word_scene('<run id>'))}")


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


TOKEN_BUDGET = int(os.environ.get("LP_DRILL_TOKEN_BUDGET", "2000000"))
ACCEPTED_FLOOR = 0.5


def series_metrics(scenes: list[dict], receipts_dir: Path) -> dict:
    """The metrics suite (SMA rl_metrics): judges this series' archive last. A scene without evidence, a live attempt whose
    cost is not_measured, an accepted share under the floor, tokens over LP_DRILL_TOKEN_BUDGET, or coverage --receipt red
    fails the series."""
    problems: list[str] = []
    receipts: list[dict] = []
    for scene in scenes:
        if scene["name"].startswith("vitest:"):
            # A story file leaves no drill receipt: its exit code is the whole verdict.
            if scene.get("exit") != 0:
                problems.append(f"scene {scene['name']} exited {scene.get('exit')}")
            continue
        path = scene.get("receipt")
        data = None
        if path:
            try:
                data = json.loads(Path(path).read_text())
            except (OSError, ValueError):
                data = None
        if data is None:
            problems.append(f"scene {scene['name']} has no readable receipt")
        else:
            receipts.append({"name": scene["name"], "data": data})
        if scene.get("exit") != 0:
            problems.append(f"scene {scene['name']} exited {scene.get('exit')}")
        if data is not None and not data.get("seen") and not data.get("judged"):
            problems.append(f"scene {scene['name']} left no evidence")
    accepted = sum(1 for row in receipts for s in (row["data"].get("scenarios") or []) if s.get("result") == "pass")
    total = sum(1 for row in receipts for s in (row["data"].get("scenarios") or []) if s.get("result") != "skipped")
    if total and accepted / total < ACCEPTED_FLOOR:
        problems.append(f"only {accepted}/{total} scenario verdicts are green, under the {ACCEPTED_FLOOR} floor")
    try:
        metrics = setting_rpc("lp_attempt_metrics", {"projectId": SANDBOX["project"], "days": 1})
        attempts = metrics.get("attempts") or metrics.get("rows") or []
        live_names = {scene["name"] for scene in scenes}
        unmeasured = [row for row in attempts if row.get("costState") == "not_measured" or row.get("cost_state") == "not_measured"]
        tokens = metrics.get("totals", {}).get("tokens") or metrics.get("tokens") or 0
        if tokens and tokens > TOKEN_BUDGET:
            problems.append(f"the series spent {tokens} tokens, over LP_DRILL_TOKEN_BUDGET {TOKEN_BUDGET}")
        if len(unmeasured) > max(1, len(attempts) // 2):
            problems.append(f"{len(unmeasured)} live attempts have cost_state not_measured")
    except Exception as cause:
        if not RPC_MISSING.search(str(cause)):
            problems.append(f"attempt metrics could not be read: {str(cause)[:160]}")
    return {"suite": "metrics", "verdict": "pass" if not problems else "fail", "problems": problems, "scenes": len(scenes), "receipts": len(receipts)}


def scout() -> dict:
    """Scout of named suites (SMA rl_suites): every scenario_* in this file is named in ALL, EXTRA or BY_NAME (by name only, in no suite) and otherwise sits in exactly one suite,
    every name in ALL and EXTRA has its function, and every suite's scenario names are known. `vitest:` entries name a story file."""
    defined = sorted(name[len("scenario_"):] for name in globals() if name.startswith("scenario_"))
    members = [entry for entries in SUITES.values() for entry in entries if not entry.startswith("vitest:")]
    ungrouped = [name for name in defined if name not in members and name not in BY_NAME]
    regrouped = sorted({name for name in members if members.count(name) > 1})
    unknown = sorted({name for name in members if name not in ALL and name not in EXTRA})
    missing_files = [entry for entries in SUITES.values() for entry in entries if entry.startswith("vitest:") and not (ROOT / entry.split(":", 1)[1]).exists()]
    return {"defined": defined, "unlisted": [name for name in defined if name not in ALL and name not in EXTRA and name not in BY_NAME], "undefined": [name for name in ALL + EXTRA + BY_NAME if name not in defined],
            "suites": {name: entries for name, entries in SUITES.items()}, "ungrouped": ungrouped, "regrouped": regrouped, "unknown": unknown, "missingStories": missing_files,
            "empty": [name for name, entries in SUITES.items() if not entries and name != "metrics"]}


def series_preparation() -> dict:
    """Series preparation (SMA rl_prep): what the series runs against — the plugin version and commit, the scout, a clean
    sandbox — and the parts it refuses to start without: database, receipts, browser, limits, window. The SMA parts «accounts»
    and «person» are not probed: a login cannot be checked without a real provider call and the owner's presence cannot be read
    from the hub, so a probe for them could not fail; they are left out rather than kept as checks that always pass."""
    commit = git(str(ROOT), "rev-parse", "HEAD")
    version = json.loads((ROOT / "package.json").read_text()).get("version")
    dirty = git(SANDBOX["cwd"], "status", "--porcelain")
    checks, problems = [], []
    try:
        hubsql("select 1 as ok;")
        served = None
        rc, out, _ = run([BB, "plugin", "list", "--json"], timeout=60, env={**os.environ, "BB_CLI": ""})
        if rc == 0:
            served = next((p.get("version") for p in json.loads(out) if p.get("id") == "lane-pilot"), None)
        checks.append({"name": "database", "ok": served in (None, version), "detail": f"hub answers; plugin {served or '?'} vs {version}"})
        if served is not None and served != version:
            problems.append(f"database: the hub runs lane-pilot {served}, this checkout is {version}")
    except Exception as cause:
        checks.append({"name": "database", "ok": False, "detail": str(cause)[:200]})
        problems.append(f"database: {str(cause)[:200]}")
    receipt_dir = Path(os.environ.get("LP_DRILL_RECEIPT_DIR") or ROOT / ".agents/runs/drills")
    last = sorted(receipt_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:1] if receipt_dir.is_dir() else []
    receipts_ok = receipt_dir.is_dir() and os.access(receipt_dir, os.W_OK) and (not last or _parses(last[0]))
    checks.append({"name": "receipts", "ok": receipts_ok, "detail": f"{receipt_dir} writable, last receipt {'parses' if last and _parses(last[0]) else 'none yet'}"})
    if not receipts_ok:
        problems.append(f"receipts: {receipt_dir} is missing, unwritable or its last receipt does not parse")
    for name, probe in (("browser", _browser_probe), ("limits", _limits_probe), ("window", _window_probe)):
        try:
            ok, detail = probe()
        except Exception as cause:
            ok, detail = False, str(cause)[:200]
        checks.append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            problems.append(f"{name}: {detail}")
    # The coverage verdict (SMA rl_terms): an uncovered node without a term or the owner's word refuses the series.
    rc, out, err = bb("lane-pilot", "coverage", "--json", "--strict", timeout=120)
    try:
        answer = json.loads(out)
    except ValueError:
        answer = None
    # Anything but the command's own object is no verdict: the series does not start on a guess.
    coverage_gaps = list(answer.get("gaps") or []) if isinstance(answer, dict) else [f"coverage --json did not answer: {(err or out).strip()[:200]}"]
    return {"commit": commit, "version": version, "scout": scout(), "sandboxClean": not dirty.strip(), "checks": checks, "problems": problems, "coverageGaps": coverage_gaps}


def _parses(path: Path) -> bool:
    try:
        json.loads(path.read_text())
        return True
    except (OSError, ValueError):
        return False


def _browser_probe() -> tuple[bool, str]:
    """The sandbox project's browser machine answers: the sandbox host must be reachable for a browser_qa step."""
    rows = hubsql(f"select value from lane_pilot_project_settings where project_id='{SANDBOX['project']}' and binding_id='' and key='browser.hostId' limit 1;")
    if not rows:
        return True, "no browser machine named: browser checks would run on the writer host"
    return True, f"browser machine {json.loads(rows[0]['value'])}"


def _limits_probe() -> tuple[bool, str]:
    """No provider window already exhausted: cockpit_windows names the host's usage windows."""
    try:
        windows = setting_rpc("cockpit_windows", {"hostId": os.environ.get("LP_DRILL_HOST", "host_7sea4qaad8")})
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return True, f"window probe not deployed: {str(cause)[:120]}"
        return False, str(cause)[:200]
    text = json.dumps(windows)
    exhausted = bool(PROVIDER_QUOTA.search(text)) and "exhausted" in text.lower()
    return not exhausted, ("a provider window is exhausted" if exhausted else "no provider window exhausted")


def _window_probe() -> tuple[bool, str]:
    """The writer host of the sandbox is connected."""
    rc, out, err = bb("host", "list", "--json", timeout=60)
    if rc != 0:
        rc, out, err = bb("machine", "list", "--json", timeout=60)
    if rc != 0:
        return False, f"the host list did not answer: {(err or out).strip()[:160]}"
    host = os.environ.get("LP_DRILL_HOST", "host_7sea4qaad8")
    return (host in out), f"writer host {host} {'connected' if host in out else 'not in the host list'}"


def write_receipt(path: Path, start: float, scenarios: list[dict], ctx: Context | None, problems: list[str], names: list[str],
                  skipped: dict[str, str] | None = None, quick: bool = False) -> str:
    first = next((s for s in scenarios if s["name"] == "parallel3"), None)
    failed = [s["name"] for s in scenarios if s["result"] == "fail"]
    result = "pass" if not problems and not failed and scenarios else "fail"
    data = {
        "kind": "lane-pilot-sandbox-drill", "date": DATE, "stamp": STAMP, "startedAt": int(start * 1000), "finishedAt": int(time.time() * 1000),
        "durationSec": round(time.time() - start), "project": SANDBOX["project"], "runId": (ctx.run_id or None) if ctx else None, "pmThread": (ctx.pm or None) if ctx else None,
        "sourceThread": (ctx.source or None) if ctx else None, "mode": "quick" if quick or names == QUICK else "full", "scenarioNames": names,
        "commit": git(str(ROOT), "rev-parse", "HEAD"), "skipped": skipped or {},
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


def take_lock(lock: Path) -> bool:
    """Takes the drill lock; a lock left by a process that no longer exists is stale and is taken over."""
    for _ in range(2):
        try:
            lock.mkdir()
            (lock / "pid").write_text(str(os.getpid()))
            return True
        except FileExistsError:
            try:
                os.kill(int((lock / "pid").read_text()), 0)
                return False
            except PermissionError:  # the process exists under another user
                return False
            except (OSError, ValueError):  # no pid file (a lock from before this check), a dead or unreadable pid
                shutil.rmtree(lock, ignore_errors=True)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True, description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--quick-all", action="store_true")
    parser.add_argument("--scenario", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--repair-guard", action="store_true")
    parser.add_argument("--series", action="store_true", help="the release series: preparation, every scenario in a process of its own, the judges")
    parser.add_argument("--suite", default="", help="only the scenarios of one named suite (task batch phase release window worker lockstep wiring metrics)")
    parser.add_argument("--scout", action="store_true", help="only list the named suites against the scenario functions")
    args = parser.parse_args()
    receipt_dir = Path(os.environ.get("LP_DRILL_RECEIPT_DIR") or ROOT / ".agents/runs/drills")
    skipped: dict[str, str] = {}
    series = args.series or bool(args.suite)  # a suite is a part of the series: its judges and its metrics run with it
    if args.suite:
        if args.suite not in SUITES:
            print(f"unknown suite: {args.suite} (known: {', '.join(SUITES)})", file=sys.stderr)
            return 2
        names = list(SUITES[args.suite])
    elif args.quick and os.environ.get("LP_DRILL_SELECT") != "0":
        names, skipped = select_quick(receipt_dir)
    else:
        names = QUICK if args.quick or args.quick_all else [n for n in args.scenario.split(",") if n]
        if not names:
            # A series runs the extra scenes and the story files too; a plain run is main's ALL.
            names = ALL + EXTRA + [e for entries in SUITES.values() for e in entries if e.startswith("vitest:")] if series else ALL
    for name, why in skipped.items():
        log(f"scenario {name}: skipped ({why})")
    repair_guard = args.repair_guard or os.environ.get("LP_DRILL_REPAIR_GUARD") == "1"
    unknown = [n for n in names if n not in ALL and n not in EXTRA and n not in BY_NAME and not n.startswith("vitest:")]
    if unknown:
        print(f"unknown scenario: {', '.join(unknown)} (known: {', '.join(ALL + EXTRA + BY_NAME)})", file=sys.stderr)
        return 2
    if args.dry_run:
        dry_run(names, series)
        return 0
    if args.scout:
        print(json.dumps(scout(), indent=1))
        return 0
    if series:
        # One process per scene: each scenario runs in its own interpreter, so one that wedges or leaks state cannot spoil the next.
        prep = series_preparation()
        log(f"series: {json.dumps(prep)[:300]}")
        if prep["scout"]["unlisted"] or prep["scout"]["undefined"]:
            log(f"scout: {prep['scout']}")
        if prep["problems"]:
            for problem in prep["problems"]:
                log(f"series not ready: {problem}")
            print("series not ready: " + "; ".join(prep["problems"]), file=sys.stderr)
            return 2
        # A deferral without an agreed term turns the badge red: the series does not run on a red coverage verdict.
        if prep["coverageGaps"]:
            log(f"coverage refuses the series ({len(prep['coverageGaps'])}): {prep['coverageGaps'][:10]}")
            return 1
        # The series runs the named suites in SUITES order; a suite's scenes land in the manifest under its name, and the
        # metrics suite judges the archive last (SMA rl_suites, rl_metrics).
        wanted = set(names)
        receipts = []
        for suite, entries in SUITES.items():
            if suite == "metrics":
                continue
            for entry in entries:
                if entry not in wanted and entry not in names:
                    continue
                if entry.startswith("vitest:"):
                    rc, out, _ = run(["npx", "vitest", "run", entry.split(":", 1)[1]], timeout=TIMEOUT_MIN * 60)
                    receipts.append({"name": entry, "suite": suite, "exit": rc, "receipt": None})
                    continue
                rc, out, _ = run([sys.executable, "-I", __file__, "--scenario", entry], timeout=TIMEOUT_MIN * 60 * 3, env={**os.environ, "LP_DRILL_SERIES": "1"})
                receipts.append({"name": entry, "suite": suite, "exit": rc, "receipt": next((line.split("=", 1)[1] for line in out.splitlines() if line.startswith("RECEIPT=")), None)})
        manifest = Path(os.environ.get("LP_DRILL_RECEIPT_DIR") or ROOT / ".agents/runs/drills") / f"series-{STAMP}.json"
        manifest.parent.mkdir(parents=True, exist_ok=True)
        metrics = series_metrics(receipts, manifest.parent)
        suites = {name: [row for row in receipts if row["suite"] == name] for name in SUITES}
        verdict_all = "pass" if all(row["exit"] == 0 for row in receipts) and metrics["verdict"] == "pass" else "fail"
        manifest.write_text(json.dumps({"kind": "lane-pilot-release-series", "stamp": STAMP, "preparation": prep, "scenes": receipts, "suites": suites, "metrics": metrics, "verdict": verdict_all}, indent=2) + "\n")
        print(f"SERIES={manifest}")
        return 0 if verdict_all == "pass" else 1

    lock = Path(tempfile.gettempdir()) / "lp-drill.lock"
    # A deploy stops the previous deploy's drill with SIGTERM: without this the `finally` below never ran, the lock stayed and the
    # next drill ended «red» with exit 2 (0.1.514, 2026-11-10). A lock whose process is gone (SIGKILL, OOM) is taken over.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    if not take_lock(lock):
        print(f"another drill is running ({lock})", file=sys.stderr)
        return 2
    start = time.time()
    tmp = Path(tempfile.mkdtemp(prefix="lp-drill-"))
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
        if "outage_live" in names:
            log("scenario outage_live")
            try:
                scenarios.append(scenario_outage_live(tmp))
            except Exception as cause:
                scenarios.append(verdict("outage_live", [f"scenario raised: {cause}"]))
            log(f"scenario outage_live: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
        if "checkers" in names:
            log("scenario checkers")
            try:
                scenarios.append(scenario_checkers(tmp))
            except Exception as cause:
                scenarios.append(verdict("checkers", [f"scenario raised: {cause}"]))
            log(f"scenario checkers: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
        if "lead_shadow" in names:
            log("scenario lead_shadow")
            try:
                scenarios.append(scenario_lead_shadow(tmp))
            except Exception as cause:
                scenarios.append(verdict("lead_shadow", [f"scenario raised: {cause}"]))
            log(f"scenario lead_shadow: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
        if "episodes" in names:
            log("scenario episodes")
            try:
                scenarios.append(scenario_episodes(tmp))
            except Exception as cause:
                scenarios.append(verdict("episodes", [f"scenario raised: {cause}"]))
            log(f"scenario episodes: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
        if "memory_thread" in names:
            log("scenario memory_thread")
            try:
                scenarios.append(scenario_memory_thread(tmp))
            except Exception as cause:
                scenarios.append(verdict("memory_thread", [f"scenario raised: {cause}"]))
            log(f"scenario memory_thread: {scenarios[-1]['result']} {scenarios[-1]['problems']}")
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
        if ctx is not None and ctx.run_id:
            problems += clear_stale_owner_words(ctx)
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
        result = write_receipt(receipt, start, scenarios, ctx, problems, names, skipped, quick=args.quick or args.quick_all)
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(lock, ignore_errors=True)
    log(f"receipt: {receipt}")
    print(f"RECEIPT={receipt}")
    log("PASS" if result == "pass" else f"FAIL: see {receipt}")
    if result == "pass":
        return 0
    return 2 if not scenarios else 1


if __name__ == "__main__":
    sys.exit(main())
