"""Region 0 · Phase graph, batch b (n30 … n58, n1768): the nodes of the plan hand-in, the drawing stage and the start of the execution that write no hub row.

The nodes that write a part of the phase book or a workflow step have a hub-database trace (evidence/r00.ts); these checks write nothing, so each is
proved here. The probe (sma_r00_b_probe.ts) runs the REAL code of the commit under drill — the phase gates, the phase driver on a scratch database and a
fake host, the auto stage of the drawing — and prints what it returned as one JSON line; `prove_b` compares each value with the card's expected result.
No model, no hub write, nothing outside the machine. Run: scripts/lp-drill.sh --scenario sma_r00. The region file sma_r00.py only calls this module.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_B = ["n36", "n37", "n38", "n44", "n46", "n48", "n49", "n51", "n54", "n55", "n1768"]
PROBE_B = ROOT / "scripts/lp_drill/scenes/sma_r00_b_probe.ts"
BASE = ["actions", "screens_states", "texts", "heuristics", "accessibility"]
AWAITS = "the drawing awaits the owner's word for this drawing: owner.words was on when the phase opened"
NO_DRAWING = "no drawing: the designer draws the screens into the phase's design folder and names the files"
NOT_REVIEWED = "the drawing is not reviewed by a separate role"
SAME_ROLE = "the reviewer of the drawing is its designer: it must be a separate role"
NO_FEASIBILITY = "no feasibility answer: feasible, or the contradiction with the plan"
NO_CONTRACT = "the drawing has no contract: add UI-SPEC.md with the checkable points (screens, states, breakpoints) to the drawing's paths"


def prove_b(proofs, tmp) -> None:
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_B)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_B:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    dd = seen("designDecisions")
    req = dd.get("requirements", {})
    # n36 Drawing requirements: the five base sections, the c4 and the event chain added for system or mixed work.
    proofs.prove("n36", req.get("screens") == BASE and req.get("unset") == BASE and req.get("system") == BASE + ["c4", "event_chain"] and req.get("mixed") == BASE + ["c4", "event_chain"]
                 and dd.get("mixedPlan", {}).get("mode") == "mixed", f"sections: screens {req.get('screens')}, mixed {req.get('mixed')}")
    # n37 Drawing needed: a view file, a ui folder or a style file needs one; the PM can ask for one.
    proofs.prove("n37", all(dd.get(key, {}).get("decision") == "needed" for key in ("screen", "folder", "style", "oneOfTwo", "asked")) and dd.get("asked", {}).get("why") == "the PM asked for a drawing"
                 and dd.get("oneOfTwo", {}).get("why") == "pieces that change screens: u", f"screen {dd.get('screen')}, asked {dd.get('asked')}")
    # n38 Drawing not needed: a plan with no screen records «not_needed» and goes to execution.
    adm = seen("admission")
    proofs.prove("n38", dd.get("logic") == {"decision": "not_needed", "why": "no piece changes a screen", "mode": None, "requirements": None}
                 and adm.get("plain") == {"stage": "execution", "decision": "not_needed", "why": "no piece changes a screen", "admitted": True}, f"logic plan {dd.get('logic')}, admitted {adm.get('plain')}")

    ready = seen("designReadiness")
    rt = seen("reviewTime")
    # n44 Drawing reviewed by a separate role: none and the designer himself are held, another role passes; the time is the machine's.
    proofs.prove("n44", ready.get("noReviewer") == [NOT_REVIEWED] and ready.get("sameRole") == [SAME_ROLE] and ready.get("otherRole") == [] and rt.get("machineTime") is True and rt.get("reportAcceptsATime") is False,
                 f"no reviewer {ready.get('noReviewer')}, the designer {ready.get('sameRole')}, another role {ready.get('otherRole')}; journal stamped by the machine {rt.get('machineTime')}")
    # n46 Awaits the feasibility answer.
    proofs.prove("n46", ready.get("noFeasibility") == [NO_FEASIBILITY] and ready.get("feasible") == [], f"no answer {ready.get('noFeasibility')}, answered {ready.get('feasible')}")
    # n48 Awaits the person's word: a yes for this drawing counts, a yes for another does not.
    proofs.prove("n48", ready.get("awaitsWord") == [AWAITS] and ready.get("wordForThisDrawing") == [] and ready.get("wordForAnotherDrawing") == [AWAITS] and ready.get("next") == {"key": "design:word:design", "waitsForPm": True},
                 f"awaiting {ready.get('awaitsWord')}, next step {ready.get('next')}")
    # n49 Drawing readiness: each part is named while it is missing; all of them together open the gate.
    proofs.prove("n49", ready.get("ready") == [] and ready.get("none") == [NO_DRAWING] and ready.get("noContract") == [NO_CONTRACT] and len(ready.get("missingSection", [])) == 1 and "accessibility" in ready["missingSection"][0]
                 and ready.get("openQuestion") == ["open question q1: Which grid?"] and ready.get("noFeasibility") == [NO_FEASIBILITY] and ready.get("noReviewer") == [NOT_REVIEWED] and ready.get("awaitsWord") == [AWAITS],
                 f"ready {ready.get('ready')}, no drawing {ready.get('none')}, no contract {ready.get('noContract')}")
    # n51 Drawing confirmed: a reviewed, feasible drawing is confirmed now; an unreviewed one is not.
    c = seen("confirmed")
    proofs.prove("n51", c.get("unreviewed") == "the drawing is not confirmed" and c.get("heldStage") == "design" and c.get("heldConfirmed") is None and c.get("stage") == "execution" and c.get("confirmedNow") is True,
                 f"unreviewed {c.get('unreviewed')} (stage {c.get('heldStage')}), reviewed → {c.get('stage')}, stamped now {c.get('confirmedNow')}")
    # n54 Full checked plan: the issue refuses a plan that is not the edition that was checked.
    ex = seen("execution")
    proofs.prove("n54", ex.get("edited") == {"refused": "the plan changed since it was checked: return the phase to planning", "dispatched": 0, "issued": {}} and ex.get("first", {}).get("issued") == {"a": "task-a"},
                 f"changed plan {ex.get('edited')}, checked plan issued {ex.get('first', {}).get('issued')}")
    # n55 Drawing ready or not needed: the gate opens for «not needed» and for a ready drawing only.
    door = seen("designDoor")
    proofs.prove("n55", door.get("notNeeded") == [] and door.get("ready") == [] and door.get("needed") == [NO_DRAWING] and door.get("unreviewed") == [NOT_REVIEWED] and door.get("undecided") == ["the design decision is not made"]
                 and adm.get("afterAdmit", {}).get("stage") == "design" and adm.get("plain", {}).get("stage") == "execution", f"gate {door}, a screen plan waits at {adm.get('afterAdmit', {}).get('stage')}")
    # n1768 Drawing scored by rubric: the mean of every criterion at every width; the checker's scores are journaled apart from the drawing.
    rub = seen("rubric")
    stage = seen("drawStage")
    scores = {"hierarchy": 3, "spacing": 2, "contrast": 3, "states": 2}
    proofs.prove("n1768", rub.get("oneWidth", {}).get("score") == 83 and rub.get("twoWidths") == 92 and rub.get("clean") == 100 and stage.get("rework", {}).get("critique") == {"scores": scores, "verdict": "rework", "notes": "redo the states"},
                 f"rubric score {rub.get('oneWidth', {}).get('score')} (two widths {rub.get('twoWidths')}), journaled critique {stage.get('rework', {}).get('critique')}")
