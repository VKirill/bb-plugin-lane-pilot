"""Region 9 · Person and window, batch b (n786 … n813) — proofs of the region scene sma_r09 (docs/sma-evidence.md, «Trace choice»).

The server halves the operations screens call (first run, coordination, bring your own helpers, the update, the backlog board, the planning home) are run
through the REAL RPCs and functions of the commit under drill by sma_r09_b_probe.ts (a fake plugin host that records every host call, a scratch database,
no model, no hub write). The SCREENS (first run, coordination, ship, forge, the project rail and choice, machines, diagnostics, memory search) are rendered
by their own jsdom tests: this scene runs those test files and a node is proved when every case tagged with its card id passed AND, where the probe has a
value for it, the value is the card's expected one. Run: scripts/lp-drill.sh --scenario sma_r09 (this module adds its nodes to that scene).
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

# node -> card id (the cases tagged [sma:<card id>] in TEST_FILES_B must all pass).
CARDS_B = {
    "n786": "d_search", "n787": "d_backlog", "n788": "d_coordination", "n789": "d_diagnostics", "n790": "d_projects", "n793": "d_project_select", "n794": "d_project_planning",
    "n795": "d_machines", "n804": "d_import_scan", "n805": "d_import_enroll", "n806": "d_onboarding", "n807": "d_onboarding_answer", "n808": "d_onboarding_done",
    "n809": "d_claim_clear", "n810": "d_ship_gate", "n811": "d_ship_publish", "n813": "d_update_run",
}
NODES_B = sorted(CARDS_B)
PROBE_B = ROOT / "scripts/lp_drill/scenes/sma_r09_b_probe.ts"
TEST_FILES_B = ["tests/sma/four-proofs-r09-b.test.ts", "tests/sma/four-proofs-r09-b.test.tsx", "tests/sma/parity-d6-window-2.test.ts", "tests/sma/parity-g5-planning.test.ts", "tests/sma/parity-h4-window.test.ts"]


def _cases_b() -> tuple[list[dict], str]:
    run = subprocess.run(["npx", "--yes", "vitest", "run", *TEST_FILES_B, "-t", "sma:d_", "--maxWorkers=2", "--reporter=json"], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        report = json.loads(run.stdout[run.stdout.index("{"):])
        return [case for file in report["testResults"] for case in file["assertionResults"]], ""
    except (ValueError, KeyError):
        return [], f"no vitest report (exit {run.returncode}): {(run.stderr or run.stdout).strip()[-200:]}"


def prove_b(proofs: Proofs, tmp) -> None:
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_B)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        s = None
        probe_error = f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"
    else:
        probe_error = ""

    # What the real server half answered, by node: (ok, what was observed). A node without an entry is proved by its tests alone.
    probed: dict[str, tuple[bool, str]] = {}
    if s:
        f = s["firstRun"]
        probed["n806"] = (f["freshNeeded"] is True and f["steps"] == ["goal", "writer", "quality", "words"] and f["afterNeeded"] is False, f"fresh project needs a first run {f['freshNeeded']}, steps {f['steps']}, after the finish {f['afterNeeded']}")
        probed["n807"] = (f["answered"] == {"goal": "a shop", "writer": "codex / gpt-6-luna", "quality": "Full", "words": "yes"}, f"the draft keeps {f['answered']}")
        probed["n808"] = (f["finished"] == {"written": ["writer.provider", "writer.model", "quality_mode", "owner.words"], "goal": True}
                          and f["settings"] == {"provider": "codex", "model": "gpt-6-luna", "quality": "full", "words": "on", "goal": "a shop"} and f["done"] == "number", f"finish wrote {f['finished']} -> settings {f['settings']}")
        c = s["coord"]
        probed["n788"] = (c["commands"][0] == "lane-coord status" and c["status"] == {"exitCode": 0, "output": "ok"}, f"status ran {c['commands'][0]!r} -> {c['status']}")
        probed["n809"] = (c["commands"][1] == "lane-coord force-clear 't-1rm-rf' --reason 'its \"bad\"'", f"clear ran {c['commands'][1]!r}")
        h = s["helpers"]
        probed["n804"] = (h["found"] == ["agent:yard", "skill:pick"], f"the scan listed {h['found']}")
        probed["n805"] = (h["taken"] == [{"name": "yard", "status": "applied"}, {"name": "pick", "status": "kept: a draft with this name exists"}]
                          and h["paths"] == [".agents/forge/roles/yard/yard.md", ".agents/forge/skills/pick/SKILL.md"], f"drafts {h['taken']} at {h['paths']}")
        probed["n813"] = (s["update"] == ["lane-stack-update --json", "lane-stack-update --json --yes"], f"the machine was asked {s['update']}")
        b = s["backlog"]
        probed["n787"] = (b == {"issuable": ["t-01"], "decompose": ["t-02"], "needsEstimate": ["t-03"], "blocked": ["t-04"]}, f"board of a real todos folder {b}")
        p = s["planning"]
        probed["n794"] = (p == {"home": "/srv/plans", "unset": "/checkout", "invalid": "/checkout", "none": None}, f"planning root {p}")

    cases, error = _cases_b()
    for node, card in CARDS_B.items():
        mine = [case for case in cases if f"[sma:{card}]" in case["title"]]
        tests_ok = bool(mine) and all(case["status"] == "passed" for case in mine)
        if node in probed:
            ok = tests_ok and probed[node][0]
            detail = f"{probed[node][1]}; {len(mine)} case(s) tagged [sma:{card}] of this commit: {[case['status'] for case in mine]}"
        else:
            ok = tests_ok
            detail = f"{len(mine)} case(s) tagged [sma:{card}] rendered for real in jsdom/node by the tests of this commit: {[case['status'] for case in mine]}"
        if not mine:
            detail = error or f"no test tagged [sma:{card}] ran"
        elif s is None and node in CARDS_B and node in ("n806", "n807", "n808", "n788", "n809", "n804", "n805", "n813", "n787", "n794"):
            ok, detail = False, probe_error
        proofs.prove(node, ok, detail)
