"""Region 0 · Phase graph — the region scene (docs/sma-evidence.md, «Trace choice»).

A thin file: each batch of the region keeps its proofs in its own module (sma_r00_a.py, sma_r00_b.py, ...) and this scene only imports them. A batch adds exactly three lines:
its import, its node list on NODES and its prove call in scenario_sma_r00. Run: scripts/lp-drill.sh --scenario sma_r00 (add --dry-run to list the nodes).
"""
from __future__ import annotations

from lp_drill.prove import Proofs
from lp_drill.scenes.sma_r00_a import NODES_A, prove_a

NODES = []
NODES.extend(NODES_A)


def scenario_sma_r00(tmp) -> dict:
    proofs = Proofs()
    prove_a(proofs, tmp)
    return proofs.verdict("sma_r00", checked=len(NODES))
