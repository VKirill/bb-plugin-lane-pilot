"""Region 16 · Slash commands and workflows, batch c — the verify-work cards, the debug session and the stand-alone commands (n1205 … n1236, without n1224 and n1230).

Called from the region scene sma_r16.py (`prove_c(proofs, tmp)`); the receipt of that scene lists these nodes next to batches a and b. The probe sma_r16_c_probe.ts runs the REAL code of
the commit under drill — the real workflow engine on the real graph files with the model and owner steps stubbed, the phase driver on a scratch database and a fake host, a scratch git
repository for the undo — with no model, no hub write and nothing outside the machine, and prints what it returned. Each prove() below compares one value with the result the node's
card expects. The same observations are asserted by tests/sma/four-proofs-r16-c.test.ts.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_C = [
    "n1205", "n1206", "n1207", "n1208", "n1209", "n1210", "n1211", "n1212", "n1213", "n1214", "n1215", "n1216", "n1217", "n1218", "n1219", "n1220", "n1221", "n1222", "n1223",
    "n1225", "n1226", "n1227", "n1228", "n1232", "n1233", "n1234", "n1235", "n1236",
]
PROBE_C = ROOT / "scripts/lp_drill/scenes/sma_r16_c_probe.ts"


def _why(open_: int, failed: int, total: int) -> str:
    return f"UAT is not complete: {open_} open, {failed} failed of {total} — the owner answers each line by its number (uat_line)"


def prove_c(proofs, tmp) -> None:
    """Run the probe and prove batch c's nodes; when the probe printed nothing every node is recorded as not proved, with the reason."""
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_C)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_C:
            proofs.prove(node, False, f"the batch c probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    d = seen("k_wv_design")
    proofs.prove("n1205", d.get("total") == 46 and d.get("kept") == 40 and d.get("first") == {"id": "design_6c4c7e24", "text": "point 1: the screen shows 1"} and d.get("last") == "point 40: the screen shows 40" and d.get("small") == ["one", "two"] and d.get("stable") is True and d.get("ids") == 40, f"design points: {d.get('kept')} kept of {d.get('total')}, first {d.get('first')}")
    d = seen("k_wv_extract")
    proofs.prove("n1206", d.get("agreed") == {"path": ["derive", "confirm", "baseline", "write_tests", "run", "inventory", "done"], "status": "done", "added": 3, "fromDerive": "baseline#1"} and d.get("timeout") == {"path": ["derive", "confirm", "blocked"], "status": "blocked"} and d.get("given", {}).get("skipped") == ["derive", "confirm"], f"agreed {d.get('agreed')}; timeout {d.get('timeout')}; given {d.get('given')}")
    d = seen("k_wv_uatfile")
    proofs.prove("n1207", d.get("bare") == ["- [ ] 1. p1: given g, when w, then then-p1", "- [ ] 2. p2: given g, when w, then then-p2", "- [ ] 3. p3: given g, when w, then then-p3"] and d.get("answered") == ["- [x] 1. p1: given g, when w, then then-p1", "- [!] 2. p2: given g, when w, then then-p2 — the total is wrong", "- [ ] 3. p3: given g, when w, then then-p3"] and d.get("readBack", {}).get("passed") == 1 and d.get("readBack", {}).get("lines") == 3, f"acceptance file {d.get('answered')}; read back {d.get('readBack')}")
    d = seen("k_wv_present")
    proofs.prove("n1208", d.get("lines") == [{"n": 1, "state": "open", "note": None, "by": None}, {"n": 2, "state": "passed", "note": None, "by": "owner via screen"}, {"n": 3, "state": "failed", "note": "the total   is wrong", "by": "owner"}] and d.get("book") == ["UAT line 2 (p2): pass by owner via screen", "UAT line 3 (p3): fail —   the total   is wrong  by owner"] and d.get("unknown") == "no UAT line 9: the lines are 1 to 3", f"lines {d.get('lines')}; book {d.get('book')}; unknown {d.get('unknown')}")
    d = seen("k_wv_complete")
    proofs.prove("n1209", d.get("open", {}).get("why") == _why(1, 0, 3) and d.get("failed", {}).get("why") == _why(0, 1, 3) and d.get("none", {}).get("why") == _why(0, 0, 0) and d.get("all") == {"why": None, "stage": "acceptance", "words": [["uat", "yes"]]}, f"the owner's yes: open {d.get('open', {}).get('why')}; all passed {d.get('all')}")
    d = seen("k_wv_diagnose")
    proofs.prove("n1210", d.get("path") == ["ask_symptoms", "normalize", "diagnose", "diagnosed"] and d.get("skipped") == ["ask_symptoms"] and d.get("count") == 3 and d.get("causes") == ["cause 1", "cause 2", "cause 3"] and d.get("gaps") == ["check p1 red: lint fails", "check p2 red: the total is wrong", "check p3 red: timeout"], f"diagnosis path {d.get('path')}; causes {d.get('causes')}; gaps {d.get('gaps')}")
    d = seen("k_wv_gapplan")
    proofs.prove("n1211", d.get("plan") == {"goal": "Fix review findings", "mode": "gaps", "gaps": [{"file": "src/a.ts", "line": 12, "severity": "high", "evidence": "return value of save() ignored"}]} and d.get("plan2", {}).get("gaps") == [{"file": "src/b.ts", "line": 3, "severity": "medium", "evidence": "empty catch"}] and d.get("path") == ["first_review", "plan_fix", "build_fix", "re_review", "plan_fix2", "build_fix2", "re_review", "done"], f"planner got {d.get('plan')}; path {d.get('path')}")
    d = seen("k_wv_gapcheck")
    proofs.prove("n1212", d.get("big") == {"path": ["plan", "lint", "plan_critic", "ok"], "verdict": "pass", "status": "ok"} and d.get("small", {}).get("path") == ["plan", "lint", "ok"] and d.get("quick") == ["plan", "lint", "ok"] and d.get("roles") == ["planner", "plan-critic"], f"big plan {d.get('big')}; small {d.get('small')}; quick {d.get('quick')}")
    d = seen("k_wv_revision")
    proofs.prove("n1213", d.get("fixed", {}).get("path") == ["plan", "plan_critic", "plan", "plan_critic", "ok"] and d["fixed"].get("handed", [None, None])[1] == [{"id": "c1", "severity": "high", "file": "PLAN", "line": 1, "evidence": "t2 depends on a task that does not exist"}] and d.get("endless") == {"plans": 3, "critics": 3, "status": "low_confidence"}, f"revision {d.get('fixed', {}).get('path')}; endless {d.get('endless')}")
    d = seen("k_c_debug")
    proofs.prove("n1214", d.get("sure", {}).get("path") == ["session", "investigate", "write_investigation_session", "write_investigation_evidence", "confirmed"] and d["sure"].get("confidence") == 82 and d.get("weak") == {"path": ["session", "investigate", "write_investigation_session", "write_investigation_evidence", "investigate", "write_investigation_session", "write_investigation_evidence", "inconclusive"], "status": "inconclusive"} and d.get("objection", {}).get("path") == ["session", "investigate", "write_investigation_session", "write_investigation_evidence", "verify_cause", "write_verification_session", "write_verification_evidence", "investigate", "write_investigation_session", "write_investigation_evidence", "verify_cause", "write_verification_session", "write_verification_evidence", "confirmed"], f"sure {d.get('sure', {}).get('path')}; weak {d.get('weak')}; objection {d.get('objection', {}).get('path')}")
    d = seen("k_c_forensics")
    entries = d.get("entries", [])
    proofs.prove("n1215", sorted(entries) == sorted(["attempt: attempt 1 created", "baseline: baseline red → kept: main was red too", "edition: contract edition 1 (created) · sha <12>", "move: attempt 1: queued → spawn_requested", "move: attempt 1: running → blocked: verification_failed: npm test", "move: attempt 1: spawn_requested → running", "stage: stage verification failed (attempt 1)", "task: task arrived (pm)"]) and d.get("receipts") == [["verification", "failed", 1]] and d.get("none") == {"runId": None, "entries": 0}, f"post-mortem {entries}")
    d = seen("k_c_health")
    proofs.prove("n1216", d.get("report") == [{"area": "todos", "missingInIndex": ["unlisted"], "deadIndexLines": ["- ghost-item — the folder was deleted"]}, {"area": "plans", "missingInIndex": ["2026-11-02-new-plan"], "deadIndexLines": []}] and d.get("plans") == "# Plans\n- 2026-11-01-big-plan\n- 2026-11-02-new-plan\n" and d.get("todosBak") is True and d.get("after") == [], f"integrity {d.get('report')}; fixed {d.get('fixed')}")
    d = seen("k_c_undo")
    first, again, collide = d.get("first", {}), d.get("again", {}), d.get("collide", {})
    proofs.prove("n1217", first.get("result", {}).get("state") == "merged" and first.get("libGone") is True and first.get("keepsMerge") is True and first.get("subject") == "Merge writer work: Revert t1" and again.get("state") == "refused" and again.get("summary") == "task t1 was already reverted in <sha>" and collide.get("collide", {}).get("conflicts") == ["server.ts"] and collide.get("mainKept") is True, f"undo {first.get('result', {}).get('summary')}; again {again.get('summary')}; collide {collide.get('collide', {}).get('summary')}")
    d = seen("k_wdb_list")
    proofs.prove("n1218", d.get("all") == {"runs": [["r5", "succeeded"], ["r4", "running"], ["r2", "failed"], ["r1", "succeeded"]], "hasMore": False} and d.get("page") == {"runs": [["r5", "succeeded"], ["r4", "running"]], "hasMore": True} and d.get("next") == {"runs": [["r2", "failed"], ["r1", "succeeded"]], "hasMore": False} and d.get("mine", {}).get("runs") == [["r4", "running"], ["r2", "failed"], ["r1", "succeeded"]], f"runs {d.get('all')}; first page {d.get('page')}")
    d = seen("k_wdb_continue")
    proofs.prove("n1219", d.get("path") == ["session", "investigate", "write_investigation_session", "write_investigation_evidence", "confirmed"] and "ask_symptoms" in d.get("skipped", []) and d.get("asked") == 0 and d.get("kept") is True, f"resumed {d.get('path')}; asked {d.get('asked')}; file kept {d.get('kept')}")
    d = seen("k_wdb_symptoms")
    proofs.prove("n1220", d.get("short") == {"path": ["ask_symptoms", "investigate", "confirmed"], "status": "confirmed"} and d.get("handed") == "ask_symptoms#1" and d.get("long", {}).get("path") == ["investigate", "confirmed"] and d.get("failures") == ["normalize", "diagnose", "diagnosed"], f"short {d.get('short')}; long {d.get('long')}; failures {d.get('failures')}")
    d = seen("k_wdb_setup")
    proofs.prove("n1221", d.get("file") == "# Debug session — csv-crash\n\nStatus: open\n\n## Symptom\n\nthe import crashes on files with an empty last line, since v2.3\n\n## Hypotheses\n\n## Evidence\n\n## Root cause\n\n## Fix directions\n- h1: fresh entry\n" and d.get("hostile", {}).get("escaped") is False and d.get("hostile", {}).get("kept") is True and d.get("none") == ["investigate", "confirmed"], f"session file {str(d.get('file'))[:60]}; hostile {d.get('hostile')}; no name {d.get('none')}")
    d = seen("k_wdb_manager")
    proofs.prove("n1222", d.get("keys") == ["affected_files", "confidence", "diagnosis", "evidence_path", "fix_direction", "fix_directions", "regression_tests", "risks", "root_cause", "status"] and d.get("out", {}).get("status") == "confirmed" and d["out"].get("confidence") == 82 and d.get("fanout") == [["diagnose:child", "new"], ["diagnose:child", "new"]], f"summary keys {d.get('keys')}; fan-out {d.get('fanout')}")
    d = seen("k_c_docsupdate")
    proofs.prove("n1223", d.get("whole") == {"path": ["prepare", "write", "verify", "commit", "done"], "row": {"state": "passed", "pages": 3}, "commitGot": "verify#1"} and d.get("unverified", {}).get("path") == ["prepare", "write", "verify", "skipped-verify"] and d.get("idle") == {"path": ["prepare", "skipped-prepare"], "wrote": 0}, f"whole {d.get('whole')}; unverified {d.get('unverified')}; idle {d.get('idle')}")
    d = seen("k_c_sessreport")
    proofs.prove("n1225", d.get("done") == "2 задач, принято 1 (50.0%)" and d.get("lpErrors") == "1" and d.get("outside") == "песочницы 1, старые версии 0" and d.get("sandbox") == "1 попыток, принято 100.0%" and d.get("where") is True and d.get("oldAttemptCounted") is False, f"report: {d.get('head')} / {d.get('done')} / {d.get('outside')}")
    d = seen("k_c_stats")
    proofs.prove("n1226", d.get("phases") == [["first", "execution", "active"], ["second", "planning", "active"]] and d.get("plans") == {"pieces": 5, "accepted": 2, "withdrawn": 2} and d.get("git") == {"commits": 1, "files": 3} and d.get("timeline") == ["accepted: T1"] and d.get("other", {}).get("phases") == 0, f"stats: phases {d.get('phases')}, plans {d.get('plans')}, git {d.get('git')}")
    d = seen("k_c_explore")
    proofs.prove("n1227", d.get("open", {}).get("path") == ["walk", "synth", "open"] and d["open"].get("out", {}).get("locked") == ["GET only"] and d["open"]["out"].get("open") == ["invalidation on write"] and d.get("done") == {"path": ["walk", "synth", "done"], "status": "done", "deferred": ["metrics"]} and d.get("again") == {"path": ["walk", "walk", "synth", "done"], "walks": 2}, f"open {d.get('open', {}).get('out')}; done {d.get('done')}; again {d.get('again')}")
    d = seen("k_c_spike")
    proofs.prove("n1228", d.get("ok") == {"path": ["spike_new", "experiment", "write_spike", "skill_dir", "write_skill", "goal_check", "answered"], "out": {"status": "answered", "decision": "yes, fts5 handles 1M rows", "spike_path": "spikes/fts.md", "skill_draft": "draft.md", "skill_path": ""}} and d.get("failed") == {"path": ["spike_new", "experiment", "write_spike", "skill_dir", "write_skill", "goal_check", "inconclusive"], "status": "inconclusive", "draft": ""} and d.get("none") == {"path": ["spike_new", "experiment", "write_spike", "skill_dir", "write_skill", "inconclusive"], "status": "inconclusive", "draft": ""}, f"ok {d.get('ok')}; failed {d.get('failed')}; none {d.get('none')}")
    d = seen("k_c_quick")
    proofs.prove("n1232", d.get("short", {}).get("path") == ["class", "plan", "lint", "write", "state", "closed"] and d["short"].get("stateGot") == "Typo in button label" and d.get("several") == {"path": ["class", "plan", "escalate", "proposed"], "status": "proposed", "wrote": 0} and d.get("failed") == {"path": ["class", "plan", "lint", "write", "partial"], "status": "partial"} and d.get("row") == ["| date | task | commit |", "| --- | --- | --- |", "| 2026-11-10 | Typo in button label | q1 |"], f"short {d.get('short', {}).get('path')}; several {d.get('several')}; failed {d.get('failed')}")
    d = seen("k_c_fastc")
    proofs.prove("n1233", d.get("done", {}).get("path") == ["self_check", "task", "done"] and d.get("big") == {"path": ["self_check", "reroute", "rerouted"], "out": {"status": "rerouted", "proposed_workflow": "analyze-plan-execute", "summary": "spans three modules"}, "wrote": 0} and d.get("failed") == {"path": ["self_check", "task", "blocked"], "status": "blocked"}, f"done {d.get('done')}; big {d.get('big')}; failed {d.get('failed')}")
    d = seen("k_c_do")
    proofs.prove("n1234", d.get("full") == {"decision": "route", "workflowId": "issue-full", "questions": 0, "rule": "tracker-ref"} and d.get("debug") == {"decision": "route", "workflowId": "debug", "questions": 0, "rule": "ui-words"} and d.get("vague") == {"decision": "clarify", "workflowId": None, "questions": 3, "rule": None} and d.get("cont") == {"decision": "clarify", "workflowId": None, "questions": 1, "rule": "state_continue"}, f"routes: full {d.get('full')}; vague {d.get('vague')}; continue {d.get('cont')}")
    d = seen("k_c_autonomous")
    proofs.prove("n1235", d.get("on") == {"next": [["Menu", "discussion", "1.2"]], "book": ["autonomous: the next phase <id> «Menu» (roadmap 1.2) is open"], "told": [], "closed": "closed"} and d.get("off", {}).get("next") == [] and len(d.get("off", {}).get("told", [])) == 1 and d.get("lastRow") == {"next": [], "book": [], "told": [], "closed": "closed"}, f"autonomous on {d.get('on')}; off {d.get('off', {}).get('next')} told {len(d.get('off', {}).get('told', []))}")
    d = seen("k_c_manager")
    idle, busy = d.get("idle", {}), d.get("busy", {})
    proofs.prove("n1236", [idle.get("first"), idle.get("second"), idle.get("third")] == [1, 1, 2] and str(idle.get("texts", [""])[0]).startswith("[Lane Pilot phase] Phase <id> «Hud» — stage 2, planning") and [busy.get("first"), busy.get("second"), busy.get("third")] == [0, 0, 0], f"idle PM told {[idle.get('first'), idle.get('second'), idle.get('third')]} times; busy PM {[busy.get('first'), busy.get('second'), busy.get('third')]}")
