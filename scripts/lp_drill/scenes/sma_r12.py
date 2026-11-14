"""Region 12 · Supervisor: the region scene (docs/sma-evidence.md, «Trace choice»).

The supervisor's nodes write no row to the hub database: the drills are judged scenes, the watchdog and its startup entries are a shell script, the guides are
text. So the node-level trace is this scene. It runs the REAL code of the commit under drill — the scene modules of the drills with the hub and the model replaced
by fakes, the real hub-watchdog.sh against stub tools and scratch state, the real guide, the TypeScript pieces through sma_r12_probe.ts — and prove()s each
node with the result its card expects. No model turn, no write to the hub. Run: scripts/lp-drill.sh --scenario sma_r12.

The outage drill's live pass (a real stand-in service is hung, killed and lifted, both messages land on a stand-in bot) runs here too when `systemctl --user` works;
without it n999 is simply not proved by this run.
"""
from __future__ import annotations

import http.server
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n994", "n995", "n996", "n997", "n998", "n999", "n1000", "n1001", "n1002", "n1003", "n1005", "n1006", "n1008", "n1009", "n1010", "n1011", "n1012",
         "n1013", "n1014", "n1015", "n1016", "n1017", "n1018", "n1019", "n1020", "n1021", "n1022", "n1023", "n1024",
         "n1027", "n1028", "n1029", "n1030", "n1031", "n1032", "n1033", "n1034", "n1035"]
SCRIPT = ROOT / "scripts" / "hub-watchdog.sh"
GUIDE = ROOT / "docs" / "watchdog.md"
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r12_probe.ts"

CURL_STUB = '''for a in "$@"; do
  case "$a" in *sendMessage*) echo "$@" >> "$TG_LOG"; exit "${TG_RC:-0}" ;; esac
done
n=0; [ -f "$CURL_STATE" ] && n="$(cat "$CURL_STATE")"
echo $((n + 1)) > "$CURL_STATE"
if [ "$n" -ge "${CURL_AFTER:-999999}" ]; then echo 200; exit 0; fi
echo "${CURL_CODE:-000}"; exit "${CURL_RC:-0}"'''
SYSTEMCTL_STUB = '''echo "$*" >> "$SYS_LOG"
case "$*" in
  *"show -p MainPID"*) cat "$MAINPID_FILE" 2>/dev/null || echo 4242 ;;
  *"show -p ActiveState"*) echo active ;;
  *"show -p Result"*) echo failure; echo 1 ;;
  *restart*) [ -n "${MAINPID_AFTER:-}" ] && echo "$MAINPID_AFTER" > "$MAINPID_FILE"; exit 0 ;;
esac
exit 0'''


def _stub(bindir: Path, name: str, text: str) -> Path:
    path = bindir / name
    path.write_text(f"#!/bin/sh\n{text}\n")
    path.chmod(0o755)
    return path


def _sandbox(tmp: Path, name: str) -> tuple[Path, Path, dict]:
    """A scratch state folder with a bin folder in front of PATH, and the environment that points the watchdog at them."""
    state = tmp / name
    (state / "bin").mkdir(parents=True)
    env = {**os.environ, "LP_WATCH_STATE": str(state), "LP_WATCH_TG_ENV": str(state / "no-telegram"), "LP_WATCH_BB": str(state / "bin" / "bb-missing"),
           "LP_WATCH_FIRST_SEC": "0", "PATH": f"{state / 'bin'}:{os.environ['PATH']}"}
    return state, state / "bin", env


def _watch(args: list[str], env: dict, timeout: int = 90) -> tuple[int, str]:
    done = subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=timeout)
    return done.returncode, done.stdout + done.stderr


def _functions(body: str, env: dict, timeout: int = 90) -> str:
    """The script's functions without its case statement (what the unit tests do): run `body` in a shell that sourced them."""
    source = f"sed '/^case /,$d' {json.dumps(str(SCRIPT))}"
    done = subprocess.run(["bash", "-c", f"source <({source})\n{body}"], env=env, capture_output=True, text=True, timeout=timeout)
    return done.stdout + done.stderr


