"""Region 1 · Task graph, batch a: the nodes proved by the region scene sma_r01 (docs/sma-evidence.md, «Trace choice»).

These nodes leave no row the hub could show (a pure check, a refused start, a question to the PM). Two real runs of THIS checkout feed prove_a(), on scratch values
and scratch databases (no model, no hub write): the probe (sma_r01_a_probe.ts) runs the pure checks; the behaviour tests of the harness-bound nodes
(tests/sma/four-proofs-r01-a2/a3/a4) run with SMA_R01A_OBSERVED set and write what they saw, per node, as JSON. prove_a() compares each value with what the node's card expects.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_A = ["n161", "n162", "n165", "n166", "n168", "n170", "n174", "n176", "n178", "n181", "n184", "n186", "n187", "n188", "n189"]
PROBE_A = ROOT / "scripts/lp_drill/scenes/sma_r01_a_probe.ts"
OBSERVING_TESTS = ["tests/sma/four-proofs-r01-a2.test.ts", "tests/sma/four-proofs-r01-a3.test.ts", "tests/sma/four-proofs-r01-a4.test.ts"]
SEEN_REASON = "merge failed: your local changes would be overwritten by merge in src/a.ts"


def _observed(tmp: Path) -> dict:
    folder = tmp / "sma-r01-a-observed"
    folder.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "SMA_R01A_OBSERVED": str(folder)}
    subprocess.run(["npx", "vitest", "run", "--maxWorkers=3", *OBSERVING_TESTS], cwd=ROOT, capture_output=True, text=True, timeout=900, env=env)
    seen = {}
    for path in folder.glob("n*.json"):
        try:
            seen[path.stem] = json.loads(path.read_text())
        except ValueError:
            pass
    return seen


def prove_a(proofs: Proofs, tmp: Path) -> None:
    done = subprocess.run(["npx", "tsx", str(PROBE_A)], cwd=ROOT, capture_output=True, text=True, timeout=300)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        s = {}
    o = _observed(tmp)

    def check(node: str, source: dict, ok) -> None:
        value = source.get(node)
        try:
            good = value is not None and bool(ok(value))
        except (KeyError, TypeError, IndexError):
            good = False
        proofs.prove(node, good, f"observed {json.dumps(value, ensure_ascii=False)[:400] if value is not None else 'nothing (the probe or its test did not run)'}")

    # n161 Permit: contract priced and the reserve fits passes; no price, or past the reserve, is refused; no run budget holds nothing.
    check("n161", s, lambda v: v["noBudgetNoPrice"] is None and v["priced"] is None and v["fits700"] is None and v["unpriced"].startswith("permit_refused:price_unknown")
          and v["over701"].startswith("permit_refused:reserve") and "keeps 700 tokens" in v["over701"])
    # n162 Reserve: an unknown budget is not a zero reserve; a known one is free less spent less the open appetites, and 31 past 30 is refused.
    check("n162", s, lambda v: v["unknownBudget"] == {"ok": True, "free": None} and v["fits"]["ok"] is True and v["fits"]["free"] == 30 and v["refused"]["ok"] is False and v["refused"]["free"] == 30)
    # n165 Stage budget question: nothing at 7 of 10 minutes, one question to the PM at 80%.
    check("n165", o, lambda v: v["askedAt7min"] == 0 and v["askedAt9min"] == 1 and v["to"] == "thr_pm" and "spent 80% of its appetite (8/10 min)" in v["text"])
    # n166 Pocket ran out: the next attempt is not started, blocked with the budget reason, one owner question with raise and finish.
    check("n166", o, lambda v: v["spawned"] == ["T1-a1"] and v["lastState"] == "blocked" and v["lastReason"] == "run_budget_exceeded:tokens" and v["what"].startswith("Лимит прогона исчерпан") and v["actions"] == ["raise", "finish"])
    # n168 Red baseline: stopped while the owner has not answered, starts after his yes.
    check("n168", o, lambda v: re.match(r"^verdict_block: red_outside_task: ", v["stop"] or "") is not None and v["afterYes"] is None)
    # n170 Permit channel: the worker lists its unanswered, unexpired tickets with category, command and folder; an answered one is gone.
    check("n170", o, lambda v: v["listed"] == [["0011223344556677", "sql", "DROP TABLE x", "/w"], ["a1b2c3d4e5f60718", "delete", "rm -rf build", "/w"]] and v["afterAnswer"] == ["0011223344556677"])
    # n174 Awaits a person: a writer's question ends the attempt blocked, the question is its reason.
    check("n174", o, lambda v: v["status"] == "blocked" and v["attemptState"] == "blocked" and v["reason"] == "needs_human: which locale should the totals use?")
    # n176 Auto retry: the pause of a class doubles with each repeat (infra: a minute, then two, four) and stays under the cap; a provider fault has no pause.
    check("n176", s, lambda v: v["infra"] == [60000, 120000, 240000] and v["merge"] == [30000, 60000, 120000] and v["capped"] == 90000 and v["provider"] == 0)
    # n178 Parked: a dirty base checkout stands as one blocked attempt with its reason, no second attempt is spawned.
    check("n178", o, lambda v: v["attempts"] == [[1, "blocked", SEEN_REASON]] and v["spawned"] == ["T1-a1"])
    # n181 Bring back: the copy's change lands in main as one commit the result names, a clash leaves main as it was.
    check("n181", o, lambda v: v["firstStatus"] == "merged" and v["namesHead"] is True and v["mainLib"] == "export const x = 1;\n" and v["clash"] == "conflict" and v["clashCommit"] is None and v["mainClean"] == "")
    # n184 Infrastructure stops: a vendor abort, a context overflow, a background tail and the turn ceiling are the provider's and free; a red check is the task's.
    check("n184", s, lambda v: all(v[k] == {"cls": "provider", "confident": True} for k in ("vendorAbort", "contextOverflow", "backgroundTail", "turnCeiling")) and v["free"]["provider"] is True and v["taskRed"] == "task")
    # n186 Host commit: the machine commits the worker's uncommitted edit and new file under the task's message, nothing is left uncommitted, then it merges.
    check("n186", o, lambda v: v["status"] == "merged" and v["leftUncommitted"] == "" and v["message"] == "t1: the task title\n\nLane-Pilot-Attempt: a1" and v["files"] == ["fresh.ts", "server.ts"])
    # n187 Design gate: no drawing decision fails, not needed passes, the designer's own review fails (a separate role passes), an infeasible drawing fails.
    check("n187", s, lambda v: v["none"] is False and v["notNeeded"] is True and v["sameRole"][0] is False and any("separate role" in line for line in v["sameRole"][1]) and v["separate"] is True and v["infeasible"] is False)
    # n188 Parked question: the stage skips the accept gate and keeps the question as a file (QA.md) with its answer open.
    check("n188", o, lambda v: v["acceptGate"] == [{"status": "skipped"}] and v["file"] == "QA.md" and v["question"] is True and v["answerOpen"] is True)
    # n189 Docs gate: the edit of the selected page with its hash is taken; a wrong hash, another page or a path outside docs/ and apps/ is refused.
    check("n189", s, lambda v: v["ok"] == 1 and "hash" in v["wrongHash"] and "outside" in v["otherPage"] and "docs/ or apps/" in v["notDocs"])
