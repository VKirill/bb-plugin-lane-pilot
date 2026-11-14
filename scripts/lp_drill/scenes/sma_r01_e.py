"""Region 1 · Task graph, batch e: the task's landing, its birth gates, its words and the states of its row (n288..n319), proved by the region scene sma_r01 (docs/sma-evidence.md, «Trace choice»).

These nodes write no row of a hub table that a trace could read (an acceptance line, a gate finding, a refusal, a state-machine row). The probe runs the REAL code of the commit under drill on scratch
repositories and scratch databases (no model, no hub write) and prove_e() compares each result with what the node's card expects; the same observations are asserted by tests/sma/four-proofs-r01-e*.test.ts.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_E = ["n288", "n289", "n290", "n291", "n292", "n293", "n295", "n296", "n297", "n298", "n299", "n300", "n301", "n302", "n303", "n304", "n305", "n307", "n308", "n309", "n310", "n311", "n312",
           "n313", "n314", "n315", "n316", "n317", "n318", "n319"]
PROBE_E = ROOT / "scripts/lp_drill/scenes/sma_r01_e_probe.ts"


def prove_e(proofs: Proofs, tmp: Path) -> None:
    done = subprocess.run(["npx", "tsx", str(PROBE_E)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_E:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return
    if "fatal" in s:
        for node in NODES_E:
            proofs.prove(node, False, f"the probe failed: {s['fatal']}")
        return

    def has(node: str):
        value = s.get(node)
        if isinstance(value, dict) and "error" in value:
            proofs.prove(node, False, f"the probe step failed: {value['error']}")
            return None
        return value

    def eq(node: str, want) -> None:
        v = has(node)
        if v is not None:
            proofs.prove(node, v == want, f"observed {json.dumps(v, ensure_ascii=False)[:420]}")

    # n288 «Useful» and «limits acknowledged»: each needs the person's own yes, under the key of this package.
    eq("n288", {"none": [False, False], "yes": [True, True], "onlyUseful": [True, False], "otherPackage": False, "notAsked": True})
    # n289 An owed verification that did not run or refused leaves the composition line red.
    eq("n289", {"none": [False, "no blind verdict yet"], "failed": [False, "blind check red: 2 failed"], "passed": [True, "blind check green"]})
    # n290 A lost race names the holder; the work stays committed, main is untouched.
    v = has("n290")
    if v:
        proofs.prove("n290", v["status"] == "busy" and v["holder"] == "writer-a: Fix the form" and v["reason"] == "another writer integration holds the base checkout: writer-a: Fix the form" and v["mainKept"] and v["committed"],
                     f"merge answered {v['status']}, holder {v['holder']!r}, main kept {v['mainKept']}, work committed {v['committed']}")
    # n291 The tree that was verified is the tree that lands.
    eq("n291", {"refused": ["failed", True, True, False], "landed": ["merged", "verified\n", True]})
    # n292 The work file is closed and re-read before «accepted».
    eq("n292", {"intact": True, "behind": False, "tampered": False, "neverWritten": False})
    # n293 Work without an owed verification (verify none) needs no check command; any other does.
    eq("n293", {"none": False, "tests": True, "testsWithCheck": False})
    # n295 Memory harvest: an accepted task starts the after-acceptance run; nothing else does.
    eq("n295", {"name": "workflow:after-accept", "started": [["proj", "run", "t-task-accepted", "pm"]]})
    # n296 A landing whose reply was lost is accepted after restart, once, with a receipt.
    v = has("n296")
    if v:
        proofs.prove("n296", v["merged"] == "merged" and v["before"] == "running" and v["first"] == ["T1"] and v["after"] == "accepted" and v["gate"] == [{"gate": "accept", "status": "passed"}]
                     and v["stages"] == ["passed", "passed", "passed"] and v["intentLeft"] is False and v["second"] == [] and v["maintained"] == ["T1"],
                     f"merged {v['merged']}, attempt {v['before']} -> {v['after']}, recovered {v['first']}, gate {v['gate']}, stages {v['stages']}, second pass {v['second']}")
    # n297 After a return a new tree replaces the old and revokes consent.
    v = has("n297")
    if v:
        proofs.prove("n297", v["same"] is None and isinstance(v["other"], str) and v["other"].startswith("owner_word: the owner's yes was given for another candidate of this task (attempt att-A)") and v["noCandidate"] is None and v["off"] is None,
                     f"same candidate {v['same']}, other candidate {v['other']!r}")
    # n298 A different hash is presented: the decision is taken anew.
    eq("n298", {"keyChanges": [True, True], "same": True, "replanned": [False, True], "newTree": False})
    # n299 The birth kind decides the gates.
    eq("n299", {"pm": [[], ["promise_missing"]], "phase": [["promise_missing"], []], "bench": {"errors": [], "warnings": []}, "loops": [True, False, False, False], "redoPromise": "warn"})
    # n300 Enqueue gate: nothing dispatched, each finding classed, an unknown field is not the schema.
    v = has("n300")
    if v:
        proofs.prove("n300", v["state"] == "validation_failed" and v["runId"] == "run-1" and v["nothing"] is True and v["classes"] == ["missing_info"]
                     and v["findings"] == [{"code": "clarify_open", "message": "the task has open clarification questions: Which currency?", "blockingClass": "missing_info"}] and v["closed"] == [True, False],
                     f"state {v['state']}, classes {v['classes']}, closed field set (known, unknown field) {v['closed']}")
    # n301 Every word change mints a numbered, hashed edition; history is kept.
    eq("n301", {"editions": [1, 2, 3], "distinct": 3, "first": {"title": "v1"}})
    # n302 Promise: Given, When, Then.
    eq("n302", {"incomplete": ["promise_incomplete"], "missing": ["promise_missing"], "whole": [[], []]})
    # n303 Clarify gate is «needed»: the row is not issued.
    v = has("n303")
    if v:
        proofs.prove("n303", v["open"][0] == ["clarify_open"] and v["open"][1].startswith("the task has open clarification questions: Which currency? — answer them") and v["answered"] == [[], []],
                     f"open question {v['open'][0]}, answered {v['answered']}")
    # n304 The person said «yes, that is it»: only the owner's answer settles a clarification when owner.words is on.
    eq("n304", {"pm": [["clarify_needs_owner"], True], "owner": [], "off": []})
    # n305 Nothing to clarify: no finding; a bench arm needs no promise.
    eq("n305", {"none": [[], []], "blank": [[], []], "bench": [[], []]})
    # n307 Is the check command runnable: judged by its program.
    eq("n307", {"program": ["npm", None, "make"], "missing": ["check_not_runnable"], "present": [], "shell": [], "pathed": []})
    # n308 Is a drawing needed: view, risk and a named drawing decide.
    eq("n308", {"medium": True, "low": False, "named": False, "logic": False, "phasePiece": False})
    # n309 The task drawing gate is «needed».
    v = has("n309")
    if v:
        proofs.prove("n309", v["screens"] == ["needed", "pieces that change screens: p1", "screens"] and v["asked"] == ["needed", "the PM asked for a drawing"] and v["held"][0] is False and "no drawing" in json.dumps(v["held"][1]),
                     f"screens {v['screens']}, asked {v['asked']}, gate without a drawing {v['held']}")
    # n310 The person confirmed a drawing of the same hash.
    eq("n310", {"same": True, "redrawn": False, "noWord": False})
    # n311 «Not needed» is a written word; silence is not a decision.
    v = has("n311")
    if v:
        proofs.prove("n311", v["silent"][0] is False and "the design decision is not made" in json.dumps(v["silent"][1]) and v["written"] is True and v["decided"] == ["not_needed", "no piece changes a screen"],
                     f"no word {v['silent']}, written word opens the gate {v['written']}, decision {v['decided']}")
    # n312 Words change while the row runs; finished work is not rewritten.
    eq("n312", {"running": {"ok": True, "state": "running", "steered": 1, "editions": 2}, "finished": {"ok": False, "code": "task_finished", "editions": 2}})
    # n313 A word change mints an edition and sends the checks again from pm-read.
    v = has("n313")
    if v:
        proofs.prove("n313", v["started"] == "waiting" and v["ok"] is True and v["state"] == "queued" and v["title"] == "Updated title" and v["outputs"] == ["out-updated.txt"] and v["dependsKept"] == ["dep-1"]
                     and v["plan"] == "New canonical plan for task" and v["critique"] is True and v["reruns"] == [True] and v["waiting"] == "waiting" and v["editions"] == [1, 2],
                     f"update {v['ok']} -> {v['state']}, editions {v['editions']}, reruns from pm-read {v['reruns']}, run {v['waiting']}")
    # n314 A hold without a date sits at year 2999; a dated one keeps its date; another run's task is refused.
    v = has("n314")
    if v:
        proofs.prove("n314", v["fresh"] is None and v["forever"] and v["foreverInFuture"] and v["reply"] == [["t1"], [{"taskId": "other", "why": "not a task of run run1"}], "released by hand"] and v["dated"] == [["t2"], True],
                     f"fresh {v['fresh']}, forever {v['forever']}, reply {v['reply']}, dated {v['dated']}")
    # n315 Queued: a new attempt, and every retry, waits in queued.
    eq("n315", {"created": "queued", "formed": "queued", "retried": ["queued"] * 5, "exhausted": "blocked", "open": True, "states": "queued"})
    # n316 Held: visible on the board, reachable by no worker until released.
    eq("n316", {"before": [False, False], "held": [True, False], "released": [["t1"], None, None], "after": [False, False]})
    # n317 Claimed: a loop that is gone loses its hold, a live one keeps it.
    eq("n317", {"resumed": ["attA"]})
    # n318 Awaiting a person: the verified task waits for the owner's word.
    v = has("n318")
    if v:
        proofs.prove("n318", v["waits"] == [True, True] and v["yes"] is None and v["no"] == "owner_word: the owner said no to this task — не сливать" and v["notAsked"] is None,
                     f"waits {v['waits']}, after yes {v['yes']}, after no {v['no']!r}")
    # n319 Completed: a yes and passed checks accept the attempt, which is an end.
    v = has("n319")
    if v:
        proofs.prove("n319", v["gap"] is None and v["accepted"] == "accepted" and v["open"] is False and v["failed"] is False and v["retry"] == "retry is not legal from accepted",
                     f"landing gap {v['gap']}, next state {v['accepted']}, open {v['open']}, failed {v['failed']}, retry: {v['retry']}")
