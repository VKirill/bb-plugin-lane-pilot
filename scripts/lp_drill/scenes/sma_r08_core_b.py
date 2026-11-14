"""Region 8 · Daemon front outside the graphs, batch core-server-b: n752 (the product update check), whose code is the update resolver of bb-core.

Read-only: `bb plugin outdated --json` (sma_core_b_hub.py), the core's own check; nothing is updated. n677, n679, n681 (the owner login door and cookie) are not
proved here: see NOT_PROVED_CORE_B.
"""
from __future__ import annotations

from lp_drill.prove import Proofs
from lp_drill.scenes.sma_core_b_hub import outdated

NODES_CORE_B = ["n752"]
OUTCOMES = {"current", "update-available", "pinned", "incompatible", "unavailable"}
NOT_PROVED_CORE_B = {
    "n677": "owner login is off on the hub (`bb owner status`: login off, no key paired); the ticket exchange needs the owner's private key and a browser",
    "n679": "the same: a session cookie exists only after a ticket exchange with a paired key",
    "n681": "the same: the cookie is minted only by that exchange",
}


def prove_core_b(proofs: Proofs, tmp) -> None:
    rows, why = outdated()
    # n752 Compares the installed version with the registry: every checked plugin answers with one known outcome and its installed version; an update-available entry names a candidate different from what is installed, any other names none.
    if not rows:
        proofs.prove("n752", False, f"the update check returned no entry ({why or 'no updatable plugin'})")
        return
    bad = []
    counts: dict[str, int] = {}
    for row in rows:
        installed = (row.get("installed") or {}).get("version")
        candidate = (row.get("candidate") or {}).get("version")
        counts[str(row.get("outcome"))] = counts.get(str(row.get("outcome")), 0) + 1
        if row.get("outcome") not in OUTCOMES or not installed:
            bad.append(f"{row.get('id')}: outcome {row.get('outcome')!r}, installed {installed!r}")
        elif row["outcome"] == "update-available" and (candidate is None or candidate == installed):
            bad.append(f"{row.get('id')}: update-available with candidate {candidate!r} against installed {installed!r}")
        elif row["outcome"] != "update-available" and candidate is not None:
            bad.append(f"{row.get('id')}: {row['outcome']} but names candidate {candidate!r}")
    proofs.prove("n752", not bad, f"{len(rows)} plugins checked {counts}; inconsistent: {bad or 'none'}")
