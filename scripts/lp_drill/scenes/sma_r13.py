"""Region 13 · Guard tools: the worked example of a region scene (docs/sma-evidence.md, «Trace choice»).

A scene named sma_rNN proves map nodes of region NN. It runs the REAL check of the commit under drill (no model, no hub write) and, per node,
calls proofs.prove(node, ok, detail) with the result the node's card expects and what was actually seen. Only a node the scene lists with
ok true counts as a drill trace; a scene that passed without naming a node proves nothing for it. Run: scripts/lp-drill.sh --scenario sma_r13.

To add a node: append its id to NODES, run its check (another probe value, a CLI call, an RPC read, a database read, a refused dispatch),
prove() it, and put `trace: drill("sma_r13")` on the node's line of evidence/r13.ts. Keep this file self-contained: import what you use from
lp_drill.*, prefix nothing, share nothing with another region's scene.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1036", "n1037", "n1038", "n1039", "n1040", "n1041", "n1042", "n1043", "n1046", "n1047"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r13_probe.ts"


def _out(args: list[str], env: dict | None = None, timeout: int = 180) -> str:
    done = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=timeout, env=env)
    return done.stdout + done.stderr


def _gate_leak_lines(tree: Path) -> list[str]:
    """The publish gate (`lp-ship.ts publishable --strict`) pointed at another tree: the `leak scan:` lines it prints."""
    env = {**os.environ, "LP_SHIP_LEAK_ROOT": str(tree)}
    return [line for line in _out(["npx", "tsx", "scripts/lp-ship.ts", "publishable", "--strict"], env).splitlines() if line.startswith("leak scan:")]


def _crash_census(tmp: Path) -> tuple[bool, str]:
    """The real `_db_census` of the outage drill on a scratch SQLite file: a writer killed mid-loop, a census before and after, a damaged file."""
    sys.path.insert(0, str(ROOT / "scripts"))
    from lp_drill.scenes.hub_outage import _db_census
    script, env = str(ROOT / "scripts/hub-watchdog.sh"), {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp)}
    db = tmp / "stand.db"
    subprocess.run(["sqlite3", str(db), "pragma journal_mode=WAL; create table beats(n integer);"], check=True, capture_output=True)
    empty = _db_census(script, env, db)
    writer = subprocess.Popen(["bash", "-c", f"for i in $(seq 1 200000); do sqlite3 '{db}' 'insert into beats values (1);' 2>/dev/null; done"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    before = {"rows": 0, "ready": False}
    for _ in range(60):
        time.sleep(0.2)
        before = _db_census(script, env, db)
        if before["rows"] > 10:
            break
    writer.kill()
    writer.wait()
    time.sleep(0.3)
    after = _db_census(script, env, db)
    own = int(subprocess.run(["sqlite3", "-readonly", str(db), "select count(*) from beats;"], capture_output=True, text=True).stdout.strip())
    broken = tmp / "broken.db"
    broken.write_text("this is not a sqlite file, only text that is long enough to fill a header page " * 80)
    bad = _db_census(script, env, broken)
    ok = empty == {"rows": 0, "ready": True} and before["rows"] > 10 and before["ready"] and after["ready"] and after["rows"] >= before["rows"] and after["rows"] == own and not bad["ready"]
    return ok, f"census before the kill {before}, after SIGKILL {after} (sqlite itself reads {own}), a damaged file {bad}"


def scenario_sma_r13(tmp: Path) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=240)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r13", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n1036 Leak scanner: a planted secret is found on its line, clean text gives [], house words are reported by key.
    ok = seen["leakPlanted"] == [2] and seen["leakClean"] == [] and seen["houseWords"] == ["attemptId", "brand", "shortColour"]
    proofs.prove("n1036", ok, f"planted secret on lines {seen['leakPlanted']}, clean text {seen['leakClean']}, house words {seen['houseWords']}")
    # n1037 Internal ids forbidden: an attempt id and a thread id are refused, a placeholder and a short word are not.
    proofs.prove("n1037", seen["internal"] == ["attempt", "thread"], f"internal ids refused in {seen['internal']}")

    # n1038 In tests and before publishing: the gate itself lists a planted leak as path:line and none for a clean tree; the repository has none.
    planted, clean = tmp / "leak-planted", tmp / "leak-clean"
    for tree in (planted, clean):
        (tree / "src").mkdir(parents=True)
    (planted / "src/a.ts").write_text("export const ok = 1;\nexport const planted = \"" + "sk" + "-" + "a" * 28 + "\";\n")
    (clean / "src/a.ts").write_text("export const ok = 1;\n")
    hit, none = _gate_leak_lines(planted), _gate_leak_lines(clean)
    proofs.prove("n1038", hit == ["leak scan: src/a.ts:2"] and none == [] and seen["leakRepo"] == [], f"gate on a planted tree {hit}, on a clean tree {none}; leak scan of this commit {seen['leakRepo']}")

    # n1039 Window contract is read: of a, b, c only the field nothing reads is reported, with its method.
    proofs.prove("n1039", seen["unreadSynthetic"] == ["zeta.c"], f"unread fields {seen['unreadSynthetic']}")
    # n1040 Explained unshown fields: each names a real answer field, has a reason of 3+ words, and the register silences it.
    register = seen["unshown"]
    proofs.prove("n1040", bool(register) and all(row["methodKnown"] and row["words"] >= 3 and row["silenced"] for row in register), f"{len(register)} registered fields, all on a known method with a reason and silenced")
    # n1041 Contract check in tests: the real contract has no unread field outside the baseline.
    proofs.prove("n1041", seen["unreadRealOutsideBaseline"] == [] and seen["unreadRealCount"] > 0, f"{seen['unreadRealCount']} unread fields, outside the baseline {seen['unreadRealOutsideBaseline']}")

    # n1042 Session and terminal parity: a named difference per side, a missing side is «not compared», never «same».
    missing = seen["parityMissing"]
    differ = seen["parityDiffer"]
    ok = (differ[1] == "memory:false:only in the session: m3; only in the terminal: m2" and differ[3] == "skills:false:only in the terminal: s9"
          and missing["same"] is None and missing["detail"].startswith("not compared"))
    proofs.prove("n1042", ok, f"memory line {differ[1]!r}; a layer with one side missing: same={missing['same']}")
    # n1043 Permission rules parity: the tool only the worker has and the one only the person has are both named, once.
    proofs.prove("n1043", seen["gaps"] == {"onlySession": ["Bash"], "onlyTerminal": ["Grep"]}, f"gaps {json.dumps(seen['gaps'])}")

    # n1046 Sweep the failure journal: one line per failed task, its LATEST attempt, across projects, newest first; accepted and live ones left out.
    sweep = seen["failedSweep"]
    ok = sorted(sweep["attempts"]) == ["a2:projA:blocked:still broken", "a3:projB:blocked:nope"] and sweep["newestFirst"] and sweep["afterNewest"] == 0
    proofs.prove("n1046", ok, f"failure journal lines {sweep['attempts']}, newest first {sweep['newestFirst']}, after the newest failure {sweep['afterNewest']}")
    # n1047 Crash drill: a writer process is killed with SIGKILL mid-work; the census did not shrink and the readiness check still calls the file ready.
    proofs.prove("n1047", *_crash_census(tmp))
    return proofs.verdict("sma_r13", checked=len(NODES))
