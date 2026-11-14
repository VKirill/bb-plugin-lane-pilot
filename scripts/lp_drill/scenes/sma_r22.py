"""Region 22 · The project planning folder: the region scene (docs/sma-evidence.md, «Trace choice»).

The phase documents and the planning folder are made by pure code (src/rooms/phase/stages.ts, the backlog, the anamnesis reader, the docs lint,
the audit graphs). A document no hub row records is proved here: the probe (sma_r22_probe.ts) runs the REAL code of the checked-out commit
(no model, no hub write, a scratch database) and prints what it returned; the scene compares each value with the node card's expected result and
prove()s it. Only a node the scene lists with ok true counts as a drill trace. Run: scripts/lp-drill.sh --scenario sma_r22.

To add a node: append its id to NODES, add the value to the probe, prove() it, and put `trace: drill("sma_r22")` on its line of evidence/r22.ts.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1592", "n1593", "n1594", "n1596", "n1597", "n1598", "n1599", "n1603", "n1605", "n1608", "n1609", "n1610", "n1611", "n1612", "n1613", "n1614",
         "n1618", "n1620", "n1622", "n1623"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r22_probe.ts"
FOLDER = ".agents/phases/ph_a1"


def scenario_sma_r22(tmp: Path) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=300)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r22", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])
    reading = seen["reading"]

    # n1592 STATE.md: the command's block is rewritten; the person's text outside it stays byte for byte; an unterminated block is refused.
    state = seen["state"]
    proofs.prove("n1592", state["kept"] and state["header"] and state["refused"], f"text outside the block kept {state['kept']}, own heading renamed {state['header']}, unterminated block refused {state['refused']}")
    # n1593 REQUIREMENTS.md: the discussion starts from the roadmap and REQUIREMENTS.md.
    proofs.prove("n1593", reading["discussion"][:2] == [".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md"], f"the discussion reads {reading['discussion']}")
    # n1594 config: global, then project, then the run's binding; the last layer wins; values parsed.
    settings = seen["settings"]
    ok = (settings["project"] == {"phase.branch": "milestone", "run.max_tokens": 5000} and settings["scoped"]["phase.branch"] == "run-scoped"
          and settings["scoped"]["run.max_tokens"] == 5000 and settings["none"] == {})
    proofs.prove("n1594", ok, f"project {settings['project']}, with a run binding {settings['scoped']}")
    # n1596 the discussion log sits beside the phase's own folder.
    proofs.prove("n1596", reading["discussion"][-1] == f"{FOLDER}/DISCUSSION.md", f"the discussion log is {reading['discussion'][-1]}")
    # n1597 SPEC.md: with the ambiguity gate on, the open planning questions over questions plus decisions give 0.25.
    proofs.prove("n1597", seen["spec"] == ["", "Ambiguity: 0.25", ""], f"spec lines {seen['spec']}")
    # n1598 / n1599 RESEARCH.md and PATTERNS.md are read at planning, in order, after the context and the spec.
    planning = reading["planning"]
    proofs.prove("n1598", planning == [f"{FOLDER}/CONTEXT.md", f"{FOLDER}/SPEC.md", f"{FOLDER}/RESEARCH.md", f"{FOLDER}/PATTERNS.md"], f"planning reads {planning}")
    proofs.prove("n1599", planning[-1] == f"{FOLDER}/PATTERNS.md", f"the last thing the planner reads is {planning[-1]}")
    # n1603 UAT.md: one open line per promise; an answer by number marks only that line; an unknown number marks nothing.
    uat = seen["uat"]
    ok = (len(uat["line1"]) == 2 and all(line.startswith("- [ ] ") for line in uat["line1"]) and uat["marked"][0] == uat["line1"][0]
          and uat["marked"][1].startswith("- [!] 2.") and uat["marked"][1].endswith("— footer missing") and uat["state"]["passed"] == 0
          and len(uat["state"]["failed"]) == 1 and len(uat["state"]["open"]) == 1 and uat["missing"] is None)
    proofs.prove("n1603", ok, f"after answering line 2 failed: {uat['marked']}")
    # n1605 REVIEW.md: a wave section with status, counts, reviewer and one line per finding.
    proofs.prove("n1605", seen["review"] == ["## Wave 1 — failed", "", "status rework; critical 1, high 0; reviewer code-critic", "", "- src/a.ts:12 save ignored", ""], f"review section {seen['review']}")
    # n1608 AI-SPEC.md: a passed check ends done, a spec refused twice ends blocked; both name the spec path.
    graphs = seen["graphs"]
    ok = graphs["aiOk"]["status"] == "done" and graphs["aiBlocked"]["status"] == "blocked" and graphs["aiBlocked"]["spec_path"] == ".agents/phases/ph_a/AI-SPEC.md"
    proofs.prove("n1608", ok, f"AI integration graph: pass {graphs['aiOk']['status']}, refused twice {graphs['aiBlocked']['status']}")
    # n1609 SECURITY.md: «нет» needs none, an open security risk needs the document signed with the context.
    sec = seen["security"]
    proofs.prove("n1609", sec["none"] is None and sec["open"] is not None and "SECURITY.md" in sec["open"] and sec["signed"] is None, f"risk «Нет» {sec['none']}; open risk {str(sec['open'])[:60]}; signed {sec['signed']}")
    # n1610 VALIDATION.md: a check that only tests a file exists is named; a real check is not.
    proofs.prove("n1610", seen["validation"] == ["p1: every check only tests that a file exists — add one that would fail without the work (VALIDATION.md)"], f"validation gaps {seen['validation']}")
    # n1611 UI-REVIEW.md: its own node runs once by default; with review_file off it is skipped.
    ok = graphs["uiOn"]["called"] == 1 and "review_doc" not in graphs["uiOn"]["skipped"] and graphs["uiOff"]["called"] == 0 and "review_doc" in graphs["uiOff"]["skipped"]
    proofs.prove("n1611", ok, f"review_doc ran {graphs['uiOn']['called']}x by default, {graphs['uiOff']['called']}x with review_file off")
    # n1612 EVAL-REVIEW.md: a flawed evaluation is reported with the review path and a todo is offered.
    flawed = graphs["evalFlawed"]
    proofs.prove("n1612", flawed["status"] == "flawed" and flawed["proposed_workflow"] == "todo-add" and flawed["review_path"].endswith("EVAL-REVIEW.md"), f"flawed eval review {flawed}")
    # n1613 Codebase map: a project root owes conventions and testing pages, a workspace owes none of them.
    proofs.prove("n1613", seen["codebase"]["root"] == ["docs/conventions.md", "docs/testing.md"] and seen["codebase"]["workspace"] == [], f"missing pages: root {seen['codebase']['root']}, workspace {seen['codebase']['workspace']}")
    # n1614 Intel (code facts): none and stale are refreshed, only an up-to-date index is fresh.
    proofs.prove("n1614", seen["intel"] == ["none", "stale", "fresh"], f"code facts states {seen['intel']}")
    # n1618 Todos: ready items sorted into issuable, needs an estimate, decompose, blocked.
    board = seen["backlog"]
    proofs.prove("n1618", board == {"issuable": ["small"], "needsEstimate": ["no-estimate"], "decompose": ["huge"], "blocked": ["waits"]}, f"backlog board {board}")
    # n1620 LEARNINGS.md: the phase's lesson lands in project memory on the hub (a memory row), the phase closes.
    lesson = seen["lesson"]
    proofs.prove("n1620", lesson["before"] == 0 and lesson["after"] == 1 and lesson["stage"] == "closed" and "check per promise" in lesson["text"], f"memory rows {lesson['before']} -> {lesson['after']}, phase {lesson['stage']}, note «{lesson['text']}»")
    # n1622 Spikes and sketches: one row each with question and verdict; a missing verdict is open.
    proofs.prove("n1622", seen["spikes"] == ["spike:does WAL help?:yes", "sketch:home:open"], f"verdict inventory {seen['spikes']}")
    # n1623 Developer profile: a lasting fact about the owner becomes a kind; a fact about someone else stays nothing; a failed model call leaves it unread.
    proofs.prove("n1623", seen["profile"] == ["preference", "nothing"] and seen["judgeDown"] == [None], f"kinds {seen['profile']}, a failed call {seen['judgeDown']}")
    return proofs.verdict("sma_r22", checked=len(NODES))
