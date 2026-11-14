"""Region 19 · Install, update, remove, batch core-server-b: n1506, n1507, n1512, whose code is the plugin update check of bb-core.

Read-only: `bb plugin outdated --json` and `bb plugin list --json` (sma_core_b_hub.py); nothing is updated. n1473 and n1495 already have their line in
sma_r19.py (our half). n1510 (never an older version: needs a registry whose latest is older than the installed one), n1511 (an update job: an update of a
hub plugin), n1513 (an unreachable registry: cannot be forced on the hub) are not proved here: see NOT_PROVED_CORE_B.
"""
from __future__ import annotations

from lp_drill.prove import Proofs
from lp_drill.scenes.sma_core_b_hub import installed_versions, is_semver, outdated

NODES_CORE_B = ["n1506", "n1507", "n1512"]
OUTCOMES = {"current", "update-available", "pinned", "incompatible", "unavailable"}
NOT_PROVED_CORE_B = {
    "n1510": "a downgrade candidate needs a registry whose latest is older than the installed version; not forced on the hub",
    "n1511": "an update job exists only while an update of a hub plugin runs (it changes the hub's plugins)",
    "n1513": "an unreachable registry cannot be arranged on the hub without changing its network or its plugins",
}


def _semver(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("-")[0].split("+")[0].split(".")[:3])


def prove_core_b(proofs: Proofs, tmp) -> None:
    before, why_before = installed_versions()
    rows, why = outdated()
    after, why_after = installed_versions()
    counts: dict[str, int] = {}
    for row in rows:
        counts[str(row.get("outcome"))] = counts.get(str(row.get("outcome")), 0) + 1

    # n1506 The command checks versions: the check answers for the installed plugins, each with one known outcome, and every unavailable one with a line saying why.
    ok = bool(rows) and all(r.get("id") and r.get("outcome") in OUTCOMES for r in rows) and all(r.get("detail") for r in rows if r.get("outcome") == "unavailable")
    proofs.prove("n1506", ok, f"{len(rows)} plugins checked {counts}" if rows else f"the update check returned no entry ({why or 'no updatable plugin'})")

    # n1507 The report names the installed version and the newest one, and changes nothing: an update-available entry shows both, and the installed versions are the same before and after the check.
    available = [r for r in rows if r.get("outcome") == "update-available"]
    shows_both = all((r.get("installed") or {}).get("display") and (r.get("candidate") or {}).get("display") for r in available)
    unchanged = bool(before) and before == after
    proofs.prove("n1507", bool(rows) and shows_both and unchanged,
                 f"{len(available)} entries with an update show installed and candidate {shows_both}; installed versions of {len(before)} plugins the same after the check {unchanged} ({why_before or why_after or 'read ok'})")

    # n1512 The check plans one run: an update-available entry has exactly one candidate (an object), and a blocked newer release, when named, is newer than that candidate.
    problems = []
    for r in available:
        candidate, blocked = r.get("candidate"), r.get("blocked")
        if not isinstance(candidate, dict):
            problems.append(f"{r.get('id')}: candidate {candidate!r}")
        elif isinstance(blocked, dict) and is_semver(blocked.get("version")) and is_semver(candidate.get("version")) and _semver(blocked["version"]) <= _semver(candidate["version"]):
            problems.append(f"{r.get('id')}: blocked {blocked['version']} is not newer than candidate {candidate['version']}")
    proofs.prove("n1512", bool(rows) and not problems, f"{len(available)} planned updates of {len(rows)} checked; one candidate each, blocked newer than it; problems {problems or 'none'}")
