"""Region 21 · sma-tools: project queries — the region scene (docs/sma-evidence.md, «Trace choice»).

The query tools of this region read the project's state and write nothing to the hub database, so the node-level trace is this scene: it runs the
REAL verbs and functions of the commit under drill (`bb lane-pilot phase state|roadmap|validate|uat|show|list`, `frontmatter`, `capabilities`,
the settings save, the code-facts probe, the docs commit …) on a scratch database, a fixture planning folder and a scratch git repo, with no model
and no hub write, and prove()s each node with the result its card expects. The run card's counter (n1583) is a screen: its own test file is run.
Run: scripts/lp-drill.sh --scenario sma_r21.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1560", "n1561", "n1563", "n1564", "n1565", "n1566", "n1567", "n1568", "n1569", "n1570", "n1571", "n1572", "n1573", "n1574", "n1575", "n1576",
         "n1577", "n1579", "n1580", "n1582", "n1583", "n1584", "n1585", "n1586", "n1587", "n1588"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r21_probe.ts"
UI_TEST = "tests/sma/four-proofs-r21-b.test.tsx"


def scenario_sma_r21(tmp) -> dict:
    proofs = Proofs()
    # vite-node, not tsx: the probe loads the whole plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r21", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n1560 The one entry: an unknown verb exits 1 and the usage names every registered verb; n1561 the launcher is `lane-pilot` and keeps nothing between calls.
    e = s["entry"]
    proofs.prove("n1560", e["exitCode"] == 1 and e["missing"] == [] and e["verbs"] > 40, f"unknown verb exit {e['exitCode']}, {e['verbs']} verbs, missing from the usage: {e['missing']}")
    proofs.prove("n1561", e["name"] == "lane-pilot" and e["conveyor"] == [True, False, "deploy window", True], f"registered as {e['name']}; conveyor on/off/on across three calls: {e['conveyor']}")

    # n1565 / n1588 The book: opened phases are listed at discussion; a held roadmap row refuses a third; pausing one leaves the other.
    ws = s["workstream"]
    row = lambda pid, state, title: f"{pid}  {'discussion'.ljust(12)} {state.ljust(15)} {title}"
    listed = sorted([row(ws["a"], "active", "Add the footer"), row(ws["b"], "active", "Fix the header")])
    proofs.prove("n1565", ws["empty"] == {"exitCode": 0, "stdout": "no phases"} and ws["listed"] == listed, f"empty book {ws['empty']}; list {ws['listed']}")
    ok = (ws["third"] == f"roadmap row row-1 already has a live phase: {ws['a']} «Add the footer» — work with that one, or close it first"
          and ws["paused"] == sorted([row(ws["a"], "paused", "Add the footer"), row(ws["b"], "active", "Fix the header")]))
    proofs.prove("n1588", ok, f"third on a held row: {ws['third']!r}; after pausing one: {ws['paused']}")

    # n1563 STATE.md read and edited by flag, the person's lines kept.
    st = s["state"]
    keep = ["- chose sqlite, do not change", "- manual: use WAL", "- manual: second", "- manual: waits on api"]
    ok = (st["none"] == {"exitCode": 0, "stdout": "no STATE.md"} and st["refusedNew"]["exitCode"] == 1 and "nothing edits it into being" in st["refusedNew"]["stderr"]
          and all(line in st["secondLines"] for line in keep) and "## Blockers" in st["firstLines"] and st["startsWith"])
    proofs.prove("n1563", ok, f"no file -> {st['none']}; after two decisions and a blocker the kept lines are {[line in st['secondLines'] for line in keep]}")

    # n1564 The roadmap read with the disk.
    r = s["roadmap"]
    ok = (r["noFile"]["exitCode"] == 1 and r["row"] == {"exitCode": 0, "stdout": "- [x] 1 First — g1\n  - note a\n  - note b"} and r["missing"] == {"exitCode": 1, "stdout": "no row 9"}
          and r["analysis"] == {"exitCode": 0, "stdout": f"ticked without SUMMARY.md: 1 First (phase {r['id']})\nphase folders with no row: none\nnext open row: 2 Second"})
    proofs.prove("n1564", ok, f"row 1 -> {r['row']['stdout']!r}; no row 9 -> {r['missing']}; analysis {r['analysis']['stdout']!r}")

    # n1587 The planning files' health.
    v = s["validate"]
    ok = (v["bad"] == {"exitCode": 1, "stdout": "duplicate roadmap row 2\nskipped roadmap row(s) between 2 and 4"} and v["good"] == {"exitCode": 0, "stdout": "planning files healthy"})
    proofs.prove("n1587", ok, f"bad roadmap -> {v['bad']['stdout']!r}; agreeing one -> {v['good']}")

    # n1584 / n1566 Open acceptance lines across phases; a legacy UAT judged by its checkboxes.
    u = s["uat"]
    ok = (u["noneOpen"] == {"exitCode": 0, "stdout": "no open acceptance lines"} and u["open"]["exitCode"] == 1
          and u["open"]["lines"] == sorted([f"{u['id']}  open   1. login: not tried", f"{u['id']}  failed 2. reset: breaks"]) and u["after"]["exitCode"] == 0)
    proofs.prove("n1584", ok, f"open lines {u['open']}; after all ticked {u['after']}")
    ok = u["refused"].startswith("UAT is not complete: 1 open, 1 failed of 3") and u["accepted"] == "accepted"
    proofs.prove("n1566", ok, f"with an open and a failed line: {u['refused']!r}; every line ticked: {u['accepted']}")

    # n1567 The verification state and the next command.
    ve = s["verification"]
    ok = (ve["failed"]["waits"] and ve["failed"]["head"].startswith("Phase ph_f «Sum» — stage 5, verification failed: npm test red.") and ve["failed"]["returns"]
          and ve["passed"]["waits"] and ve["passed"]["head"].startswith("Phase ph_p «Sum» — stage 5, verification: the blind check passed (3 checks green). Run the goal audit")
          and ve["none"]["waitsForPm"] is False and ve["none"]["text"] == "Phase ph_n «Sum» — stage 5, verification: Lane Pilot runs every piece's checks together on main.")
    proofs.prove("n1567", ok, f"failed: {ve['failed']['head']!r}; none yet: {ve['none']['text']!r}")

    # n1576 The plan's structure: a piece whose task id differs, with no owned paths or check, is named line by line.
    vf = s["verify"]
    want = ["p1: the task id must equal the piece id", "p1: no owns_paths — the piece cannot become a work", "p1: no verification command — nothing proves the promise"]
    proofs.prove("n1576", vf["ok"] is False and vf["p1"] == want and vf["p2"] == [] and vf["sound"] == [], f"plan gate lines for p1 {vf['p1']}, for the sound p2 {vf['p2']}")

    # n1585 A lesson the owner applies goes through the memory door and is listed from the learning verb.
    le = s["lessons"]
    ok = le["before"] is False and le["rows"] == [{"project_id": "projA", "kind": "note", "origin": "phase-lessons", "content": "keep the migrations small and reversible"}] and le["listed"]
    proofs.prove("n1585", ok, f"before the yes: listed {le['before']}; after: row {le['rows']}, listed by `learning lessons` {le['listed']}")

    # n1577 / n1574 / n1568 The plan inventory, the prefilled plan, the inputs of a stage's workflow.
    w = s["waves"]
    proofs.prove("n1577", w["waves"] == [1, 2, 3] and w["issue"] == ["a", "a2", "b", "c"], f"waves {w['waves']}, issue order {w['issue']}")
    t = s["template"]
    ok = t["head"] == ["# Plan — phase ph_t: Sum", "Goal: sums", "## Waves"] and t["w1"] < t["a"] < t["w2"] and t["owns"] and t["checks"]
    proofs.prove("n1574", ok, f"PLAN.md head {t['head']}, piece a at line {t['a']} between wave 1 (line {t['w1']}) and wave 2 (line {t['w2']})")
    i = s["init"]
    proofs.prove("n1568", i == {"goal": "g", "folder": ".agents/phases/ph_draw", "material": False, "requirements": "actions, texts", "pieces": True}, f"draw inputs {i}")

    # n1569 / n1570 The model of a role and the table.
    rs = s["resolve"]
    ok = (rs["byDefault"] == "opencode2|router9/ag/gemini-3.8-flash-high|medium|default|null" and rs["byTable"] == "claude-code|claude-opus-5-5|xhigh|table|role_model.code-critic"
          and rs["byStage"] == "codex|gpt-6.1-terra|low|stage|code_critique.model" and rs["escalated"].endswith("|default|null|escalated"))
    proofs.prove("n1569", ok, f"code-critic: default {rs['byDefault']}; table {rs['byTable']}; stage {rs['byStage']}; below the least tier {rs['escalated']}")
    c = s["catalog"]
    ok = (c["roles"] > 20 and c["defaults"] == {"analyst": "claude-opus-5-5:high", "planner": "claude-opus-5-5:high", "copy-lead": "claude-sonnet-5-5:high",
                                                "code-critic": "router9/ag/gemini-3.8-flash-high:medium", "auditor": "gpt-6.1-sol:high"} and len(c["options"]) == 12
          and c["options"][1] == "claude-opus-5-5|claude-code|claude|strong")
    proofs.prove("n1570", ok, f"{c['roles']} roles, {len(c['options'])} offered models, defaults {c['defaults']}")

    # n1571 The skills a writer is given: listed names, once, at most eight.
    k = s["skills"]
    proofs.prove("n1571", k["named"] == ["alpha-skill", "beta-skill"] and k["none"] == [] and k["nine"] == k["expectNine"] and len(k["nine"]) == 8, f"named {k['named']}, nine asked -> {len(k['nine'])}")

    # n1573 The setting read back as saved; a bad or stale write is refused and the stored value stays.
    cf = s["config"]
    ok = (cf["unset"] is None and cf["refusedOk"] is False and cf["validation"]["code"] == "invalid_choice" and cf["afterRefused"] is None
          and cf["savedOk"] is True and cf["read"] == 2 and cf["staleOk"] is False and cf["afterStale"] == 2)
    proofs.prove("n1573", ok, f"unset {cf['unset']}; 4 refused ({cf['validation']['params'][1]}), stored {cf['afterRefused']}; 2 saved, read {cf['read']}; stale write refused, still {cf['afterStale']}")

    # n1572 Commit by an explicit list of paths; n1586 the code facts of a checkout.
    cm = s["commit"]
    ok = (cm["empty"]["status"] == "nothing" and cm["status"] == "committed" and cm["head"] and cm["subject"] == "docs: state" and cm["files"] == ".agents/planning/STATE.md"
          and cm["rest"] == "?? other.ts" and cm["again"] == "nothing" and cm["count"] == "2")
    proofs.prove("n1572", ok, f"committed {cm['files']!r} as {cm['subject']!r}; left over: {cm['rest']!r}; a second call: {cm['again']}")
    it = s["intel"]
    proofs.prove("n1586", it == {"none": {"state": "none"}, "stale": {"state": "stale", "behind": 2}, "fresh": {"state": "fresh"}}, f"no index -> {it['none']}; two commits behind -> {it['stale']}; at HEAD -> {it['fresh']}")

    # n1575 The header of a real file through the verb.
    fm = s["frontmatter"]
    ok = (fm["read"] == {"title": "A: b", "tags": ["x"]} and fm["wrote"] == 0 and fm["text"] == "---\ntitle: \"A: b\"\n# why\ntags: [x, y]\nstatus: done\n---\n\n# Body\n" and fm["outside"] == 1)
    proofs.prove("n1575", ok, f"header read {fm['read']}; after --set status=done --merge tags=y the file is {fm['text']!r}; a path outside the checkout exits {fm['outside']}")

    # n1579 / n1580 / n1582 The capability registry, its frozen snapshot, and the verb.
    cr = s["capreg"]
    proofs.prove("n1579", cr["ids"] and cr["perAgent"] and cr["gaps"] == [] and len(cr["broken"]) == 3 and cr["agents"] > 10, f"{cr['agents']} bundled agents plus the session guard, gaps {cr['gaps']}, a made-up feature reports {cr['broken']}")
    cg = s["capgen"]
    proofs.prove("n1580", cg["same"] and cg["ids"] and cg["count"] > 10, f"docs/capabilities.snapshot.json equals the generator's output for the checkout: {cg['same']} ({cg['count']} capabilities)")
    cs = s["capstate"]
    ok = (cs["ok"][0] == 0 and cs["red"][0] == 1 and cs["red"][1]["pause"] == "not_supported" and cs["unproven"] == 0 and cs["bogus"] == 1)
    proofs.prove("n1582", ok, f"all supported exit {cs['ok'][0]}; one not_supported exit {cs['red'][0]}; unproven exit {cs['unproven']}; unknown flag exit {cs['bogus']}")

    # n1583 The run card's counter is a screen: its own test (the checked-out commit's) renders the card and reads the header.
    ui = subprocess.run(["npx", "--yes", "vitest", "run", UI_TEST, "--maxWorkers=2", "--reporter=json"], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        report = json.loads(ui.stdout[ui.stdout.index("{"):])
        cases = [case for file in report["testResults"] for case in file["assertionResults"]]
        ok = bool(cases) and all(case["status"] == "passed" for case in cases) and any("[sma:k_t_progress]" in case["title"] for case in cases)
        detail = f"{len(cases)} case(s) of {UI_TEST}: {[case['status'] for case in cases]}"
    except (ValueError, KeyError):
        ok, detail = False, f"no vitest report (exit {ui.returncode}): {(ui.stderr or ui.stdout).strip()[-200:]}"
    proofs.prove("n1583", ok, f"run card header reads «2 of 3 tasks accepted», a resent task counts once, a closed run says closed: {detail}")
    return proofs.verdict("sma_r21", checked=len(NODES))
