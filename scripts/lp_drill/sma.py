"""Region scenes of the SMA-parity proof (docs/sma-evidence.md): `scripts/lp_drill/scenes/sma_rNN.py` (NN = two-digit region) is found by
its file name, so adding one edits no shared list. Each defines `NODES` (the map nodes it proves) and `scenario_sma_rNN(tmp) -> dict`.
They are not in ALL, EXTRA, QUICK or any suite: `--scenario sma_r13` runs one, `--suite sma` runs every one that exists."""
from __future__ import annotations

import importlib
import re
from pathlib import Path

SMA_FILE = re.compile(r"^sma_r\d\d$")


def discover() -> dict[str, dict]:
    """name -> {"run": scenario function, "nodes": [node ids]} for every scenes/sma_rNN.py, sorted by name."""
    found: dict[str, dict] = {}
    for path in sorted((Path(__file__).resolve().parent / "scenes").glob("sma_r[0-9][0-9].py")):
        if not SMA_FILE.match(path.stem):
            continue
        module = importlib.import_module(f"lp_drill.scenes.{path.stem}")
        run = getattr(module, f"scenario_{path.stem}", None)
        nodes = getattr(module, "NODES", None)
        if not callable(run) or not nodes:
            raise RuntimeError(f"{path.name} must define scenario_{path.stem}(tmp) and NODES (the map nodes it proves)")
        found[path.stem] = {"run": run, "nodes": list(nodes)}
    return found
