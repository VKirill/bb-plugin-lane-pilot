"""Region 1 · Task graph: the region scene (docs/sma-evidence.md, «Trace choice»). A thin file: each batch of the region proves its own nodes in
scenes/sma_r01_<letter>.py (NODES_<LETTER> and prove_<letter>(proofs, tmp)); this file only imports them and runs them in order."""
from __future__ import annotations

from pathlib import Path

from lp_drill.prove import Proofs
from lp_drill.scenes.sma_r01_a import NODES_A, prove_a
from lp_drill.scenes.sma_r01_b import NODES_B, prove_b
from lp_drill.scenes.sma_r01_c import NODES_C, prove_c
from lp_drill.scenes.sma_r01_d import NODES_D, prove_d
from lp_drill.scenes.sma_r01_e import NODES_E, prove_e
from lp_drill.scenes.sma_r01_f import NODES_F, prove_f
from lp_drill.scenes.sma_r01_g import NODES_G, prove_g
from lp_drill.scenes.sma_r01_h import NODES_H, prove_h

NODES = []
NODES += NODES_A
NODES += NODES_B
NODES += NODES_C
NODES += NODES_D
NODES += NODES_E
NODES += NODES_F
NODES += NODES_G
NODES += NODES_H


def scenario_sma_r01(tmp: Path) -> dict:
    proofs = Proofs()
    prove_a(proofs, tmp)
    prove_b(proofs, tmp)
    prove_c(proofs, tmp)
    prove_d(proofs, tmp)
    prove_e(proofs, tmp)
    prove_f(proofs, tmp)
    prove_g(proofs, tmp)
    prove_h(proofs, tmp)
    return proofs.verdict("sma_r01", checked=len(NODES))
