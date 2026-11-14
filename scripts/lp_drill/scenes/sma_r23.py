"""Region 23 · Templates, references, contexts: the region scene (docs/sma-evidence.md, «Trace choice»).

A template or a reference of this region is text an agent is handed. The scene runs the REAL pieces of the commit under drill — the brief a role's step is
given (its method, its rules), the selection that decides who gets a template and when, the graphs on the real engine with their model nodes answered by
stubs (what the code does with the filled-in answer: a loop back, a block, an end), a real temp git repository for the landing gate — and prove()s each
node with the result its card expects. No model, no hub write, nothing leaves the machine. Run: scripts/lp-drill.sh --scenario sma_r23.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = [f"n{n}" for n in range(1627, 1653) if n in (1627, 1629, 1630, 1631, 1632, 1633, 1634, 1635, 1636, 1637, 1638, 1639, 1640, 1641, 1642, 1643, 1644, 1645, 1646, 1650, 1651, 1652)]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r23_probe.ts"


def scenario_sma_r23(tmp) -> dict:
    proofs = Proofs()
    # vite-node, not tsx: the probe loads the plugin's rooms, whose barrel files tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r23", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n1627 Execution step gates: a candidate lands on main when main is in it, and a landing after main moved is refused (BASE_MOVED) with main untouched.
    lc, lm = s["landClean"], s["landMoved"]
    proofs.prove("n1627", lc["status"] == "merged" and lc["onMain"] and lm["status"] == "failed" and lm["reason"].startswith("base moved since the candidate") and lm["mainUnchanged"],
                 f"main in the candidate -> {lc['status']} (file on main {lc['onMain']}); main moved after -> {lm['status']} «{lm['reason']}», main unchanged {lm['mainUnchanged']}")
    # n1629 Gate and revision rules: the third change-requesting round stops the revising, the second and an approval do not.
    r = s["rounds"]
    proofs.prove("n1629", r["max"] == 3 and r["atMax"] == 1 and r["before"] == 0 and r["approved"] == 0, f"max {r['max']}; stop-revising gap at round {r['max']}: {r['atMax']}, one round earlier: {r['before']}, approved: {r['approved']}")
    # n1630 Inventory of checkable gates: every refusal the pre-task guard really gives has an inventory row; an unknown tag is reported.
    inv = s["inventory"]
    proofs.prove("n1630", inv["tags"] == ["execution-without-agent", "subagent-foreground", "subagent-cap", "spend-cap"] and inv["gaps"] == {"empty": [], "unknown": []} and inv["unknown"] == ["no-such-deny"],
                 f"deny tags {inv['tags']} -> gaps {inv['gaps']}; unknown tag reported {inv['unknown']} ({inv['rows']} rows)")
    # n1631 Planner rules: the planner's brief carries its rules and method; a lint error goes back to the planner as gaps, a clean plan goes to the critic.
    p = s["planner"]
    proofs.prove("n1631", p["role"] == "planner" and p["rule"] and p["method"] and p["path"] == "plan lint plan lint plan_critic ok" and p["gaps"] == ["t1 and t2 run in the same wave (neither depends on the other) but both own src"],
                 f"role {p['role']}, rules in brief {p['rule']}, method {p['method']}, path {p['path']}, second plan call got gaps {p['gaps']}")
    # n1632 Thinking models per role: each role's brief carries its own method and no other role's; a specialist and a writer carry none.
    m = s["methods"]
    ok = all(m[key] for key in ("planner", "critic", "analyst", "debugger")) and not m["plannerHasCritic"] and not m["criticHasPlanner"] and not m["specialistAny"] and m["writer"] == 0
    proofs.prove("n1632", ok, f"planner/critic/analyst/debugger own method in brief {[m[k] for k in ('planner', 'critic', 'analyst', 'debugger')]}, crossed {m['plannerHasCritic'] or m['criticHasPlanner']}, {m['specialistRole']} has any {m['specialistAny']}, writer lines {m['writer']}")
    # n1633 Research rules: an analyst's read-only claims step carries the two-source rule; no source ends blocked; a bad citation goes back once.
    rs = s["research"]
    ok = (rs["role"] == "analyst" and rs["readOnly"] and rs["rule"] and rs["none"] == "frame search blocked" and rs["fixed"].endswith("check report check deliver goal_check done")
          and rs["fixedOut"] == "done" and rs["stillOut"] == "partial" and rs["stillOk"] is False)
    proofs.prove("n1633", ok, f"claims role {rs['role']} read-only {rs['readOnly']}; no sources -> {rs['none']}; bad citation fixed -> {rs['fixedOut']}, still bad -> {rs['stillOut']}")
    # n1634 Phase execution rules: the worked example rides at the end of a piece's plan only where the phase has piece notes; the rest of the plan is the same.
    ex = s["exec"]
    proofs.prove("n1634", not ex["plainHas"] and ex["tail"] and ex["same"], f"plain plan has the example {ex['plainHas']}, noted plan ends with it {ex['tail']}, same head {ex['same']}")
    # n1635 Copy and git rules: a git worktree writer is told not to commit/push/merge, a live-folder writer gets the live rule instead, never both.
    w = s["worktree"]
    proofs.prove("n1635", w["worktreeHasRule"] and not w["worktreeHasLive"] and w["liveHasLive"] and not w["liveHasRule"], f"worktree brief: rule {w['worktreeHasRule']}, live line {w['worktreeHasLive']}; live brief: live line {w['liveHasLive']}, rule {w['liveHasRule']}")
    # n1636 MVP and story concepts: a planner's story, judged by a plan critic; one rework goes back once, a second ends the run.
    mv = s["mvp"]
    proofs.prove("n1636", mv["roles"] == ["planner", "plan-critic"] and mv["checkReadOnly"] and mv["once"] == "story split_check story split_check goal_check done" and mv["alwaysStory"] == 2,
                 f"roles {mv['roles']}, one rework path {mv['once']}, always rework: story called {mv['alwaysStory']} times")
    # n1637 Design training and brand: the drawing rules go to the author and to a checker of another role, and sit in the design stage's order and no other's.
    d = s["drawing"]
    proofs.prove("n1637", d["roles"] == ["specialist:design-lead", "plan-critic"] and d["checkReadOnly"] and d["both"] and d["design"] and d["animator"] and d["others"] == [],
                 f"roles {d['roles']}, rules in both briefs {d['both']}, in the design rubric {d['design']}, in other stages {d['others']}")
    # n1638 Sketch rules: the sketch part of the rules rides the same way to the author, the checker and the design stage, and to no other stage.
    proofs.prove("n1638", d["sketchBoth"] and d["sketchDesign"] and d["sketchOthers"] == [], f"sketch rules in both briefs {d['sketchBoth']}, in the design rubric {d['sketchDesign']}, in other stages {d['sketchOthers']}")
    # n1639 AI system references: evaluation plan before the spec and carried into it; a failed check reworks the spec once; a second failure blocks.
    a = s["ai"]
    ok = (a["ok"] == "select research eval_plan spec check done" and a["once"] == "select research eval_plan spec check spec check done" and a["twice"].endswith("spec check spec check blocked")
          and a["evalCalls"] == 1 and a["specConsumes"] == ["select", "research", "eval_plan"])
    proofs.prove("n1639", ok, f"clean {a['ok']}; one rework {a['once']}; two failures end {a['twice'].split(' ')[-1]}; spec consumes {a['specConsumes']}")
    # n1640 Debugging philosophy: a read-only debugger with the scientific method; a cause without confidence, pressure pass or files is not confirmed independently.
    db = s["debug"]
    proofs.prove("n1640", db["role"] == "debugger" and db["readOnly"] and db["method"] and db["backed"] and db["weak"] == [True, True, True], f"role {db['role']} read-only {db['readOnly']}, method in brief {db['method']}; backed cause confirmed {db['backed']}; weak causes re-investigated {db['weak']}")
    # n1641 Edge and prohibition probes: the strategy step is an auditor's, runs only with validation on outside quick mode, and its text reaches the plan.
    st = s["strategy"]
    proofs.prove("n1641", st["role"] == "auditor" and st["readOnly"] and st["onCalls"] == 1 and st["planGot"] == "V: an empty list fixture" and st["offCalls"] == 0 and st["quickCalls"] == 0,
                 f"role {st['role']}, runs with validation on {st['onCalls']}, off {st['offCalls']}, quick {st['quickCalls']}, plan got «{st['planGot']}»")
    # n1642 Conversation rules: the owner's consent is the whole message; «да, но …» is a new word.
    c = s["consent"]
    proofs.prove("n1642", c["yes"] and c["launch"] and not c["but"] and not c["please"] and not c["butLaunch"], f"{c}")
    # n1643 Untrusted input boundary: a stored note is data to compare with, outside the instructions; an answer with an override or a credential is refused.
    sf = s["safety"]
    proofs.prove("n1643", sf["inBlock"] and not sf["outside"] and sf["clean"] == 1 and sf["override"].startswith("memory content addresses the") and sf["credential"].startswith("memory content appears to contain"),
                 f"note inside the data block {sf['inBlock']}, outside it {sf['outside']}; clean entry parsed {sf['clean']}; override -> {sf['override']!r}; credential -> {sf['credential']!r}")
    # n1644 Model profiles: a role runs on its table row; the owner's row wins; a row naming no model is ignored; a pinned agent keeps its own.
    mo = s["models"]
    ok = (mo["planner"] == "claude-opus-5-5" and not mo["critic"].startswith("claude") and mo["own"]["model"] == "gpt-6.1-sol" and mo["own"]["source"] == "table" and mo["own"]["sourceKey"] == "role_model.planner"
          and mo["other"] == "claude-opus-5-5" and mo["bad"] == "claude-opus-5-5" and mo["pinned"] == "pinned" and mo["table"] == "gpt-6.1-sol")
    proofs.prove("n1644", ok, f"planner {mo['planner']}, critic {mo['critic']}, with the owner's row {mo['own']['model']} ({mo['own']['source']}), analyst unchanged {mo['other']}, bad row ignored {mo['bad']}")
    # n1645 Infra profile and teaching: the eight keys with sane values pass; an unknown key, a secret-named key, a secret-looking and an over-long value are refused by key.
    pf = s["profile"]
    ok = pf["stack"] is None and pf["test_command"] is None and pf["style"].startswith("the value is longer") and pf["api_key"].startswith("unknown profile key") and pf["deploy"] == "the value looks like a secret" and pf["hobby"].startswith("unknown profile key")
    proofs.prove("n1645", ok, f"profile pairs judged: {pf}")
    # n1646 Verification patterns: the PM and the check auditor carry the lane-pilot skill, another role does not; another run's red check is set aside, the run's own fails.
    v = s["verify"]
    proofs.prove("n1646", v["pm"] and v["nyquist"] and not v["selector"] and v["reference"] and v["aside"] == "passed" and v["own"] == "failed", f"PM skill {v['pm']}, nyquist {v['nyquist']}, selector {v['selector']}; other run's red check -> {v['aside']}, own red check -> {v['own']}")
    # n1650 Plan predictions and risk: forecast and risk are in a piece's plan only with phase.piece_notes.
    pr = s["predictions"]
    proofs.prove("n1650", not pr["plain"] and pr["noted"] and pr["risk"], f"plain plan has Predictions/Risk {pr['plain']}; with piece notes: predictions {pr['noted']}, risk {pr['risk']}")
    # n1651 Agent instruction templates: AGENTS.md and the Copilot form point at PROJECT.md, CLAUDE.md is the import, the preferences are filled from the profile.
    fm = s["forms"]
    proofs.prove("n1651", fm["pointers"] and fm["claude"] == "@AGENTS.md\n" and fm["prefs"], f"pointers to PROJECT.md {fm['pointers']}, CLAUDE.md {fm['claude']!r}, preferences filled {fm['prefs']}")
    # n1652 Milestone and retrospective forms: with retro.living on the close keeps the living retro and writes the record; off, neither runs.
    ms = s["milestone"]
    proofs.prove("n1652", "living close record snapshot" in ms["on"] and "living" not in ms["off"].split(" ") and "record" not in ms["off"].split(" "), f"retro on: {ms['on']}; retro off: {ms['off']}")
    return proofs.verdict("sma_r23", checked=len(NODES))