def _py_checks() -> dict:
    """The drills' own judging, with the hub and the model replaced by fakes: what each scene reports for a good run and for a broken one."""
    from lp_drill.scenes import hub_outage, owner, revert, skills, writers

    out: dict = {}
    # n994 a verification receipt counts only with checks listed and every exit 0
    rows = [{"task_id": "t1", "result_json": json.dumps({"verification": [{"exitCode": 0}]})},
            {"task_id": "t2", "result_json": json.dumps({"verification": [{"exitCode": 1}]})},
            {"task_id": "t3", "result_json": json.dumps({"verification": []})}]

    class RunCtx:
        run_id = "r1"

    with mock.patch.object(writers, "hubsql", lambda sql: rows):
        out["ran"] = writers.verification_ran(RunCtx(), ["t1", "t2", "t3", "t4"])
    # n995 / n1000 the three-note and the no-code scenes
    tmp = tempfile.mkdtemp()

    class Ctx:
        run_id = "r1"
        cwd = tmp
        dispatches: dict = {}

        def dispatch(self, spec):
            return True

        def wait_ended(self, ids, minutes=None):
            return []

    def parallel3(states, spaces):
        def summarize(rows, tid, cwd, output=None):
            i = "abc".index(tid[-1])
            return {"task": tid, "state": states[i], "states": [states[i]], "reason": "", "workspace": spaces[i], "attempt": f"a{i}", "fileInSandbox": True, "environment": "env", "holder": None}
        with mock.patch.object(writers, "summarize", summarize), mock.patch.object(writers, "verification_ran", lambda ctx, ids: {i: True for i in ids}), \
             mock.patch.object(writers, "worktree_registry", lambda attempts: {}), mock.patch.object(writers, "worktree_leftovers", lambda *a: []), \
             mock.patch.object(writers, "cleanup_schedule_rows", lambda: []), mock.patch.object(writers, "cleanup_schedule_problems", lambda rows: []):
            return writers.scenario_parallel3(Ctx())

    good, blocked = parallel3(["accepted"] * 3, ["/w/a", "/w/b", "/w/c"]), parallel3(["accepted", "blocked", "accepted"], ["/w/a", "/w/b", "/w/c"])
    out["parallel_good"], out["parallel_blocked"] = [good["result"], good["problems"]], [blocked["result"], blocked["problems"]]

    def no_code(attempts):
        def summarize(rows, tid, cwd, output=None):
            if "answer" in tid:
                return {"state": "accepted", "states": ["accepted"], "reason": "r", "attempts": attempts}
            return {"state": "blocked", "states": ["blocked"], "reason": "NEEDS_HUMAN: colour"}

        class C2:
            run_id = "r1"
            cwd = tmp

            def dispatch(self, spec):
                return True

            def wait_ended(self, ids):
                return []
        with mock.patch.dict(os.environ, {"LP_DRILL_SERIES": "1"}), mock.patch.object(writers, "summarize", summarize), mock.patch.object(writers, "hubsql", lambda sql: [{"n": 1}]):
            return writers.scenario_no_code_exit(C2())["problems"]

    out["answer_first"], out["answer_twice"] = no_code(1), no_code(2)

    # n996 the approval scene with a red task
    def approve(red_state):
        folder = Path(tempfile.mkdtemp())

        class C3:
            project = "proj_x"
            run_id = "run_abc"
            pm = "thr"
            cwd = str(folder)
            tmp = folder

            def dispatch(self, spec):
                return True

            def wait_ended(self, ids):
                return []

            def rows(self, ids):
                return []

        def summarize(rows, tid, cwd, output=None):
            state = red_state if "red" in tid else "accepted"
            return {"state": state, "states": [state], "reason": ""}
        with mock.patch.dict(os.environ, {"LP_DRILL_LIVE_PRESS": "1"}), mock.patch.object(owner, "owner_words", lambda ctx, v: ("off", 1)), \
             mock.patch.object(owner, "restore_owner_words", lambda ctx, o, v: []), mock.patch.object(owner, "thread_text", lambda t: "waits for the owner's word before it lands"), \
             mock.patch.object(owner.time, "sleep", lambda s: None), mock.patch.object(owner, "hubsql", lambda sql: [{"n": 0}]), mock.patch.object(owner, "latest_states", lambda rows: {}), \
             mock.patch.object(owner, "summarize", summarize), mock.patch.object(owner, "setting_rpc", lambda m, p: {"ok": True}), mock.patch.object(owner, "run", lambda args, **k: (0, "", "")):
            scene = owner.scenario_live_word(C3())
        return [scene["result"], scene["problems"]]

    out["approve_good"], out["approve_red_accepted"] = approve("blocked"), approve("accepted")

    # n997 the revert is judged by a merged receipt of kind revert
    receipts = lambda items: revert.revert_merged(json.dumps({"receipts": items, "summary": "revert is mentioned here"}))
    out["revert"] = {"merged": receipts([{"kind": "revert", "state": "merged"}]), "dry": receipts([{"kind": "revert", "state": "dry_run"}]), "none": receipts([])}
    # n998 the skills screen: a changed file is named, an unchanged one is not
    door = {"catalog": 3, "narrowed": True}
    out["skills"] = {"changed": skills.skills_screen_problems({"door": door, "window": {"listed": True}, "diskBefore": {"a": "1"}, "diskAfter": {"a": "2"}}),
                     "same": skills.skills_screen_problems({"door": door, "window": {"listed": True}, "diskBefore": {"a": "1"}, "diskAfter": {"a": "1"}})}
    # n999 the outage drill drives nothing but its own stand-in unit
    with mock.patch.dict(os.environ, {"LP_WATCH_SERVICE": "bb-server"}):
        refused = hub_outage.scenario_outage_live(Path(tmp))
    out["outage_refusal"] = [refused["result"], refused.get("note", "")]
    return out


