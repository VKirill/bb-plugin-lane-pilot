"""Region 0 · Phase graph, batch a: the discussion and the plan admission, n0 … n29 (docs/sma-evidence.md, «Trace choice»).

The phase driver, its gates and the plan graph write no row a node of this batch can be told apart by, or write only the parts every phase writes, so the node-level trace
is this scene. The probe (sma_r00_a_probe.ts, run by vite-node) runs the REAL code of the commit under drill — the phase driver on a scratch database and a fake host whose
files are a map, the phase gates, the next-action text, the real workflow engine with fake executors on workflows/lp.plan.json and lp.analyze.json — with no model, no hub write and
nothing outside the machine; prove_a() compares each observation with the result the card expects. The observations live in tests/sma/r00-world-a.ts (`observe.<smaId>`).
The region scene sma_r00.py only imports the batch modules; run: scripts/lp-drill.sh --scenario sma_r00.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_A = [f"n{n}" for n in range(30)]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r00_a_probe.ts"
NO_APPETITE = "no appetite: say how much this phase may take before any solution (time or size)"
NO_GOS = "no-gos not named: what this phase will not do («none» is an answer)"
NOT_INDEPENDENT = "the plan check is not proven independent: "
SIGNED_CONTEXT = "the plan was not built on the signed context (contextSha differs): read the context documents and plan again"


def prove_a(proofs, tmp) -> None:
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_A:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    def prove(node: str, name: str, check, detail) -> None:
        d = seen(name)
        try:
            ok = bool(d) and bool(check(d))
        except (KeyError, IndexError, TypeError):
            ok = False
        proofs.prove(node, ok, detail(d) if d else f"observation {name} did not run: {s.get(name)}")

    prove("n0", "p1_start", lambda d: d["distinct"] and d["stage"] == "discussion" and d["goal"] == "skip blanks" and d["opened"] == ["phase opened: Sums"], lambda d: f"phase opened at {d.get('stage')}, book {d.get('opened')}, second open distinct {d.get('distinct')}")
    prove("n1", "p1_cmd", lambda d: d["key"] == "discussion:none" and d["tool"] and d["workflow"] and len(d["open"]) == 1 and d["open"][0].startswith("Open: no context documents") and d["doneOpen"] == [] and d["question"] == {"key": "discussion:questions:q1", "waitsForPm": True, "text": True}, lambda d: f"command key {d.get('key')}, open lines {len(d.get('open', []))}, question wait {d.get('question')}")
    prove("n2", "p1_card", lambda d: d["stage"] == "planning" and d["shaIsOfDocs"] and d["risks"] == ["value", "usability", "feasibility", "viability", "security"] and d["appetite"] == "one day" and d["noGos"] == ["no OAuth", "no sync"] and d["decisions"] == ["D1", "D2"] and d["requirements"] == ["R1"], lambda d: f"signed card: docs {len(d.get('docs', []))}, risks {d.get('risks')}, appetite {d.get('appetite')}, no-gos {d.get('noGos')}")
    prove("n3", "p1_appetite", lambda d: d["bare"] == [NO_APPETITE] and d["stage"] == "discussion" and d["heads"][:2] == ["## Appetite", "## Decisions"] and d["appetite"] == "two days", lambda d: f"no appetite refused {d.get('bare')}; CONTEXT.md headings {d.get('heads')}")
    prove("n4", "p1_risks", lambda d: d["kinds"] == ["value", "usability", "feasibility", "viability"] and d["missing"] == ["risks not named: usability, feasibility, viability (name each, «none» is an answer)"] and d["complete"] is True, lambda d: f"kinds {d.get('kinds')}, missing {d.get('missing')}")
    prove("n5", "p1_validate", lambda d: d["good"] and d["noDocs"] == 1 and d["oneRisk"] == ["risks not named: viability (name each, «none» is an answer)"] and d["noAppetite"] == [NO_APPETITE] and d["noGos"] == [NO_GOS] and d["swapped"] == ["the context signature does not match its documents"], lambda d: f"complete card passes {d.get('good')}; one risk missing {d.get('oneRisk')}; no-gos {d.get('noGos')}")
    prove("n6", "p1_pieces", lambda d: d["good"] == [] and d["noThen"] == ["a: the promise has no «then»"] and d["noOwns"] == ["a: no owns_paths — the piece cannot become a work"] and len(d["command"]) == 1 and d["commandOk"] == [] and d["link"] == ["a depends on gone, which is not in the plan"], lambda d: f"piece problems: no then {d.get('noThen')}, link {d.get('link')}")
    prove("n7", "p1_write", lambda d: d["stage"] == "planning" and d["files"] == ["CONTEXT.md"] and d["onDiskIsSigned"] and d["signedDocs"] == [f"{d['folder'][0]}/CONTEXT.md"] and d["text"].startswith("# Context — Sums\n\nGoal: skip blanks\n\n## Appetite\ntwo days\n") and d["questions"] == ["Which tag syntax?"], lambda d: f"analysis written to {d.get('folder')}/CONTEXT.md, signed {d.get('signedDocs')}, stage {d.get('stage')}")
    prove("n8", "p1_docs", lambda d: d["writes"] == [["CONTEXT.md", d["earlierSha"], "applied"], ["SECURITY.md", None, "applied"]] and d["commits"][0][0] == ["CONTEXT.md", "SECURITY.md"] and d["signedDocs"] == ["CONTEXT.md", "SECURITY.md"] and d["kept"] and d["onDiskIsSigned"], lambda d: f"host writes {d.get('writes')}, commit {d.get('commits')}, signed over the disk bytes {d.get('onDiskIsSigned')}")
    prove("n9", "p1_docs_ready", lambda d: d["held"] == ["docs/FAQ.md is empty"] and d["stage"] == "discussion" and "is at discussion" in (d["plan"] or "") and d["whole"] == "planning", lambda d: f"empty document {d.get('held')}, stage {d.get('stage')}, plan {str(d.get('plan'))[:60]}, once whole {d.get('whole')}")
    prove("n10", "p1_scope", lambda d: d["late"] == "the goal is revised in discussion or planning: return the phase there first" and d["goal"] == "sums skip blanks" and d["revisions"] == 1 and d["admitted"] is None and d["critique"] is None and d["book"] == ["sums skip blanks — the owner cut a screen"], lambda d: f"late revision refused, goal {d.get('goal')}, revisions {d.get('revisions')}, admitted {d.get('admitted')}")
    prove("n11", "p1_files_current", lambda d: d["same"] == "the plan is not admitted" and d["sameParts"] == 0 and d["changed"].startswith("docs/CONTEXT.md changed after the context was signed") and d["changedParts"] == ["docs/CONTEXT.md changed after the signature"], lambda d: f"unchanged: {d.get('same')}; edited: {d.get('changed')}")
    prove("n12", "p1_confirm", lambda d: d["off"] == {"stage": "planning", "awaits": 0} and d["on"] == {"stage": "discussion", "awaits": 1, "afterYes": "planning"} and d["noDecisions"] == [NO_APPETITE, NO_GOS], lambda d: f"owner.words off {d.get('off')}, on {d.get('on')}")
    prove("n13", "p1_signed", lambda d: d["before"] and d["text"].startswith(f"context signed {d['sha'][:12]}:"), lambda d: f"book line «{str(d.get('text'))[:60]}», before the stage move {d.get('before')}")
    prove("n14", "p1_book_ready", lambda d: d["chained"] and d["signedBeforeMove"] and d["seqs"] == [1, 2, 3, 4], lambda d: f"book {d.get('kinds')}, seqs {d.get('seqs')}, chained {d.get('chained')}")
    prove("n15", "p2_start", lambda d: d["stage"] == "planning" and d["move"] == "discussion → planning: the context documents exist, none is empty, and they are signed" and d["planContext"] and "is at discussion" in d["early"], lambda d: f"stage {d.get('stage')}, move «{d.get('move')}», plan on the signed edition {d.get('planContext')}")
    prove("n16", "p2_context", lambda d: d["missing"] == 1 and d["empty"] == ["docs/CONTEXT.md is empty"] and d["stage"] == "discussion" and "is at discussion" in d["plan"], lambda d: f"missing documents {d.get('missing')}, empty {d.get('empty')}, plan refused {str(d.get('plan'))[:60]}")
    prove("n17", "p2_admission", lambda d: d == {"good": True, "stale": 1, "noContext": 1, "noCheck": 1, "asked": ["the plan checker asked for changes: split b"]}, lambda d: f"admission {d}")
    prove("n18", "p2_legacy", lambda d: d["stage"] == "planning" and d["legacy"] is True and d["docs"] == 0 and d["queued"] == "planning" and d["admitted"] is None and d["checked"] == [NOT_INDEPENDENT + "it names no workflow run: report the wfRunId of the lp.plan run whose plan critic approved"] and d["normalLegacy"] is None, lambda d: f"legacy stage {d.get('stage')}, handed in {d.get('checked')}, normal phase {d.get('normalStage')}")
    prove("n19", "p2_cmd", lambda d: d["bare"] == {"skipped": ["research", "patterns", "strategy"], "ran": ["plan", "lint", "plan_critic"], "status": "succeeded"} and d["asked"]["ran"] == ["research", "plan", "lint", "plan_critic"], lambda d: f"lp.plan default: {d.get('bare')}; with research: {d.get('asked', {}).get('ran')}")
    prove("n20", "p2_signed_input", lambda d: d["ok"] and d["other"] == [SIGNED_CONTEXT] and d["orphan"] == [SIGNED_CONTEXT], lambda d: f"plan on another edition {d.get('other')}")
    prove("n21", "p2_researcher", lambda d: d["sure"] == ["gather", "assess", "done"] and d["unsure"] == ["gather", "assess", "gather", "assess", "done"], lambda d: f"lp.analyze: sure {d.get('sure')}, unsure {d.get('unsure')}")
    prove("n22", "p2_planner", lambda d: d["roles"] == ["planner", "plan-critic"] and d["planVisits"] == [1, 2] and d["criticVisits"] == [1, 2] and d["status"] == "succeeded", lambda d: f"lp.plan with a rework: path {d.get('path')}, roles {d.get('roles')}")
    prove("n23", "p2_checker", lambda d: d["same"] == [NOT_INDEPENDENT + "the plan checker went on in the planner's session thr_planner: continuing by message is no independent check"] and d["asked"] == ["the plan checker asked for changes: split a"] and d["stage"] == "execution" and d["independence"] is True, lambda d: f"own session refused {d.get('same')}; approved run admitted, stage {d.get('stage')}")
    prove("n24", "p2_order", lambda d: d["early"] == [False, "the plan checker started before the plan was done: the check must come after the planner"] and d["later"] == [True, 30, 20] and d["stage"] == "planning", lambda d: f"early critic {d.get('early')}, later {d.get('later')}, driver {d.get('driver')}")
    prove("n25", "p2_session_end", lambda d: d["after"] == [NOT_INDEPENDENT + "the planner wrote again after the check: the checker must have the last word"] and d["stage"] == "execution" and d["checker"] == "thr_critic2", lambda d: f"planner after the check {d.get('after')}; rework ended by a critic: stage {d.get('stage')}")
    prove("n26", "p2_record", lambda d: d["good"] and d["noGoal"] == ["the plan names no objective: its goals in one line"] and len(d["two"]) == 1 and d["five"] == [] and len(d["six"]) == 1 and len(d["blanks"]) == 1, lambda d: f"objective {d.get('noGoal')}, two risks {d.get('two')}, six {d.get('six')}")
    prove("n27", "p2_waves", lambda d: d["computed"] == [["a", 1], ["b", 2], ["c", 3]] and d["cycleWaves"][:2] == [["a", 0], ["b", 0]] and d["cycle"][0].startswith("the pieces depend on each other in a cycle (a → b → a)") and d["same"] == 1 and d["gate"] == 1 and d["good"] == [], lambda d: f"computed waves {d.get('computed')}, cycle {d.get('cycle', [''])[0][:60]}, gate lines {d.get('gate')}")
    prove("n28", "p2_issue_troubles", lambda d: d["id"] == ["a: the task id must equal the piece id"] and d["owns"] == ["a: no owns_paths — the piece cannot become a work"] and d["verification"] == ["a: no verification command — nothing proves the promise"] and d["ok"] == [] and len(d["gate"]) == 1, lambda d: f"piece problems: {d.get('id')} {d.get('owns')}")
    prove("n29", "p2_doc_gate", lambda d: d["good"] and d["drift"] == 1 and d["twice"] == 1 and len(d["noPlan"]) == 1 and d["session"] == [NOT_INDEPENDENT + "the checker stayed in the planner's session"], lambda d: f"drift {d.get('drift')}, repeated ids {d.get('twice')}, session {d.get('session')}")
