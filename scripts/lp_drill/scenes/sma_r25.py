"""Region 25 · Receipts and evidence: the region scene of the SMA-parity proof (docs/sma-evidence.md, «Trace choice»).

Most nodes of this region read what the stages left and print or return a value; they write no hub row of their own, so the node-level trace is this scene. It runs the
REAL code of the commit under drill (forecast scoring and calibration, the receipt chain, preship, the PR pack, the planted defects, the grill, the wires on a real git
tree, reverify and revert on a scratch repository) on scratch databases and folders, with no model and no hub write, and prove()s each node with the result its card
expects. Nodes whose work leaves a hub row (the verification receipt hash, the blind critic's receipt, the baseline rows, the plan-fact receipts) are traced from those rows
in evidence/r25.ts instead. Run: scripts/lp-drill.sh --scenario sma_r25   (add --dry-run to list the nodes).
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = [f"n{n}" for n in (1681, 1682, 1683, 1685, 1686, 1687, 1688, 1690, 1692, 1693, 1694, 1695, 1696, 1697, 1698, 1699, 1700, 1701, 1702, 1703, 1704, 1705, 1707, 1709)]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r25_probe.ts"


def _sec(seen: dict, name: str) -> dict:
    """One probe section; a missing or errored one is {} so every node reading it fails with the section's error in its detail."""
    value = seen.get(name)
    return value if isinstance(value, dict) and "error" not in value else {}


def _why(seen: dict, name: str) -> str:
    value = seen.get(name)
    return f"section {name} did not run: {value.get('error') if isinstance(value, dict) else 'missing'}"


