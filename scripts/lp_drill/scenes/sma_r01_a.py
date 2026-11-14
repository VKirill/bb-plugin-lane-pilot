"""Region 1 · Task graph, batch a (n158..n189): the drill proofs of the nodes whose trace is `drill("sma_r01")`.

The card results are checked by the batch's behaviour tests, tagged `[sma:<id>]` in their names (tests/sma/task-graph-*.test.ts,
tests/sma/parity-*.test.ts, tests/sma/four-proofs-r01-a*.test.ts). The scene runs them for real on scratch databases and folders (no model,
no hub write) and proves a node only when every test that carries its tag passed and at least one exists.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT

NODES_A = ["n161", "n162", "n165", "n166", "n168", "n170", "n176", "n178", "n184", "n186", "n187", "n189"]
TAGS_A = {"n161": "ac_permit", "n162": "ac_reserve", "n165": "ac_budget_q", "n166": "ac_pocket", "n168": "ac_baseline_red", "n170": "ac_channel",
          "n176": "ae_auto_retry", "n178": "ae_parked", "n184": "ag_infra", "n186": "ag_host_commit", "n187": "ag_design_gate", "n189": "ag_doc_gate"}
FILES_A = ["tests/sma/task-graph-1.test.ts", "tests/sma/task-graph-3.test.ts", "tests/sma/parity-b1-admit.test.ts", "tests/sma/parity-a6-misc.test.ts",
           "tests/sma/four-proofs-r01-a.test.ts", "tests/sma/four-proofs-r01-a2.test.ts", "tests/sma/four-proofs-r01-a3.test.ts", "tests/sma/four-proofs-r01-a4.test.ts"]


def prove_a(proofs, tmp: Path) -> None:
    out = tmp / "sma-r01-a.json"
    subprocess.run(["npx", "vitest", "run", "--maxWorkers=3", "--reporter=json", f"--outputFile={out}", *FILES_A], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        results = [row for suite in json.loads(out.read_text())["testResults"] for row in suite["assertionResults"]]
    except (OSError, ValueError, KeyError):
        results = []
    for node, tag in TAGS_A.items():
        mine = [row for row in results if f"[sma:{tag}]" in row["fullName"]]
        failed = [row["title"][:60] for row in mine if row["status"] != "passed"]
        proofs.prove(node, bool(mine) and not failed, f"{len(mine)} tests tagged [sma:{tag}], failed: {failed or 'none'}")
