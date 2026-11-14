"""Region 0 · Phase graph: the region scene (docs/sma-evidence.md, «Trace choice»).

A thin file: each batch of the region keeps its checks in a module of its own (sma_r00_<letter>.py with NODES_<LETTER> and prove_<letter>(proofs, tmp)) and adds
three single lines here — its import, its NODES and its call. Run: scripts/lp-drill.sh --scenario sma_r00 (add --dry-run to list the nodes it proves).
"""
from __future__ import annotations

from lp_drill.prove import Proofs
from lp_drill.scenes.sma_r00_b import NODES_B, prove_b

NODES = []
NODES += NODES_B


def scenario_sma_r00(tmp) -> dict:
    proofs = Proofs()
    prove_b(proofs, tmp)
    return proofs.verdict("sma_r00", checked=len(NODES))