def _live_outage(tmp: Path) -> dict | None:
    """The outage drill's live pass against the stand-in unit; None when there is no systemd --user here."""
    if subprocess.run(["systemctl", "--user", "show-environment"], capture_output=True).returncode != 0:
        return None
    from lp_drill.scenes import hub_outage
    problems, details = hub_outage._watchdog_live(tmp, with_bot=True, census=False)
    return {"problems": problems, "events": details.get("events", []), "posts": len(details.get("posts", []))}


def _lift_with_stubs(tmp: Path) -> dict:
    """A lift against a stub manager (n1001, n1005): the manager is asked to restart the service, the log holds the killed pid, the new pid is kept."""
    state, bindir, env = _sandbox(tmp, "lift")
    _stub(bindir, "curl", CURL_STUB)
    _stub(bindir, "sleep", "exit 0")
    _stub(bindir, "ss", "exit 0")
    systemctl = _stub(bindir, "systemctl", SYSTEMCTL_STUB)
    (state / "mainpid").write_text("4242\n")
    base = {**env, "CURL_STATE": str(state / "s"), "SYS_LOG": str(state / "sys.log"), "MAINPID_FILE": str(state / "mainpid"), "MAINPID_AFTER": "5151",
            "LP_WATCH_USER": "1", "LP_WATCH_SYSTEMCTL": str(systemctl), "LP_WATCH_SERVICE": "lp-drill-door"}
    commands = {"mac": _functions("lift_cmd", {**base, "LP_WATCH_PLATFORM": "darwin"}).strip(), "linux": _functions("lift_cmd", base).strip()}
    rose = _functions("lift; echo rc=$?", {**base, "CURL_AFTER": "2"})
    return {"commands": commands, "rc": rose.strip().splitlines()[-1], "log": (state / "outages.jsonl").read_text(), "lifted": (state / "hub-watchdog.lifted-pid").read_text().strip(),
            "sys": (state / "sys.log").read_text(), "uid": os.getuid()}


def _door_answers(tmp: Path) -> dict:
    state, bindir, env = _sandbox(tmp, "answers")
    _stub(bindir, "curl", "echo 200")
    _stub(bindir, "ss", "exit 0")
    out = _functions("lift || true", {**env, "LP_WATCH_DRY": "1"})
    return {"out": out, "log": (state / "outages.jsonl").read_text()}


def _db_ready(tmp: Path) -> dict:
    state, _, env = _sandbox(tmp, "dbready")
    good, wide, corrupt, missing = (str(state / name) for name in ("good.db", "wide.db", "corrupt.db", "missing.db"))
    subprocess.run(["sqlite3", good, "CREATE TABLE t(x);"], check=True)
    subprocess.run(["sqlite3", wide, "PRAGMA encoding='UTF-16le'; CREATE TABLE t(x);"], check=True)
    Path(corrupt).write_text("this is not a database")
    each = {name: _watch(["db-ready"], {**env, "LP_WATCH_DBS": path}) for name, path in {"good": good, "wide": wide, "corrupt": corrupt, "missing": missing}.items()}
    return {name: [rc, out.strip()] for name, (rc, out) in each.items()} | {"paths": {"wide": wide, "missing": missing, "good": good}}


