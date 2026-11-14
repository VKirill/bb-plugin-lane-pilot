"""Region 1 · Task graph, batch f: the ends of an attempt, the queues, the claim guards and the phase steps, proved by the region scene sma_r01 (docs/sma-evidence.md, «Trace choice»).

These nodes write no row of a hub table that a trace could read (a lane choice, a dead-letter list, a refusal, a wait key). The probe runs the REAL code of the commit under
drill on a scratch database and a fake plugin host (no model, no hub write), and prove_f() compares each result with what the node's card expects.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_F = ["n322", "n326", "n328", "n333", "n334", "n335", "n336", "n337", "n338", "n339", "n340", "n341", "n342", "n343", "n344"]
PROBE_F = ROOT / "scripts/lp_drill/scenes/sma_r01_f_probe.ts"


def prove_f(proofs: Proofs, tmp: Path) -> None:
    done = subprocess.run(["npx", "tsx", str(PROBE_F)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_F:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return
    if "fatal" in s:
        for node in NODES_F:
            proofs.prove(node, False, f"the probe failed: {s['fatal']}")
        return

    def has(node: str) -> dict | None:
        value = s.get(node)
        if isinstance(value, dict) and "error" in value:
            proofs.prove(node, False, f"the probe step failed: {value['error']}")
            return None
        return value

    # n322 Closing in words is kept on that task's row and on no other.
    v = has("n322")
    if v:
        proofs.prove("n322", v["t1"] == "obsolete: the screen was removed" and v["t2"] is None, f"closed words of t1 {v['t1']!r}, of t2 {v['t2']!r}")
    # n326 The kind of work picks one of four queues; unnamed kinds write.
    v = has("n326")
    if v:
        proofs.prove("n326", v["lanes"] == ["write", "write", "check", "docs", "research"], f"lanes {v['lanes']}")
    # n328 Only a blocked or rejected task untouched for a day is a dead letter.
    v = has("n328")
    if v:
        proofs.prove("n328", v["dead"] == ["old-blocked", "old-rejected"], f"dead letters {v['dead']}")
    v = has("n333")
    if v:
        proofs.prove("n333", v["first"] is None and v["third"] == "p1" and v["twoOnly"] is None and v["ordered"] is None, f"pilot of p1 {v['first']}, p3 {v['third']}, two siblings {v['twoOnly']}, ordered {v['ordered']}")
    # n334 A paused run is held and its resume lets it go; another run is not held.
    v = has("n334")
    if v:
        proofs.prove("n334", v["before"] is False and v["held"] is True and v["other"] is False and v["after"] is False, f"before {v['before']}, paused {v['held']}, other run {v['other']}, resumed {v['after']}")
    # n335 Two tasks on the same declared files: a note that the later waits, not a refusal.
    v = has("n335")
    if v:
        proofs.prove("n335", "owns_overlap_open" not in v["errors"] and len(v["warnings"]) == 1 and "waits" in v["warnings"][0], f"errors {v['errors']}, warnings {v['warnings']}")
    # n336 A family the owner said no to is refused before a task or an attempt exists.
    v = has("n336")
    if v:
        proofs.prove("n336", v["code"] == "owner_said_no" and "not this quarter" in v["hint"] and v["tasks"] == 0 and v["attempts"] == 0, f"code {v['code']}, tasks {v['tasks']}, attempts {v['attempts']}, hint {v['hint'][:80]!r}")
    # n337 The design step is the row's stage; the PM waits for the drawing, and a drawing changes the key.
    v = has("n337")
    if v:
        proofs.prove("n337", v["stages"] == ["design", "execution", "verification"] and v["bare"] == {"stage": "design", "waitsForPm": True, "key": "design:none:-:-"} and v["drawn"] == {"stage": "design", "waitsForPm": True, "key": "design:S1:true:ui-review"},
                     f"bare {v['bare']}, drawn {v['drawn']}")
    # n338 Feasibility: a yes with a separate reviewer opens the gate; no answer or a contradiction holds it.
    v = has("n338")
    if v:
        proofs.prove("n338", v["yes"] == {"ok": True} and v["none"]["ok"] is False and any("no feasibility answer" in w for w in v["none"]["why"]) and v["no"]["ok"] is False and any("contradicts the plan: the plan has no table" in w for w in v["no"]["why"]),
                     f"yes {v['yes']}, none {v['none']}, contradiction {v['no']}")
    # n339 At execution Lane Pilot issues the pieces; a blocked piece is the PM's.
    v = has("n339")
    if v:
        proofs.prove("n339", v["run"] == {"stage": "execution", "waitsForPm": False, "key": "execution:running:2:1"} and v["stuck"] == {"waitsForPm": True, "key": "execution:blocked:b"}, f"running {v['run']}, blocked piece {v['stuck']}")
    # n340 At verification the cycle runs the checks; a failed verdict and a passed blind check are the PM's.
    v = has("n340")
    if v:
        proofs.prove("n340", v["running"] == {"waitsForPm": False, "key": "verification:running"} and v["failed"] == {"waitsForPm": True, "key": "verification:verdict-failed:IN1"} and v["passed"] == {"waitsForPm": True, "key": "verification:model"},
                     f"running {v['running']}, failed {v['failed']}, passed {v['passed']}")
    # n341 Nothing is held by default; the PM's hold lasts until its release, and another run's task is refused.
    v = has("n341")
    if v:
        proofs.prove("n341", v["fresh"] is None and v["hold"]["tasks"] == ["th1"] and v["hold"]["until"] == "released by hand" and v["hold"]["refused"] == [{"taskId": "tx", "why": "not a task of run run-h"}]
                     and v["during"] == [v["forever"], None] and v["release"]["tasks"] == ["th1"] and v["after"] is None, f"fresh {v['fresh']}, hold {v['hold']}, during {v['during']}, after release {v['after']}")
    # n342 No drawing is asked for while a blocking design question is open.
    v = has("n342")
    if v:
        proofs.prove("n342", v["asked"] == {"waitsForPm": True, "key": "design:questions:q1"} and v["answered"] == "design:none:-:-", f"open question {v['asked']}, answered {v['answered']}")
    # n343 A returned drawing keeps the person's remark against its edition, is archived and cleared; the phase stays at design.
    v = has("n343")
    if v:
        remark = v["feedback"][0] if v["feedback"] else {}
        proofs.prove("n343", v["stage"] == "design" and v["drawingLeft"] is None and v["archived"] == ["D"] and len(v["feedback"]) == 1 and remark.get("drawingSha") == "D" and remark.get("text") == "bigger buttons" and remark.get("by") == "owner",
                     f"stage {v['stage']}, drawing left {v['drawingLeft']}, archived {v['archived']}, feedback {v['feedback']}")
    # n344 The drawing step asks for the design-lead; no other automatic stage does.
    v = has("n344")
    if v:
        proofs.prove("n344", v["drawRole"] == "specialist:design-lead" and v["others"] == [], f"draw step role {v['drawRole']}, other stages naming it {v['others']}")
