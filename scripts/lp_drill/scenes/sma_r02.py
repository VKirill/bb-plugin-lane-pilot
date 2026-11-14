"""Region 2 · Batch graph: the pure checks and the control steps of the phase driver that write no hub row (docs/sma-evidence.md).

The probe (sma_r02_probe.ts) runs the REAL checks of the commit under drill on scratch data: the closure line, the design decision, the spend
reserve, the issue order, the pilot, the wave's clearance, the execution gate, the stop and the pause. This scene compares each value with the
node card's expected result and prove()s it. Nodes that write a book part (opened, submitted, issued, wave_in, ...) read their trace from the
hub's lane_pilot_phase_part instead. No model, no hub write, no lock.

Cards that disagree with the owner's rule (decision D7) are proved on OUR behaviour, and the detail says so: n365 (the next wave waits for
this one's acceptance: we start a piece when its own dependencies are accepted) and n366 (a broken piece stops the whole batch: we hold only
the pieces that depend on it and ask the PM). Run: scripts/lp-drill.sh --scenario sma_r02.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n346", "n354", "n355", "n358", "n362", "n363", "n364", "n365", "n366", "n369", "n370", "n373", "n377", "n378", "n380"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r02_probe.ts"


def scenario_sma_r02(tmp: Path) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=300)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r02", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n346 Batch closed: the closing calculation is run fresh; a piece withdrawn with its requirement leaves the requirement uncovered and holds the closure.
    c = seen["closure"]
    proofs.prove("n346", c["whole"] is True and c["dropped"] is False and "R1" in c["droppedDetail"], f"covered requirement holds {c['whole']}; dropped requirement holds {c['dropped']}: {c['droppedDetail'][:80]}")
    # n354 Is a shared drawing needed: asked of the whole composition; screen pieces are named, a plan with no screen needs none.
    d = seen["design"]
    proofs.prove("n354", d["ui"]["decision"] == "needed" and "sum" not in d["ui"]["why"] and d["none"]["decision"] == "not_needed", f"screens plan {d['ui']['decision']} ({d['ui']['why']}); no-screen plan {d['none']['decision']}")
    # n355 Batch service drawing: one drawing decision for the whole phase names every screen piece, a drawing per piece is not made.
    proofs.prove("n355", "card" in d["ui"]["why"] and "row" in d["ui"]["why"] and d["ui"]["mode"] == "screens", f"one decision: {d['ui']['why']} (mode {d['ui']['mode']})")
    # n358 / n378 Budget: a wave whose appetite does not fit the reserve is held and the shortfall is named; a fitting one goes.
    b = seen["budget"]
    proofs.prove("n358", b["held"]["ok"] is False and b["held"]["free"] == 10 and "10" in b["held"]["why"] and b["fits"] is True, f"appetite 20 against 10 free: ok {b['held']['ok']}; appetite 10: ok {b['fits']}")
    proofs.prove("n378", b["held"]["ok"] is False and "20" in b["held"]["why"], f"the wave over budget is held and asks: {b['held']['why']}")
    # n362 Piece waits its turn: b stays out while a is not accepted (and while a is blocked), goes once a is accepted.
    h = seen["held"]
    proofs.prove("n362", h["first"] == ["a"] and h["blocked"] == [] and h["after"] == ["b"], f"first {h['first']}, a blocked {h['blocked']}, a accepted {h['after']}")
    # n363 / n364 Pilot, then fan-out: among three siblings only the earliest starts, the rest name it; two siblings need no pilot.
    p = seen["pilot"]
    proofs.prove("n363", p["first"] is None and p["second"] == "a", f"the earliest sibling waits for {p['first']}, the second for {p['second']}")
    proofs.prove("n364", p["third"] == "a" and p["two"] is None, f"the third sibling waits for {p['third']}; with two siblings the second waits for {p['two']}")
    # n365 Wave eligibility: DEVIATION (card: the next wave waits for this wave's acceptance). Ours: wave 2 piece c with no dependency goes while wave 1 holds a blocked piece; d (depends on it) waits.
    w = seen["barrier"]
    proofs.prove("n365", w["go"] == ["c"] and w["clearedUnreviewed"] is False, f"with wave 1 not cleared (b blocked) the issue order is {w['go']}: c goes, d waits for b; wave 1 cleared: {w['clearedUnreviewed']}")
    # n366 Piece broke: DEVIATION (card: stops issue and asks the owner). Ours: the PM is asked to decide on the blocked piece; only its dependents are held.
    k = seen["broken"]
    proofs.prove("n366", k["waits"] is True and k["key"] == "execution:blocked:a" and "a is blocked" in k["text"], f"asks: {k['text'][:110]}")
    # n369 Batch abandoned: stopping cancels the open and queued pieces and leaves the landed one.
    s = seen["stopAndPause"]
    proofs.prove("n369", s["canceled"] == ["open", "queued"] and s["phaseState"] == "stopped" and s["landed"] == "accepted" and s["open"] == "canceled", f"canceled {s['canceled']}, phase {s['phaseState']}, landed piece {s['landed']}")
    # n370 Pause: closes issue for the named run only; the queued piece waits, the running one is listed as still at work.
    q = s["pause"]
    proofs.prove("n370", q["paused"] is True and q["waiting"] == ["q"] and q["running"] == ["w"] and q["otherRunPaused"] is False, f"paused {q['paused']}, waiting {q['waiting']}, still at work {q['running']}, other run paused {q['otherRunPaused']}")
    # n373 / n377 Gate: the phase leaves execution only when every piece is issued and accepted, naming the piece.
    g = seen["gate"]
    proofs.prove("n373", g["running"] == {"ok": False, "why": ["b is running"]} and g["all"] == {"ok": True}, f"one piece running: {g['running']}; all accepted: {g['all']}")
    proofs.prove("n377", g["notIssued"] == {"ok": False, "why": ["b is not issued yet"]}, f"last wave not issued: {g['notIssued']}")
    # n380 Person accepts the wave: cleared only with the lines holding and the owner's yes.
    v = seen["wave"]
    proofs.prove("n380", v["yes"] is True and v["no"] is False and v["lineRed"] is False, f"owner yes {v['yes']}, owner no {v['no']}, a red line {v['lineRed']}")
    return proofs.verdict("sma_r02", checked=len(NODES))
