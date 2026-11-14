"""Region 0 · Phase graph, batch c (n59 … n89): execution by plans and the phase's own verification (docs/sma-evidence.md, «Trace choice»).

The pieces of a plan are issued, weighed and verified by code that writes at most a part of the phase book, so the node-level trace is this scene (n61, n62, n66, n73, n75, n80, n84
also write a book part the hub database shows; n70 writes a baseline row and is not proved here). The probe (sma_r00_c_probe.ts, run by vite-node) runs the REAL code of the commit
under drill — the phase driver on a scratch database and a fake host, the phase logic, the goal audit's inputs — with no model, no hub write and nothing outside the machine;
prove_c() compares each observation with the result the card expects. The observations live in tests/sma/r00-world-c.ts (`observe.<name>`). The region scene sma_r00.py only
imports the batch modules; run: scripts/lp-drill.sh --scenario sma_r00.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_C = [f"n{n}" for n in list(range(59, 67)) + list(range(68, 70)) + list(range(71, 90))]
PROBE_C = ROOT / "scripts/lp_drill/scenes/sma_r00_c_probe.ts"
HEAD = "a" * 40
MAIN = "b" * 40
PASSED = "every piece accepted and proved; the composition passes on main"
NO_RECEIPT = "b: plan-fact left no receipt — its acceptance items were not checked against the diff"


def prove_c(proofs, tmp) -> None:
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_C)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_C:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    def rows(name: str) -> list:
        value = s.get(name)
        return [] if not isinstance(value, list) else value

    # n59 Plan unchanged since checking: the same hash is unchanged; a rewritten plan is neither issued nor accepted.
    pf = seen("planFile")
    proofs.prove("n59", pf.get("unchanged") is True and pf.get("unchangedLine") == {"ok": True, "detail": "the plan is the admitted one"}
                 and pf.get("rewritten") == {"unchanged": False, "line": {"ok": False, "detail": "the plan changed after its admission"}, "refused": "the plan changed since it was checked: return the phase to planning", "dispatched": 0}
                 and pf.get("edited") is False, f"same plan {pf.get('unchangedLine')}, rewritten {pf.get('rewritten')}")
    # n60 Plan as a work piece: its own contract, the fields the machine knows itself filled in, its promise.
    pc = seen("pieceContract")
    proofs.prove("n60", pc.get("bare") == {"display_title": "Skeleton view", "kind": "feature", "area": "phase:ph_1/p1", "promise": {"given": "an empty cell", "when": "the sum runs", "then": "it skips the cell (p1)"}, "qa_cases": None, "dropped": None}
                 and pc.get("own", {}).get("kind") == "fix" and pc.get("own", {}).get("area") == "billing" and pc.get("sent", {}).get("area") == "phase:<id>/p1" and pc.get("sent", {}).get("id") == "p1",
                 f"bare piece {pc.get('bare')}, sent {pc.get('sent', {}).get('area')}")
    # n61 Plan-to-work binding: the task, the contract print and the run are written on the phase; issued once, again only when the contract changed.
    b = seen("binding")
    proofs.prove("n61", b.get("afterFirst") == {"dispatched": 1, "issued": {"a": "a"}, "printIsPiece": True, "runId": "run1", "book": ["a → task a (wave 1)"]} and b.get("again") == {"dispatched": 1, "issued": {"a": "a"}}
                 and b.get("changed", {}).get("secondId") == "a.2" and b.get("changed", {}).get("issued") == {"a": "a.2"}, f"first {b.get('afterFirst')}, changed {b.get('changed')}")
    # n62 Plan wave address: the earliest wave is issued first and every issue line and wave table names its wave.
    w = seen("waveAddress")
    proofs.prove("n62", w.get("order") == ["b", "a", "c"] and w.get("issued") == ["b → task b (wave 1)", "a → task a (wave 2)", "c → task c (wave 2)"] and w.get("wave2") == ["a", "c"] and w.get("wave1") == ["b"]
                 and [t[0] for t in w.get("tables", [])] == ["wave 1:", "wave 2:"] and len(w.get("tables", [[], []])[1]) == 5, f"order {w.get('order')}, issued {w.get('issued')}")
    # n63 Plan holds the phase drawing: a piece that builds screens carries it, another does not.
    d = seen("drawingInPiece")
    paths = [".agents/phases/ph_1/design/UI-SPEC.md", ".agents/phases/ph_1/design/kit.html"]
    proofs.prove("n63", d.get("sentDrawing") == [["ui", paths], ["a", None]] and d.get("pure", {}).get("logic") == [] and d.get("pure", {}).get("noDrawing") == []
                 and d.get("pure", {}).get("ui") == [f"   the screens follow the phase drawing: {', '.join(paths)}"], f"sent {d.get('sentDrawing')}")
    # n64 Plan waits for dependencies: its own dependencies, not the whole earlier wave; a broken one holds what depends on it only.
    dp = seen("deps")
    proofs.prove("n64", dp.get("none") == ["a", "c"] and dp.get("oneAcceptedOneRunning") == ["b"] and dp.get("oneBlocked") == [] and dp.get("afterB") == ["d"] and dp.get("queuedIsNotAccepted") == ["c"],
                 f"none accepted {dp.get('none')}, a accepted and c running {dp.get('oneAcceptedOneRunning')}, a blocked {dp.get('oneBlocked')}")
    # n65 Plan runs the task graph: each piece is its own work with its own contract, quality mode full and the steps of its contract.
    pr = rows("pieceRuns")
    proofs.prove("n65", len(pr) == 2 and [r.get("id") for r in pr] == ["a", "b"] and all(r.get("quality_mode") == "full" for r in pr) and pr[1].get("acceptance") == ["b works", "b is fast"]
                 and "4. Done when: b works; b is fast" in pr[1].get("steps", []) and pr[0].get("priority") == "high" and pr[1].get("priority") is None, f"pieces {[(r.get('id'), r.get('quality_mode')) for r in pr]}")
    # n66 Plan as a nested batch: closed with its run by a person; the hub's own cleaning ends nobody's plan.
    nb = seen("nestedBatch")
    closed = {"state": "closed", "stage": "closed", "closing": "batch closed: run1", "book": ["batch closed: run1"], "dispatched": 0}
    proofs.prove("n66", nb.get("cli") == closed and nb.get("rpc") == closed and nb.get("sweep", {}).get("state") == "active" and nb.get("ttl", {}).get("state") == "active",
                 f"closed by cli {nb.get('cli', {}).get('closing')}, by sweep {nb.get('sweep', {}).get('state')}")
    # n68 Execution waits for all plans: one not issued or not accepted is named; all accepted opens the gate.
    ew = seen("executionWait")
    proofs.prove("n68", ew.get("nothingIssued") == ["a is not issued yet", "b is not issued yet"] and ew.get("running") == ["b is running"] and ew.get("blocked") == ["b is blocked"] and ew.get("noFact") == ["b is queued"] and ew.get("allIn") == [],
                 f"running {ew.get('running')}, all in {ew.get('allIn')}")
    # n69 Phase execute command: what runs, what is blocked, what could not be issued.
    et = seen("executionText")
    proofs.prove("n69", et.get("running", {}).get("key") == "execution:running:1:1" and et.get("running", {}).get("waitsForPm") is False
                 and "1 of 2 pieces issued, 1 at work." in et.get("running", {}).get("text", "") and et.get("blocked", {}).get("key") == "execution:blocked:a" and et.get("blocked", {}).get("waitsForPm") is True
                 and et.get("issueError", {}).get("key") == "execution:issue_error:b", f"running {et.get('running', {}).get('key')}, blocked {et.get('blocked', {}).get('key')}")
    # n71 Executed? — by facts: the latest attempt of the task family and the receipts of its stages.
    c = seen("calc")
    proofs.prove("n71", c.get("a") == {"taskId": "a.2", "state": "accepted", "planFact": "passed", "verification": "passed", "codeCritique": "passed", "browserQa": "passed", "qaPlanned": True, "attempt": "att-a.2"}
                 and c.get("b", {}).get("state") == "running" and c.get("b", {}).get("planFact") is None and c.get("c", {}).get("state") is None, f"redo {c.get('a')}, running {c.get('b')}")
    # n72 Test, code, run, commit: each piece's cycle judged by its receipts.
    pcy = seen("pieceCycle")
    nr = pcy.get("noReceipts", {})
    proofs.prove("n72", nr.get("promises_proved") == [False, "plan-fact left no receipt"] and nr.get("independent_check") == [False, "the code critic has not passed it (no critic receipt is no reading)"]
                 and pcy.get("proved", {}).get("independent_check") == [True, "the code critic passed it"] and pcy.get("blocked", {}).get("independent_check") == [False, "the code critic blocks it"]
                 and pcy.get("failed", {}).get("checks_passed") == [False, "its checks failed"], f"no receipts {nr.get('independent_check')}, blocked {pcy.get('blocked', {}).get('independent_check')}")
    # n73 Phase execution hand-in: the wave package with its lines, written once; a blocked piece is not handed in.
    wi = seen("waveIn")
    hi = wi.get("handedIn", {})
    proofs.prove("n73", hi.get("book") == ["wave 1 in, package <pkg>: ✓ contract_current, ✓ landed, ✓ promises_proved, ✓ checks_passed, ✗ independent_check, ✓ qa_read"] and hi.get("bookAfterSecondPass") == 1 and hi.get("packageIsOfThePieces") is True
                 and hi.get("lines", {}).get("independent_check") == [False, "independent_check fails: b"] and wi.get("blocked", {}).get("waveIn") == 0 and wi.get("blocked", {}).get("decides") is True,
                 f"book {hi.get('book')}, blocked piece wave_in {wi.get('blocked', {}).get('waveIn')}")
    # n74 Live QA by the machine: not run is not a pass; foreign green does not transfer.
    q = seen("liveQa")
    proofs.prove("n74", q.get("notRun") == {"ok": False, "detail": "the planned browser check has not passed: a"} and q.get("failed", {}).get("ok") is False and q.get("passed", {}).get("ok") is True
                 and q.get("foreignGreen") == {"ok": False, "detail": f"the live check was taken on head {'1' * 12}, the package it decides on is at {'2' * 12} — check the same candidate"} and q.get("sameCandidate", {}).get("ok") is True,
                 f"not run {q.get('notRun')}, foreign green {q.get('foreignGreen', {}).get('detail')}")
    # n75 Execution → verification: only when every issued piece is accepted.
    tv = seen("toVerification")
    proofs.prove("n75", tv.get("whileRunning") == "execution" and tv.get("notIssued") == "execution" and tv.get("afterAccepted") == "verification" and tv.get("book") == ["execution → verification: every piece is issued and accepted"],
                 f"one running {tv.get('whileRunning')}, one not issued {tv.get('notIssued')}, all accepted {tv.get('afterAccepted')}")
    # n76 Barrier on the phase tree and n85 Phase candidate prepared: one regression run over the candidate's trees, its goal on the phase, the heads frozen as the package.
    br = seen("barrier")
    proofs.prove("n76", br.get("regression") == [{"projectId": "projA", "runId": "run1", "force": True, "mode": "full", "basePaths": ["/repo/.git/lp-phases/ph_1"]}] and br.get("goalCheckOfMain") == 0
                 and br.get("goal") == {"state": "passed", "tasks": 2, "headSha": HEAD, "runId": "run1"}, f"regression {br.get('regression')}, goal {br.get('goal')}")
    proofs.prove("n85", br.get("verified") == {"/repo": HEAD} and br.get("verdict") == {"state": "passed", "detail": PASSED, "mainSha": HEAD}, f"verified heads {br.get('verified')}, verdict {br.get('verdict')}")
    # n77 Phase verifier input and n83 Phase verifier prompt: every piece's promise and contract, its dependencies, the diff range and the drawing.
    ci = seen("closeInputs")
    goals = ci.get("goals", [])
    proofs.prove("n77", [g.get("id") for g in goals] == ["p1", "p2"] and goals[0].get("done_when") == "given an empty cell; when the sum runs; then it skips the cell (p1); accepts: acc-p1" and ci.get("merged") == ["base0..phase/ph_1"]
                 and ci.get("landed", {}).get("merged") == ["base0..HEAD"] and ci.get("drawing") == {"paths": ["d/UI-SPEC.md", "d/one.html"], "sha256": "drawsha", "ui_spec": "d/UI-SPEC.md"} and ci.get("plain", {}).get("drawing") is None,
                 f"diff range {ci.get('merged')}, drawing {ci.get('drawing')}")
    proofs.prove("n83", len(goals) == 2 and goals[1].get("depends_on") == ["p1"] and goals[0].get("depends_on") == [] and goals[1].get("contract") == {"acceptance": ["acc-p2"], "verification": [{"command": "npm test -- p2"}], "owns_paths": ["src/p2.ts"]}
                 and ci.get("summary", "").endswith("the blind detail"), f"p2 depends on {goals[1].get('depends_on') if len(goals) > 1 else None}")
    # n78 Blind check of every plan, n79 never read the executor's story, n81 summaries of the whole composition, n84 the phase verdict, n86 the whole plan set accepted.
    v = seen("verdicts")
    proofs.prove("n78", v.get("allProved", {}).get("state") == "passed" and v.get("firstChecksFailed") == {"state": "failed", "detail": "a: its checks failed", "mainSha": "h1"}
                 and v.get("lastPlanFactFailed", {}).get("detail") == "c: plan-fact failed — the promise is not proved" and v.get("criticBlocks", {}).get("detail") == "c: the code critic blocks it", f"checks failed {v.get('firstChecksFailed')}")
    proofs.prove("n79", v.get("noPlanFactReceipt") == {"state": "failed", "detail": NO_RECEIPT, "mainSha": "h1"} and v.get("allProved", {}).get("state") == "passed", f"no receipt {v.get('noPlanFactReceipt')}")
    proofs.prove("n81", v.get("firstChecksFailed", {}).get("state") == "failed" and v.get("lastPlanFactFailed", {}).get("state") == "failed" and v.get("allProved", {}).get("state") == "passed", f"first piece {v.get('firstChecksFailed', {}).get('detail')}, last piece {v.get('lastPlanFactFailed', {}).get('detail')}")
    fz = seen("frozen")
    proofs.prove("n84", v.get("allProved") == {"state": "passed", "detail": PASSED, "mainSha": "h1"} and v.get("goalRunning") == {"state": "pending", "detail": "the run's goal check is still running", "mainSha": None}
                 and v.get("goalFailed", {}).get("detail") == "the run's goal check failed: npm test is red" and v.get("goalNever", {}).get("detail") == "the run's goal check has not run yet" and fz.get("pending", {}).get("verdict") is None
                 and fz.get("frozen", {}).get("mainSha") == HEAD, f"pending {v.get('goalRunning')}, frozen {fz.get('frozen', {}).get('state')} at {fz.get('frozen', {}).get('mainSha')}")
    proofs.prove("n86", v.get("oneRunning") == {"state": "failed", "detail": "b not accepted", "mainSha": "h1"} and v.get("oneNotIssued", {}).get("detail", "").startswith("b not accepted") and v.get("allProved", {}).get("state") == "passed",
                 f"one piece running {v.get('oneRunning')}")
    # n80 Frozen blind verdict: the same facts give the same verdict, the goal check later does not make a new one, one book line.
    st = v.get("stable", {})
    proofs.prove("n80", st.get("sameFactsSameInput") is True and st.get("newFactNewInput") is True and st.get("newGoalNewInput") is True and fz.get("later") == {"sameVerdict": True, "state": "passed", "book": 1, "checks": 2},
                 f"later pass {fz.get('later')}")
    # n82 Phase drawing in verification: the verdict is bound to the confirmed drawing; a changed one fails it and names both hashes.
    db = seen("drawingBound")
    proofs.prove("n82", v.get("drawingChanged") == {"state": "failed", "detail": "the drawing changed since it was confirmed: confirmed aaa, now bbb", "mainSha": "h1"} and db.get("same", {}).get("state") == "passed"
                 and db.get("changed") == {"state": "failed", "detail": "the drawing changed since it was confirmed: confirmed <confirmed>, now <now>"} and db.get("differentInput") is True, f"changed drawing {db.get('changed')}")
    # n87 Main has not moved: acceptance holds and the phase is verified again on the main that is there.
    mm = seen("mainMoved")
    proofs.prove("n87", mm.get("lines", {}).get("same", {}).get("ok") is True and mm.get("lines", {}).get("moved") == {"ok": False, "detail": f"main moved from {MAIN[:12]} to {HEAD[:12]} since the verdict — verify again"}
                 and mm.get("driver", {}).get("stage") == "verification" and mm.get("driver", {}).get("verdict") is None, f"moved main {mm.get('lines', {}).get('moved')}, phase went to {mm.get('driver', {}).get('stage')}")
    # n88 Work verification stage: the session opens only on the candidate's frozen heads, one numbered line per piece.
    us = seen("uatStage")
    lines = [{"n": 1, "pieceId": "p1", "state": "open"}, {"n": 2, "pieceId": "p2", "state": "open"}, {"n": 3, "pieceId": "p3", "state": "open"}]
    proofs.prove("n88", us.get("unverified", {}).get("uat") is None and us.get("verified", {}).get("uat", {}).get("lines") == lines and us.get("verified", {}).get("written") == 0
                 and us.get("noCandidate", {}).get("uat", {}).get("lines") == lines, f"before the heads are frozen {us.get('unverified', {}).get('uat')}, after {[l.get('n') for l in us.get('verified', {}).get('uat', {}).get('lines', [])]}")
    # n89 Verify-work command: one numbered line per promise, where to test, the answers as they stand.
    ud = seen("uatDocument")
    proofs.prove("n89", ud.get("plain", [])[8:10] == ["- [ ] 1. p1: given an empty cell, when the sum runs, then it skips the cell (p1)", "- [ ] 2. p2: given an empty cell, when the sum runs, then it skips the cell (p2)"]
                 and ud.get("answered") == ["- [x] 1. p1: given an empty cell, when the sum runs, then it skips the cell (p1)", "- [!] 2. p2: given an empty cell, when the sum runs, then it skips the cell (p2) — the bar is gone"]
                 and ud.get("landed") == "Test the work on main: the phase landed (phase/ph_7)." and ud.get("none") == [], f"numbered lines {ud.get('plain', [])[8:10]}")
