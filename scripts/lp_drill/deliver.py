"""A drill receipt is judged where the owner measures (`bb lane-pilot sma-map --states --live` on the hub), so a run copies its
receipt into the hub's plugin folder over the same ssh channel hubsql uses. A failure is a problem line, never a silent skip."""
from __future__ import annotations

import os
import shlex
from pathlib import Path

from lp_drill.env import HUB, KEY
from lp_drill.hub import log, run

# The hub's plugin folder; $HOME is the hub user's. LP_DRILL_HUB_RECEIPTS overrides it with an absolute path; `off` turns delivery off (logged).
HUB_RECEIPTS_DEFAULT = "$HOME/Documents/BB-сервис/plugins/bb-plugin-lane-pilot/.agents/runs/drills"


def deliver_receipt(path: Path, runner=run) -> str | None:
    """Copy the receipt file to the hub. Returns a problem line when it did not arrive, None when it did (or delivery is off)."""
    target = os.environ.get("LP_DRILL_HUB_RECEIPTS", HUB_RECEIPTS_DEFAULT)
    if target == "off":
        log("receipt delivery to the hub is off (LP_DRILL_HUB_RECEIPTS=off)")
        return None
    folder = f'"{target}"' if target.startswith("$HOME/") else shlex.quote(target)
    remote = f'd={folder}; mkdir -p "$d" && cat > "$d/.{path.name}.part" && mv "$d/.{path.name}.part" "$d/{path.name}" && test -s "$d/{path.name}"'
    rc, _, err = runner(["ssh", "-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HUB, remote], stdin=path.read_text(), timeout=60)
    if rc != 0:
        problem = f"receipt {path.name} was not delivered to the hub's plugin folder ({HUB}): {(err or 'ssh failed').strip()[:200]}"
        log(problem)
        return problem
    log(f"receipt delivered to {HUB}:{target}/{path.name}")
    return None