def _units(tmp: Path) -> dict:
    state, _, env = _sandbox(tmp, "units")
    system, user, mac = (_watch(["print-unit", which], env)[1] for which in ("system", "user", "mac"))
    capped = _watch(["print-unit", "user"], {**env, "LP_WATCH_RESTART_CAP": "3"})[1]
    return {"system": system, "user": user, "mac": mac, "capped": capped, "self": str(SCRIPT.resolve()), "state": str(state), "left": sorted(p.name for p in state.iterdir() if p.name != "bin")}


def _batch_b(tmp: Path) -> dict:
    """The watchdog's verbs, units, lock, lift limit and no-administrator install, run for real on scratch state with stub tools (n1027 … n1035)."""
    out: dict = {}
    state, bindir, env = _sandbox(tmp, "batchb")
    env = {**env, "LP_WATCH_DRY": "1", "LP_WATCH_DOOR": "http://127.0.0.1:1/no"}
    out["status"] = _watch(["status"], env)
    out["unknown"] = _watch(["nope"], env)
    out["unit_user"] = _watch(["print-unit", "user"], env)[1]
    out["unit_system"] = _watch(["print-unit", "system"], env)[1]
    out["unit_nocap"] = _watch(["print-unit", "user"], {**env, "LP_WATCH_RESTART_CAP": "0"})[1]
    out["unit_mac"] = _watch(["print-unit", "mac"], env)[1]
    out["left"] = sorted(p.name for p in state.iterdir() if p.name not in ("bin", "outages.jsonl"))
    # n1029 a second watchdog finds the lock and leaves
    holder = subprocess.Popen(["flock", "-n", str(state / "hub-watchdog.lock"), "/bin/sleep", "20"])
    try:
        for _ in range(50):
            if (state / "hub-watchdog.lock").exists():
                break
            time.sleep(0.1)
        out["lock"] = _watch(["run"], env)
    finally:
        holder.kill()
        holder.wait()
    # n1030 five lifts inside the window refuse the next one
    lifts = _functions('for n in 1 2 3 4 5; do record lift "seed $n"; done\nlift || true\necho ---\ncat "$LOG"', {**env, "LP_WATCH_MAX_LIFTS_IN_WINDOW": "5"})
    out["lifts"] = {"refused": "lift_refused" in lifts, "lift_rows": lifts.count('"event":"lift"')}
    # n1031 / n1032 no administrator rights: the user unit, then, with no user systemd, the crontab line
    home = tmp / "home-b"
    home.mkdir()
    _stub(bindir, "sudo", "exit 1")
    _stub(bindir, "systemctl", 'case "$*" in *show-environment*) exit "${USERCTL_RC:-0}" ;; esac\n' + SYSTEMCTL_STUB)
    _stub(bindir, "crontab", 'case "$1" in\n  -l) cat "$CRON_IN" ;;\n  -) cat > "$CRON_OUT" ;;\nesac')
    (home / "cron-in").write_text("0 3 * * * /usr/bin/backup\n@reboot /bin/bash /old/place/hub-watchdog.sh run\n")
    inst_env = {**env, "HOME": str(home), "SYS_LOG": str(home / "sys.log"), "MAINPID_FILE": str(home / "m"), "STATE_FILE": str(home / "st"), "LP_WATCH_SYSTEMCTL": str(bindir / "systemctl"),
                "CRON_IN": str(home / "cron-in"), "CRON_OUT": str(home / "cron-out")}
    user = _watch(["install"], {**inst_env, "LP_WATCH_RESTART_CAP": "5"})[1]
    unit_file = home / ".config/systemd/user/lp-hub-watchdog.service"
    out["install_user"] = {"out": user, "file": unit_file.read_text() if unit_file.exists() else ""}
    if unit_file.exists():
        unit_file.unlink()
    cron = _watch(["install"], {**inst_env, "USERCTL_RC": "1"})[1]
    out["install_cron"] = {"out": cron, "lines": (home / "cron-out").read_text().splitlines() if (home / "cron-out").exists() else [], "unit_written": unit_file.exists()}
    # n1035 the Mac install
    mac_home = tmp / "home-mac"
    (mac_home / "Library/LaunchAgents").mkdir(parents=True)
    _stub(bindir, "launchctl", 'echo "$*" >> "$LCTL_LOG"; exit 0')
    mac = _watch(["install"], {**env, "HOME": str(mac_home), "LP_WATCH_PLATFORM": "darwin", "LCTL_LOG": str(mac_home / "lctl.log")})[1]
    plist = mac_home / "Library/LaunchAgents/pro.vechkasov.lp-hub-watchdog.plist"
    out["install_mac"] = {"out": mac, "plist": plist.read_text() if plist.exists() else "", "calls": (mac_home / "lctl.log").read_text().splitlines()[:2] if (mac_home / "lctl.log").exists() else [], "path": str(plist)}
    out["self"] = str(SCRIPT.resolve())
    return out


