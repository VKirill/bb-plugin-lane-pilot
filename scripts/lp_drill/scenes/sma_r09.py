"""Region 9 · Person and window — the region scene (docs/sma-evidence.md, «Trace choice»). Batches add their nodes to the same file.

Two kinds of node live here. The doors the window reaches on the server (the conveyor switch, the UAT line, the withdraw gate, the work-file path gate,
the board and the card of a task, the memory index and lint, the stage actions of a phase) are run through the REAL handlers and functions of the commit
under drill by sma_r09_probe.ts (a fake plugin host, a scratch database, no model, no hub write) and prove()d here with the card's expected result.
The SCREENS (accept, return, batch, the phase card, money, workers, memory drafts, the task board, the live panel, the window) are rendered by their
own jsdom tests: this scene runs those test files of the checked-out commit and proves a node when every case tagged with its card id passed; the
detail of such a line says so and counts the cases. Run: scripts/lp-drill.sh --scenario sma_r09.

To add a node: put it in NODES, then either compute its value in the probe (a block that puts it on `out`) and prove() it in `probe_nodes`, or write a
`[sma:<card id>]` test and list the id in SCREENS; put `trace: drill("sma_r09")` on its line of evidence/r09.ts.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs
from lp_drill.scenes.sma_r09_b import NODES_B, prove_b
from lp_drill.scenes.sma_r09_c import NODES_C, prove_c

# node -> card id, for the nodes proved by a test file of the commit (screens, and handlers whose result is a whole screen or an rpc answer).
SCREENS = {
    "n755": "d_approve", "n756": "d_return", "n757": "d_batch", "n758": "d_batch_suggest", "n760": "d_wave_hold", "n761": "d_redirect", "n762": "d_cancel",
    "n763": "d_close", "n765": "d_agent_toggle", "n766": "d_budget_set", "n767": "d_mem_drafts", "n768": "d_mem_apply", "n773": "d_decision_answer",
    "n774": "d_index", "n777": "d_done", "n779": "d_diff", "n780": "d_events", "n781": "d_harness", "n782": "d_phase_card", "n783": "d_phase_files",
}
# node -> card id, for the nodes proved from the probe's values.
PROBED = {"n759": "d_batch_decide", "n764": "d_pipeline", "n769": "d_mem_index", "n770": "d_mem_lint", "n771": "d_phase_stage", "n772": "d_phase_uat",
          "n776": "d_state", "n778": "d_task", "n784": "d_artifact"}
NODES = sorted([*SCREENS, *PROBED])
NODES = sorted([*NODES, *NODES_B])
NODES = sorted([*NODES, *NODES_C])
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r09_probe.ts"
TEST_FILES = ["tests/sma/four-proofs-r09-a.test.ts", "tests/sma/four-proofs-r09-a.test.tsx", "tests/sma/four-proofs-r09-a2.test.tsx", "tests/sma/four-proofs-r09-a3.test.tsx",
              "tests/sma/parity-d10-rest-1.test.ts", "tests/sma/parity-d5-phase-1.test.ts"]


def _cases() -> tuple[list[dict], str]:
    ui = subprocess.run(["npx", "--yes", "vitest", "run", *TEST_FILES, "-t", "sma:d_", "--maxWorkers=2", "--reporter=json"], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        report = json.loads(ui.stdout[ui.stdout.index("{"):])
        return [case for file in report["testResults"] for case in file["assertionResults"]], ""
    except (ValueError, KeyError):
        return [], f"no vitest report (exit {ui.returncode}): {(ui.stderr or ui.stdout).strip()[-200:]}"


def scenario_sma_r09(tmp) -> dict:
    proofs = Proofs()
    # vite-node, not tsx: the probe loads the whole plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r09", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n764 The conveyor switch of the window: off stores when and why, a second off keeps the first word, on clears it.
    c = s["conveyor"]
    ok = (c["untouched"] == {"on": True, "since": None, "reason": None} and c["off"] == {"on": False, "reason": "deploy window", "stamped": True}
          and c["sameOnSecondOff"] and c["sameOnRead"] and c["on"] == {"on": True, "since": None, "reason": None})
    proofs.prove("n764", ok, f"untouched {c['untouched']}; off -> {c['off']}; a second off changes nothing: {c['sameOnSecondOff']}; on -> {c['on']}")

    # n772 One numbered UAT line marked by its number, CRLF kept, an unknown number refused.
    u = s["uat"]
    ok = u["failed"] == "# UAT\r\n- [!] 1. a: given g — bad\r\n- [ ] 2. b: x\r\n" and u["passed"] == "- [x] 1. a: g" and u["none"] is None
    proofs.prove("n772", ok, f"line 1 failed with a note -> {u['failed']!r}; passed -> {u['passed']!r}; line 9 -> {u['none']}")

    # n759 The owner's per-piece decision: a piece trims out of an open plan, never from a closed phase, the design stage, an unknown or an issued piece.
    w = s["withdraw"]
    ok = (w["open"] is None and "closed" in w["closed"] and "at design" in w["design"] and w["unknown"].startswith("no piece zzz") and w["issued"] == "issued pieces are canceled, not withdrawn")
    proofs.prove("n759", ok, f"open plan -> {w['open']}; closed -> {w['closed']!r}; design -> {w['design']!r}; unknown -> {w['unknown']!r}; issued -> {w['issued']!r}")

    # n784 The work-file path gate: ordinary code passes, an escape, an absolute path, .git and a secret name are refused.
    p = s["paths"]
    ok = (p["src/app.ts"] is None and p["src/keyboard.ts"] is None and all((p[bad] or "").startswith("work file refused") for bad in ["../x", "/etc/passwd", ".git/config", "a/.env"]))
    proofs.prove("n784", ok, f"src/app.ts -> {p['src/app.ts']}; ../x -> {p['../x']!r}; a/.env -> {p['a/.env']!r}")

    # n778 The card of a task: contract, stages in the pipeline's order, the PM chat; none for an unknown task.
    k = s["card"]
    ok = (k["title"] == "The form saves" and k["techTitle"] == "Fix the form" and k["state"] == "running" and k["stages"] == ["plan-critique:passed", "code-critique:failed"]
          and k["contract"]["acceptance"] == ["form saves"] and k["contract"]["checks"] == ["npm test"] and k["pm"] == "thr_pm" and k["missing"] is None)
    proofs.prove("n778", ok, f"card «{k['title']}» ({k['techTitle']}) {k['state']}, stages {k['stages']}, contract {k['contract']}, unknown task -> {k['missing']}")

    # n776 The board's row of that task: its column, and «held» only while the hold is in the future.
    b = s["board"]
    proofs.prove("n776", b["column"] == "running" and b["free"] is False and b["held"] is True and b["title"] == "The form saves", f"column {b['column']}, held before the hold {b['free']}, with a hold {b['held']}")

    # n769 / n770 The memory index rebuild counts what it rebuilt; the lint counts the records no trace leads back from (an owner's or an import is none).
    m = s["memory"]
    proofs.prove("n769", m["rebuilt"] == {"active": 1, "added": 1, "stale": 0} and m["again"] == {"active": 1, "added": 0, "stale": 0}, f"after a lost entry {m['rebuilt']}; a second rebuild {m['again']}")
    proofs.prove("n770", m["untraced"] == ["orphan1"], f"records without a trace: {m['untraced']} (an owner's and an import's record planted beside it are not listed)")

    # n771 Each stage action of the phase door reaches its own function and answers with the phase's status.
    st = s["stages"]
    proofs.prove("n771", st["seen"] == ["open", "context", "plan", "planCheck", "drawing", "goalAudit", "correct", "answer", "lessons"] and st["answers"][0] == {"status": "ph_new"} and all(a == {"status": "ph1"} for a in st["answers"][1:]),
                 f"actions reached {st['seen']}")

    # The screens: their own tests of this commit, run once.
    cases, error = _cases()
    for node, card in SCREENS.items():
        mine = [case for case in cases if f"[sma:{card}]" in case["title"]]
        ok = bool(mine) and all(case["status"] == "passed" for case in mine)
        detail = f"{len(mine)} case(s) tagged [sma:{card}] rendered or called for real in jsdom/node by the tests of this commit: {[case['status'] for case in mine]}" if mine else (error or f"no test tagged [sma:{card}] ran")
        proofs.prove(node, ok, detail)
    prove_b(proofs, tmp)
    prove_c(proofs, tmp)
    return proofs.verdict("sma_r09", checked=len(NODES))
