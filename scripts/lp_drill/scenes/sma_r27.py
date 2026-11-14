"""Region 27 · Shipping and honest numbers: the region scene (docs/sma-evidence.md, «Trace choice»).

Model-free and hub-free. The probe (sma_r27_probe.ts) runs the REAL ship checks of the commit under drill: `scripts/lp-ship.ts` (doc-audit,
vendor, licenses, badge, publishable, predict-lint, freshness, lane, batch, explain, watch and the publish gate) against fixture release trees
with a stand-in `bb` on PATH, the explain verb, the daily ship watch against a throw-away git checkout, and a live window run (lp-ui-drive)
through a real browser against a local page. It prints {node: {ok, detail}}; this scene prove()s each node with what was observed.

Never a real deploy or publish: the gate runs on a fixture tree with a stand-in `bb plugin build`, never on this checkout. The checkout itself is
only read: its `predict-lint` and `doc-audit` exits and the last line of ~/.lane-pilot/deploys.log are noted in the scene's details.
Run: scripts/lp-drill.sh --scenario sma_r27. Nodes n1738 (npm test: badge check — no behaviour) and n1748 (bb-core's window build) are not here.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1733", "n1734", "n1735", "n1736", "n1737", "n1739", "n1740", "n1741", "n1742", "n1743", "n1744", "n1745", "n1746", "n1747",
         "n1749", "n1751", "n1752", "n1753", "n1754", "n1755"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r27_probe.ts"


def scenario_sma_r27(tmp: Path) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=1500)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r27", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])
    nodes = seen["nodes"]
    for node in NODES:
        row = nodes.get(node)
        if row is None:
            proofs.prove(node, False, "the probe did not observe this node")
            continue
        proofs.prove(node, bool(row["ok"]), row["detail"])
    # The checkout itself, as the gate would meet it: noted, never judged here (a doc finding is the docs' to fix, not this scene's failure).
    return proofs.verdict("sma_r27", checked=len(NODES), checkout=seen["checkout"])
