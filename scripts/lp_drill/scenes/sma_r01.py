<<<<<<< HEAD
"""Region 1 · Task graph: a thin scene that only imports the batch modules (sma_r01_a.py, sma_r01_b.py, ...).

Each batch keeps its node list and its proofs in its own file; this file holds one import, one NODES extension and one call per batch.
Run: scripts/lp-drill.sh --scenario sma_r01.
"""
=======
"""Region 1 · Task graph: the region scene (docs/sma-evidence.md, «Trace choice»). A thin file: each batch of the region proves its own nodes in
scenes/sma_r01_<letter>.py (NODES_<LETTER> and prove_<letter>(proofs, tmp)); this file only imports them and runs them in order."""
>>>>>>> integ-0567
from __future__ import annotations

from pathlib import Path

from lp_drill.prove import Proofs
<<<<<<< HEAD
from lp_drill.scenes.sma_r01_a import NODES_A, prove_a

NODES = []
NODES += NODES_A
=======
from lp_drill.scenes.sma_r01_b import NODES_B, prove_b

NODES = []
NODES += NODES_B
>>>>>>> integ-0567


def scenario_sma_r01(tmp: Path) -> dict:
    proofs = Proofs()
<<<<<<< HEAD
    prove_a(proofs, tmp)
=======
    prove_b(proofs, tmp)
>>>>>>> integ-0567
    return proofs.verdict("sma_r01", checked=len(NODES))
