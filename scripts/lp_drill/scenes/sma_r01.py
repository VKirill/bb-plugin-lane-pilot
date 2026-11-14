"""Region 1 · Task graph: the region scene (docs/sma-evidence.md, «Trace choice»). A thin file: each batch of the region proves its own nodes in
scenes/sma_r01_<letter>.py (NODES_<LETTER> and prove_<letter>(proofs, tmp)); this file only imports them and runs them in order."""
from __future__ import annotations

from pathlib import Path

from lp_drill.prove import Proofs
from lp_drill.scenes.sma_r01_b import NODES_B, prove_b

NODES = []
NODES += NODES_B


def scenario_sma_r01(tmp: Path) -> dict:
    proofs = Proofs()
    prove_b(proofs, tmp)
    return proofs.verdict("sma_r01", checked=len(NODES))
