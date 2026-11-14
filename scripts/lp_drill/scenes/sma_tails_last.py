"""The last tails of the SMA-parity proof, a batch module of the tails scene sma_tails.py (docs/sma-evidence.md, «Trace choice»): n1230 and n1362.

Neither writes a hub row a trace could read: n1230 is what the designer is launched with, n1362 is the brief of the project start's preview step. The probe
(sma_tails_last_probe.ts, run by vite-node) runs the REAL code of the commit on a fake plugin host and a scratch database (no model, no hub write), and
prove_last() compares each result with what the node's card expects.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_LAST = ["n1230", "n1362"]
PROBE_LAST = ROOT / "scripts/lp_drill/scenes/sma_tails_last_probe.ts"


def prove_last(proofs: Proofs, tmp: Path) -> None:
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_LAST)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_LAST:
            proofs.prove(node, False, f"the last-tails probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return

    def has(node: str) -> dict:
        value = seen.get(node)
        if isinstance(value, dict) and "error" not in value:
            return value
        proofs.prove(node, False, f"the probe step failed: {value.get('error') if isinstance(value, dict) else value}")
        return {}

    d = has("n1230")
    if d:
        proofs.prove("n1230", d.get("chat") == ["project-design", "modern-web-guidance", "page-prototype"] and d.get("specialist") == ["env-catalog", "project-design", "modern-web-guidance", "page-prototype"] and d.get("copyChat") == ["copywriter"],
                     f"the designer's chat is launched with {d.get('chat')}, as a specialist with {d.get('specialist')}; the copy editor's chat with {d.get('copyChat')}")
    d = has("n1362")
    if d:
        proofs.prove("n1362", d.get("block") == [d.get("expected")] and d.get("written") == 0,
                     f"the preview step of project-start shows the hub's notes {d.get('block')} (another project's note and an unconfirmed guess left out); memory rows written: {d.get('written')}")
