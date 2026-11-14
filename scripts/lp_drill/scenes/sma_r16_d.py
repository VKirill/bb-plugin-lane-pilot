"""Region 16 · Slash commands and workflows, batch d — quick work, navigation and session commands, phase planning (n1237 … n1267).

Called from the region scene sma_r16.py (`prove_d(proofs, tmp)`); the receipt of that scene lists these nodes next to the other batches'. The probe sma_r16_d_probe.ts runs the REAL
code of the commit under drill — the real workflow engine with fake executors on the real graph files (issue-quick, lp.plan, plan-review-convergence), the phase driver on a scratch
database and a fake host, the PM tool and the phase gates — with no model, no hub write and nothing outside the machine, and prints what it returned. Each prove() below compares one
value with the result the node's card expects. The same observations are asserted by tests/sma/four-proofs-r16-d.test.ts.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_D = [
    "n1237", "n1238", "n1239", "n1240", "n1241", "n1242", "n1243", "n1244", "n1245", "n1246", "n1247", "n1248", "n1249", "n1250", "n1251", "n1252",
    "n1254", "n1255", "n1256", "n1257", "n1258", "n1259", "n1260", "n1261", "n1262", "n1263", "n1264", "n1265", "n1266", "n1267",
]
PROBE_D = ROOT / "scripts/lp_drill/scenes/sma_r16_d_probe.ts"
QUICK = "class plan lint write state closed"
REVIEWED = "class plan validate lint write review state closed_reviewed"
FULL = "class plan validate lint write-full review state closed_reviewed"
BARE = ["plan", "lint", "plan_critic", "ok"]
QUICK_MODE = ["plan", "lint", "ok"]


def prove_d(proofs, tmp) -> None:
    """Run the probe and prove batch d's nodes; when the probe printed nothing every node is recorded as not proved, with the reason."""
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_D)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_D:
            proofs.prove(node, False, f"the batch d probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    # ---- quick work
    d = seen("k_c_next")
    proofs.prove("n1237", d.get("first", {}).get("waitsForYou") is True and d.get("first", {}).get("stage") == "discussion" and d.get("paused", {}).get("waitsForYou") is False and str(d.get("paused", {}).get("next", "")).endswith("moves it on."), f"next: open stage {d.get('first')}, paused {d.get('paused')}")
    d = seen("k_wq_init")
    proofs.prove("n1238", d.get("flags") == {"full": False, "validate": False, "discuss": False, "research": False} and d.get("none") == QUICK and d.get("validate") == REVIEWED and d.get("full") == FULL and d.get("research") == "class research plan lint write state closed" and d.get("discuss") == "class discuss plan lint write state closed", f"flags {d.get('flags')}; paths none «{d.get('none')}», full «{d.get('full')}»")
    d = seen("k_wq_dir")
    proofs.prove("n1239", d.get("home") == ".agents/tasks/quick-1" and d.get("abs") == "/repo/.agents/tasks/quick-1" and d.get("slash") is None and d.get("up") is None and d.get("owner") == "quick-1", f"task folder {d.get('home')}, unsafe ids {d.get('slash')}/{d.get('up')}")
    d = seen("k_wq_discuss")
    proofs.prove("n1240", d.get("on") == "class discuss plan lint write state closed" and d.get("asked") == 1 and d.get("planAfter") is True and d.get("off") == QUICK and d.get("offAsked") == 0, f"discuss flag: path «{d.get('on')}», owner asked {d.get('asked')}; no flag: «{d.get('off')}», asked {d.get('offAsked')}")
    d = seen("k_wq_research")
    proofs.prove("n1241", d.get("on") == "class research plan lint write state closed" and d.get("planSaw") == {"research_notes": "files a.ts"} and d.get("off") == QUICK and d.get("offPlanSaw") == {}, f"research flag: path «{d.get('on')}», the plan saw {d.get('planSaw')}")
    d = seen("k_wq_plan")
    proofs.prove("n1242", d.get("one", {}).get("path") == QUICK and d.get("notClear", {}).get("status") == "blocked" and d.get("two", {}).get("status") == "proposed" and d.get("high", {}).get("status") == "proposed" and d.get("met", {}).get("comment") == "already met: nothing changed" and d.get("failed", {}).get("status") == "partial", f"plan routes: one {d.get('one', {}).get('status')}, unclear {d.get('notClear', {}).get('status')}, two tasks {d.get('two', {}).get('status')}, met {d.get('met', {}).get('comment')}")
    d = seen("k_wq_check")
    proofs.prove("n1243", d.get("none") == QUICK and d.get("once") == "class plan validate plan validate lint write review state closed_reviewed" and d.get("validations") == 2 and d.get("plans") == 2 and d.get("role") == "plan-critic", f"plan check: validate path «{d.get('once')}», critic visits {d.get('validations')}, planner visits {d.get('plans')}")
    d = seen("k_wq_exec")
    proofs.prove("n1244", d.get("modes") == {"write": "quick", "write-medium": "standard", "write-full": "full"} and d.get("medium") == "class plan lint write-medium state closed" and d.get("lowOut", {}).get("merged_commits") == ["abc"] and d.get("lost") == ["class plan lint write partial", "partial", "quick path: not finished"], f"executor modes {d.get('modes')}, medium risk «{d.get('medium')}», failed write {d.get('lost')}")
    d = seen("k_wq_review")
    proofs.prove("n1245", d.get("validate") == [REVIEWED, "closed", 1] and d.get("full") == [FULL, "closed", 1] and d.get("plain") == [QUICK, 0] and d.get("policy") == "all_or_low_confidence", f"review as advice: validate {d.get('validate')}, full {d.get('full')}, no flag {d.get('plain')}")
    d = seen("k_wq_verify")
    proofs.prove("n1246", d.get("validate") == [REVIEWED, 0, "done"] and d.get("plain") == [QUICK, 0, "quick path: built and verified"] and d.get("modes", {}).get("quick") == {"plan_critique.enabled": False, "code_critique.enabled": False} and d.get("modes", {}).get("full", {}).get("code_critique.enabled") is True, f"verify by flag: validate {d.get('validate')}, plain {d.get('plain')}, modes {d.get('modes')}")
    d = seen("k_wq_state")
    proofs.prove("n1247", d.get("table") is True and d.get("headings") == 1 and d.get("rows") == ["| 2026-11-10 | fix typo | abc123 |", "| 2026-11-11 | fix icon | def456 |"] and d.get("none") is None, f"STATE.md rows {d.get('rows')}, one heading {d.get('headings')}, no STATE.md -> {d.get('none')}")
    # ---- navigation and session
    d = seen("k_c_help")
    proofs.prove("n1248", d.get("missing") == [] and (d.get("commands") or 0) > 100 and d.get("firstLine") == "bb lane-pilot configure <json>" and len(d.get("regressLine", [])) == 1, f"help lists {d.get('commands')} commands, missing {d.get('missing')}")
    d = seen("k_c_progress")
    proofs.prove("n1249", d.get("inScope") == [] and d.get("outOfScope") == ["src/app.ts", ".agents/LESSONS.md", "docs/ARCHITECTURE.md", ".agents/decisions/d1.md", ".agents/PROGRESS.md.bak"] and d.get("final", {}).get("files") == [".agents/PROGRESS.md"] and d.get("idle") is True and d.get("busy") is False and d.get("folded") == ["a", "b"], f"project-life writes: in scope {d.get('inScope')}, refused {d.get('outOfScope')}")
    d = seen("k_c_resume")
    proofs.prove("n1250", d.get("hasResume") is True and d.get("alias") == "project-resume" and d.get("other") == "lp-docs", f"PM skills {d.get('skills')}, resume-project reads as {d.get('alias')}")
    d = seen("k_c_pause")
    proofs.prove("n1251", (d.get("handoff") or {}).get("stage") == "execution" and (d.get("handoff") or {}).get("awaitingOwnerWord") is None and (d.get("handoff") or {}).get("pieces") == [{"id": "p1", "taskId": "p1", "state": "not issued"}, {"id": "p2", "taskId": None, "state": "not issued"}] and str((d.get("note") or {}).get("how", "")).startswith("Как продолжить: lane_pilot_phase {action:\"resume\""), f"pause wrote {d.get('files')}; handoff {d.get('handoff')}")
    d = seen("k_c_plan")
    proofs.prove("n1252", d.get("approved") == [] and d.get("noCheck") == ["no independent plan check: run the plan critic (workflow lp.plan) and report its decision with the run's wfRunId"] and d.get("rounds3ok") == [] and len(d.get("rounds3", [])) == 2 and d.get("rounds3", [""])[0].startswith("3 rounds of the plan check asked for changes: stop revising") and d.get("rounds2") == ["the plan checker asked for changes"], f"plan gate: approved {d.get('approved')}, no check {d.get('noCheck')}, three rounds {d.get('rounds3', [''])[0][:60]}")
    d = seen("k_c_converge")
    proofs.prove("n1254", d.get("approved", [""])[0] == "critic_a critic_b converge approve" and d.get("approved", ["", {}])[1].get("status") == "approve" and d.get("changes", ["", {}])[1].get("status") == "changes_requested" and d.get("changes", ["", {}])[1].get("rounds") == 2, f"convergence: approved {d.get('approved')}, changes {d.get('changes')}")
    d = seen("k_c_review")
    proofs.prove("n1255", d.get("roles") == ["plan-critic", "specialist-reviewer", "plan-critic"] and d.get("ran") == [1, 1, 1] and d.get("consumes") == ["critic_a", "critic_b"], f"two independent readers: roles {d.get('roles')}, converge reads {d.get('consumes')}")
    # ---- phase planning
    d = seen("k_wp_rubric")
    proofs.prove("n1256", d.get("sameByPhase") is True and d.get("byStage", {}).get("order", [""])[0] == "read CONTEXT.md and SPEC.md" and len(d.get("byStage", {}).get("order", [])) == 7 and d.get("byStage", {}).get("antipatterns", [None, ""])[1] == "a dependency inside one wave", f"planning rubric: {d.get('counts')} steps/blocks, by stage equals by phase {d.get('sameByPhase')}")
    d = seen("k_wp_init")
    proofs.prove("n1257", d.get("discussion") == [".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md", ".agents/phases/ph_sma/DISCUSSION.md"] and d.get("closed") == [".agents/phases/ph_sma/BOOK.md"], f"stage init reads {d.get('discussion')}; closed {d.get('closed')}")
    d = seen("k_wp_closed")
    refusal = f"phase {d.get('id')} is closed: open a new phase for new work"
    proofs.prove("n1258", d.get("resumed") == refusal and d.get("paused") == refusal and d.get("replanned") == refusal and d.get("stageOnly") == refusal and d.get("stateOnly") == refusal and d.get("newPhase") is True, f"closed phase refuses resume/pause/replan: {d.get('resumed')}")
    d = seen("k_wp_headless")
    proofs.prove("n1259", d.get("held") == ["q1"] and d.get("heldAfterAnswer") == [] and d.get("gate") == ["open question q1: text q1"] and d.get("gateAfter") == [] and d.get("next", {}).get("key") == "planning:questions:q1,q2" and d.get("nextAfter") is True, f"parked question: held {d.get('held')}, gate {d.get('gate')}, after the answer {d.get('gateAfter')}")
    d = seen("k_wp_context")
    proofs.prove("n1260", d.get("firstTwo") == [".agents/phases/ph_sma/CONTEXT.md", ".agents/phases/ph_sma/DISCUSSION.md"] and d.get("spec") == 2, f"planning reads {d.get('firstTwo')} then SPEC at {d.get('spec')}")
    d = seen("k_wp_research")
    proofs.prove("n1261", d.get("off") == BARE and d.get("on") == ["research"] + BARE and d.get("planSaw", {}).get("research_md") == "R" and d.get("quick") == QUICK_MODE, f"research: default {d.get('off')}, on {d.get('on')}, quick {d.get('quick')}")
    d = seen("k_wp_validation")
    proofs.prove("n1262", d.get("off") == BARE and d.get("on") == ["strategy"] + BARE and d.get("planSaw", {}).get("validation_md") == "V" and d.get("emitted") == "V" and d.get("quick") == QUICK_MODE, f"validation strategy: default {d.get('off')}, on {d.get('on')}, quick {d.get('quick')}")
    d = seen("k_wp_threat")
    refusal = "the security risk «user tokens leave the box» needs a threat model: write the phase's SECURITY.md (lane-plan template fill SECURITY --phase …) and sign it with the context"
    proofs.prove("n1263", d.get("none") is None and d.get("risk") == refusal and d.get("withModel") is None and d.get("inGate") == [refusal], f"threat gate: none {d.get('none')}, a risk without SECURITY.md «{str(d.get('risk'))[:70]}», with it {d.get('withModel')}")
    d = seen("k_wp_uigate")
    proofs.prove("n1264", d.get("noContract") == "the drawing has no contract: add UI-SPEC.md with the checkable points (screens, states, breakpoints) to the drawing's paths" and d.get("withSpec") is None and d.get("notNeeded") is None and d.get("noDrawing") is None, f"UI contract gate: {d.get('noContract')}; with UI-SPEC {d.get('withSpec')}")
    d = seen("k_wp_drift")
    proofs.prove("n1265", d.get("behind") == 3 and d.get("same") == 0 and d.get("fresh") == 0 and d.get("noMeta") == 0 and d.get("text") == "Code map is 3 commits behind HEAD: reindex before relying on it" and d.get("none") is None, f"code map drift {d.get('behind')}, same commit {d.get('same')}, session text «{d.get('text')}»")
    d = seen("k_wp_patterns")
    proofs.prove("n1266", d.get("off") == BARE and d.get("on") == ["patterns"] + BARE and d.get("planSaw", {}).get("patterns_md") == "P" and d.get("emitted") == "P" and d.get("quick") == QUICK_MODE, f"patterns: default {d.get('off')}, on {d.get('on')}, quick {d.get('quick')}")
    d = seen("k_wp_planner")
    proofs.prove("n1267", d.get("role") == "planner" and d.get("bad") == [["plan", "lint", "plan", "lint", "plan", "lint", "failed"], 3, 0, "failed"] and d.get("fixed", [None, [None, {}]])[1][1] == {"gaps": ["a: owns_paths overlap"]} and d.get("already", [None, None, None])[1:] == [True, 0], f"planner: role {d.get('role')}, lint-failing plan {d.get('bad')}, revisit carries {d.get('fixed', [None, [None, None]])[1][1:]}")
