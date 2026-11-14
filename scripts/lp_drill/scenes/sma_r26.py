"""Region 26 · Self-improvement and measurement: the region scene (docs/sma-evidence.md, «Trace choice»).

Most nodes here print or keep a value in the plugin store and write no row to the hub database, so the node-level trace is this scene: it runs the REAL
entries of the commit under drill (the hub's own schedules, the CLI verbs, the work-graph RPC, a real `git log`) on scratch databases and folders, with no
model and no hub write, and prove()s each node with the result its card expects. The ladder (n1722) is also read from the hub's own rule events.
Run: scripts/lp-drill.sh --scenario sma_r26.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = [f"n{n}" for n in range(1710, 1733)]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r26_probe.ts"
BRIEF = "WHEN a p1 question like «who owns the wall» returns nothing → write the fact to memory (3 misses)"


def scenario_sma_r26(tmp) -> dict:
    proofs = Proofs()
    # vite-node, not tsx: the probe loads the whole plugin (server.ts), whose barrel files tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r26", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    cur, ladder, corpus, exam, gap, mine = s["curriculum"], s["ladder"], s["corpus"], s["exam"], s["examGap"], s["mine"]
    # n1710 The weekly job: the hub's schedule is registered; switched off it stores nothing, on it stores the brief the verb prints.
    proofs.prove("n1710", cur["scheduled"] and cur["whenOff"] is None and cur["brief"] == BRIEF and cur["printed"] == BRIEF, f"scheduled {cur['scheduled']}, off -> {cur['whenOff']}, on -> {cur['brief']!r}")
    # n1721 Miss clusters: three misses of one question become one cluster line with its count.
    proofs.prove("n1721", cur["brief"] == BRIEF and "(3 misses)" in cur["brief"], f"brief {cur['brief']!r}")
    # n1711 / n1722 The ladder: the nightly scan moves a confirmed rule from note to warning once, logs the tier event, the verb shows it.
    ok = ladder["before"] == "note" and ladder["after"] == "warning" and ladder["events"] == [{"action": "tier", "detail": "warning"}]
    proofs.prove("n1722", ok, f"tier {ladder['before']} -> {ladder['after']}, tier events {ladder['events']}")
    proofs.prove("n1711", ok and ladder["shown"].startswith("r1  warning") and "next warning" in ladder["shown"], f"rules ladder: {ladder['shown']!r}")
    # n1723 Decision corpus: one item with situation, decision and why; the same message twice stays one; the night's collection adds a proposal item.
    item = corpus["item"]
    ok = (corpus["first"] == {"added": 1, "skipped": 0, "total": 1} and corpus["again"] == {"added": 0, "skipped": 1, "total": 1}
          and item == {"quote": "decision 1", "expected": "owner_only", "why": "the owner decided 1", "strength": "strong", "source": "owner_message"} and corpus["collected"] == ["night_proposes"] and corpus["storedTotal"] == 2)
    proofs.prove("n1723", ok, f"{corpus['first']}, again {corpus['again']}, item {item}, collected {corpus['collected']}")
    # n1713 Exam: twenty unseen decisions, sixteen right, two owner-only answers named unsafe, the verdict says passed.
    proofs.prove("n1713", exam["exitCode"] == 0 and (exam["total"], exam["correct"], exam["unsafe"]) == (20, 16, 2) and exam["passed"] and exam["verdict"], f"{exam}")
    # n1724 Replay exam: a decision before the freeze never scores; too few unseen ones is a stated gap with exit 2.
    ok = gap["exitCode"] == 2 and (gap["inSplit"], gap["seenExcluded"], gap["total"]) == (4, 1, 3) and gap["enough"] is False and gap["said"]
    proofs.prove("n1724", ok, f"{gap}")
    # n1719 Approvals: a decision repeated three or more times becomes a suggestion that names the pattern; nothing is applied.
    app = s["approvals"]
    proofs.prove("n1719", len(app) == 1 and app[0]["pattern"] == "zz_unlisted_change→night_decides" and app[0]["times"] >= 3, f"{app}")
    # n1712 Mining: the Russian «да, выкатывай» is drafted, the weather question is not, mining twice never doubles, only an accept joins the exam.
    ok = mine["first"] == {"mined": 1, "skipped": 1, "total": 1} and mine["second"]["mined"] == 0 and mine["drafts"] == [["да, выкатывай", "approve", "owner_only"]] and (mine["before"], mine["after"]) == (0, 1)
    proofs.prove("n1712", ok, f"{mine}")
    # n1714 / n1725 Arena: only the arms without a stored run are run; the table ranks by cost per verified result, cheapest verified first; an arm with nothing verified is last with no cost.
    arena = s["arena"]
    ok = arena["ran"] == ["dear", "cheap", "failing"] and arena["ranks"] == [["stored", 2, 4], ["dear", 3, 9], ["cheap", 1, 0.5], ["failing", 4, None]]
    proofs.prove("n1714", arena["ran"] == ["dear", "cheap", "failing"], f"ran {arena['ran']}")
    proofs.prove("n1725", ok, f"ranks {arena['ranks']}")
    # n1715 / n1726 The model-free bench: false-done, phantom writes and git loss recoverability of the accepted attempts.
    b = s["baseline"]
    proofs.prove("n1715", b["accepted"] == 2 and "false-done rate 50%" in b["text"] and "git loss recoverability 50% (1 of 2" in b["text"], f"{b['text']!r}")
    ok = b["gitLoss"]["recoverable"] == 1 and b["gitLoss"]["lost"] == ["b" * 40] and b["falseDone"]["tasks"] == ["ghost"] and b["phantom"] == [{"attemptId": "att-ghost", "taskId": "ghost", "missing": ["src/b.ts"]}]
    proofs.prove("n1726", ok, f"false-done {b['falseDone']}, git loss {b['gitLoss']}")
    # n1716 / n1727 / n1717 / n1728 The repeatable memory measurement.
    m = s["memory"]
    proofs.prove("n1716", m["repeated"] and m["seed"] == 7, f"same seed twice: scores equal {m['repeated']}, seed {m['seed']}")
    proofs.prove("n1727", m["reproduceLine"] == f"reproduce: {m['command']}" and m["printedRepeats"], f"last line {m['reproduceLine']!r}; the printed command repeats the scores: {m['printedRepeats']}")
    proofs.prove("n1717", m["northStar"] and m["noNorthStar"] and m["gate"][0] == 0, f"north-star appended {m['northStar']}, absent without the flag {m['noNorthStar']}, gate {m['gate']}")
    proofs.prove("n1728", m["repeated"] and m["gate"][0] == 0, f"retrieval scores reproduced from one extract; gate {m['gate'][1]!r}")
    # n1718 / n1730 Excavation: a real `git log` through the machine, fix commits with their own files, newest first, no feature commit.
    e = s["excavate"]
    proofs.prove("n1718", e["found"] == e["expected"], f"found {e['found']}")
    proofs.prove("n1730", e["asked"] == ["git 'log' '--no-merges' '-n' '400' '--name-only' '--format=%x01%H%x02%s'"], f"asked {e['asked']}")
    # n1729 / n1720 / n1732 Cost per verified result, the report and the page.
    proofs.prove("n1729", s["cost"] == [["projA", 600, 1, 600]], f"{s['cost']}")
    r, page = s["report"], s["page"]
    proofs.prove("n1720", all(r.values()), f"report {r}")
    proofs.prove("n1732", page["heading"] and page["columns"] and page["escaped"] and not page["outside"], f"page {page}")
    # n1731 Process telemetry: rounds, failed rounds and time per stage from the stage events; reading writes nothing.
    t = s["telemetry"]
    ok = t["cells"] == [{"stageId": "verification", "state": "passed", "rounds": 2, "failures": 1, "reason": None}] and t["returns"] == 1 and t["seconds"] == 40 and t["stage"]["medianRounds"] == 1.5 and not t["writes"]
    proofs.prove("n1731", ok, f"cells {t['cells']}, stage {t['stage']}")
    return proofs.verdict("sma_r26", checked=len(NODES))
