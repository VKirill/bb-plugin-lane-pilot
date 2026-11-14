"""Region 16 · Slash commands and workflows — the region scene (docs/sma-evidence.md, «Trace choice»).

The commands and workflow stages of this region run in the daemon's phase driver, the phase gates and the workflow engine; most of them write no
row of their own, so the node-level trace is this scene. It runs the REAL code of the commit under drill — the phase gates and their texts, the phase
driver on a scratch database and a fake host, the real workflow engine with fake executors on the real graph files (lp.draw, lp.build, lp.browser-qa)
— with no model, no hub write and nothing outside the machine, and prove()s each node with the result its card expects. Run: scripts/lp-drill.sh --scenario sma_r16.

Batches of the region add their nodes here: append the ids to NODES, put the observation in tests/sma/r16-world.ts (`observe.<smaId>`), a prove() under the
batch's heading below, and `trace: drill("sma_r16")` on the node's line in evidence/r16.ts. Batch a: n1144 … n1173 (the design phase and the execute phase).
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = [
    # batch a: the design-phase and execute-phase cards
    "n1144", "n1145", "n1146", "n1147", "n1148", "n1149", "n1150", "n1151", "n1152", "n1153", "n1154", "n1155", "n1156", "n1157", "n1158", "n1159", "n1160",
    "n1161", "n1162", "n1163", "n1164", "n1165", "n1166", "n1167", "n1168", "n1169", "n1170", "n1171", "n1172", "n1173",
]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r16_probe.ts"
AWAITS = "the drawing awaits the owner's word for this drawing"
NO_CONTRACT = "the drawing has no contract: add UI-SPEC.md with the checkable points (screens, states, breakpoints) to the drawing's paths"
BASE = ["actions", "screens_states", "texts", "heuristics", "accessibility"]
SAME = {"stage": "execution", "kept": ["UI-SPEC.md", "kit.png"], "committed": [["UI-SPEC.md", "kit.png"]], "commit": "ccccccc", "book": ["drawing", "drawing_committed"]}


def _subset(seen: dict, want: dict) -> bool:
    return all(seen.get(key) == value for key, value in want.items())


def scenario_sma_r16(tmp) -> dict:
    proofs = Proofs()
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r16", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    def seen(name: str):
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    # ---- batch a: the design phase
    d = seen("k_c_design")
    proofs.prove("n1144", d.get("held") == [AWAITS] and d.get("confirmed") is True and d.get("redrawn") == [AWAITS], f"gate with owner words on: {d}")
    d = seen("k_wd_rubric")
    proofs.prove("n1148", d.get("design", "").endswith("the designer reviewing his own drawing; motion without the animator's rules.") and d["design"].count(") ") >= 7 and d.get("closed") == "", f"design rubric ends «{d.get('design', '')[-90:]}»")
    d = seen("k_wd_read")
    proofs.prove("n1149", d.get("design") == [".agents/phases/ph_sma/CONTEXT.md", ".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/PLAN.md", "DESIGN.md"], f"read before drawing: {d.get('design')}")
    d = seen("k_wd_mode")
    proofs.prove("n1150", d.get("screens") == ["screens", BASE] and d.get("system") == ["system", BASE + ["c4", "event_chain"]] and d.get("mixed", [None])[0] == "mixed" and d.get("none") == "screens", f"modes {d}")
    d = seen("k_wd_version")
    proofs.prove("n1151", d.get("replaced") == ["a"] and d.get("same") == 0 and d.get("first") == 0 and len(d.get("capped", [])) == 10, f"archive: replaced {d.get('replaced')}, same drawing {d.get('same')}, capped at {len(d.get('capped', []))}")
    d = seen("k_wd_path")
    proofs.prove("n1152", _subset(d.get("pm", {}), SAME) and _subset(d.get("auto", {}), SAME), f"PM path {d.get('pm')}; auto path {d.get('auto')}")
    proofs.prove("n1160", d.get("pm", {}).get("committed") == [["UI-SPEC.md", "kit.png"]] and d.get("pm", {}).get("commit") == "ccccccc", f"manifest commit {d.get('pm', {}).get('committed')} at {d.get('pm', {}).get('commit')}")
    d = seen("k_wd_h1")
    proofs.prove("n1153", d.get("draw", {}).get("rules") is True and d.get("check", {}).get("rules") is True and d["draw"]["words"] == d.get("words") and d["check"]["words"] == d.get("words"), f"draw {d.get('draw')}, check {d.get('check')}")
    d = seen("k_wd_h2")
    proofs.prove("n1154", d.get("designMd") is None and d.get("full") is None and (d.get("partial") or "").startswith("the drawing's contract misses required section(s): texts, heuristics, accessibility"), f"contract: DESIGN.md {d.get('designMd')}, partial {d.get('partial')}, full {d.get('full')}")
    d = seen("k_wd_h3")
    proofs.prove("n1155", d.get("none") == ["the drawing is not reviewed by a separate role"] and d.get("same") == ["the reviewer of the drawing is its designer: it must be a separate role"] and d.get("other") is True, f"reviewer {d}")
    d = seen("k_wd_snapshot")
    proofs.prove("n1156", d.get("path") == "qa verdict done" and d.get("qa", {}).get("viewports") == "375,768,1280" and d.get("out", {}).get("state") == "failed", f"browser check path {d.get('path')}, viewports {d.get('qa', {}).get('viewports')}, out {d.get('out')}")
    d = seen("k_wd_i1")
    proofs.prove("n1157", d.get("off") == ["draw", "check", "done"] and d.get("offSkipped") == ["material"] and d.get("on") == ["material", "draw", "check", "done"] and d.get("onDraw") == "f/design/MATERIAL.md", f"off {d.get('off')}, on {d.get('on')}, draw told {d.get('onDraw')}")
    d = seen("k_wd_i2")
    proofs.prove("n1158", d.get("bare", {}).get("text", "").startswith("Phase ph_x «Sum» — stage 3, design (screens). Lane Pilot draws the screens itself (lp.draw:") and d["bare"].get("motion") is True and d.get("drawn", {}).get("mentionsLpDraw") is False, f"next action {d.get('bare', {}).get('text', '')[:110]}")
    d = seen("k_wd_i3")
    proofs.prove("n1159", d.get("path") == ["draw", "check", "draw", "check", "done"] and d.get("draws") == 2, f"lp.draw path with a rework verdict {d.get('path')}")
    d = seen("k_wd_c2")
    proofs.prove("n1161", d.get("wait", {}).get("key") == "design:word:design" and d["wait"].get("waitsForPm") is True and d.get("after", {}).get("key") == "design:s1:t", f"awaiting the word {d.get('wait')}, after the yes {d.get('after')}")
    d = seen("k_wd_c3")
    proofs.prove("n1162", d.get("ready") is True and d.get("noAnswer") == ["no feasibility answer: feasible, or the contradiction with the plan"] and len(d.get("contradicts", [])) == 1 and d.get("noContract") == [NO_CONTRACT], f"readiness {d}")

    # ---- batch a: the execute phase
    d = seen("k_c_execute")
    proofs.prove("n1145", d.get("first") == ["p1", "p3"] and d.get("afterP1") == ["p2"] and d.get("sent") == ["q1"] and d.get("issued") == ["q1"], f"ready {d.get('first')}, after p1 {d.get('afterP1')}, driver issued {d.get('issued')}")
    d = seen("k_c_execplan")
    proofs.prove("n1146", d.get("done", {}).get("path") == "run_tasks gate done" and d["done"].get("status") == "done" and d.get("partial", {}).get("status") == "partial" and d["partial"].get("failed") == ["t3"] and d.get("blocked", {}).get("path") == "run_tasks blocked", f"lp.build {d.get('done', {}).get('status')}/{d.get('partial', {}).get('status')}/{d.get('blocked', {}).get('status')}")
    d = seen("k_c_noderepair")
    proofs.prove("n1147", d.get("briefLine") == "- the check `npm test` failed (exit 1) → run `npm test` yourself, read its output, fix what it names inside owns_paths" and d.get("accepted") == "" and d.get("none") == "", f"retry brief: {d.get('briefLine')}")
    d = seen("k_we_rubric")
    proofs.prove("n1163", d.get("execution", "").endswith("accepting on a model's word alone.") and "5) the regression pass of earlier phases after each merge" in d["execution"], f"execution rubric ends «{d.get('execution', '')[-70:]}»")
    d = seen("k_we_init")
    proofs.prove("n1164", d.get("execution") == [".agents/phases/ph_sma/design/UI-SPEC.md", ".agents/phases/ph_sma/design/kit.png", ".agents/phases/ph_sma/PLAN.md"] and d.get("plain") == [".agents/phases/ph_sma/PLAN.md"], f"execution context {d.get('execution')}")
    d = seen("k_we_resume")
    proofs.prove("n1165", d.get("resumed") == ["p2"] and d.get("stillRunning") == [] and d.get("changed") == ["p1", "p2"], f"issued again on resume: {d}")
    d = seen("k_we_headless")
    proofs.prove("n1166", d.get("within") == "owner_present:codex used by the owner 2 min ago on mac" and d.get("after") is None and d.get("old") is None and d.get("other") is None, f"presence hold {d}")
    d = seen("k_we_branch")
    proofs.prove("n1167", d.get("milestone") == ["git branch -f milestone/v1 HEAD", ["marker branch milestone/v1 at the accepted main"]] and d.get("phase", [""])[0] == "git branch -f phase/<id> HEAD", f"marker branches {d}")
    d = seen("k_we_discover")
    proofs.prove("n1168", d.get("waves") == [1, 2] and d.get("perWave") == [["a", "d"], ["b", "c"]] and d.get("ready") == ["a", "d", "b", "c"], f"inventory {d}")
    d = seen("k_we_wavetable")
    proofs.prove("n1169", d.get("table") == ["wave 1:", "| piece | task | promise |", "|---|---|---|", "| p1 | task_1 | then-p1 |", "| p2 | — | a / b |"] and len(d.get("journal", [])) == 1 and d["journal"][0][3] == "| p1 | p1 | then-p1 |", f"wave table {d.get('table')}; journal {d.get('journal')}")
    d = seen("k_we_contract")
    proofs.prove("n1170", d.get("noContract") == NO_CONTRACT and d.get("execution") == [".agents/phases/ph_sma/design/UI-SPEC.md", ".agents/phases/ph_sma/PLAN.md"] and d.get("backend") is False, f"contract {d}")
    d = seen("k_we_animator")
    proofs.prove("n1171", d.get("rows") == ["m", "r"] and d.get("decision") == ["m"], f"motion rows {d}")
    d = seen("k_we_animator_inline")
    proofs.prove("n1172", (d.get("on") or "").startswith("Motion (the animator's law): motion rows: animate transform and opacity only") and d.get("onPlain") is None and d.get("off") is None, f"inline law {str(d.get('on'))[:90]}; plain {d.get('onPlain')}; off {d.get('off')}")
    d = seen("k_we_crossai")
    proofs.prove("n1173", d.get("named", {}).get("providerId") == "codex" and d["named"].get("model") == "gpt-x" and d.get("request", {}).get("selection") == {"providerId": "codex", "model": "gpt-x"} and d.get("stops") == ["thr_w"], f"reassign {d}")
    return proofs.verdict("sma_r16", checked=len(NODES))