def _logs(tmp: Path) -> dict:
    """Rotation and the daily count on a log whose line is of yesterday (n1013, n1018)."""
    state, _, env = _sandbox(tmp, "logs")
    # noon UTC of a day well in the past: the same day in every time zone the drill runs in
    (state / "outages.jsonl").write_text('{"at":1700049600,"event":"lift","detail":"old"}\n')
    rotated = _watch(["rotate"], env)[1]
    daily_old = _watch(["daily"], env)[1]
    (state / "outages.jsonl").write_text(f'{{"at":{int(__import__("time").time())},"event":"lift","detail":"today"}}\n')
    daily = _watch(["daily"], env)[1]
    return {"rotated": rotated, "kept": (state / "outages-2023-11-15.jsonl").exists(), "todayLeft": (state / "outages.jsonl").read_text().count("today"), "daily_old": daily_old, "daily": daily}


def _selfcheck(tmp: Path) -> dict:
    """The selfcheck with curl missing from the PATH: one FAIL line and the exit code is the number of failures."""
    state, _, env = _sandbox(tmp, "selfcheck")
    lean = tmp / "lean-bin"
    lean.mkdir()
    for folder in ("/usr/bin", "/bin"):
        for tool in os.listdir(folder):
            target = lean / tool
            if tool != "curl" and not target.exists():
                try:
                    target.symlink_to(Path(folder) / tool)
                except OSError:
                    pass
    rc, out = _watch(["selfcheck"], {**env, "PATH": str(lean)})
    return {"rc": rc, "out": out}


def _rotation_drill(tmp: Path) -> list[str]:
    """The `watchdog` scene of lp-drill.py with its two heavy parts replaced (the eight-second wait, the real hub's address): its rotation check."""
    spec = importlib.util.spec_from_file_location("lp_drill_main_for_sma_r12", ROOT / "scripts" / "lp-drill.py")
    main = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(main)

    class Door(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"v")

        def log_message(self, *a):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Door)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    door = f"http://127.0.0.1:{server.server_address[1]}/install/version"
    bindir = Path(tempfile.mkdtemp())
    _stub(bindir, "ss", "exit 0")

    class Proc:
        def terminate(self):
            pass

        def wait(self, timeout=None):
            return 0

    def popen(args, env=None, **k):
        (Path(env["LP_WATCH_STATE"]) / "outages.jsonl").write_text('{"at":1,"event":"outage","detail":"x"}\n{"at":2,"event":"lift","detail":"x"}\n')
        return Proc()

    class Sub:
        Popen = staticmethod(popen)
        DEVNULL = subprocess.DEVNULL
        TimeoutExpired = subprocess.TimeoutExpired

    def run_real(args, env=None, timeout=None):
        env = dict(env or {})
        env["PATH"] = f"{bindir}:{env.get('PATH', '')}"
        if args[-1] == "lift":
            env["LP_WATCH_DOOR"] = door
        done = subprocess.run(args, env=env, capture_output=True, text=True, timeout=60)
        return done.returncode, done.stdout, done.stderr

    try:
        with mock.patch.object(main, "subprocess", Sub), mock.patch.object(main, "run", run_real), mock.patch.object(main.time, "sleep", lambda s: None):
            (tmp / "rotation-drill").mkdir()
            return main.scenario_watchdog(tmp / "rotation-drill")["problems"]
    finally:
        server.shutdown()


