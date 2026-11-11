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
import lp_drill.scenes.writers
import lp_drill.scenes.nogit
import lp_drill.scenes.hub_outage
import lp_drill.lock

for _mod in (lp_drill.env, lp_drill.hub, lp_drill.report, lp_drill.tasks, lp_drill.context, lp_drill.select, lp_drill.series, lp_drill.preview, lp_drill.scenes.memory, lp_drill.scenes.owner, lp_drill.scenes.skills, lp_drill.scenes.guard, lp_drill.scenes.deferrals, lp_drill.scenes.hub_checks, lp_drill.scenes.checkers, lp_drill.scenes.revert, lp_drill.scenes.phase, lp_drill.scenes.providers, lp_drill.scenes.writers, lp_drill.scenes.nogit, lp_drill.scenes.hub_outage, lp_drill.lock,):
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
    # Noon UTC, so the line's day is the same in every time zone the drill runs in: the watchdog names a day by the machine's
    # clock, and the old sample (22:13 UTC) was already the 15th in Moscow, where this check then always failed.
    (state / "outages.jsonl").write_text('{"at":1700049600,"event":"lift","detail":"old"}\n')
    run(["bash", script, "rotate"], env=env, timeout=30)
    if not (state / "outages-2023-11-15.jsonl").exists():
        problems.append("an old log did not rotate to its day")
    if os.environ.get("LP_DRILL_WATCHDOG_LIVE") == "1" and shutil.which("systemctl"):
        live_problems, live = _watchdog_live(tmp, with_bot=False, census=True)
        problems += live_problems
    else:
        live = {"note": "live pass off (it runs only with LP_DRILL_WATCHDOG_LIVE=1) or no systemd --user here"}
    return verdict("watchdog", problems, events=events, live=live)


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


def series_preparation(names: list[str] | None = None) -> dict:
    """Series preparation (SMA rl_prep): what the series runs against — the plugin version and commit, the scout, a clean
    sandbox — and the parts it refuses to start without: database, receipts, browser, accounts, limits, window, person.
    Accounts is the capability table plus one cheap probe per unproven provider (60 s each); person is the hub's owner
    presence and the owner-waiting push. Browser refuses only a series whose scenes open a window when none is named."""
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
    for name, probe in (("browser", _browser_probe), ("accounts", _accounts_probe), ("limits", _limits_probe), ("window", _window_probe), ("person", _person_probe)):
        try:
            ok, detail = probe(names) if name == "browser" else probe()
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
        prep = series_preparation(names)
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
