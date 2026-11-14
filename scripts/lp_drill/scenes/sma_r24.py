"""Region 24 · Safety nets, budget and guards: the region scene (docs/sma-evidence.md, «Trace choice»).

Model-free, network-free and hub-free. The probe (sma_r24_probe.ts) runs the REAL safety-net code paths of the commit under drill on scratch
state: the owner verbs (undo, airbag, breaker, gates, evidence, integrity, statusline) through the plugin's CLI on a fake host with an
in-memory database, a revert of an accepted change in a throw-away git repository, the guard hook (guard_shell.py) as a real process for the
airbag, the reflex, the dependency-store guard and the permit round trip, the permit answer, the stall rules, the price list and spend book,
the breaker, the convention gates, the evidence store, the disarm re-arm, the helper's merged settings, the store journal, the progress
journal and the tier file. It prints {nodes: {node: {ok, detail}}}; this scene prove()s each node with what was observed.

The probe runs with HOME pointing at a scratch folder, so the guard's permit and reflex files and the store journal never touch the real home;
a check that would write under a HOME that is not a scratch folder refuses. Run: scripts/lp-drill.sh --scenario sma_r24.
Not here: n1661 (a deviation: an unset cap holds the paid line), n1662 (closed by a hub source), n1675 (behaviour gap), n1677 (bb-core).
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1653", "n1654", "n1655", "n1656", "n1657", "n1658", "n1659", "n1660", "n1663", "n1664", "n1665", "n1666", "n1667", "n1668",
         "n1669", "n1670", "n1671", "n1672", "n1673", "n1674", "n1676", "n1678", "n1679"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r24_probe.ts"


def scenario_sma_r24(tmp: Path) -> dict:
    proofs = Proofs()
    home = tmp / "home"
    home.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "HOME": str(home)}
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=900, env=env)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r24", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])
    nodes = seen["nodes"]
    for node in NODES:
        row = nodes.get(node)
        if row is None:
            proofs.prove(node, False, "the probe did not observe this node")
            continue
        proofs.prove(node, bool(row["ok"]), row["detail"])
    return proofs.verdict("sma_r24", checked=len(NODES), scratch_home=seen["home"])
