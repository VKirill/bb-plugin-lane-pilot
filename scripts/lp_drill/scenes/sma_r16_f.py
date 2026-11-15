"""Region 16 · Slash commands and workflows, batch f — the phase list commands, settings, the discussion command and its stage, ship and the clean PR branch (n1298 … n1329).

Called from the region scene sma_r16.py (`prove_f(proofs, tmp)`); the receipt of that scene lists these nodes next to the other batches'. The probe sma_r16_f_probe.ts runs the REAL
code of the commit under drill — the phase driver on a scratch database and a fake host whose files are a map, the real workflow engine with fake executors on the real graph files
(profile-user, grill-plan, phase-assumptions, spec-phase, lp.draw, ai-integration-phase, mvp-phase, lp.analyze, ship, pr-branch), the settings store, the phase gates and the stage
rubrics — with no model, no hub write and nothing outside the machine, and prints what it returned. Each prove() below compares one value with the result the node's card expects.
The same observations are asserted by tests/sma/four-proofs-r16-f.test.ts and four-proofs-r16-f2.test.ts.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_F = [
    "n1298", "n1299", "n1300", "n1301", "n1302", "n1303", "n1304", "n1306", "n1307", "n1308", "n1309", "n1310", "n1311", "n1312", "n1313", "n1314",
    "n1315", "n1316", "n1317", "n1318", "n1319", "n1320", "n1322", "n1323", "n1324", "n1325", "n1326", "n1327", "n1328", "n1329",
]
PROBE_F = ROOT / "scripts/lp_drill/scenes/sma_r16_f_probe.ts"
ORDER = ["read the goal and the roadmap row", "scout the code the goal touches", "list the gray areas and pick the ones to settle", "deep-dive each chosen area (one advisor per area)", "write CONTEXT.md: locked / free / deferred, FAQ, ADR", "name the four risks", "sign the context"]
ANTI = ["deciding for the owner what only he knows", "a decision without its reason", "a free area written as locked", "risks left unnamed"]
CARD = "Kirill: a marketer who writes code"
REFUSAL_WORDS = "closing in words carries the words: why the phase ends here"
REVISE_REFUSAL = "the goal is revised in discussion or planning: return the phase there first"
SIGNED = "signed: context signed <sha>: .agents/phases/<id>/CONTEXT.md (46 B); appetite — one wave; no-gos — none; risks — value: v; usability: u; feasibility: f; viability: b"


def prove_f(proofs, tmp) -> None:
    """Run the probe and prove batch f's nodes; when the probe printed nothing every node is recorded as not proved, with the reason."""
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_F)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_F:
            proofs.prove(node, False, f"the batch f probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    # ---- the phase list
    d = seen("k_c_addphase")
    row = d.get("row", {})
    proofs.prove("n1298", d.get("ids") == [True, True, True] and row.get("stage") == "discussion" and row.get("state") == "active" and row.get("title") == "Export" and row.get("roadmapRow") == "2" and d.get("folder") == ".agents/phases/<id>" and d.get("byRow") is True and d.get("live") == ["Export", "Hud"], f"new phase {row}, folder {d.get('folder')}, live {d.get('live')}")
    d = seen("k_c_insertphase")
    proofs.prove("n1299", d.get("unchanged") is True and d.get("urgent", {}).get("row") == "1.1" and d["urgent"].get("title") == "Hotfix" and d["urgent"].get("goal") == "stop the double charge" and d.get("distinct") == 3 and d.get("resolved") == ["Login", "Hotfix", "Billing"], f"urgent phase {d.get('urgent')}, neighbours unchanged {d.get('unchanged')}, rows 1/1.1/2 name {d.get('resolved')}")
    d = seen("k_c_removephase")
    proofs.prove("n1300", d.get("noWords") == REFUSAL_WORDS and d.get("kept") == ["discussion", "active"] and d.get("closed", {}).get("stage") == "closed" and d["closed"].get("closing", {}).get("words") == "dropped: the owner moved the hud to next quarter" and d.get("live") == ["Stats"] and d.get("other", {}).get("state") == "active", f"close without words «{d.get('noWords')}», with words {d.get('closed')}, live {d.get('live')}")
    d = seen("k_c_editphase")
    proofs.prove("n1301", d.get("same") is True and d.get("first", {}).get("goal") == "a hud with a CSV export" and d["first"].get("revisions") == 1 and d.get("second", {}).get("revisions") == 2 and d.get("roadmapRow") == "5" and d.get("running") == REVISE_REFUSAL and d.get("goalAfterRefusal") == "a hud with a PDF export" and d.get("closed") == REVISE_REFUSAL, f"edit in place {d.get('first')}, then {d.get('second')}; at execution «{d.get('running')}»")
    # ---- settings
    d = seen("k_c_settings")
    proofs.prove("n1302", d.get("project", {}).get("quality_mode") == "full" and d.get("section", {}).get("quality_mode") == "standard" and d["section"].get("plan_critique.enabled") is True and d.get("other", {}).get("quality_mode") == "quick" and d["other"].get("specialist.enabled") is True and d.get("project", {}).get("note") == "plain words", f"project {d.get('project')}, section {d.get('section')}, other project {d.get('other')}")
    d = seen("k_c_settingsadv")
    proofs.prove("n1303", d.get("shown", {}).get("hidden") is False and d.get("hidden", {}).get("hidden") is True and d["hidden"].get("keepsRow") is True and d.get("planBounce") == ["project", "on|off"], f"advanced rows shown {d.get('shown')}, hidden {d.get('hidden')}, plan bounce {d.get('planBounce')}")
    d = seen("k_c_settingsint")
    proofs.prove("n1304", d.get("tavily") == {"bbPlugins": ["env-catalog"], "skills": ["env-catalog", "tavily"], "mcpServers": []} and d.get("reviewer") == {"before": False, "granted": True, "source": "owner"}, f"search specialist {d.get('tavily')}, reviewer {d.get('reviewer')}")
    # ---- the profile, discussion and spec commands
    d = seen("k_c_profileuser")
    proofs.prove("n1306", d.get("sessions", [""])[0] == "consent sessions card done" and d["sessions"][1] == {"status": "done", "card": CARD} and d.get("form", [""])[0] == "consent interview record card done" and d.get("silent", [""])[0] == "consent interview cancelled" and d.get("cancel") == ["consent cancelled", {"status": "cancelled", "card": ""}, 0], f"consent paths: sessions {d.get('sessions', [''])[0]}, questionnaire {d.get('form', [''])[0]}, refusal {d.get('cancel')}")
    d = seen("k_c_discuss")
    proofs.prove("n1307", len(d.get("none", [])) == 4 and d.get("empty") == ["e.md is empty"] and d.get("changed") == ["the context signature does not match its documents"] and d.get("risks", [""])[0].startswith("risks not named: usability, feasibility, viability") and d.get("complete") == [] and d.get("ok") is True, f"gate: nothing {len(d.get('none', []))} reasons, empty file {d.get('empty')}, complete {d.get('ok')}")
    d = seen("k_c_discuss_assume")
    proofs.prove("n1308", d.get("anchored", [""])[0] == "walk synth open" and d["anchored"][1].get("status") == "open" and d["anchored"][1].get("open") == ["invalidation on write"] and d.get("unanchored") == ["walk walk synth open", 2, 6] and d.get("clear", [""])[0] == "walk synth done" and d.get("prompt") is True, f"walk without anchors {d.get('unanchored')}, answered {d.get('anchored', [''])[0]}")
    d = seen("k_c_discuss_power")
    proofs.prove("n1309", len(d.get("listed", [])) == 7 and d["listed"][6].endswith("— deferred by the owner") and d.get("inFile") == 7 and d.get("askedInChat") == 5, f"questions in the file {len(d.get('listed', []))}, asked in chat {d.get('askedInChat')}")
    d = seen("k_c_listassume")
    proofs.prove("n1310", d.get("path") == "assumptions done" and d.get("out", {}).get("status") == "done" and len(d["out"].get("assumptions", [])) == 2 and d["out"]["assumptions"][0].get("evidence") == "db.ts:4" and d.get("writes") == 0, f"assumptions listed {len(d.get('out', {}).get('assumptions', []))}, writes {d.get('writes')}")
    d = seen("k_c_spec")
    proofs.prove("n1311", d.get("asked", [""])[0] == "score ask score spec done" and d["asked"][1].get("ambiguity") == 0.15 and d.get("clear") == "score spec done" and d.get("doubt", [""])[0] == "score ask score ask score spec low_confidence" and d["doubt"][1].get("status") == "low_confidence", f"spec: {d.get('asked', [''])[0]}; under doubt {d.get('doubt', [''])[0]}")
    d = seen("k_c_uiphase")
    proofs.prove("n1312", d.get("loop", [""])[0] == "draw check draw check done" and d["loop"][1].get("verdict") == "pass" and d["loop"][1].get("contradiction") == "" and d["loop"][1].get("feasible") is True and len(d["loop"][1].get("paths", [])) == 2 and d.get("draws") == 2, f"revision loop {d.get('loop', [''])[0]}, result verdict {d.get('loop', ['', {}])[1].get('verdict')}")
    d = seen("k_c_aiphase")
    proofs.prove("n1313", d.get("clean", [""])[0] == "select research eval_plan spec check done" and d.get("rework", [""])[0] == "select research eval_plan spec check spec check done" and d.get("blocked", ["", {}])[1].get("status") == "blocked" and d.get("clean", ["", {}])[1].get("framework") == "langchain", f"AI-SPEC: clean {d.get('clean', [''])[0]}; short spec {d.get('blocked', ['', {}])[1].get('status')}")
    d = seen("k_c_mvp")
    proofs.prove("n1314", d.get("once", [""])[0] == "story split_check story split_check done" and d["once"][1].get("who") == "the owner" and d["once"][1].get("why") == "to decide" and d.get("clean") == "story split_check done" and d.get("stuck", [""])[0] == "story split_check story split_check blocked", f"story path {d.get('once', [''])[0]}, who/what/why {[d.get('once', ['', {}])[1].get(k) for k in ('who', 'what', 'why')]}")
    # ---- the discussion stage
    d = seen("k_wdi_rubric")
    proofs.prove("n1315", d.get("order") == ORDER and d.get("same") is True and d.get("stages") == d.get("phaseStages") and len(d.get("stages", [])) == 7, f"discussion order {d.get('order')}")
    d = seen("k_wdi_init")
    proofs.prove("n1316", d.get("discussion") == [".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md", ".agents/phases/ph_sma/DISCUSSION.md"] and d.get("closed") == [".agents/phases/ph_sma/BOOK.md"], f"discussion reads {d.get('discussion')}")
    d = seen("k_wdi_anti")
    proofs.prove("n1317", d.get("antipatterns") == ANTI and d.get("line") == "; ".join(ANTI) + ".", f"blocking antipatterns {d.get('antipatterns')}")
    d = seen("k_wdi_spec")
    proofs.prove("n1318", d.get("written", [])[1:4] == ["# Spec — phase <id>: Hud", "", "Goal: a hud for the stats page"] and d.get("planning", [])[1] == ".agents/phases/ph_sma/SPEC.md" and "- R1" in d.get("written", []) and "- D1" in d.get("written", []), f"SPEC.md written {d.get('written', [])[:5]}, planning reads {d.get('planning')}")
    d = seen("k_wdi_existing")
    proofs.prove("n1319", d.get("kept", {}).get("tail") == ["## Earlier decisions (kept)", "", "D1: keep this decision always", ""] and len(d["kept"].get("booked", [])) == 1 and d.get("fresh") == {"has": False, "booked": []}, f"existing CONTEXT.md kept: {d.get('kept', {}).get('tail')}")
    d = seen("k_wdi_scout")
    proofs.prove("n1320", d.get("path") == "gather assess done" and d.get("anchors") == [{"file": "src/stats.ts", "line": 12, "note": "the table"}] and d.get("again") == ["gather assess gather assess done", 2] and d.get("readOnly") is True, f"scout path {d.get('path')}, anchors {d.get('anchors')}, thin scout {d.get('again')}")
    d = seen("k_wdi_gray")
    proofs.prove("n1322", d.get("asked") == ["gather assess choose advise done", ["cache?"]] and d.get("plain") == ["gather assess done", 0] and d.get("marked") == ["- auth?", "- cache? — deferred by the owner"], f"owner picks: {d.get('asked')}, without ask_owner {d.get('plain')}, CONTEXT lines {d.get('marked')}")
    d = seen("k_wdi_deep")
    proofs.prove("n1323", d.get("step") == ORDER[3] and d.get("advisors") == 3 and d.get("loop") == ["gather assess gather assess gather assess done", 3], f"deep-dive step «{d.get('step')}», advisors for three areas {d.get('advisors')}, until clear {d.get('loop')}")
    d = seen("k_wdi_advisor")
    proofs.prove("n1324", d.get("profile") == ["gather assess choose advise done", 2, 2] and d.get("bare") == [0, []] and d.get("wide") == ["succeeded", 6] and d.get("fanOut") == 6, f"advisors: with profile {d.get('profile')}, without {d.get('bare')}, eight areas {d.get('wide')}")
    d = seen("k_wdi_write")
    proofs.prove("n1325", d.get("step") == ORDER[4] and d.get("decisions") == ["- **D1** (locked): reuse the table", "- **D2** (free): the chart library", "- **D3** (deferred): pdf export", "- **D4** (locked): no id and no status"] and d.get("sections") == ["## Appetite", "## Decisions", "## No-gos", "## Risks", "## Open questions"], f"CONTEXT.md decisions {d.get('decisions')}")
    d = seen("k_wdi_commit")
    proofs.prove("n1326", d.get("plain", {}).get("commits") == [{"files": ["CONTEXT.md"], "message": "phase <id>: CONTEXT.md from the analysis"}] and d.get("secure", {}).get("commits") == [{"files": ["CONTEXT.md", "SECURITY.md"], "message": "phase <id>: CONTEXT.md and SECURITY.md from the analysis"}] and d.get("quiet") == {"commits": [], "written": True} and d.get("signed", {}).get("commits", [{}, {}])[1] == {"files": ["STATE.md"], "message": "phase <id>: STATE.md at planning"}, f"commits: {d.get('plain', {}).get('commits')}; with a security risk {d.get('secure', {}).get('commits')}; no commit_docs {d.get('quiet')}")
    d = seen("k_wdi_advance")
    proofs.prove("n1327", d.get("auto") == ["planning", "planning", [SIGNED, "stage: discussion → planning: the context documents exist, none is empty, and they are signed"]] and d.get("asked", [""])[0] == "discussion" and d["asked"][1] == "discussion" and d["asked"][3][1].startswith("awaits_signature: the context is complete and awaits the owner's signature"), f"after the signature: auto {d.get('auto', ['', ''])[:2]}, owner's word asked {d.get('asked', ['', ''])[:2]}")
    # ---- ship and the clean PR branch
    d = seen("k_c_ship")
    proofs.prove("n1328", d.get("shipped", ["", {}])[1].get("status") == "shipped" and d["shipped"][1].get("pr_url") == "https://example/pr/7" and d["shipped"][1].get("hooks_failed") == ["tag"] and d.get("gate") == ["gate held_gate", {"status": "held", "pr_url": "", "held_by": ["npm test red on the head"], "hooks_failed": []}] and d.get("held", ["", {}])[1].get("held_by") == ["no full-gate marker", "untriaged vendor bump"] and d.get("reviewed") == ["gate preflight review held_review", "held", 0], f"ship: ready {d.get('shipped', [''])[0]}; red gate {d.get('gate', ['', {}])[1].get('held_by')}; held by {d.get('held', ['', {}])[1].get('held_by')}; review rework {d.get('reviewed')}")
    d = seen("k_c_prbranch")
    proofs.prove("n1329", d.get("clean") == ["split done", {"status": "done", "branch": "review/ph_a", "commits": 3}] and d.get("conflict") == ["split blocked", {"status": "blocked", "branch": "review/ph_a", "commits": 1}] and d.get("drops") is True and d.get("stops") is True, f"PR branch: clean {d.get('clean')}, conflict {d.get('conflict')}")
