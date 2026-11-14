"""Region 17 · Agent roles (subagents): the region scene (docs/sma-evidence.md, «Trace choice»).

A role of this region is a prompt plus a spawn profile. The scene runs the REAL roles of the commit under drill — the profile a session role is spawned with
(tools, skills), the request the executor builds for a graph's agent node (role row, what it may write, the fields of its answer), the shipped graphs on the real
engine with their model nodes answered by stubs (where the answer goes), and the code that reads an answer (verdicts, the QA parser, the fragment judge) — and
prove()s each node with the result its card expects. No model, no hub write. A role that writes no row to the hub database (a session, a graph that never ran
live) is traced here. Run: scripts/lp-drill.sh --scenario sma_r17.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = [f"n{n}" for n in range(1368, 1402) if n not in (1388, 1390)]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r17_probe.ts"


def scenario_sma_r17(tmp) -> dict:
    proofs = Proofs()
    # vite-node, not tsx: the probe loads the plugin's rooms, whose barrel files tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r17", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    sessions, ai = s["sessions"], s["ai"]

    # n1368 Selector: a read-only session, a read-only select step answering framework/options/scores, and the picked framework is what the run reports.
    sel = sessions["framework-selector"]
    ok = sel["writes"] == [] and "Read" in sel["reads"] and s["select"]["readOnly"] and s["select"]["fields"]["scores"] == "json" and ai["out"]["framework"] == "langchain"
    proofs.prove("n1368", ok, f"session writes {sel['writes']}, select read-only {s['select']['readOnly']}, run framework {ai['out']['framework']}")
    # n1369 AI researcher: the research step runs as the tavily specialist, writes only its own notes, and answers the quick reference and the guidance.
    r = s["research"]
    ok = r["role"] == "specialist:tavily" and r["notes"] and not r["src"] and r["fields"]["quick_reference"] == "string" and r["fields"]["implementation_notes"] == "string" and "research" in s["spec"]["consumes"] and sessions["ai-researcher"]["skills"] == ["tavily"]
    proofs.prove("n1369", ok, f"role {r['role']}, notes writable {r['notes']}, src writable {r['src']}, fields {sorted(k for k in r['fields'] if k.endswith('notes') or k == 'quick_reference')}")
    # n1370 Domain researcher: domain_notes is the field the evaluation plan is told to read, and the research comes before the plan.
    ok = r["fields"].get("domain_notes") == "string" and s["evalPlan"]["named"] == ["domain_notes"] and ai["path"].startswith("select research eval_plan")
    proofs.prove("n1370", ok, f"research answers domain_notes, the evaluation plan reads {s['evalPlan']['named']}, path {ai['path']}")
    # n1371 Eval planner: a planner's answer in one typed field, made before the spec and carried into it; a failed check reworks the spec only.
    ep = s["evalPlan"]
    ok = ep["helper"] == "planner" and ep["readOnly"] and ep["fields"]["eval_plan"] == "string" and s["spec"]["consumes"] == ["select", "research", "eval_plan"] and ai["evalPlanCalls"] == 1 and ai["path"] == "select research eval_plan spec check spec check done"
    proofs.prove("n1371", ok, f"{ep['helper']} read-only {ep['readOnly']}, spec consumes {s['spec']['consumes']}, rework path {ai['path']}")
    # n1372 Executor: the writer is told Lane Pilot commits and merges; the phase conclusion has one line per piece with its task, state and promise.
    ex = s["executor"]
    ok = ex["brief"] and ex["summary"] == ["# Summary — phase ph_9: T", "- a (task task_a, accepted): A works", "- b (task task_b, blocked): B works"]
    proofs.prove("n1372", ok, f"brief says Lane Pilot commits {ex['brief']}, summary {ex['summary']}")
    # n1373 Animator: a motion piece carries the animator's law into its plan, only where the phase has piece notes.
    an = s["animator"]
    proofs.prove("n1373", an["motion"] and not an["plain"] and not an["noNotes"], f"motion piece {an['motion']}, plain piece {an['plain']}, phase without piece notes {an['noNotes']}")
    # n1374 Code fixer: the review's findings go to the planner as gaps, the planned tasks go to the build, a not-clean re-review is fixed once more.
    fx = s["fix"]
    ok = (fx["firstReviewCalls"] == 0 and fx["planGaps"]["mode"] == "gaps" and len(fx["planGaps"]["gaps"]) == 2 and fx["buildTasks"]["tasks"] == [{"id": "fix-a", "objective": "fix a"}]
          and fx["secondGaps"]["gaps"][0]["file"] == "src/c.ts" and fx["path"] == "first_review plan_fix build_fix re_review plan_fix2 build_fix2 re_review done" and fx["secondBuild"]["tasks"] == [{"id": "fix-b", "objective": "fix b"}] and fx["out"]["review_status"] == "pass")
    proofs.prove("n1374", ok, f"plan gaps {len(fx['planGaps']['gaps'])}, build tasks {fx['buildTasks']['tasks']}, second-round gaps {fx['secondGaps']['gaps'][0]['file']}, path {fx['path']}")
    # n1375 Debugger: a read-only debugger handed the scientific method, answering the evidence path.
    d = s["debug"]
    ok = d["helper"] == "debugger" and d["readOnly"] and d["method"] and d["skills"]["names"] == ["gitnexus-debugging"] and d["out"]["evidence_path"] == "e.md" and d["out"]["status"] == "confirmed"
    proofs.prove("n1375", ok, f"{d['helper']} read-only {d['readOnly']}, method in its brief {d['method']}, answer {d['out']['status']} at {d['out']['evidence_path']}")
    # n1376 Debug session manager: an objection sends the debugger back, an answered one confirms compactly, an unanswered one ends as partial after three rounds.
    ok = "investigate verify_cause investigate verify_cause confirmed" in d["path"] and d["out"]["root_cause"] == "list[0] on empty" and d["stuckInvestigate"] == 3 and d["stuckStatus"] == "partial"
    proofs.prove("n1376", ok, f"path {d['path']}; never-answered objection: {d['stuckInvestigate']} investigations then {d['stuckStatus']}")
    # n1377 Verifier: an unproved promise fails the phase and names the piece, a proved one passes, and the same facts freeze one verdict.
    v = s["verdict"]
    proofs.prove("n1377", v["failed"]["state"] == "failed" and "hud: plan-fact failed" in v["failed"]["detail"] and v["passed"] == "passed" and v["again"], f"{v['failed']['state']}: {v['failed']['detail']}; proved piece {v['passed']}; same facts same hash {v['again']}")
    # n1378 Integration checker: after the merge the checks green on the base and red on main are named, kept on the row and shown on the acceptance card.
    b = s["baseline"]
    proofs.prove("n1378", b["turned"] == ["test -f keep.txt"] and b["after"]["turnedRed"] == ["test -f keep.txt"] and b["after"]["checked"] == 3 and b["card"] == ["test -f keep.txt"], f"turned red {b['turned']}, row {b['after']['turnedRed']}, card {b['card']}")
    # n1379 Nyquist auditor: spawned read-only with the lane-pilot skill; a piece whose every check only tests existence is named.
    ny = sessions["nyquist-auditor"]
    proofs.prove("n1379", ny["writes"] == [] and ny["skills"] == ["lane-pilot"] and len(s["gaps"]) == 1 and s["gaps"][0].startswith("p1"), f"writes {ny['writes']}, skills {ny['skills']}, gaps {s['gaps']}")
    # n1380 Security auditor: without a phase the threat model is skipped, with one it runs once.
    sec = s["security"]
    proofs.prove("n1380", sec["plainCalls"] == 0 and sec["plainSkipped"] == ["threat_model"] and sec["phaseCalls"] == 1, f"no phase: {sec['plainCalls']} calls, skipped {sec['plainSkipped']}; with a phase: {sec['phaseCalls']} call")
    # n1381 UI auditor: the six-pillar review is its own step, on by default, skipped and no file when review_file is false.
    ui = s["uiAudit"]
    proofs.prove("n1381", ui["offSkipped"] == ["review_doc"] and ui["offCalls"] == 0 and ui["onCalls"] == 1, f"review_file=false skipped {ui['offSkipped']}, default calls {ui['onCalls']}")
    # n1382 UI QA: a pass with one case blocked is blocked, no verdict block is blocked with its reason, a pass with every case passed passes.
    q = s["qa"]
    proofs.prove("n1382", q["blocked"] == "blocked" and q["none"] == "browser_qa_thread_returned_no_verdict" and q["passed"] == "passed", f"{q}")
    # n1383 Eval auditor: a flawed evaluation is offered a fix and answered flawed; a sound one closes sound with its review path.
    er = s["evalReview"]
    proofs.prove("n1383", er["flawedPath"] == "review offer flawed" and er["flawedOut"]["status"] == "flawed" and er["flawedOut"]["proposed_workflow"] == "todo-add" and er["soundStatus"] == "sound", f"flawed path {er['flawedPath']} -> {er['flawedOut']['status']}, sound -> {er['soundStatus']}")
    # n1384 UI researcher: the UI-SPEC.md contract names the required sections it misses and passes when each heading is there.
    sp = s["uiSpec"]
    proofs.prove("n1384", sp["ok"] is None and "misses required section(s): accessibility" in (sp["gap"] or ""), f"complete spec -> {sp['ok']}, missing one -> {sp['gap']!r}")
    # n1385 Doc writer: the owner's assignment reaches the docs pass as data, and without it the pass carries none.
    dc = s["docs"]
    proofs.prove("n1385", dc["withAssignment"] and not dc["without"], f"assignment in the pass {dc['withAssignment']}, without one {dc['without']}")
    # n1386 Doc verifier: a claim whose identifier is not in the cited lines is a finding; one that is there is not.
    c = s["citation"]
    proofs.prove("n1386", c["absent"] == ["evidence"] and c["present"] == 0, f"absent identifier -> {c['absent']}, present -> {c['present']} findings")
    # n1387 Classifier: spawned unable to change any file.
    proofs.prove("n1387", sessions["doc-classifier"]["writes"] == [] and "Read" in sessions["doc-classifier"]["reads"], f"writes {sessions['doc-classifier']['writes']}")
    # n1389 Codebase mapper: one scope goes to the analysis at the depth its mode asks for; the recommendation and report path are the result.
    ac = s["analyzeCode"]
    ok = ac["input"]["scope"] == "src/rooms/writer" and ac["input"]["depth"] == "standard" and ac["quickDepth"] == "quick" and ac["out"]["report_path"] == "reports/analysis-1.md" and ac["out"]["confidence"] == 77
    proofs.prove("n1389", ok, f"scope {ac['input']['scope']}, depth {ac['input']['depth']} (quick: {ac['quickDepth']}), report {ac['out']['report_path']}")
    # n1391 User profiler: only a lasting, confident fact about the person becomes a kind; sensitive ones are marked.
    f = s["fragments"]
    ok = f[0]["kind"] == "skill" and f[1]["kind"] == "nothing" and f[2] == {"kind": "fact", "kindP": 0.6, "aboutOwner": 0.6, "sensitive": 0.9}
    proofs.prove("n1391", ok, f"kinds {[x['kind'] for x in f]}, sensitive {[x['sensitive'] for x in f]}")
    # n1392 Pattern mapper: the closest-analog step runs on request, feeds the plan and the result, and does not run in a quick plan.
    p = s["patterns"]
    ok = p["ran"][:2] == ["patterns", "plan"] and p["planInput"] == p["out"] and p["out"].startswith("src/rooms/x.ts:10") and p["quickCalls"] == 0
    proofs.prove("n1392", ok, f"ran {p['ran']}, patterns in the result {p['out']!r}, quick plan calls {p['quickCalls']}")
    # n1393 Assumptions analyzer: a question without an anchor is walked again once; the synthesis decides open or done.
    g = s["grill"]
    proofs.prove("n1393", g["walks"] == 2 and g["openStatus"] == "open" and g["doneStatus"] == "done", f"walks {g['walks']}, with an open question {g['openStatus']}, without {g['doneStatus']}")
    # n1394 Advisor: read-only, with the tavily search skill.
    ad = sessions["advisor-researcher"]
    proofs.prove("n1394", ad["writes"] == [] and ad["skills"] == ["tavily"] and "WebSearch" in ad["reads"], f"writes {ad['writes']}, skills {ad['skills']}")
    # n1395 Project researcher: the stack and the features found are in the analysis result.
    an2 = s["analyze"]
    proofs.prove("n1395", an2["stack"] == ["ts", "node"] and an2["features"] == ["tasks"], f"stack {an2['stack']}, features {an2['features']}")
    # n1396 Research synthesizer: the parallel researchers' sources are merged without duplicates and a question that found none is named.
    rd = s["reducer"]
    proofs.prove("n1396", rd == {"sources": [{"url": "u1"}, {"url": "u2"}], "source_count": 2, "unavailable": ["q3"]}, f"{rd}")
    # n1397 Roadmapper: a refused roadmap is cut again up to three times then blocks; an approved one runs its sessions.
    rm = s["roadmap"]
    proofs.prove("n1397", rm["badRoadmapCalls"] == 3 and rm["badStatus"] == "blocked" and rm["goodStatus"] == "done" and rm["goodDone"] == ["s1"], f"refused: {rm['badRoadmapCalls']} roadmaps then {rm['badStatus']}; approved: {rm['goodStatus']} {rm['goodDone']}")
    # n1398 The Agent tool only for documentary stages: a PM's Agent/Task is narrowed to Explore and Plan, code-writing names are stripped, others are untouched.
    t = s["pmTools"]
    proofs.prove("n1398", t["narrowed"] == ["Agent(Explore, Plan)", "Task(Explore, Plan)", "Read"] and t["listed"] == ["Agent(Explore, Plan)"] and t["other"] == ["Agent"], f"{t}")
    # n1399 A writer does the task itself: the pre-task hook refuses a general-purpose subagent and lets the documentary ones through.
    h = s["hook"]
    proofs.prove("n1399", "[execution-without-agent]" in h["refused"]["deny"] and h["refused"]["spawned"] == 0 and h["documentary"] == [None, None, None], f"refused {h['refused']['deny'][:40]!r}, documentary {h['documentary']}")
    # n1400 Subagent in the foreground only: a background call is refused with the foreground reason and not counted; the foreground call passes and is counted.
    fg = s["foreground"]
    refused = [fg["pmBackground"], fg["writerBackground"]]
    ok = all((r["deny"] or "").startswith("[subagent-foreground]") and r["spawned"] == 2 for r in refused) and fg["pmForeground"] == {"deny": None, "spawned": 3} and fg["writerForeground"] == {"deny": None, "spawned": 3}
    proofs.prove("n1400", ok, f"background: {[r['deny'][:21] for r in refused if r['deny']]}, count kept {[r['spawned'] for r in refused]}; foreground: {fg['pmForeground']}")
    # n1401 Role model and skills: each role is given its own skills and its own row of the model table; an owner's list and a pin win.
    rs = s["resolve"]
    want = {"writer": ["lp-writer", "karpathy-guidelines"], "docs-maintainer": ["lp-docs", "docs-methodology"], "browser-qa": ["browser-automation"], "plan-critic": []}
    ok = (all(rs["skills"][role] == {"names": names, "source": "role"} for role, names in want.items()) and rs["owner"] == {"names": ["only-this"], "source": "owner"}
          and all(m["got"] == m["row"] for m in rs["models"].values()) and rs["models"]["writer"]["got"] != rs["models"]["plan-critic"]["got"] and rs["pinned"] == ["gpt-x", "pinned"])
    proofs.prove("n1401", ok, f"skills {{role: names}} {dict((k, v['names']) for k, v in rs['skills'].items())}, owner list {rs['owner']['names']}, models {dict((k, m['got'][1]) for k, m in rs['models'].items())}, pin {rs['pinned']}")
    return proofs.verdict("sma_r17", checked=len(NODES))
