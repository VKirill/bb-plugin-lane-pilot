"""Model-free tail traces for the five SMA nodes owned by the tail scene."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1059", "n1060", "n1077", "n132", "n1621"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_tail_traces_probe.ts"


def prove_tail_traces(proofs: Proofs, tmp: Path) -> None:
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    if done.returncode != 0:
        for node in NODES:
            proofs.prove(node, False, f"tail-traces probe exited {done.returncode}: {(done.stderr or done.stdout).strip()[-300:]}")
        return
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
        if not isinstance(seen, dict):
            raise ValueError("probe result must be an object")
    except (ValueError, IndexError):
        for node in NODES:
            proofs.prove(node, False, f"tail-traces probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return

    def get(node: str) -> dict:
        value = seen.get(node)
        if isinstance(value, dict) and value and "error" not in value:
            return value
        proofs.prove(node, False, f"tail-traces step failed: {value.get('error') if isinstance(value, dict) else value}")
        return {}

    d = get("n1059")
    if d:
        accepted = d.get("accepted", {})
        replaced = d.get("replaced", {})
        proofs.prove("n1059", accepted.get("state") == "accepted" and accepted.get("targetPrefix") == "note" and len(accepted.get("memoryRows", [])) == 1
                     and replaced.get("state") == "adopted" and replaced.get("target") == "rule:rp-tail" and replaced.get("proposals") == ["Run the migration before the seed"],
                     f"accept stored {accepted.get('targetPrefix')} with memory rows {accepted.get('memoryRows')}; replacement {replaced.get('state')} -> {replaced.get('target')}")

    d = get("n1060")
    if d:
        proofs.prove("n1060", d.get("state") == "passed" and d.get("stored") == 1 and d.get("unsupportedDropped") == 1
                     and len(d.get("recordIds", [])) == 1 and d.get("row", {}).get("status") == "active" and d.get("row", {}).get("task") == "tail-task"
                     and d.get("fts") == [1],
                     f"maintenance receipt {d.get('state')}: stored {d.get('stored')}, dropped {d.get('unsupportedDropped')}, ids {d.get('recordIds')}, row {d.get('row')}")

    d = get("n1077")
    if d:
        rows = d.get("empty", {}).get("rows", [])
        proofs.prove("n1077", d.get("empty", {}).get("miss") is True and d.get("active") is False and d.get("rowCount") == 1
                     and d.get("onlyEmpty") is True and len(rows) == 1 and rows[0].get("kind") == "empty",
                     f"empty query miss {d.get('empty', {}).get('miss')}, recorded rows {rows}; active query miss {d.get('active')}")

    d = get("n132")
    if d:
        proofs.prove("n132", d.get("phase", {}).get("ambiguous") is True and d.get("task", {}).get("ambiguous") is True,
                     f"phase ambiguity refused {d.get('phase', {}).get('error')!r}; task-file resolver returned null {d.get('task', {}).get('ambiguous')}")

    d = get("n1621")
    if d:
        path = d.get("path", [])
        archive = d.get("archiveStep") or {}
        proofs.prove("n1621", d.get("status") == "succeeded" and "snapshot" in path and "archive" in path
                     and archive.get("kept") is False and archive.get("files") == ["ROADMAP.md", "REQUIREMENTS.md"],
                     f"milestone-close path {path}; archive output {archive}")
