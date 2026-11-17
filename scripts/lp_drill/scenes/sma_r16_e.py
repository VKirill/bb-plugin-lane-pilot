"""Region 16 · Slash commands and workflows, batch e — the plan check and admission, the review / audit / QA workflows and the live check (n1268 … n1297).

Called from the region scene sma_r16.py (`prove_e(proofs, tmp)`); the receipt of that scene lists these nodes next to the other batches'. The probe sma_r16_e_probe.ts runs the REAL
code of the commit under drill — the plan gate and the auto stage, the phase driver on a scratch database and a fake host, the real workflow engine with fake executors on the real graph
files (code-review, review-fix, secure-phase, validate-phase, ui-audit, eval-review, audit-uat, test-gen, lp.review, lp.browser-qa), the host handlers of the live check against a local
server and a stand-in runner, the checkout step git.diff_files on a scratch git repository — with no model, no hub write and nothing outside the machine, and prints what it returned.
Each prove() below compares one value with the result the node's card expects. The same observations are asserted by tests/sma/four-proofs-r16-e.test.ts and four-proofs-r16-e2.test.ts.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_E = [
    "n1268", "n1269", "n1270", "n1271", "n1272", "n1273", "n1274", "n1275", "n1276", "n1277", "n1278", "n1279", "n1280", "n1281", "n1282",
    "n1283", "n1284", "n1285", "n1286", "n1287", "n1288", "n1289", "n1290", "n1291", "n1292", "n1293", "n1294", "n1295", "n1296", "n1297",
]
PROBE_E = ROOT / "scripts/lp_drill/scenes/sma_r16_e_probe.ts"
NO_RUN = "the plan check is not proven independent: it names no workflow run: report the wfRunId of the lp.plan run whose plan critic approved"


def prove_e(proofs, tmp) -> None:
    """Run the probe and prove batch e's nodes; when the probe printed nothing every node is recorded as not proved, with the reason."""
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_E)], cwd=ROOT, capture_output=True, text=True, timeout=1500)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_E:
            proofs.prove(node, False, f"the batch e probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    # ---- phase planning
    d = seen("k_wp_checker")
    proofs.prove("n1268", d.get("approved") == [] and d.get("noCheck") == ["no independent plan check: run the plan critic (workflow lp.plan) and report its decision with the run's wfRunId"] and d.get("changes") == ["the plan checker asked for changes: split p1"] and d.get("notIndependent") == ["the plan check is not proven independent: same thread"] and d.get("noRun") == [NO_RUN], f"plan gate: no check {d.get('noCheck')}, changes {d.get('changes')}, not independent {d.get('notIndependent')}")
    d = seen("k_wp_revision")
    proofs.prove("n1269", d.get("max") == 3 and d.get("due") == ["plan", "plan", "plan", None] and d.get("gate2") == ["the plan checker asked for changes"] and str((d.get("gate3") or [""])[0]).startswith("3 rounds of the plan check asked for changes: stop revising") and d.get("gate3approved") == [], f"revision rounds: max {d.get('max')}, machine plans again after rounds {d.get('due')}, gate at round three {str((d.get('gate3') or [''])[0])[:50]}")
    d = seen("k_wp_bounce")
    proofs.prove("n1270", d.get("due") == "bounce" and d.get("off") is None and d.get("done") is None and d.get("otherSha") == "bounce" and d.get("unchecked") == "check" and d.get("changes", {}).get("bounce", {}).get("decision") == "changes_requested" and str(d.get("changes", {}).get("gaps", "")).startswith("the external plan bounce asked for changes") and d.get("approve") == {"decision": "approve", "replan": None} and d.get("again") == 0, f"bounce: due {d.get('due')}, once per sha {d.get('done')}, off {d.get('off')}, changes {d.get('changes', {}).get('gaps')}")
    d = seen("k_wp_reqgate")
    gap = "requirements no piece covers: R2 (name them in a piece's covers, or defer them in CONTEXT.md and sign again)"
    proofs.prove("n1271", d.get("open") == [gap] and d.get("all") == [] and d.get("none") == [gap.replace("R2", "R1, R2")] and d.get("gate") == [gap] and d.get("gateAll") == [] and d.get("alreadyMet") == [], f"requirements gate: {d.get('open')}")
    d = seen("k_wp_decgate")
    proofs.prove("n1272", d.get("open") == ["locked decisions no piece carries out: D1"] and d.get("all") == [] and d.get("none") == ["locked decisions no piece carries out: D1, D2"] and d.get("gate") == ["locked decisions no piece carries out: D2"] and d.get("gateAll") == [], f"decision gate: {d.get('open')}, all {d.get('all')}")
    d = seen("k_wp_state")
    proofs.prove("n1273", d.get("stateHas") == [True, True, True, True] and d.get("rows") == ["- [x] 1.1 Hud — build it", "- [ ] 1.2 Menu — the menu", "- [ ] 999.1 Later — parked"] and d.get("closed") is True, f"closed phase marks: STATE {d.get('stateHas')}, roadmap {d.get('rows')}")
    d = seen("k_wp_commit")
    proofs.prove("n1274", d.get("on", {}).get("commits") == [[".agents/phases/<id>/PLAN.md"]] and "### Wave 2" in (d.get("on", {}).get("plan") or []) and "- p2: given g; when w; then then-p2" in (d.get("on", {}).get("plan") or []) and d.get("off", {}).get("plan") is None and d.get("off", {}).get("commits") == [] and d.get("noCommit", {}).get("commits") == [] and d.get("noCommit", {}).get("plan") == d.get("on", {}).get("plan"), f"PLAN.md: on {d.get('on', {}).get('commits')}, off {d.get('off', {}).get('plan')}, commit switch off {d.get('noCommit', {}).get('commits')}")
    d = seen("k_wp_advance")
    proofs.prove("n1275", d.get("plain") == {"stage": "execution", "admitted": True, "design": "not_needed", "booked": ["admitted"]} and d.get("screens") == {"stage": "design", "admitted": True, "design": "needed", "booked": ["admitted"]} and d.get("refused", {}).get("stage") == "planning" and d.get("refused", {}).get("admitted") is False and d.get("unsigned", {}).get("stage") == "planning", f"admission moves on: plain {d.get('plain', {}).get('stage')}, screens {d.get('screens', {}).get('stage')}, refused {d.get('refused', {}).get('stage')}")
    # ---- review, security, audit
    d = seen("k_c_codereview")
    proofs.prove("n1276", d.get("rework", {}).get("path") == "review report offer_fix done_offer" and d.get("rework", {}).get("out", {}).get("status") == "rework" and d.get("rework", {}).get("out", {}).get("proposed") == "review-fix" and d.get("pass", {}).get("path") == "review report done" and d.get("pass", {}).get("out", {}).get("proposed") is None, f"code review: rework {d.get('rework', {}).get('path')}, pass {d.get('pass', {}).get('path')}")
    d = seen("k_c_crfix")
    proofs.prove("n1277", d.get("one", {}).get("path") == "plan_fix build_fix re_review done" and d.get("two", {}).get("path") == "plan_fix build_fix re_review plan_fix2 build_fix2 re_review done" and d.get("spent", {}).get("path") == "plan_fix build_fix re_review plan_fix2 build_fix2 re_review classify ask partial" and d.get("spent", {}).get("plans") == 2 and d.get("noBuild", {}).get("path") == "plan_fix", f"fix rounds: one {d.get('one', {}).get('path')}, spent {d.get('spent', {}).get('status')}")
    d = seen("k_c_secure")
    proofs.prove("n1278", d.get("open", [None, {}])[0] == "audit doc_path write_security gaps" and d.get("open", [None, {}])[1].get("open") == ["T1", "T2"] and d.get("clean", [None, {}])[0] == "audit doc_path write_security goal_check done" and d.get("clean", [None, {}])[1].get("status") == "done" and d.get("unmet", [None, None])[1] == "gaps", f"secure-phase: open {d.get('open')}, clean {d.get('clean', [None])[0]}")
    d = seen("k_c_validate")
    proofs.prove("n1279", d.get("gaps", [None, {}])[0] == "audit doc_path write_validation gaps" and d.get("gaps", [None, {}])[1].get("gaps") == ["p2: existence-only check"] and d.get("clean", [None, {}])[0] == "audit doc_path write_validation goal_check done" and d.get("clean", [None, {}])[1].get("status") == "done" and d.get("unmet", [None, None])[1] == "gaps", f"validate-phase: gaps {d.get('gaps')}, clean {d.get('clean', [None])[0]}")
    d = seen("k_c_uireview")
    proofs.prove("n1280", d.get("ok") == ["capture audit review_doc goal_check done", "done", 30, ["s375.png", "s1280.png"]] and d.get("noFile") == "capture audit done" and d.get("low") == ["capture audit review_doc goal_check offer done_offer", "review-fix"] and d.get("zero") == "capture audit review_doc goal_check done" and d.get("blocked") == ["capture blocked", "blocked"], f"ui-review: ok {d.get('ok', [''])[0]}, low score {d.get('low')}, blocked {d.get('blocked')}")
    d = seen("k_c_evalreview")
    proofs.prove("n1281", d.get("sound") == ["review doc_path write_review goal_check sound", "sound", None] and d.get("flawed") == ["review doc_path write_review offer flawed", "flawed", "todo-add", 1] and d.get("unmet") == ["review doc_path write_review goal_check flawed", "flawed"], f"eval-review: sound {d.get('sound')}, flawed {d.get('flawed')}")
    d = seen("k_c_audituat")
    proofs.prove("n1282", d.get("rows") == ["a:open", "a:failed"] and d.get("asked") == ["audit write goal_check offer done_offer", 2] and d.get("nothing") == "audit write goal_check done" and d.get("plain") == "audit write goal_check done", f"audit-uat: lines {d.get('rows')}, asked {d.get('asked')}, nothing open {d.get('nothing')}")
    # ---- audit-fix, add-tests and the live check
    rounds = "first_review plan_fix build_fix re_review plan_fix2 build_fix2 re_review"
    d = seen("k_c_auditfix")
    proofs.prove("n1283", d.get("audited", [None, None, None])[0] == rounds + " done" and d.get("audited", [None, None])[1] == [{"severity": "high", "file": "src/a.ts", "line": 12, "evidence": "return value of save() ignored"}] and d.get("clean") == ["first_review done_first", "done"] and d.get("stuck", [None, None])[0] == rounds + " classify ask partial" and d.get("stuck", [None, None, None])[1] == "partial", f"audit-fix: audited {d.get('audited', [''])[0]}, clean {d.get('clean')}, stuck {d.get('stuck', ['', ''])[1]}")
    d = seen("k_c_addtests")
    proofs.prove("n1284", d.get("given") == ["baseline write_tests run inventory done", "done", 5] and d.get("derived") == ["derive confirm baseline write_tests run inventory done", "done"] and d.get("timeout") == ["derive confirm blocked", "blocked"] and d.get("fixing") == ["baseline write_tests run inventory classify fix_tests run inventory classify done", "done"] and d.get("noWrite") == ["baseline write_tests blocked", "blocked"], f"add-tests: given {d.get('given')}, derived {d.get('derived')}, timeout {d.get('timeout')}")
    d = seen("k_c_qa")
    proofs.prove("n1285", d.get("ok", {}).get("answered", {}).get("state") == "passed" and d.get("ok", {}).get("run") == [{"workflow_id": "lp.browser-qa", "status": "succeeded", "reason": None}] and d.get("ok", {}).get("args", {}).get("viewports") == "375,768,1280" and d.get("red", {}).get("answered", {}).get("reason") == "case 1 failed" and d.get("red", {}).get("run") == [{"workflow_id": "lp.browser-qa", "status": "failed", "reason": "step_failed:verdict"}], f"sma-qa: ok {d.get('ok', {}).get('run')}, red {d.get('red', {}).get('run')}")
    d = seen("k_wqa_find")
    proofs.prove("n1286", d.get("defaults") == [3000, 5173, 8080, 4200, 8000] and d.get("hostId") is True and d.get("listed") is True and d.get("boundSome") is True and d.get("mineFound") is True and len(d.get("scan", [])) == 2 and d.get("scanFirst") is True, f"find the app: default ports {d.get('defaults')}, my servers found {d.get('mineFound')}, scan {d.get('scan')}")
    d = seen("k_wqa_notrun")
    proofs.prove("n1287", d.get("reachable", {}).get("ok") is True and str(d.get("unreachable", {}).get("error", "")).startswith("browser_qa_url_unreachable:") and d.get("userinfo", {}).get("error") == "browser_qa_url_must_be_http_without_userinfo" and d.get("scheme", {}).get("error") == "browser_qa_url_must_be_http_without_userinfo" and d.get("workspace", {}).get("error") == "browser_qa_workspace_unreachable", f"probe: reachable {d.get('reachable', {}).get('ok')}, nothing answers -> {d.get('unreachable', {}).get('error')}")
    d = seen("k_wqa_spawn")
    argv = d.get("passed", {}).get("argv", [])
    proofs.prove("n1288", d.get("passed", {}).get("runner") == "browser-qa-codex" and d.get("passed", {}).get("verdict") == "passed" and "--viewports" in argv and argv[argv.index("--viewports") + 1] == "375,768,1280" and argv.count("--case") == 2 and "--authorized" in d.get("authorized", []) and d.get("none", {}).get("reason") == "browser_qa_report_missing" and str(d.get("production", "")).startswith("browser_qa_requires_explicit_authorization"), f"spawn: runner argv {argv}, authorized {'--authorized' in d.get('authorized', [])}, production {d.get('production')}")
    d = seen("k_wqa_result")
    proofs.prove("n1289", d.get("verdicts") == {"all": "passed", "failed": "failed", "blocked": "blocked", "pending": "blocked", "sum": "blocked", "zero": "blocked", "exit": "failed"} and d.get("noPlaque") == "blocked" and d.get("failedRun", {}).get("verdict") == "failed" and d.get("failedRun", {}).get("text") == "Total / Passed / Failed / Blocked: 3 / 2 / 1 / 0" and d.get("missing", {}).get("verdict") == "blocked", f"plaque verdicts {d.get('verdicts')}")
    d = seen("k_wqa_route")
    proofs.prove("n1290", [d.get(k) for k in ("one", "blocked", "laterFailed", "laterBlocked", "byTime")] == ["returnable", "not_returnable", "returnable", "not_returnable", "returnable"] and [d.get(k) for k in ("stopTwo", "oneOfTwo", "stopThree", "never")] == ["stop", "returnable", "returnable", "returnable"] and d.get("defaults") == [2, None, None, 4, 2], f"route: blocked {d.get('blocked')}, two failures {d.get('stopTwo')}, defaults {d.get('defaults')}")
    # ---- the review pipeline
    d = seen("k_wr_gate")
    proofs.prove("n1291", d.get("off") == {"allowed": True, "review": "not_required", "state": "skipped", "reason": "disabled_by_project_setting"} and d.get("quick") == {"allowed": True, "review": "not_required", "state": "skipped", "reason": "quality_mode_quick"}, f"review gate: config off {d.get('off', {}).get('reason')}, quick {d.get('quick', {}).get('reason')}")
    d = seen("k_wr_scope")
    proofs.prove("n1292", d.get("given") == {"files": ["src/x.ts", "src/y.ts"], "count": 2, "level": "quick"} and d.get("ranged") == {"files": ["src/a.ts", "src/b.ts"], "count": 2, "level": "quick"} and d.get("commits", {}).get("files") == ["src/c.ts"] and d.get("nothing", {}).get("count") == 0 and d.get("many") == [25, "deep"] and d.get("some") == [4, "standard"], f"scope: given {d.get('given', {}).get('files')}, range {d.get('ranged', {}).get('files')}, 25 files -> {d.get('many')}")
    d = seen("k_wr_empty")
    proofs.prove("n1293", d.get("empty") == ["scope nothing", "pass", [], 0, 0] and d.get("some") == "scope prepass spec_check dims", f"empty scope: {d.get('empty')}")
    d = seen("k_wr_prepass")
    proofs.prove("n1294", d.get("rework") == ["scope prepass aggregate result", "rework", 0, 0] and d.get("clean") == ["scope prepass spec_check dims", 1, 1], f"pre-pass: rework {d.get('rework')}, clean {d.get('clean')}")
    d = seen("k_wr_spawn")
    proofs.prove("n1295", d.get("quick") == ["correctness", "security"] and d.get("standard") == ["correctness", "security", "maintainability", "performance"] and d.get("full") == ["correctness", "security", "performance", "architecture", "maintainability", "best_practices", "silent_failures"], f"reviewer depth: quick {d.get('quick')}, standard {len(d.get('standard', []))}, full {len(d.get('full', []))}")
    d = seen("k_wr_commit")
    proofs.prove("n1296", (d.get("first") or [""])[1:2] == ["## Wave 1 — passed"] and "## Wave 2 — failed" in (d.get("second") or []) and "## Wave 1 — passed" in (d.get("second") or []) and (d.get("replaced") or []).count("## Wave 1 — failed") == 1 and "## Wave 1 — passed" not in (d.get("replaced") or []) and "## Wave 2 — failed" in (d.get("replaced") or []) and [w["path"] for w in d.get("written", [])] == [".agents/phases/ph_sma/REVIEW.md"] * 3, f"REVIEW.md after wave 1, 2 and a redo of 1: {d.get('replaced')}")
    d = seen("k_wr_fix")
    proofs.prove("n1297", d.get("offered") == ["rework", "review-fix"] and d.get("fix", {}).get("path") == "plan_fix build_fix re_review done" and d.get("fix", {}).get("skipped") == ["first_review"] and d.get("fix", {}).get("mode") == "gaps" and d.get("audit", {}).get("reviewed") == 1, f"--fix: offered {d.get('offered')}, fix path {d.get('fix', {}).get('path')}, skipped {d.get('fix', {}).get('skipped')}")
