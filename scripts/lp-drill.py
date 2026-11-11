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
import lp_drill.report
import lp_drill.tasks
import lp_drill.context
import lp_drill.select
import lp_drill.series
import lp_drill.preview
import lp_drill.scenes.memory
import lp_drill.scenes.owner
import lp_drill.scenes.skills
import lp_drill.scenes.guard
import lp_drill.scenes.deferrals
import lp_drill.scenes.hub_checks
import lp_drill.scenes.checkers
import lp_drill.scenes.revert
import lp_drill.scenes.phase
import lp_drill.scenes.providers

for _mod in (lp_drill.env, lp_drill.hub, lp_drill.report, lp_drill.tasks, lp_drill.context, lp_drill.select, lp_drill.series, lp_drill.preview, lp_drill.scenes.memory, lp_drill.scenes.owner, lp_drill.scenes.skills, lp_drill.scenes.guard, lp_drill.scenes.deferrals, lp_drill.scenes.hub_checks, lp_drill.scenes.checkers, lp_drill.scenes.revert, lp_drill.scenes.phase, lp_drill.scenes.providers,):
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


# --- scenarios ----------------------------------------------------------------------------------------------------------


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
