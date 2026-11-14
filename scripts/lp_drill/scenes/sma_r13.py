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
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1036", "n1037", "n1038", "n1039", "n1040", "n1041", "n1042", "n1043"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r13_probe.ts"


def _out(args: list[str], env: dict | None = None, timeout: int = 180) -> str:
    done = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=timeout, env=env)
    return done.stdout + done.stderr


def _gate_leak_lines(tree: Path) -> list[str]:
    """The publish gate (`lp-ship.ts publishable --strict`) pointed at another tree: the `leak scan:` lines it prints."""
    env = {**os.environ, "LP_SHIP_LEAK_ROOT": str(tree)}
    return [line for line in _out(["npx", "tsx", "scripts/lp-ship.ts", "publishable", "--strict"], env).splitlines() if line.startswith("leak scan:")]


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
    return proofs.verdict("sma_r13", checked=len(NODES))
