"""Region 16 · Slash commands and workflows, batch g — milestone close, ship, deploy, project start, code analysis (n1330 … n1348).

Called from the region scene sma_r16.py (`prove_g(proofs, tmp)`); the receipt of that scene lists these nodes next to the other batches'. The probe sma_r16_g_probe.ts runs the REAL
code of the commit under drill — the real workflow engine on the real graph files (milestone-close, milestone-summary, new-milestone, cleanup, ship, deploy, project-start,
analyze-code) with the model steps answering from a table, and the real full-gate verdict — with no model, no hub write and nothing outside the machine, and prints what it returned.
Each prove() below compares one value with the result the node's card expects. The same observations are asserted by tests/sma/four-proofs-r16-g.test.ts.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_G = [
    "n1330", "n1331", "n1332", "n1333", "n1334", "n1335", "n1336", "n1337", "n1338", "n1339", "n1340", "n1341", "n1342", "n1343", "n1344", "n1345", "n1346", "n1347", "n1348",
]
PROBE_G = ROOT / "scripts/lp_drill/scenes/sma_r16_g_probe.ts"
FULL_CLOSE = ["status", "retro", "living", "close", "summary", "approve_knowledge", "record", "snapshot", "archive", "closed"]
SHIPPED = ["gate", "preflight", "open_pr", "hooks", "goal_check", "shipped"]
PHASES = ["1 coverage of REQ-2", "2 the gate"]


def prove_g(proofs, tmp) -> None:
    """Run the probe and prove batch g's nodes; when the probe printed nothing every node is recorded as not proved, with the reason."""
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_G)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_G:
            proofs.prove(node, False, f"the batch g probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    # ---- milestone close, summary, audit, new milestone, cleanup
    d = seen("k_c_completems")
    proofs.prove("n1330", d.get("onPath") == FULL_CLOSE and d.get("offPath") == ["status", "retro", "close", "approve_knowledge", "archive", "closed"] and [d.get("onRecordCalled"), d.get("onSnapshotCalled"), d.get("offRecordCalled"), d.get("offSnapshotCalled")] == [1, 1, 0, 0] and d.get("recordPath") == ".agents/milestones/{{status.effective_run_id}}.md" and "only if the file already exists; never create it" in d.get("retroPrompt", ""), f"close path with the record and the snapshot {d.get('onPath')}; switches off {d.get('offPath')}")
    d = seen("k_c_mssummary")
    proofs.prove("n1331", d.get("alonePath") == ["summary", "goal_check", "done"] and d.get("aloneOut", {}).get("status") == "done" and d.get("summaryCalls") == [1, 0, 0] and "summary" in d.get("onPath", []) and "summary" not in d.get("offPath", []) and d.get("haltedStatus") == "halted", f"summary runs after a close only with the switch on: calls {d.get('summaryCalls')}, graph alone {d.get('alonePath')}")
    d = seen("k_c_auditms")
    proofs.prove("n1332", d.get("clear", {}).get("asked") == 0 and d.get("clear", {}).get("status") == "closed" and all(d.get(k, {}).get("asked") == 1 and d.get(k, {}).get("status") == "not_ready" for k in ["open", "uncovered", "red", "unlanded", "running", "timeout"]) and d.get("uncovered", {}).get("uncovered") == ["REQ-2"] and d.get("red", {}).get("gate") == "red" and d.get("anyway", {}).get("status") == "closed", f"owner asked: clear {d.get('clear', {}).get('asked')}, open {d.get('open', {}).get('asked')}, uncovered {d.get('uncovered', {}).get('uncovered')}, red gate {d.get('red', {}).get('gate')}")
    d = seen("k_c_msgaps")
    proofs.prove("n1333", d.get("path") == ["archive", "frame", "done"] and d.get("out") == {"status": "done", "phases": PHASES} and "phases in order (lane-plan phase add <name> --goal …)" in d.get("framePrompt", ""), f"gap milestone: path {d.get('path')}, phases {d.get('out', {}).get('phases')}")
    d = seen("k_c_cleanup")
    proofs.prove("n1334", d.get("dryRun") is True and d.get("dry") == {"path": ["plan", "planned"], "out": {"status": "planned", "moved": ["phases/ph_old"]}} and d.get("applied", {}).get("path") == ["plan", "goal_check", "done"] and d.get("applied", {}).get("out", {}).get("status") == "done" and d.get("failed", {}).get("out") == {"status": "blocked"}, f"cleanup: dry {d.get('dry', {}).get('out')}, applied {d.get('applied', {}).get('out')}, failed check {d.get('failed', {}).get('out')}")
    # ---- ship
    d = seen("k_ws_preflight")
    proofs.prove("n1335", d.get("ready", {}).get("path") == SHIPPED and d.get("held", {}).get("path") == ["gate", "preflight", "held"] and d.get("held", {}).get("out", {}).get("status") == "held" and d.get("held", {}).get("prCalls") == 0, f"not ready: {d.get('held', {}).get('path')} {d.get('held', {}).get('out')}; ready: {d.get('ready', {}).get('out', {}).get('status')}")
    d = seen("k_ws_fullgate")
    proofs.prove("n1336", d.get("windowHours") == 6 and d.get("none", {}).get("ok") is False and d.get("fresh", {}).get("ok") is True and d.get("stale", {}).get("ok") is False and d.get("wrongHead", {}).get("ok") is False and d.get("red", {}).get("ok") is False and d.get("blocked", {}).get("path") == ["gate", "held_gate"], f"full-gate verdict: none {d.get('none', {}).get('ok')}, fresh {d.get('fresh', {}).get('ok')}, 7h old {d.get('stale', {}).get('ok')}, wrong head {d.get('wrongHead', {}).get('ok')}, held ship {d.get('blocked', {}).get('path')}")
    d = seen("k_ws_vendor")
    proofs.prove("n1337", d.get("status") == "held" and d.get("heldBy") == ["verification is not passed", "untriaged vendor update: lodash 4.17.21 → 5.0.0 has no note"] and d.get("prCalls") == 0 and d.get("cleanHeldBy") == [], f"untriaged update: {d.get('status')}, held_by {d.get('heldBy')}, PRs opened {d.get('prCalls')}")
    d = seen("k_ws_infra")
    proofs.prove("n1338", d.get("other", {}).get("path") == ["preflight", "tests", "run_deploy", "post_check", "record", "deployed_other"] and d.get("other", {}).get("plugin") == 0 and d.get("plugin", {}).get("path") == ["preflight", "push_plugin", "post_check", "record", "deployed"] and d.get("plugin", {}).get("errand") == 0 and d.get("refused", {}).get("deploys") == 0 and d.get("readsSteps") is True, f"ritual by target: ssh {d.get('other', {}).get('path')}, plugin {d.get('plugin', {}).get('path')}, refused deploys {d.get('refused', {}).get('deploys')}")
    d = seen("k_ws_push")
    proofs.prove("n1339", d.get("shippedPr") == 1 and d.get("holds") == [{"pr": 0, "status": "held"}] * 3 and d.get("prompt", "").startswith("Push the phase branch (git push -u origin HEAD), ") and "--force" not in d.get("prompt", "") and d.get("pushBeforePr") is True, f"push: errand runs {d.get('shippedPr')}x when shipped, held ships {d.get('holds')}")
    d = seen("k_ws_pr")
    proofs.prove("n1340", d.get("status") == "shipped" and d.get("prUrl") == "https://git.example/pr/7" and "into a temp file made with mktemp outside every repository" in d.get("prompt", "") and "open it with gh pr create --body-file <that file> and delete the file" in d.get("prompt", ""), f"PR emitted {d.get('prUrl')}; body {d.get('prompt', '')[60:230]}")
    d = seen("k_ws_review")
    proofs.prove("n1341", d.get("off", {}).get("skipped") == ["review", "post_ship"] and d.get("pass", {}).get("reviewCalls") == 1 and d.get("rework", {}).get("path") == ["gate", "preflight", "review", "held_review"] and d.get("block", {}).get("path") == ["gate", "preflight", "review", "held_review"] and d.get("rework", {}).get("prCalls") == 0 and d.get("range") == {"range": "main..HEAD"}, f"review: off {d.get('off', {}).get('skipped')}, rework {d.get('rework', {}).get('path')}, range {d.get('range')}")
    d = seen("k_ws_track")
    proofs.prove("n1342", d.get("path") == SHIPPED and "record the shipment in .agents/deploys.log and set the phase's status and last activity in .agents/planning/STATE.md." in d.get("prompt", ""), f"shipment record: {d.get('prompt', '')[-170:]}")
    d = seen("k_ws_post")
    proofs.prove("n1343", d.get("none", {}).get("calls") == 0 and d.get("some", {}).get("calls") == 1 and d.get("some", {}).get("failed") == ["h2"] and d.get("some", {}).get("status") == "shipped" and d.get("none", {}).get("path") == SHIPPED, f"post-ship hooks: none {d.get('none', {}).get('calls')} runs, two files {d.get('some', {}).get('calls')} run, failed {d.get('some', {}).get('failed')}")
    # ---- project start, new project, new milestone, code analysis
    d = seen("k_c_start")
    proofs.prove("n1344", d.get("first") == ["tree", "probe", "value_map", "preview", "profile_write", "ask", "research", "requirements", "recap", "done"] and d.get("valueMapBeforeAsk") is True and d.get("resumed", {}).get("path") == ["tree", "probe", "resumed"] and "value_map" in d.get("profileOnly", []), f"first run {d.get('first')}; started project {d.get('resumed', {}).get('path')}")
    d = seen("k_c_newproject")
    proofs.prove("n1345", d.get("requirementsCalls") == [1, 0, 0] and d.get("researchCalls") == [1, 0, 0] and d.get("quickSkipped") == ["research", "requirements"] and d.get("recapOut") == ["a", "b", "c"], f"requirements runs {d.get('requirementsCalls')} (full, quick, research off), quick skips {d.get('quickSkipped')}")
    d = seen("k_c_newmilestone")
    proofs.prove("n1346", d.get("path") == ["archive", "frame", "done"] and d.get("archiveFirst") is True and d.get("out") == {"status": "done", "phases": PHASES} and "3–7 requirements with ids into REQUIREMENTS.md" in d.get("framePrompt", ""), f"new milestone: {d.get('path')} -> {d.get('out')}")
    d = seen("k_c_mapcode")
    proofs.prove("n1347", d.get("full", {}).get("path") == ["analyze", "report", "done"] and d.get("full", {}).get("analyze", {}).get("depth") == "deep" and d.get("std", {}).get("analyze", {}).get("depth") == "standard" and d.get("full", {}).get("out", {}).get("report_path") == "reports/analysis-run.md" and d.get("reportPath") == "reports/analysis-{{run_id}}.md", f"analysis: full depth {d.get('full', {}).get('analyze', {}).get('depth')}, report {d.get('full', {}).get('out', {}).get('report_path')}")
    d = seen("k_c_scan")
    proofs.prove("n1348", d.get("quick", {}).get("analyze") == {"goal": "how the merge queue works", "scope": "src/rooms/phase", "depth": "quick"} and d.get("std", {}).get("analyze", {}).get("depth") == "standard" and d.get("quick", {}).get("path") == ["analyze", "report", "done"], f"scan: quick {d.get('quick', {}).get('analyze')}, standard depth {d.get('std', {}).get('analyze', {}).get('depth')}")