def scenario_sma_r25(tmp) -> dict:
    proofs = Proofs()
    # vite-node, not tsx: the probe loads rooms whose barrel files tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r25", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    def prove(node: str, name: str, check, detail) -> None:
        data = _sec(seen, name)
        if not data:
            proofs.prove(node, False, _why(seen, name))
            return
        try:
            ok = bool(check(data))
        except (KeyError, IndexError, TypeError):
            ok = False
        proofs.prove(node, ok, detail(data))

    # n1682 / n1696 Predict-score: the forecast scored by arithmetic: files error +3, first try missed, tokens x2.5, minutes not measured.
    prove("n1682", "predict", lambda d: d["score"]["files"] == {"forecast": 2, "fact": 5, "error": 3} and d["score"]["tokensRatio"] == 2.5 and d["score"]["minutesRatio"] is None,
          lambda d: f"files {d['score']['files']}, tokens x{d['score']['tokensRatio']}, minutes {d['score']['minutesRatio']}")
    prove("n1696", "predict", lambda d: d["score"]["firstTry"] == {"forecast": True, "fact": False, "hit": False} and d["footprint"]["firstTry"]["hit"] is True,
          lambda d: f"first try {d['score']['firstTry']}, and a right forecast {d['footprint']['firstTry']}")
    # n1703 Footprint: lines, dependencies and paths of the header against the merge: +50 lines, lodash undeclared, c.ts unplanned.
    prove("n1703", "predict", lambda d: d["footprint"]["lines"] == {"forecast": 40, "fact": 90, "error": 50} and d["footprint"]["dependencies"] == {"undeclared": ["lodash"], "notAdded": []} and d["footprint"]["paths"] == {"unplanned": ["c.ts"], "untouched": []},
          lambda d: f"lines {d['footprint']['lines']}, dependencies {d['footprint']['dependencies']}, paths {d['footprint']['paths']}")
    # n1683 / n1697 Calibration: summed per area, the weak area first and visible, nothing scored is null.
    prove("n1683", "calibration", lambda d: d["byArea"][0] == {"area": "billing", "tasks": 2, "filesMae": 3, "firstTryHit": 0} and d["empty"] == {"overall": None, "byArea": []},
          lambda d: f"by area {d['byArea']}, empty {d['empty']}")
    prove("n1697", "calibration", lambda d: [row["area"] for row in d["byArea"]] == ["billing", "docs"] and d["overall"] == 3,
          lambda d: f"areas in order {[row['area'] for row in d['byArea']]} over {d['overall']} scored tasks")
    # n1701 Model version: a model reads only its own priors; for the fresh one the headline hides; dispatch stamps the run's model over a PM-sent one.
    prove("n1701", "calibration", lambda d: d["modelA"] == 5 and d["modelB"] == 1 and d["lineB"] is None and "5 tasks" in d["lineA"] and d["stamped"] == "claude/opus",
          lambda d: f"model a {d['modelA']} tasks, model b {d['modelB']}, headline for b {d['lineB']}, stamped {d['stamped']}")
    # n1687 Passport: the badge of the CURRENT model, reset when the model changes, and worse after a miss ten files off.
    prove("n1687", "passport", lambda d: d["forB"] == {"model": "codex/gpt-b", "tasks": 1, "badge": "unrated"} and d["forA"] == {"tasks": 4, "badge": "calibrated"} and d["worse"] == "miscalibrated",
          lambda d: f"model b {d['forB']}, model a {d['forA']}, after a miss {d['worse']}")
    # n1700 Passport badge: a pure function of the scores: unrated under three tasks, calibrated at MAE 2, miscalibrated past it.
    prove("n1700", "passport", lambda d: d["badges"] == {"none": "unrated", "two": "unrated", "three": "calibrated", "mae2": "calibrated", "mae3": "miscalibrated"},
          lambda d: f"badges {d['badges']}")
    # n1686 Skeptic: the critic's countersign scored on the same fact (MAE 2) beside the PM's (3.5), named only where it was right against the PM.
    prove("n1686", "skeptic", lambda d: d["skeptic"] == 2 and d["pm"] == 3.5 and d["rightAgainstPm"] == ["t_sk"],
          lambda d: f"skeptic MAE {d['skeptic']}, PM MAE {d['pm']}, right against the PM on {d['rightAgainstPm']}")
    # n1692 Chain: the same receipts give the same tip; a forged output hash moves it and the old tip no longer verifies.
    prove("n1692", "chain", lambda d: d["same"] and d["moved"] and d["oldVerifies"] is False and d["newVerifies"] and d["links"] == 1,
          lambda d: f"tip verifies {d['same']}, forged: tip moved {d['moved']}, old tip verifies {d['oldVerifies']}")
    # n1695 Preship: a running task stops a clear ship; a deferral the founder keeps does not.
    prove("n1695", "preship", lambda d: d["open"] == {"clear": False, "items": ["task t1 is running"]} and d["kept"] == {"clear": True, "items": ["keep with its term"]},
          lambda d: f"open task {d['open']}, kept deferral {d['kept']}")
    # n1704 Consequences: a checker that missed the defect class it exists to catch stops the ship, naming both.
    prove("n1704", "preship", lambda d: d["missed"]["clear"] is False and "ownership missed planted outside_owns it is designed to catch" in d["missed"]["items"],
          lambda d: f"after a missed planted defect: clear {d['missed']['clear']}, items {d['missed']['items']}")
    # n1705 PR pack: acceptance, checks, the check's receipt with its output hash, the blind check's verdicts, the stages and the chain tip.
    want = ["### Acceptance", "- item one works", "- item two works", "### Checks", "- `npm test`", "### Receipts", "- `npm test`: exit 1 (abc123def456)", "### Blind check",
            "- item 1: proven — item one works", "- item 2: unproven — item two works", "### Stages", "- verification: failed"]
    prove("n1705", "pack", lambda d: all(line in d["lines"] for line in want) and d["tipLine"], lambda d: f"pack lines {d['lines']}")
    # n1693 Receipt coverage: 2 of 3 attempts checked, one phantom named, median packet 2000 bytes.
    prove("n1693", "pack", lambda d: d["coverage"] == {"checked": 2, "skipped": 1, "share": 0.67} and d["phantoms"] == [{"taskId": "t2", "evidence": "src/gone.ts", "code": "file_not_in_diff"}] and d["median"] == 2000,
          lambda d: f"coverage {d['coverage']}, phantoms {d['phantoms']}, median pack {d['median']}")
    # n1685 / n1698 Canary: planted defects are real edits (the boundary changed to <=), caught by the verification checker, and no planted mark is in the diff.
    prove("n1685", "canary", lambda d: d["offAfter"] == "if (i <= n) return i;\n" and d["expected"] == ["verification"],
          lambda d: f"off-by-one planted as {d['offAfter']!r}, expected catchers {d['expected']}")
    prove("n1698", "canary", lambda d: d["marked"] is False and d["classes"] == ["outside_owns", "masked_check", "acceptance_missing", "broken_import"],
          lambda d: f"classes planted {d['classes']}, the word «planted» in the diff the critic reads: {d['marked']}")
    # n1699 Goodhart: an edit or removal of a reference test is on the trail, a new test is not; a near miss rides the plan-fact block.
    prove("n1699", "goodhart", lambda d: d["edits"] == ["tests/a.test.ts", "tests/b.test.ts"] and d["nearMisses"] == ["almost dropped the migration"],
          lambda d: f"reference test edits {d['edits']}, near misses {d['nearMisses']}")
    # n1688 Grill: an open challenge of THIS plan blocks the build; another plan, the switch off or the owner's word lifts it.
    prove("n1688", "grill", lambda d: d["blocked"] == {"run": "g1", "open": ["the migration is not reversible", "no owner for the queue"]} and d["otherPlan"] is None and d["switchedOff"] is None and d["lifted"] is None,
          lambda d: f"open grill {d['blocked']}, another plan {d['otherPlan']}, switched off {d['switchedOff']}, owner's yes {d['lifted']}")
    # n1702 Grill lib: a dispute needs evidence, a fix needs evidence, a repeated finding stays open, a block gets no repair round.
    prove("n1702", "grill", lambda d: d["disputeWithEvidence"] and not d["disputeEmpty"] and not d["fixedNoEvidence"] and d["repeated"] and not d["changed"] and not d["nothingLeft"] and d["repairOnRework"] and not d["repairOnBlock"],
          lambda d: f"dispute with evidence {d['disputeWithEvidence']}, empty {d['disputeEmpty']}, silence {d['nothingLeft']}, repetition {d['repeated']}, repair on rework {d['repairOnRework']} / block {d['repairOnBlock']}")
    # n1690 / n1707 Wires: on a real tree the wire is met where one source file names both ends, a test does not count, a hop with no line is not a pass.
    prove("n1690", "wires", lambda d: d["exit"] == 0 and d["hops"] == ["src/theme.ts", "src/provider.ts"] and d["metBroken"] is None and d["goneBroken"] == {"from": "loadSettings", "to": "GhostConsumer", "file": None},
          lambda d: f"hops {d['hops']}, the wire only a test names: {d['goneBroken']}")
    prove("n1707", "wires", lambda d: d["parsed"] == {"from": "loadSettings", "to": "ThemeProvider", "file": None}, lambda d: f"output with one hop missing: broken at {d['parsed']}")
    # n1681 Reverify: the checks run on the accepted commit, not on whatever main is now (main no longer has the text), with a receipt.
    prove("n1681", "rollback", lambda d: d["reverify"]["ok"] and d["reverify"]["state"] == "passed" and d["reverify"]["summary"].startswith("1/1 checks of t1 pass on ") and d["tree"] == "line1\nline2\nline3\n",
          lambda d: f"reverify {d['reverify']['summary']!r} while main reads {d['tree']!r}")
    # n1694 Rollbacks: one revert puts the tree back, and the next check names that rollback (revertedIn is the revert's commit).
    prove("n1694", "rollback", lambda d: d["reverted"]["ok"] and d["reverted"]["state"] == "merged" and d["reverted"]["files"] == 1 and d["tree"] == "line1\nline2\nline3\n" and d["revertedIn"],
          lambda d: f"revert {d['reverted']}, tree {d['tree']!r}, the later check names the revert {d['revertedIn']}")
    # n1709 Rollback mark: the cause a person stated is what the status names; without one it says «cause unknown»; skipping the gate needs a stated cause.
    prove("n1709", "rollback", lambda d: d["before"] is None and d["after"] == {"cause": "broke checkout", "hasCommit": True} and d["silentRefused"] == "refused" and "--why" in d["refusedSummary"] and _sec(seen, "mark").get("silent", {}).get("cause") == "rolled back, cause unknown",
          lambda d: f"before {d['before']}, after a revert with --why {d['after']}, no cause: {_sec(seen, 'mark').get('silent')}, gate skipped without why: {d['refusedSummary']!r}")
    return proofs.verdict("sma_r25", checked=len(NODES))
