"""Region 1 · Task graph, batch d: the verification barrier, the attempt automaton, the landing word and the phase's acceptance proved by the region scene sma_r01 (docs/sma-evidence.md, «Trace choice»).

These nodes write no row of a hub table that a trace could read for them (a schema, a rule table, a pure check, a copy that merged). The probe runs the REAL code of
the commit under drill on scratch repositories and scratch databases (no model, no hub write), and prove_d() compares each result with what the node's card expects.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_D = ["n256", "n257", "n258", "n263", "n265", "n272", "n279", "n280", "n281", "n282", "n283", "n284", "n285", "n286", "n287"]
PROBE_D = ROOT / "scripts/lp_drill/scenes/sma_r01_d_probe.ts"


def prove_d(proofs: Proofs, tmp: Path) -> None:
    # vite-node, not tsx: the probe loads the plugin entry (the dispatch node), whose import cycles tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_D)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_D:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return
    if "fatal" in s:
        for node in NODES_D:
            proofs.prove(node, False, f"the probe failed: {s['fatal']}")
        return

    def has(node: str) -> dict | None:
        value = s.get(node)
        if isinstance(value, dict) and "error" in value:
            proofs.prove(node, False, f"the probe step failed: {value['error']}")
            return None
        return value

    # n256 The contract a verdict is read against is the confirmed edition: a worker's own key, a missing acceptance or output, a foreign verify word are refused.
    v = has("n256")
    if v:
        proofs.prove("n256", v == {"confirmed": True, "workerKey": False, "noAcceptance": False, "noOutputs": False, "badVerify": False, "relativeCwd": False}, f"schema accepts the confirmed contract and refuses the rest: {v}")
    # n257 The code critic of the writer's own model moves to the other vendor when the host has it; with none on offer the same pair is kept.
    v = has("n257")
    if v:
        proofs.prove("n257", v["moved"] == {"pair": v["sol"], "changed": True} and v["onlyOwn"] == {"pair": v["opus"], "changed": False} and v["otherWriter"] == {"pair": v["opus"], "changed": False}
                     and v["noWriter"] == {"pair": v["opus"], "changed": False}, f"same-model critic moved to {v['moved']}; only own on offer {v['onlyOwn']}")
    # n258 The worker's copy is merged with main; the merge names the commit, what main was and what changed; a clash leaves main as it was.
    v = has("n258")
    if v:
        proofs.prove("n258", v["made"] == {"status": "ready", "branch": "lane/lpattempt_d1"}
                     and v["merged"] == {"status": "merged", "commit": v["head"], "base": v["moved"], "changed": [{"status": "A", "path": "c.txt"}], "rebased": True, "worktreeRemoved": True}
                     and v["hasCandidateFile"] and v["hasMainFile"] and v["gone"] and v["refused"] == {"status": "conflict", "conflicts": ["c.txt"], "commit": None} and v["mainAfterClash"] == v["before"],
                     f"merge {v['merged']}; a clash gave {v['refused']} and main stayed on {v['mainAfterClash'] == v['before']}")
    # n263 What the barrier judged is archived per attempt: diff, promise, contract, the previous verdict and the receipt hash; a patch over the cap is cut and says so.
    v = has("n263")
    if v:
        b = v["body"]
        proofs.prove("n263", b["stage"] == "code-critique" and b["state"] == "blocked" and b["inputSha256"] == v["receiptSha"] == v["sourceSha"] and b["diff"] == {"src/a.ts": "+x"}
                     and b["promise"] == {"given": "g", "when": "w", "then": "t"} and b["contract"]["id"] == "t-barrier" and b["priorVerdict"] == {"status": "changes_requested"}
                     and v["longDiffTail"].endswith("[cut: 50 chars]") and v["longDiffLen"] == 200016,
                     f"archived input keys {sorted(b)}, receipt hash kept {b['inputSha256'] == v['receiptSha']}, long diff cut to {v['longDiffLen']} chars")
    # n265 The verdict has its form: promise, correctness, regression, tests, out of scope, floor and class, all optional; evidence is not.
    v = has("n265")
    if v:
        proofs.prove("n265", v["kept"] == {"promise": "the promise", "correctness": "green", "regression": "none", "tests": "vitest run", "out_of_scope": "docs", "floor": "opens", "class": "minor"}
                     and v["plainKeys"] == [] and v["noEvidence"] is False, f"form kept {v['kept']}, a verdict without it carries {v['plainKeys']}, without evidence parses {v['noEvidence']}")
    # n272 The same failure on other ids is the same answer: the second one stops the task as a repeat; another fault, a question and a budget stop do not.
    v = has("n272")
    if v:
        proofs.prove("n272", v["fpA"] == v["fpB"] and v["fpA"] != v["fpOther"] and isinstance(v["repeated"], str) and v["repeated"].startswith("repeated_failure: ")
                     and v["different"] is None and v["first"] is None and v["question"] is None and v["budget"] is None,
                     f"fingerprints {v['fpA']!r} / {v['fpB']!r} / {v['fpOther']!r}; repeat {v['repeated']!r}; other fault {v['different']}")
    # n279 Acceptance needs one stage decided by code: a model's opinion alone never accepts, and the refusal says which case it is.
    v = has("n279")
    if v:
        proofs.prove("n279", v["opinion"] == "acceptance_without_code_proof: only advisory stages passed (plan-critique, code-critique); a model's opinion cannot accept a task on its own"
                     and v["none"] == "acceptance_without_code_proof: no stage passed" and v["code"] is None and v["mixed"] is None, f"opinion only: {v['opinion']}; none: {v['none']}; code stage: {v['code']}")
    # n280 A writer's launch line is refused push, merge, tag and release itself; a critic's carries only the helper list and a PM's none.
    v = has("n280")
    if v:
        proofs.prove("n280", v["writer"] == "Workflow,ScheduleWakeup,AskUserQuestion,Agent,Bash(git push:*),Bash(git merge:*),Bash(git tag:*),Bash(gh release:*)"
                     and v["critic"] == "Workflow,ScheduleWakeup,AskUserQuestion,Agent" and v["pm"] is None, f"writer denies {v['writer']}; critic {v['critic']}; PM {v['pm']}")
    # n281 The same dispatch delivered again is recognised as the task already there: no second task, no second attempt; a changed plan is new work.
    v = has("n281")
    if v:
        proofs.prove("n281", v["first"] == {"taskId": "suite-green", "state": "queued", "dedup": None} and v["again"] == {"taskId": "suite-green", "sameAttempt": True, "state": "queued", "dedup": True}
                     and v["tasks"] == 1 and v["attempts"] == 1 and v["otherPlanDedup"] is None, f"second delivery {v['again']}, tasks {v['tasks']}, attempts {v['attempts']}, other plan dedup {v['otherPlanDedup']}")
    # n282 With the checks passed and only the person's decisions left the phase is prepared and waits for his keyed decision on that package; a red machine line is not.
    v = has("n282")
    if v:
        proofs.prove("n282", v["ready"]["waitsForPm"] is True and v["ready"]["prepared"] is True and re.fullmatch(r"[0-9a-f]{16}", v["ready"]["key"] or "") is not None
                     and v["notReady"]["prepared"] is False, f"ready {v['ready']}, red machine line prepared {v['notReady']['prepared']}")
    # n283 The owner's yes binds this very candidate: no word, a no and a yes for another candidate hold the landing; the latest word wins.
    v = has("n283")
    if v:
        proofs.prove("n283", v["off"] is None and isinstance(v["none"], str) and v["none"].startswith("owner_word: owner.words is on — the task is verified and waits for the owner's word") and v["yes"] is None
                     and v["no"] == "owner_word: the owner said no to this task — не сливать"
                     and v["other"] == "owner_word: the owner's yes was given for another candidate of this task (attempt att-0); ask him for the word on this one" and v["latestWins"] is None,
                     f"no word: {v['none'][:60]!r}; no: {v['no']!r}; yes: {v['yes']}; other candidate: {v['other'][:60]!r}")
    # n284 Work that landed in main moves the attempt to accepted from every state that ended without it; accepted never moves back.
    v = has("n284")
    if v:
        proofs.prove("n284", v["landed"] == {k: "accepted" for k in ["cancel_requested", "blocked", "provider_error", "timeout", "empty_output", "validation_failed"]} and v["mainfix"] is True
                     and v["backToRunning"] is False and v["backToQueued"] is False, f"landed {v['landed']}, mainfix {v['mainfix']}")
    # n285 The phase is closed only after its closing documents read back as written; an unfaithful read-back keeps it open and tells the PM once.
    v = has("n285")
    if v:
        proofs.prove("n285", v == {"heldState": "active", "heldClosedDocs": None, "heldNotices": 1, "sameDayNotices": 1, "closedState": "closed", "closedDocs": True}, f"close read-back: {v}")
    # n286 A piece not accepted keeps the landing line red; the person's two decisions are lines of their own and stay red until he decides.
    v = has("n286")
    if v:
        proofs.prove("n286", v["open"] == {"landed": False, "useful": True, "limits": True} and v["landed"] == {"landed": True, "useful": False, "limits": False}
                     and sorted(v["ids"]) == ["limits_acknowledged", "result_useful"], f"piece running {v['open']}, piece landed {v['landed']}, decision lines {v['ids']}")
    # n287 The package shows the key the person decides on and the frozen verdict; the card says which stages were decided by code and which by opinion.
    v = has("n287")
    if v:
        proofs.prove("n287", v["verdict"] == {"state": "passed", "detail": "all proved", "mainSha": "head9"} and v["keyHex"] and v["keyIsShown"]
                     and v["proofs"] == {"verification": "passed:code", "code-critique": "passed:advisory"} and v["awaitsWord"] is True and "plan-critique" in v["notRun"] and "verification" not in v["notRun"]
                     and v["risk"] == "low" and v["objective"] == "do it", f"verdict {v['verdict']}, proofs {v['proofs']}, awaits word {v['awaitsWord']}, not run {v['notRun']}")
