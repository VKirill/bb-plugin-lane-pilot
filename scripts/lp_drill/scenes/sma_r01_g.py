"""Region 1 · Task graph, batch g: writer marker consumers and dispatch idempotency.

The probe runs the real writer finish/reaction and dispatch entrypoints against
scratch sqlite databases. It writes no hub state; this scene only records the
returned observations as proofs for the three cards.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_G = ["n251", "n252", "n330"]
PROBE_G = ROOT / "scripts/lp_drill/scenes/sma_r01_g_probe.ts"


def prove_g(proofs: Proofs, tmp: Path) -> None:
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_G)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    if done.returncode != 0:
        for node in NODES_G:
            proofs.prove(node, False, f"the probe exited {done.returncode}: {(done.stderr or done.stdout).strip()[-300:]}")
        return
    try:
        observed = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_G:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return
    if not isinstance(observed, dict):
        for node in NODES_G:
            proofs.prove(node, False, f"the probe printed a non-object result: {observed!r}")
        return
    if "fatal" in observed:
        for node in NODES_G:
            proofs.prove(node, False, f"the probe failed: {observed['fatal']}")
        return

    def value(node: str) -> dict | None:
        result = observed.get(node)
        if not isinstance(result, dict) or not result:
            proofs.prove(node, False, f"the probe returned no observation for {node}: {result!r}")
            return None
        if isinstance(result, dict) and "error" in result:
            proofs.prove(node, False, f"the probe step failed: {result['error']}")
            return None
        return result

    v = value("n251")
    if v:
        proofs.prove("n251", v.get("status") == "passed" and v.get("approach") == "use the narrow marker path" and v.get("lesson") == "keep the report short" and v.get("warning") is False,
                     f"finish accepted and recorded approach/lesson {v}")
    v = value("n252")
    if v:
        proofs.prove("n252", v.get("lesson") == "run the seed before the check" and v.get("noneReason") == "nothing new" and v.get("noneLesson") is None and v.get("proposals") == 1,
                     f"lesson consumer filed one proposal and skipped LESSON: none {v}")
    v = value("n330")
    if v:
        proofs.prove("n330", v.get("first") == {"taskId": "suite-green", "state": "queued", "dedup": None}
                     and v.get("again") == {"taskId": "suite-green", "sameAttempt": True, "state": "queued", "dedup": True}
                     and v.get("tasks") == 1 and v.get("attempts") == 1 and v.get("stagesAfterFirst") == v.get("stagesAfterAgain"),
                     f"repeat dispatch {v.get('again')} left tasks={v.get('tasks')}, attempts={v.get('attempts')}, stages {v.get('stagesAfterFirst')}->{v.get('stagesAfterAgain')}")
