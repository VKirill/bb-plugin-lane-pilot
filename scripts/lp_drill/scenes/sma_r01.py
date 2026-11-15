"""Region 1 · Task graph: the region scene (docs/sma-evidence.md, «Trace choice»). A thin file: each batch of the region proves its own nodes in
scenes/sma_r01_<letter>.py (NODES_<LETTER> and prove_<letter>(proofs, tmp)); this file only imports them and runs them in order.

LP_DRILL_SMA_PRIMARY_ONLY=1 (the owner's PRIMARY-only rule: no scratch `git worktree add`): the batches whose probes or observing tests create
real worktrees are held — never invoked — and their nodes are receipted as notProved with the seam named. Unset runs every batch as before."""
from __future__ import annotations

import os
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

# Batches held under LP_DRILL_SMA_PRIMARY_ONLY=1: their probes or observing tests run a real `git worktree add`, which the PRIMARY-only rule
# bans even on scratch repositories. A held batch is never invoked; its nodes go to notProved — never proved, never silently dropped.
PRIMARY_ONLY_HELD = {
    "a": "PRIMARY-only hold: the batch's observing tests create real worktrees (tests/baseline/world.ts gitCreateWorktree→createWorktree; four-proofs-r01-a4 repo()→git worktree add)",
    "c": "PRIMARY-only hold: sma_r01_c_probe.ts step n222 calls createWorktree (git worktree add); the probe has no observe filter",
    "d": "PRIMARY-only hold: sma_r01_d_probe.ts observeCandidateMerge calls createWorktree twice (n258); the probe has no observe filter",
    "e": "PRIMARY-only hold: sma_r01_e_probe.ts world-e worktreeOf runs git worktree add (n290, n291, n296); the probe has no observe filter",
}
BATCHES = (
    ("a", NODES_A, prove_a), ("b", NODES_B, prove_b), ("c", NODES_C, prove_c), ("d", NODES_D, prove_d),
    ("e", NODES_E, prove_e), ("f", NODES_F, prove_f), ("g", NODES_G, prove_g), ("h", NODES_H, prove_h),
)


def scenario_sma_r01(tmp: Path) -> dict:
    proofs = Proofs()
    primary_only = os.environ.get("LP_DRILL_SMA_PRIMARY_ONLY") == "1"
    held: dict[str, str] = {}
    for name, nodes, prove in BATCHES:
        reason = PRIMARY_ONLY_HELD.get(name) if primary_only else None
        if reason is None:
            prove(proofs, tmp)
        else:
            held.update(dict.fromkeys(nodes, reason))
    details: dict = {"checked": len(NODES) - len(held)}
    if primary_only:
        details["notProved"] = held
        details["primaryOnly"] = True
    return proofs.verdict("sma_r01", **details)
