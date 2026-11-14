"""Region 9 · Person and window, batch c (n814 … n849) — proofs of the region scene sma_r09 (docs/sma-evidence.md, «Trace choice»).

Every node of this batch is a screen of the window or a door it presses, and its result is a call that goes out, a row that appears or a refusal. The screens are
rendered for real in jsdom and the doors (the cockpit's server table, the forge tool, the PM's update, the facts tool, the board builder, the draft path) are run on
a scratch database with a fake plugin host, by the tests of the checked-out commit: this scene runs those test files once and a node is proved when every case
tagged with its card id passed and at least one ran. There is no probe: no value of these nodes needs the hub. Run: scripts/lp-drill.sh --scenario sma_r09
(this module adds its nodes to that scene).
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

# node -> card id (the cases tagged [sma:<card id>] in TEST_FILES_C must all pass).
CARDS_C = {
    "n814": "d_agent_model", "n815": "d_skill_assign", "n816": "d_skill_create", "n817": "d_mcp_toggle", "n820": "d_enqueue", "n821": "d_forge", "n822": "d_backlog_promote",
    "n823": "d_priority", "n824": "d_task_suggest", "n825": "d_task_words", "n826": "d_stage_confirm", "n829": "m_sw_sources", "n831": "m_sw_conv_settings",
    "n832": "m_sw_chat_draft", "n833": "m_sw_batch_draft", "n834": "m_sw_decision_prop", "n836": "m_sw_awaiting", "n839": "m_sw_workbook_panel", "n840": "m_sw_visible_time",
    "n841": "m_sw_registry", "n842": "m_sw_kpi", "n843": "m_sw_dayfeed", "n844": "m_sw_done_unfold", "n845": "m_sw_done_list", "n846": "m_sw_unit_card",
    "n847": "m_sw_unit_row", "n848": "m_sw_piece_line", "n849": "m_sw_artifact",
}
NODES_C = sorted(CARDS_C)
TEST_FILES_C = ["tests/sma/four-proofs-r09-c.test.ts", "tests/sma/four-proofs-r09-c.test.tsx", "tests/role-models-ui.test.tsx", "tests/agent-access-ui.test.tsx",
                "tests/sma/parity-g6-rest-a.test.ts", "tests/sma/parity-d10-rest-2.test.ts", "tests/sma/parity-h4-window.test.ts", "tests/sma/parity-d9-records-2.test.ts",
                "tests/sma/parity-d6-window-1.test.ts"]


def _cases_c() -> tuple[list[dict], str]:
    run = subprocess.run(["npx", "--yes", "vitest", "run", *TEST_FILES_C, "-t", "sma:", "--maxWorkers=2", "--reporter=json"], cwd=ROOT, capture_output=True, text=True, timeout=1200)
    try:
        report = json.loads(run.stdout[run.stdout.index("{"):])
        return [case for file in report["testResults"] for case in file["assertionResults"]], ""
    except (ValueError, KeyError):
        return [], f"no vitest report (exit {run.returncode}): {(run.stderr or run.stdout).strip()[-200:]}"


def prove_c(proofs: Proofs, tmp) -> None:
    cases, error = _cases_c()
    for node, card in CARDS_C.items():
        mine = [case for case in cases if f"[sma:{card}]" in case["title"]]
        ok = bool(mine) and all(case["status"] == "passed" for case in mine)
        detail = f"{len(mine)} case(s) tagged [sma:{card}] rendered or called for real in jsdom/node by the tests of this commit: {[case['status'] for case in mine]}"
        if not mine:
            detail = error or f"no test tagged [sma:{card}] ran"
        proofs.prove(node, ok, detail)
