"""Region 16 · Slash commands and workflows, batch b — the execute-phase tail, the todo/note/seed commands, verify-work, lessons and graduation (n1174 … n1204).

Called from the region scene sma_r16.py (`prove_b(proofs, tmp)`); the receipt of that scene lists these nodes next to batch a's. The probe sma_r16_b_probe.ts runs the REAL code of the
commit under drill — the phase driver on a scratch database and a fake host, the real workflow engine writing into a temp checkout, the phase gates and their texts, the
backlog and the session-memory door — with no model, no hub write and nothing outside the machine, and prints what it returned. Each prove() below compares one value with the
result the node's card expects. The same observations are asserted by tests/sma/four-proofs-r16-b.test.ts.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_B = [
    "n1174", "n1175", "n1176", "n1177", "n1178", "n1179", "n1180", "n1181", "n1182", "n1183", "n1184", "n1185", "n1186", "n1187", "n1188", "n1189", "n1190",
    "n1192", "n1193", "n1194", "n1195", "n1196", "n1197", "n1198", "n1199", "n1200", "n1201", "n1202", "n1203", "n1204",
]
PROBE_B = ROOT / "scripts/lp_drill/scenes/sma_r16_b_probe.ts"
LESSON = "Phase «Sums» lessons: The plan missed the empty-cell case; a check per promise would have caught it."


def prove_b(proofs, tmp) -> None:
    """Run the probe and prove batch b's nodes; when the probe printed nothing every node is recorded as not proved, with the reason."""
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_B)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_B:
            proofs.prove(node, False, f"the batch b probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    d = seen("k_we_waves")
    proofs.prove("n1174", d.get("open", {}).get("first") == ["a", "b", "c"] and d.get("capped", {}).get("first") == ["a", "b"] and d["capped"].get("second") == ["a", "b", "c"], f"one pass issues {d.get('open', {}).get('first')}, with a cap of 2 {d.get('capped', {}).get('first')} then {d.get('capped', {}).get('second')}")
    d = seen("k_we_inline")
    proofs.prove("n1175", d.get("inline") == {"first": ["a"], "second": ["a", "b"]} and d.get("withSubagents", {}).get("first") == ["a", "b", "c"], f"without subagents {d.get('inline')}, with them {d.get('withSubagents', {}).get('first')}")
    d = seen("k_we_aggregate")
    broken = [line for line in d.get("broken", []) if line[1] is False]
    proofs.prove("n1176", d.get("held", [[0, 0, ""]] * 6)[0][2] == "2 piece(s) hold contract_current" and broken == [["independent_check", False, "independent_check fails: p2"]] and d.get("brokenPiece") == ["independent_check"], f"wave lines: {d.get('held', [[0, 0, '']])[0][2]}; broken {broken}")
    d = seen("k_we_codereview")
    proofs.prove("n1177", d.get("adviceOnly") == [True, False] and d.get("blockingRubric") == [True, True] and d.get("blockingOther") == [True, False] and d.get("blockStatus") == [True, True] and d.get("approved") == [False, False] and d.get("advisoryMode") == "advisory", f"[gate, advisory] stops: advice only {d.get('adviceOnly')}, blocking rubric {d.get('blockingRubric')}, block status {d.get('blockStatus')}; default mode {d.get('defaultMode')}")
    d = seen("k_we_regression")
    call = d.get("call", {})
    proofs.prove("n1178", call.get("mode") == "full" and call.get("force") is True and call.get("basePaths") == [d.get("greenTree")] and d.get("green", {}).get("verdict") == "passed" and d.get("red", {}).get("verdict") == "failed", f"regression call {call}; green {d.get('green')}; red {d.get('red')}")
    d = seen("k_we_verify")
    proofs.prove("n1179", d.get("skipped") is False and d.get("passed") is True and d.get("notOwed") is True and d.get("onOtherHead", [True])[0] is False and "same candidate" in str(d.get("onOtherHead")) and d.get("onSameHead", [False])[0] is True, f"live check: skipped {d.get('skipped')}, passed {d.get('passed')}, other head {d.get('onOtherHead')}, same head {d.get('onSameHead')}")
    d = seen("k_we_uiqa")
    proofs.prove("n1180", d == {"withUi": "live", "checkOff": "close", "taken": "close", "noScreens": "close", "beforeVerdict": None}, f"next automatic stage: {d}")
    d = seen("k_we_roadmap")
    proofs.prove("n1181", d.get("rows") == ["- [x] 1.1 Hud — build it", "- [ ] 1.2 Menu — the menu", "- [ ] 999.1 Later — parked"] and d.get("parked") is True and d.get("unknown") is True, f"roadmap rows after the close {d.get('rows')}")
    d = seen("k_we_learnings")
    proofs.prove("n1182", d.get("yes") == {"staged": ["staged", 0], "after": ["applied", [["phase-lessons", LESSON]]]} and d.get("no") == {"staged": ["staged", 0], "after": ["declined", []]}, f"owner's yes {d.get('yes', {}).get('after')}; no {d.get('no', {}).get('after')}")
    d = seen("k_we_next")
    proofs.prove("n1183", d.get("told") == "Next on the roadmap: 1.2 «Menu» — the menu" and d.get("autoPhases") == [["Menu", "1.2"]] and d.get("rows", [None, None, 0, None])[2:] == [None, "999.1"] and d.get("gaps") == "replan", f"told «{d.get('told')}»; autonomous opened {d.get('autoPhases')}; failed verdict -> {d.get('gaps')}")
    d = seen("k_c_addtodo")
    meta = d.get("meta") or {}
    proofs.prove("n1184", d.get("status") == "succeeded" and d.get("folders") == ["<day>-<run>"] and meta.get("status") == "ready" and meta.get("estimate") == 3 and meta.get("priority") == "high" and d.get("readme") == "the flaky payments test" and d.get("board") == [True], f"todo folder {d.get('folders')}, meta {meta}, on the backlog board {d.get('board')}")
    d = seen("k_c_note")
    proofs.prove("n1185", d.get("output") == {"status": "done", "confirmation": "note saved"} and d.get("notes") == 1 and d.get("body") == "---\ncreated: <day>\nsource: note-add\n---\n\ndeploy is manual\n", f"note: {d.get('output')}, {d.get('notes')} write(s) of {d.get('file')}")
    d = seen("k_c_seed")
    proofs.prove("n1186", d.get("parsed", {}).get("dependsOn") == ["a", "b"] and d.get("noId") is None and d.get("board") == {"issuable": ["later"], "blocked": ["waits"]}, f"seed meta {d.get('parsed')}, board {d.get('board')}")
    d = seen("k_c_backlog")
    proofs.prove("n1187", d.get("first", [None])[0] == "999.1" and d.get("second", [None])[0] == "999.2" and d.get("next") == "1.1" and d.get("hostile") == ["- [ ] 999.2 Evil - [ ] 1.9 injected — line one ## Backlog2"], f"parked as {d.get('first', [None])[0]}, then {d.get('second', [None])[0]}; the machine's next row {d.get('next')}")
    d = seen("k_c_checktodos")
    proofs.prove("n1188", d.get("order") == ["high-small", "high-big", "mid", "low-small"] and d.get("needsEstimate") == ["none"] and d.get("decompose") == ["huge"] and "high-small/AGENT.md" in d.get("order1", ""), f"pick order {d.get('order')}, needs an estimate {d.get('needsEstimate')}, to split {d.get('decompose')}")
    d = seen("k_c_listseeds")
    proofs.prove("n1189", d.get("board") == [["r"], [], []] and d.get("like") == ["x"] and d.get("parsed") == [["a", "ready"], ["b", "idea"]] and d.get("readOnly") is True, f"open ideas {d.get('board')}, match {d.get('like')}, read-only command {d.get('readOnly')}")
    d = seen("k_c_thread")
    proofs.prove("n1190", d.get("written") is True and d.get("found") == ["The reports page lives in components/reports and reads the daily table."] and d.get("other") == 0 and d.get("secret") == [False, True] and d.get("where", [{}])[0] == {"projectId": "P", "scopes": ["section:bot"]}, f"a note from one session is found by another: {d.get('found')}; other project sees {d.get('other')}; secret refused {d.get('secret')}")
    d = seen("k_c_verify")
    state = d.get("state", {})
    proofs.prove("n1192", len(d.get("lines", [])) == 3 and len(d.get("changed", [])) == 2 and state.get("lines") == 3 and state.get("passed") == 1 and len(state.get("failed", [])) == 1 and d.get("none") is None and "verified head abcdef123456" in str(d.get("candidate")), f"UAT lines {len(d.get('lines', []))}, changed by two answers {len(d.get('changed', []))}, read back {state}")
    d = seen("k_c_verifyphase")
    proofs.prove("n1193", d.get("passed", [""])[0] == "passed" and d.get("unproved") == ["failed", "p2: plan-fact failed — the promise is not proved"] and d.get("running", [""])[0] == "pending" and d.get("noGoal", [""])[0] == "failed" and d.get("same") is True, f"verdicts: all proved {d.get('passed')}, one unproved {d.get('unproved')}, goal check running {d.get('running')}")
    d = seen("k_c_diagnose")
    proofs.prove("n1194", d.get("due") == "diagnose" and d.get("off") == "replan" and d.get("two") == ["ask_symptoms diagnose diagnosed", 2] and d.get("seven") == ["ask_symptoms diagnose diagnosed", 6], f"failed verdict with phase.diagnose on -> {d.get('due')}, off -> {d.get('off')}; debuggers for 2 gaps {d.get('two', [None, None])[1]}, for 7 gaps {d.get('seven', [None, None])[1]}")
    d = seen("k_c_transition")
    proofs.prove("n1195", d.get("state") == "closed" and d.get("closed") is True and d.get("stateHas") == [True, True, True, True] and d.get("committed") == [[".agents/phases/<id>/SUMMARY.md", ".agents/planning/ROADMAP.md", ".agents/planning/STATE.md"]] and d.get("booked") == 1, f"closed: {d.get('state')}, documents committed {d.get('committed')}, STATE marks {d.get('stateHas')}")
    d = seen("k_c_graduation")
    proofs.prove("n1196", d == {"twice": None, "thrice": "recurred", "owner": "owner", "confirmed": "confirmed", "proposed": None, "held": None, "notAMechanism": None}, f"rule graduation: {d}")
    d = seen("k_c_lessons")
    proofs.prove("n1197", d.get("early") == "phase <id> is at discussion, not lessons" and d.get("stage") == "closed" and d.get("lessons", {}).get("author") == "thr_retro" and d["lessons"].get("reviewer") == "thr_stage" and d["lessons"].get("hashIsMeasured") is True, f"lessons at the wrong stage «{d.get('early')}»; at lessons -> {d.get('stage')}, kept {d.get('lessons')}")
    d = seen("k_wl_rubric")
    proofs.prove("n1198", d.get("clean") == {"needed": False, "why": "the phase went through without returns or failures"} and d.get("troubled", {}).get("needed") is True and d.get("troubled", {}).get("why") == "2 return(s) to an earlier stage, 1 failed attempt(s)" and "5) the daemon writes the conclusion (SUMMARY.md)" in d.get("rubric", ""), f"clean phase {d.get('clean')}, troubled {d.get('troubled')}")
    d = seen("k_wl_order")
    refusals = d.get("refusals", {})
    proofs.prove("n1199", len(set(refusals.values())) == 4 and "is not a session other than the analysis's author" in refusals.get("self", "") and "did not receive these bytes" in refusals.get("other", "") and d.get("bytesKept") is True and d.get("reviewer") == "thr_stage", f"refusals {sorted(refusals)}; the independent reviewer {d.get('reviewer')} read the author's {d.get('author')} bytes: {d.get('bytesKept')}")
    d = seen("k_wl_write")
    proofs.prove("n1200", d.get("direct") == {"stage": "closed", "draft": None, "memory": [["phase-lessons", LESSON]]} and d.get("drafted", {}).get("draft") == "staged" and d["drafted"].get("memory") == 0, f"the daemon wrote {d.get('direct', {}).get('memory')}; with the owner's word asked a draft {d.get('drafted', {}).get('draft')}, memory rows {d.get('drafted', {}).get('memory')}")
    d = seen("k_wv_rubric")
    proofs.prove("n1201", d.get("rubric", "").endswith("Blocking: verifying on a main that moved since; a goal audit by the author of the work; a passed check that proves only that a file exists.") and d.get("selfReport", [""])[0] == "failed" and "left no receipt" in str(d.get("selfReport")) and d.get("proved") == "passed", f"a writer's report without receipts -> {d.get('selfReport', [''])[0]}; with receipts {d.get('proved')}")
    d = seen("k_wv_init")
    proofs.prove("n1202", d.get("verification") == [".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/VALIDATION.md", ".agents/phases/ph_sma/design/UI-SPEC.md"] and d.get("plain") == [".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/VALIDATION.md"], f"verification reads {d.get('verification')}")
    d = seen("k_wv_active")
    proofs.prove("n1203", d.get("state", {}).get("lines") == 4 and d["state"].get("passed") == 1 and len(d["state"].get("failed", [])) == 1 and d.get("next") == "3. p3: given g, when w, then t3" and d.get("none", {}).get("lines") == 0, f"UAT state {d.get('state')}, next {d.get('next')}")
    d = seen("k_wv_autoui")
    proofs.prove("n1204", d.get("builds") == [True, False, True, True] and d.get("due") == "live" and d.get("inputs", {}).get("url") == "http://127.0.0.1:5173/" and d.get("inputs", {}).get("dev_server") == "npm run dev" and d.get("backendOnly") == "close", f"screens built {d.get('builds')}, check {d.get('due')} with {d.get('inputs')}, backend-only phase -> {d.get('backendOnly')}")