def scenario_sma_r12(tmp: Path) -> dict:
    proofs = Proofs()
    tmp = Path(tmp)
    py = _py_checks()

    # n994 Clean completion drill: a receipt counts only with green checks listed; the scene names a task accepted without them.
    proofs.prove("n994", py["ran"] == {"t1": True, "t2": False, "t3": False, "t4": False}, f"verification_ran {py['ran']}")
    # n995 No-code exit drill: edit-free work closing on its answer the first time passes, a second attempt is named.
    proofs.prove("n995", py["answer_first"] == [] and py["answer_twice"] == ["edit-free answer work needed 2 attempts to close on its answer"], f"first try {py['answer_first']}, second try {py['answer_twice']}")
    # n996 Approval drill: the red task accepted without a word is named, the green path is a pass.
    proofs.prove("n996", py["approve_good"] == ["pass", []] and py["approve_red_accepted"][1] == ["a task whose check failed was accepted without a word"], f"good {py['approve_good']}, red accepted {py['approve_red_accepted']}")
    # n997 Terminal merge drill: only a merged receipt of kind revert counts.
    proofs.prove("n997", py["revert"] == {"merged": True, "dry": False, "none": False}, f"revert_merged {py['revert']}")
    # n998 Skills drill: a changed skill file is named, an unchanged one is not.
    proofs.prove("n998", py["skills"]["same"] == [] and any("skill files changed" in line for line in py["skills"]["changed"]), f"changed {py['skills']['changed']}, same {py['skills']['same']}")
    # n1000 Live contour check: three accepted notes, each in a worktree of its own, is a pass; one not accepted is named.
    proofs.prove("n1000", py["parallel_good"] == ["pass", []] and py["parallel_blocked"][0] == "fail" and "not every task was accepted" in py["parallel_blocked"][1], f"good {py['parallel_good']}, one blocked {py['parallel_blocked']}")

    # n999 Outage drill: refuses a service that is not its stand-in; the live pass (a real stand-in daemon hung, lifted, both messages) where systemd --user exists.
    live = _live_outage(tmp)
    refusal_ok = py["outage_refusal"][0] == "skipped" and "lp-drill-door" in py["outage_refusal"][1]
    if live is not None:
        ok = refusal_ok and live["problems"] == [] and "outage" in live["events"] and "risen" in live["events"] and live["posts"] == 2
        proofs.prove("n999", ok, f"refusal {py['outage_refusal'][0]}; live pass problems {live['problems']}, events {live['events']}, posts to the stand-in bot {live['posts']}")

    # n1001 / n1005 Lift: one command per platform, the manager is asked to restart the service, the log holds the killed pid, the door decides.
    lift = _lift_with_stubs(tmp)
    proofs.prove("n1001", 'try 1, killing pid 4242' in lift["log"] and lift["lifted"] == "5151" and "--user restart lp-drill-door" in lift["sys"], f"log {lift['log'].strip()[:120]!r}, lifted-pid {lift['lifted']}")
    ok = lift["commands"]["mac"] == f"launchctl kickstart -k gui/{lift['uid']}/lp-drill-door" and lift["commands"]["linux"].endswith("--user restart lp-drill-door") and lift["rc"] == "rc=0"
    proofs.prove("n1005", ok, f"lift commands {lift['commands']}, lift returned {lift['rc']}")
    # n1006 The door already answers: nothing is done and the record says it was skipped.
    answers = _door_answers(tmp)
    proofs.prove("n1006", "nothing to do: the door answers" in answers["out"] and "lift_skipped" in answers["log"] and '"event":"lift"' not in answers["log"], f"output {answers['out'].strip()!r}")

    # n1008 / n1022 / n1023 Readiness is a real query: a missing file, a non-UTF-8 file and a corrupt file are not ready, a good one is.
    db = _db_ready(tmp)
    proofs.prove("n1008", db["missing"][0] == 1 and db["missing"][1] == f"missing: {db['paths']['missing']}" and db["good"][0] == 0, f"missing {db['missing']}, good {db['good']}")
    proofs.prove("n1022", db["wide"][0] == 1 and "UTF-16le" in db["wide"][1] and db["good"][1].startswith("ready:"), f"UTF-16 file {db['wide']}")
    proofs.prove("n1023", db["corrupt"][0] == 1 and db["corrupt"][1].startswith("not ready:") and db["good"][1].startswith("ready:"), f"corrupt file {db['corrupt']}")

    # n1009 / n1010 / n1011 / n1014 The startup entries, printed and registered nowhere.
    units = _units(tmp)
    proofs.prove("n1009", f"ExecStart=/bin/bash {units['self']} run" in units["system"] and "WantedBy=multi-user.target" in units["system"] and units["left"] == [], f"system unit runs the loop; files left behind {units['left']}")
    user = units["user"]
    proofs.prove("n1010", "WantedBy=default.target" in user and "RestartSec=30" in user and "StartLimitBurst=5" in user and "StartLimitBurst=3" in units["capped"], f"user unit: login target, 30 s between restarts, cap 5 (3 when asked for 3)")
    proofs.prove("n1011", "<key>RunAtLoad</key><true/>" in units["mac"] and "<key>KeepAlive</key><true/>" in units["mac"] and f"<string>{units['self']}</string><string>run</string>" in units["mac"], "launchd entry: run at load, keep alive, runs the loop")
    out_path = f"<key>StandardOutPath</key><string>{units['state']}/hub-watchdog.log</string><key>StandardErrorPath</key><string>{units['state']}/hub-watchdog.log</string>"
    proofs.prove("n1014", out_path in units["mac"], "launchd entry sends stdout and stderr to the watchdog log")

    # n1013 / n1018 The log of a day: a line of an old day goes to that day's file; the daily count is that day's events.
    logs = _logs(tmp)
    proofs.prove("n1018", "rotated: outages-2023-11-15.jsonl" in logs["rotated"] and logs["kept"], f"rotated {logs['rotated'].strip()!r}")
    proofs.prove("n1013", "2023-11-15 lift 1" in logs["daily_old"] and any(line.endswith(" lift 1") for line in logs["daily"].splitlines()), f"daily count {logs['daily_old'].strip()!r}")

    # n1015 First Mac check: with curl missing the selfcheck names it and the exit code is the number of failures.
    check = _selfcheck(tmp)
    failures = [line for line in check["out"].splitlines() if line.startswith("FAIL:")]
    proofs.prove("n1015", check["rc"] == len(failures) and any("prerequisite: curl" in line for line in failures) and f"selfcheck: {len(failures)} failure(s)" in check["out"], f"exit {check['rc']}, failures {failures}")

    # n1012 / n1016 / n1017 The guide: the Windows logon task and the startup shortcut, the Mac agent file the install writes.
    guide = GUIDE.read_text()
    windows = guide[guide.index("## Windows"):]
    no_admin = next((line for line in windows.splitlines() if "Без прав администратора" in line), "")
    proofs.prove("n1012", "`shell:startup`" in no_admin and "той же командой" in no_admin, f"line {no_admin!r}")
    proofs.prove("n1016", "schtasks /Create /SC ONLOGON" in windows and "hub-watchdog.sh run" in windows and any(ch in windows for ch in "абвгде"), "Windows section: Russian text, ONLOGON task, the run command")
    mac = guide[guide.index("## macOS"):guide.index("## Windows")]
    label = "pro.vechkasov.lp-hub-watchdog"
    proofs.prove("n1017", f"~/Library/LaunchAgents/{label}.plist" in mac and f"<key>Label</key><string>{label}</string>" in units["mac"] and "RunAtLoad" in mac and "KeepAlive" in mac, "the guide names the agent file whose label print-unit mac prints")

    # Batch b: the verbs, the units, the lock, the lift limit and the no-administrator install, on scratch state.
    b = _batch_b(tmp)
    rc_status, out_status = b["status"]
    rc_unknown, out_unknown = b["unknown"]
    proofs.prove("n1027", rc_status == 1 and "the door does not answer" in out_status and rc_unknown == 2 and "run|status|stop|restart|lift|install" in out_unknown, f"status with a silent door exit {rc_status}, unknown verb exit {rc_unknown}")
    ok = ("StartLimitIntervalSec=3600" in b["unit_user"] and "StartLimitBurst=5" in b["unit_user"] and "StartLimitIntervalSec=3600" in b["unit_system"] and "StartLimit" not in b["unit_nocap"])
    proofs.prove("n1028", ok, "units cap a fallen watchdog at 5 restarts an hour; the cap is absent when set to 0")
    rc_lock, out_lock = b["lock"]
    proofs.prove("n1029", rc_lock == 0 and "another watchdog runs" in out_lock, f"second watchdog with the lock held: exit {rc_lock}, '{out_lock.strip()[:60]}'")
    proofs.prove("n1030", b["lifts"] == {"refused": True, "lift_rows": 5}, f"after 5 lifts in the window the next is {b['lifts']}")
    iu = b["install_user"]
    order = iu["out"].find("no administrator rights (sudo -n refused)") != -1 and iu["out"].find("no administrator rights (sudo -n refused)") < iu["out"].find("installed: user unit")
    proofs.prove("n1031", order and "StartLimitBurst=5" in iu["file"] and "WantedBy=default.target" in iu["file"], f"refusal said before the fallback {order}, user unit written with the cap")
    ic = b["install_cron"]
    want = [f"0 3 * * * /usr/bin/backup"]
    ok = ic["lines"][:1] == want and len(ic["lines"]) == 2 and ic["lines"][1].startswith(f"@reboot /bin/bash {b['self']} run >> ") and "/old/place" not in "".join(ic["lines"]) and not ic["unit_written"]
    proofs.prove("n1032", ok, f"crontab after install {ic['lines']}")
    text = GUIDE.read_text()
    windows_part = text[text.index("## Windows"):]
    linux_part = text[text.index("## Linux"):text.index("## macOS")]
    task = re.search(r"/TR \"bash -lc '([^']+)'\"", windows_part)
    verb = re.search(r"ExecStart=/bin/bash \S+ (\w+)", iu["file"])
    no_admin_lines = [line for line in windows_part.splitlines() if "Без прав администратора" in line]
    ok = (no_admin_lines == ["Без прав администратора — ярлык в `shell:startup` с той же командой."] and "~/.config/systemd/user/lp-hub-watchdog.service" in linux_part and task is not None and verb is not None
          and task.group(1).endswith(f"hub-watchdog.sh {verb.group(1)}") and not re.search(r"AppData|C:\\|%APPDATA%", windows_part) and "installed: user unit lp-hub-watchdog.service" in iu["out"])
    proofs.prove("n1033", ok, f"guide line {no_admin_lines}, Windows command ends with the verb the unit runs ({verb.group(1) if verb else None})")
    ok = "Environment=LP_WATCH_FIRST_SEC=120" in b["unit_system"] and "<key>LP_WATCH_FIRST_SEC</key><string>120</string>" in b["unit_mac"] and "ThrottleInterval" in b["unit_mac"] and b["left"] == []
    proofs.prove("n1034", ok, f"units carry the two-minute first look and the cap; files left behind by print-unit {b['left']}")
    im = b["install_mac"]
    domain = im["calls"][0].split(" ")[1] if im["calls"] else ""
    ok = ("<key>RunAtLoad</key><true/>" in im["plist"] and "<key>KeepAlive</key><true/>" in im["plist"] and "[Unit]" not in im["plist"]
          and im["calls"] == [f"bootout {domain} {im['path']}", f"bootstrap {domain} {im['path']}"] and "installed: LaunchAgent pro.vechkasov.lp-hub-watchdog" in im["out"])
    proofs.prove("n1035", ok, f"agent file written with run-at-load and keep-alive, launchctl calls {im['calls']}")

    # n1019 Day rotation drill: the watchdog scene passes only when the old log rotated to its day.
    rotation = _rotation_drill(tmp)
    proofs.prove("n1019", rotation == [], f"watchdog scene problems with the real script's rotate: {rotation}")

    # n1002 / n1003 / n1020 / n1021 / n1024 The TypeScript pieces, run for real on scratch folders.
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=240)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r12", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])
    grants, journal, database = seen["grants"], seen["journal"], seen["database"]
    proofs.prove("n1002", grants["onlyTheFolder"] == [True, True], f"every grant command on both platforms names only the run folder: {grants['onlyTheFolder']}")
    if grants["ledger"] is not None:
        proofs.prove("n1003", grants["ledger"]["grantedIsGood"] and grants["ledger"]["rows"] == 1 and grants["ledger"]["rowIsGood"], f"granted folders {grants['ledger']}")
    proofs.prove("n1020", (journal["one"], journal["same"], journal["other"], journal["oldDropped"]) == (1, 1, 2, True), f"rows after one mark {journal['one']}, same thread same day {journal['same']}, another thread {journal['other']}, 91-day-old dropped {journal['oldDropped']}")
    proofs.prove("n1021", journal["summary"] == {"days": 3, "windowDays": 7, "attempts": 10, "share": 3 / 7} and journal["empty"] == 0, f"summary {journal['summary']}, empty journal {journal['empty']} days")
    proofs.prove("n1024", database["created"] and not database["threw"] and database["kept"] == 1, f"database opened twice: created {database['created']}, second open raised {database['threw']}, row kept {database['kept']}")
    return proofs.verdict("sma_r12", checked=len(NODES))
