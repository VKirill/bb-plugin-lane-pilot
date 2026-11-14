"""Region 0 · Phase graph, batch d (n90 … n119): acceptance, landing, closure, the rollback watch and the lessons trigger (docs/sma-evidence.md, «Trace choice»).

The acceptance lines, the key of the package, the closing documents and the lessons trigger are decided by code that writes at most a part of the phase book, so the node-level trace is
this scene (n103, n105, n110, n113 write book parts the hub database shows and are not proved here). The probe (sma_r00_d_probe.ts, run by vite-node) runs the REAL code of the commit
under drill — the acceptance calculation, the phase driver on a scratch database and a fake host, the phase logic — with no model, no hub write and nothing outside the machine;
prove_d() compares each observation with the result the card expects. The observations live in tests/sma/r00-world-d.ts (`observe.<name>`). The region scene sma_r00.py only imports the
batch modules; run: scripts/lp-drill.sh --scenario sma_r00.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_D = [f"n{n}" for n in list(range(90, 103)) + [104, 106, 107, 108, 109] + [111, 112] + list(range(114, 120)) if n != 103]
PROBE_D = ROOT / "scripts/lp_drill/scenes/sma_r00_d_probe.ts"
NOT_ASKED = "this phase's acceptance does not ask for the owner's word (owner.words: not in money, data or production deploy, or off)"
GAPS = "left uncovered at close: requirements no piece covers: r2 (name them in a piece's covers, or defer them in CONTEXT.md and sign again); locked decisions no piece carries out: d1"
STRAIGHT = "the phase went through without returns or failures"
HELD = "1 deferred check(s) of this project are open with no term from the owner, so they count as unproven: def-1 — close each with evidence (bb lane-pilot defer-close <id> --evidence …)"


def prove_d(proofs, tmp) -> None:
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_D)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_D:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    # n90 UAT line: answered by its number; an unknown number is refused, one answer changes that line alone, the session word waits for every line.
    u = seen("uatLine")
    proofs.prove("n90", u.get("refused") == "no UAT line 4: the lines are 1 to 3" and u.get("afterFail") == [[1, "p1", "open", None], [2, "p2", "failed", "the bar is missing"], [3, "p3", "open", None]]
                 and str(u.get("early", "")).startswith("UAT is not complete: 2 open, 1 failed of 3") and [row[2] for row in u.get("afterPass", [])] == ["passed"] * 3 and u.get("word") == "uat",
                 f"line 4: {u.get('refused')}; after one fail {u.get('afterFail')}; session word before the lines passed: {u.get('early')}")
    # n91 UAT record after the landing: before it the answers live in the record and UAT.md is not written; after it the file is written once with them.
    r = seen("recordAfter")
    proofs.prove("n91", r.get("early") == {"lines": 1, "sha": "", "writes": 0} and r.get("after") == {"writes": 1, "text": "- [x] 1. p1: given an empty cell, when the sum runs, then it skips the cell (p1)", "sha": True},
                 f"before the landing {r.get('early')}, after {r.get('after')}")
    # n92 Phase acceptance package: the key, the frozen verdict and the diffstat; nothing outside acceptance or without a verdict.
    p = seen("acceptancePackage")
    shown = p.get("shown") or {}
    proofs.prove("n92", shown.get("key") == p.get("key") and len(str(shown.get("key"))) == 16 and shown.get("verdict") == {"state": "passed", "detail": "every piece accepted and proved", "mainSha": "b" * 40}
                 and shown.get("diffStat") == "a" * 40 and p.get("wrongStage") is None and p.get("noVerdict") is None, f"package {shown.get('key')} verdict {shown.get('verdict')}, outside acceptance {p.get('wrongStage')}")
    # n93 Phase acceptance calculation: a stored claim improves nothing; one worse fact worsens its own line; the goal audit is read as it is.
    c = seen("lineCalc")
    proofs.prove("n93", c.get("green") == [] and c.get("claimedRed") == ["checks_passed"] and c.get("goal") == {"ok": True, "detail": "audit: the goal is met"} and c.get("noAudit") == {"ok": False, "detail": "no goal audit yet"}
                 and c.get("unmet") == {"ok": False, "detail": "audit: the cart is still hidden"}, f"red on green facts {c.get('green')}, red with a claim over a failed check {c.get('claimedRed')}, goal {c.get('goal')}")
    # n94 Composition and result editions: a changed record is a new edition, the same record is not.
    e = seen("editions")
    proofs.prove("n94", e == {"start": 2, "afterChange": 3, "afterSame": 3, "afterStage": 3, "afterSecond": 4}, f"editions {e}")
    # n95 Window, blind and QA read: a failed or owed browser check and a live check on another head are red; passed and not owed say so.
    q = seen("qaRead")
    proofs.prove("n95", q.get("none") == {"ok": True, "detail": "0 piece(s) passed their browser check; 1 piece(s) plan none (no qa_cases)"} and q.get("failed") == {"ok": False, "detail": "the browser check failed: a"}
                 and q.get("owed") == {"ok": False, "detail": "the planned browser check has not passed: a"} and q.get("passed") == {"ok": True, "detail": "1 piece(s) passed their browser check"}
                 and q.get("stale", {}).get("ok") is False and q.get("stale", {}).get("detail", "").startswith(f"the live check was taken on head {'b' * 12}, the package it decides on is at {'a' * 12}"), f"failed {q.get('failed')}, stale {q.get('stale')}")
    # n96 Contract is current.
    k = seen("contractLine")
    proofs.prove("n96", k.get("current") == {"ok": True, "detail": "the plan is the admitted one"} and k.get("changed") == {"ok": False, "detail": "the plan changed after its admission"}
                 and k.get("neverAdmitted") == {"ok": False, "detail": "the plan changed after its admission"}, f"admitted {k.get('current')}, changed {k.get('changed')}")
    # n97 Promise proved.
    m = seen("promiseLine")
    proofs.prove("n97", m.get("proved") == {"ok": True, "detail": "2 promises proved"} and m.get("oneFailed") == {"ok": False, "detail": "not proved by plan-fact: b"} and m.get("noReceipt") == {"ok": False, "detail": "not proved by plan-fact: a"},
                 f"proved {m.get('proved')}, one failed {m.get('oneFailed')}")
    # n98 Mandatory checks passed.
    h = seen("checksLine")
    proofs.prove("n98", h.get("passed") == {"ok": True, "detail": "every piece's checks passed"} and h.get("oneFailed", {}).get("checks_passed") == {"ok": False, "detail": "checks failed: b"}
                 and [i for i, line in h.get("oneFailed", {}).items() if not line.get("ok")] == ["checks_passed"] and h.get("bothFailed") == {"ok": False, "detail": "checks failed: a, b"},
                 f"passed {h.get('passed')}, one failed {h.get('oneFailed', {}).get('checks_passed')}")
    # n99 Independent check admits.
    v = seen("criticLine")
    none = {"ok": False, "detail": "the code critic has not passed: a (no critic receipt is no reading)"}
    proofs.prove("n99", v.get("passed") == {"ok": True, "detail": "the code critic passed all 1 piece(s)"} and v.get("blocked") == {"ok": False, "detail": "the code critic blocks: a"} and v.get("noReceipt") == none and v.get("skipped") == none,
                 f"passed {v.get('passed')}, blocked {v.get('blocked')}, no receipt {v.get('noReceipt')}")
    # n100 Landing tree prepared.
    ld = seen("landedLine")
    proofs.prove("n100", ld.get("main") == {"ok": True, "detail": "every piece is merged into main"} and ld.get("oneNot") == {"ok": False, "detail": "not merged: b"} and ld.get("bothNot") == {"ok": False, "detail": "not merged: a, b"}
                 and ld.get("candidate") == {"ok": True, "detail": "every piece is merged into the phase candidate phase/ph_1"}, f"main {ld.get('main')}, one not merged {ld.get('oneNot')}")
    # n101 Result clear and useful: a person's decision under the shown key; it does not open «limits».
    us = seen("usefulLine")
    proofs.prove("n101", us.get("notAsked") == {"ok": True, "detail": NOT_ASKED} and us.get("waiting") == {"ok": False, "detail": "awaits the owner's keyed decision"}
                 and us.get("usefulOnly", {}).get("useful") == {"ok": True, "detail": "owner: yes — the result is clear and useful — да"} and us.get("usefulOnly", {}).get("limits", {}).get("ok") is False
                 and us.get("limitsOnly", {}).get("useful", {}).get("ok") is False and us.get("no") == {"ok": False, "detail": "owner: no — not yet"}, f"useful only {us.get('usefulOnly', {}).get('useful')}, waiting {us.get('waiting')}")
    # n102 Limits acknowledged.
    li = seen("limitsLine")
    proofs.prove("n102", li.get("notAsked") == {"ok": True, "detail": f"nothing deferred; {NOT_ASKED}"} and li.get("noTermNotAsked") == {"ok": False, "detail": HELD} and li.get("noTermAsked") == {"ok": False, "detail": HELD}
                 and li.get("openAsked") == {"ok": True, "detail": "2 deferred item(s) of this project stay open, named in the book; owner: yes — the limits are acknowledged — да"}
                 and li.get("waiting") == {"ok": False, "detail": "nothing deferred; awaits the owner's keyed decision"}, f"no term {li.get('noTermAsked')}, open items {li.get('openAsked')}")
    # n104 Phase authorized: the yes under the shown key opens both person lines; another key, no key, a «no» and silence do not.
    a = seen("authorized")
    proofs.prove("n104", a.get("shown", {}).get("useful", {}).get("ok") is True and a.get("shown", {}).get("limits", {}).get("ok") is True
                 and a.get("otherPackage", {}).get("useful") == {"ok": False, "detail": "the owner's word was given on another package (0123456789abcdef): it is asked again"}
                 and a.get("noKey", {}).get("useful", {}).get("ok") is False and a.get("no", {}).get("useful") == {"ok": False, "detail": "owner: no — not yet"} and a.get("none", {}).get("useful", {}).get("ok") is False,
                 f"under the shown key {a.get('shown', {}).get('useful', {}).get('ok')}, another package {a.get('otherPackage', {}).get('useful', {}).get('detail')}")
    # n106 Phase book closed: the closing documents read back as written, or the phase stays open and says so.
    cl = seen("closingDocs")
    op, cd = cl.get("open", {}), cl.get("closed", {})
    proofs.prove("n106", op.get("state") == "active" and op.get("closedDocs") is None and len(op.get("said", [])) == 1 and "did not read back as written" in op.get("said", [""])[0] and op.get("concluded") == 0
                 and cd.get("state") == "closed" and cd.get("closedDocs") is True and len(cd.get("concluded", [])) == 1, f"unconfirmed read: {op.get('state')} / {op.get('said')}; intact read: {cd.get('state')}")
    # n107 Full phase acceptance: what the screen is given — the lines with what they saw, the key it shows (the one the yes carries), the verdict and what the phase waits for.
    vw = seen("view")
    proofs.prove("n107", vw.get("accepted") is False and vw.get("green") == 12 and vw.get("red") == ["limits_acknowledged: nothing deferred; awaits the owner's keyed decision", "result_useful: awaits the owner's keyed decision"]
                 and len(str(vw.get("key"))) == 16 and vw.get("keyIsOwnerWordKey") is True and vw.get("verdict", {}).get("state") == "passed" and vw.get("waitsForPm") is True, f"red lines {vw.get('red')}, key {vw.get('key')}")
    # n108 Keyed decision: sixteen hex characters; the plan, the verdict's input, the tree it saw and the drawing each make a new key, nothing else does.
    key = seen("key")
    proofs.prove("n108", key == {"shape": True, "same": True, "plan": True, "input": True, "tree": True, "drawing": True, "redrawn": True, "contract": True, "unrelated": True}, f"key facts {key}")
    # n109 Main moved — a new word: the phase goes back to verification with no verdict and no acceptance.
    mv = seen("mainMoved")
    proofs.prove("n109", mv.get("same") == {"stage": "acceptance", "verdict": "passed"} and mv.get("moved") == {"stage": "verification", "verification": None, "acceptance": None}
                 and mv.get("stages") == ["acceptance → verification: main moved since the verdict: verified again"], f"main unmoved {mv.get('same')}, main moved {mv.get('moved')}")
    # n111 Phase closure by completeness.
    cz = seen("closure")
    proofs.prove("n111", cz.get("covered") == {"ok": True, "detail": "every requirement and locked decision is covered"} and cz.get("uncovered") == {"ok": False, "detail": GAPS} and cz.get("afterWithdraw") == {"ok": False, "detail": GAPS}
                 and cz.get("notMet", {}).get("ok") is False and cz.get("alreadyMet", {}).get("ok") is True, f"covered {cz.get('covered')}, after a withdrawal {cz.get('afterWithdraw')}")
    # n112 Scope withdrawal agreed.
    w = seen("withdrawal")
    proofs.prove("n112", w.get("issued") == "issued pieces are canceled, not withdrawn" and str(w.get("unknown", "")).endswith(": nothing is changed") and w.get("left") == ["keep", "more"] and w.get("withdrawn") == ["drop"]
                 and w.get("readmitted") is True and w.get("book") == ["drop withdrawn by owner: the owner dropped it"], f"issued piece: {w.get('issued')}; left {w.get('left')}, withdrawn {w.get('withdrawn')}")
    # n114 Observation outcome.
    until = 7 * 86_400_000
    o = seen("outcome")
    proofs.prove("n114", o.get("failure") == {"outcome": "failure", "reverted": ["p1 (task t)"], "until": until} and o.get("noData") == {"outcome": "no_data", "reverted": [], "until": until}
                 and o.get("incomplete") == {"outcome": "incomplete", "reverted": [], "until": until} and o.get("atEnd") == {"outcome": "no_failure", "reverted": [], "until": until} and o.get("lateFailure", {}).get("outcome") == "failure",
                 f"revert {o.get('failure', {}).get('outcome')}, unreadable {o.get('noData', {}).get('outcome')}, open window {o.get('incomplete', {}).get('outcome')}, at the end {o.get('atEnd', {}).get('outcome')}")
    # n115 / n118 Phase outcomes to analyse; no analysis required.
    oc = seen("outcomes")
    sa = oc.get("straight", {})
    proofs.prove("n115", oc.get("returned", {}).get("lessons") == {"needed": True, "why": "1 return(s) to an earlier stage"} and oc.get("attempt", {}).get("lessons") == {"needed": True, "why": "1 failed attempt(s)"}
                 and oc.get("failedVerdict", {}).get("lessons") == {"needed": True, "why": "1 failed verdict(s)"}, f"return {oc.get('returned', {}).get('lessons')}, attempt {oc.get('attempt', {}).get('lessons')}, verdict {oc.get('failedVerdict', {}).get('lessons')}")
    proofs.prove("n118", sa == {"stage": "closed", "lessons": {"needed": False, "why": STRAIGHT}, "none": [STRAIGHT], "booked": 0} and all(oc.get(name, {}).get("stage") == "lessons" and oc.get(name, {}).get("none") == [] for name in ["returned", "attempt", "failedVerdict", "all"]),
                 f"straight phase: stage {sa.get('stage')}, booked {sa.get('none')}; with a trigger: {oc.get('returned', {}).get('stage')}")
    # n116 Lessons pass every tick.
    ps = seen("pass")
    proofs.prove("n116", ps == {"due": "lessons", "analysed": None, "noRun": None, "tried": None, "paused": None, "execution": True}, f"due at lessons {ps.get('due')}, with an analysis {ps.get('analysed')}")
    # n117 Is an analysis needed.
    cc = seen("calc")
    proofs.prove("n117", cc.get("none") == {"needed": False, "why": STRAIGHT} and cc.get("returns") == {"needed": True, "why": "1 return(s) to an earlier stage"} and cc.get("attempts") == {"needed": True, "why": "2 failed attempt(s)"}
                 and cc.get("verdicts") == {"needed": True, "why": "3 failed verdict(s)"} and cc.get("all") == {"needed": True, "why": "1 return(s) to an earlier stage, 2 failed attempt(s), 3 failed verdict(s)"}, f"none {cc.get('none')}, all {cc.get('all')}")
    # n119 Analysis awaits a worker.
    pd = seen("pending")
    proofs.prove("n119", pd.get("waiting", {}).get("key") == "lessons:analysis" and pd.get("waiting", {}).get("waitsForPm") is True and pd.get("waiting", {}).get("asks") is True
                 and pd.get("written") == {"key": "lessons:written", "waitsForPm": False}, f"no analysis {pd.get('waiting', {}).get('key')} waits {pd.get('waiting', {}).get('waitsForPm')}, written {pd.get('written')}")
