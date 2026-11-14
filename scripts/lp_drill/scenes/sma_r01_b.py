"""Region 1 · Task graph, batch b: the gates and admission nodes proved by the region scene sma_r01 (docs/sma-evidence.md, «Trace choice»).

These nodes write no row of their own (a lint, a pure check of a result, a refused contract). The probe runs the REAL check of the commit under drill on
scratch values and a scratch database (no model, no hub write), and prove_b() compares each result with what the node's card expects.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_B = ["n194", "n196", "n198", "n200", "n204", "n205", "n206", "n209", "n210", "n213", "n214", "n215", "n218", "n219", "n220"]
PROBE_B = ROOT / "scripts/lp_drill/scenes/sma_r01_b_probe.ts"


def prove_b(proofs: Proofs, tmp: Path) -> None:
    done = subprocess.run(["npx", "tsx", str(PROBE_B)], cwd=ROOT, capture_output=True, text=True, timeout=300)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_B:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return

    # n194 No recipes in the tree: verify none with no check is accepted from its files; verify tests with none listed is told so.
    ok, owed = s["n194"]
    proofs.prove("n194", ok == {"ok": True} and owed == {"ok": False, "state": "validation_failed", "reason": "verify is set but verification[] is empty"}, f"verify none {ok}; verify tests, no checks {owed}")
    # n196 Execution checklist: every flag at once.
    c = s["n196"]
    proofs.prove("n196", c["promise"]["approach"] is True and c["promise"]["planFactUnproven"] == ["handles errors"] and c["stagnation"]["sameKeyTurns"] is True
                 and c["scope"]["outsideOwnsPaths"] == ["out/x.ts"] and c["referenceTestEdits"] == ["tests/old.test.ts"], f"checklist {json.dumps(c)}")
    # n198 Shape of the work: a new top-level folder and a test that imports nothing go to a person.
    proofs.prove("n198", s["n198"] == [["new_top_level:newpkg"], ["self_test:tests/b.test.ts"]], f"shape flags {s['n198']}")
    # n200 Is the work deliverable: an expected output outside owns_paths is refused, an owned one is not.
    unowned, owned = s["n200"]
    proofs.prove("n200", "output_unowned" in unowned and "output_unowned" not in owned, f"lint codes for an unowned output {unowned}, for an owned one {owned}")
    # n204 New attempt starts at execution: the writer stages go back to pending, the receipts before them stay.
    proofs.prove("n204", s["n204"] == {"pm-read": "passed", "writer-agent": "pending", "verification": "pending", "acceptance-receipt": "pending"}, f"stages after the restart {s['n204']}")
    # n205 Pool of suitable workers: the writer's fallbacks then the PM's model; no repeat of the writer or another, an empty slot out.
    proofs.prove("n205", [(row["providerId"], row["model"]) for row in s["n205"]] == [("q", "m2")], f"pool {s['n205']}")
    # n206 Route: the first unheld member takes the work; a held first one is passed over and the wait is its reopen time.
    proofs.prove("n206", s["n206"] == {"first": 0, "afterHold": 1, "wakeAt": 300000}, f"route {s['n206']}")
    # n209 Worker written on the row: once, only while the row is queued.
    proofs.prove("n209", s["n209"] == {"first": True, "second": False, "late": False, "a1": "thr_holder", "a2": None}, f"holder writes {s['n209']}")
    # n210 Pre-start refusals: an unsafe path is refused, and the refusal names its class.
    proofs.prove("n210", "ownership_unsafe" in s["n210"]["codes"] and "conflict" in s["n210"]["classes"], f"refusal {s['n210']}")
    # n213 Forge lane: the Creator owns exactly the one draft folder and expects the one draft file.
    f = s["n213"]
    proofs.prove("n213", f == {"owns": [".agents/forge/roles/fixer/"], "outputs": [".agents/forge/roles/fixer/fixer.md"], "never": [".claude/", ".lane-pilot/"]}, f"Creator task {f}")
    # n214 Service drawing kinship: a drawing of another phase is refused with drawing_kin, the confirmed one passes.
    other, own = s["n214"]
    proofs.prove("n214", "drawing_kin" in other and "drawing_kin" not in own, f"lint codes for a foreign drawing {other}, for the confirmed one {own}")
    # n215 Batch drawing ready: the designer's own review does not make it ready, a separate role does.
    ready_same, why, ready_other = s["n215"]
    proofs.prove("n215", ready_same is False and any("separate role" in line for line in why) and ready_other is True, f"same reviewer ready={ready_same} ({why}); separate reviewer ready={ready_other}")
    # n218 Lane permission envelope: the contract schema refuses a task without its ownership lists.
    proofs.prove("n218", s["n218"] == [True, False, False], f"schema reads full / no owns_paths / empty owns_paths: {s['n218']}")
    # n219 Third-party sandbox: only the workspace and its temp are writable, the guard path is read-only.
    w = s["n219"]
    proofs.prove("n219", w["writable"] == ["/tmp", "/work/repo", "/tmp/lp-sma"] and "/work/repo/.git" in w["readOnly"], f"sandbox writable {w['writable']}, read-only {w['readOnly']}")
    # n220 Fresh promise at launch: the stored (corrected) contract and plan replace the dispatched ones.
    p = s["n220"]
    proofs.prove("n220", p == {"ok": True, "plan": "the corrected plan", "objective": "the corrected objective"}, f"admission {p}")
