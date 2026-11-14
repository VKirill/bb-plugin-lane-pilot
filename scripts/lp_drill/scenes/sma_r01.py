"""Region 1 · Task graph: a thin scene that only imports the batch modules (sma_r01_a.py, sma_r01_b.py, ...).

Each batch keeps its node list and its proofs in its own file; this file holds one import, one NODES extension and one call per batch.
Run: scripts/lp-drill.sh --scenario sma_r01.
"""
from __future__ import annotations

from pathlib import Path

from lp_drill.prove import Proofs
from lp_drill.scenes.sma_r01_a import NODES_A, prove_a

NODES = []
NODES += NODES_A


def scenario_sma_r01(tmp: Path) -> dict:
    proofs = Proofs()
    prove_a(proofs, tmp)
    return proofs.verdict("sma_r01", checked=len(NODES))
