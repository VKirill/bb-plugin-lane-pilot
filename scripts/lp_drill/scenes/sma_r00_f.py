"""Region 0 · Phase graph, batch f (n140 … n157, n1769): roles per stage, the pause family, the stops, the returns, the correction, the answer and the compensation.

These nodes decide by code and write at most a part of the phase book, so the node-level trace is this scene. The probe (sma_r00_f_probe.ts, run by vite-node) runs the REAL code of the
commit under drill — the phase driver on a scratch database and a fake host, the phase logic, the workflow definitions — with no model, no hub write and nothing outside the machine;
prove_f() compares each observation with the result the card expects. The observations live in tests/sma/r00-world-f.ts (`observe.<name>`). The region scene sma_r00.py only imports the
batch modules; run: scripts/lp-drill.sh --scenario sma_r00.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_F = [f"n{n}" for n in range(140, 158)] + ["n1769"]
PROBE_F = ROOT / "scripts/lp_drill/scenes/sma_r00_f_probe.ts"


def prove_f(proofs, tmp) -> None:
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_F)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_F:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    # n140 roles per stage: plan researchers, planner, checker; drawing designer and a checker of another role.
    r = seen("roles")
    draw = {row[0]: row[1] for row in r.get("draw", [])}
    proofs.prove("n140", r.get("plan") == [["research", "analyst"], ["patterns", "analyst"], ["strategy", "auditor"], ["plan", "planner"], ["plan_critic", "plan-critic"]]
                 and draw == {"material": "specialist:design-lead", "draw": "specialist:design-lead", "check": "plan-critic"} and draw.get("check") != draw.get("draw"), f"plan roles {r.get('plan')}, drawing roles {r.get('draw')}")
    # n141 role separateness: own reviewer and none are held, another role opens.
    j = seen("separateness")
    proofs.prove("n141", j.get("own") == "the reviewer of the drawing is its designer: it must be a separate role" and j.get("none") == "the drawing is not reviewed by a separate role" and j.get("other") == "open",
                 f"own reviewer: {j.get('own')}; other role: {j.get('other')}")
    # n142 a plan that is not the checked one is not issued.
    g = seen("parentGuard")
    proofs.prove("n142", g.get("refused") == "the plan changed since it was checked: return the phase to planning" and g.get("dispatched") == [] and g.get("issued") == {}, f"refused: {g.get('refused')}; dispatched {g.get('dispatched')}")
    # n143 the phase book: intact chain, a rewritten part is named.
    b = seen("book")
    proofs.prove("n143", b.get("status") == "Stage: acceptance · state: active · edition 1 · chain: intact (2 parts)" and b.get("goal") is True and str(b.get("broken", "")).endswith("chain: BROKEN at part 2"),
                 f"intact: {b.get('status')}; rewritten: {b.get('broken')}")
    # n144 + n157 pause: the phase is paused and the pass issues none of its pieces.
    p = seen("pause")
    proofs.prove("n144", p.get("state") == "paused" and p.get("booked") == ["pm"], f"after the PM's pause intent: {p.get('state')}, booked {p.get('booked')}")
    proofs.prove("n157", p.get("afterDrive") == "paused" and p.get("issued") == {} and p.get("dispatched") == [], f"pass on a paused phase: state {p.get('afterDrive')}, issued {p.get('issued')}, dispatched {p.get('dispatched')}")
    # n145 a requested pause becomes paused before any issue.
    q = seen("requested")
    proofs.prove("n145", q == {"state": "paused", "issued": {}, "dispatched": []}, f"requested pause after a pass: {q}")
    # n146 a paused phase stands and names the resume.
    d = seen("paused")
    proofs.prove("n146", d.get("waitsForPm") is False and str(d.get("text", "")).endswith(f'is paused; lane_pilot_phase {{action:"resume", phaseId:"{d.get("id")}"}} moves it on.'), f"waitsForPm {d.get('waitsForPm')}, text {d.get('text')}")
    # n147 + n1769 interrupt: refused when active or quiet; a stop not yet proved keeps pause_requested, the next pass finishes it.
    i = seen("interrupt")
    proofs.prove("n147", i.get("unconfirmed") == 1 and i.get("midState") == "pause_requested" and i.get("midInterrupting") == "owner" and i.get("midNamed") == 1 and i.get("afterState") == "paused"
                 and i.get("afterInterrupting") is None and i.get("attempt") == "canceled", f"stop unproved: {i.get('midState')} (open stops {i.get('midNamed')}); next pass: {i.get('afterState')}, attempt {i.get('attempt')}")
    proofs.prove("n1769", str(i.get("active", "")).endswith("is active: an interrupt is for a pausing or paused phase — pause it first") and str(i.get("quiet", "")).endswith("has no running work to interrupt: it is already still")
                 and i.get("issuedSha") == "interrupted", f"active: {i.get('active')}; quiet: {i.get('quiet')}; piece print {i.get('issuedSha')}")
    # n148 continue: resume moves a paused phase to active; a closed one is never resumed.
    c = seen("resume")
    proofs.prove("n148", c.get("paused") == "paused" and c.get("resumed") == "active" and str(c.get("closedRefusal", "")).endswith("is closed: open a new phase for new work"), f"paused {c.get('paused')}, resumed {c.get('resumed')}, closed: {c.get('closedRefusal')}")
    # n149 stop: writer first, then the phase; a stop not observed keeps the phase open.
    st = seen("stop")
    proofs.prove("n149", st.get("open") == {"unconfirmed": 1, "state": "active", "stopping": "wrong goal", "attempt": "cancel_requested"} and st.get("state") == "stopped" and st.get("stopping") is None and st.get("attempt") == "canceled",
                 f"unobserved stop: {st.get('open')}; next pass: {st.get('state')}, attempt {st.get('attempt')}")
    # n150 close in words.
    cl = seen("close")
    proofs.prove("n150", cl.get("refused") == "closing in words carries the words: why the phase ends here" and cl.get("blank") == cl.get("refused") and cl.get("state") == "closed"
                 and cl.get("closing") == {"by": "owner", "words": "the owner stopped the goal"}, f"without words: {cl.get('refused')}; with words: {cl.get('state')} {cl.get('closing')}")
    # n151 + n152 return to execution: only from a frozen verdict; the preparation is withdrawn; the note rides and is booked.
    re = seen("returnExec")
    proofs.prove("n151", str(re.get("early", "")).startswith("a return to execution is allowed only from acceptance, on a frozen verdict") and re.get("stage") == "execution" and re.get("verification") is None
                 and re.get("acceptance") is None and re.get("verified") is None and re.get("issuedSha") == "returned", f"from verification: {str(re.get('early'))[:60]}; from acceptance: stage {re.get('stage')}, piece print {re.get('issuedSha')}")
    proofs.prove("n152", re.get("returnNote") == "the header is wrong" and re.get("booked") == ["acceptance → execution by owner: the header is wrong"] and re.get("branchKept") == "phase/x", f"booked {re.get('booked')}, note {re.get('returnNote')}")
    # n153 a correction goes only to the running writer.
    co = seen("correct")
    proofs.prove("n153", co.get("sent") == ["task-r"] and co.get("threads") == ["thr_w"] and co.get("booked") == ["keep the blank cell → task-r"], f"sent to {co.get('sent')}, booked {co.get('booked')}")
    # n154 stop the wave.
    w = seen("wave")
    proofs.prove("n154", w == {"canceled": ["task-q"], "state": "paused", "queued": "canceled", "running": "running", "booked": ["queued pieces canceled: task-q"]}, f"wave stop: {w}")
    # n155 answer a stage question.
    a = seen("answer")
    proofs.prove("n155", a.get("unknown") == "no question nope" and a.get("openAfter") == 0 and a.get("question") == {"answer": "the daily one", "answeredBy": "owner"}, f"unknown: {a.get('unknown')}; answered: {a.get('question')}")
    # n156 compensate only own accepted pieces.
    cp = seen("compensate")
    proofs.prove("n156", cp.get("reverted") == ["task-done"] and cp.get("results") == [{"taskId": "task-done", "state": "merged"}] and cp.get("booked") == ["undo the piece: task-done merged"] and cp.get("live") == "running",
                 f"reverted {cp.get('reverted')}, booked {cp.get('booked')}")
