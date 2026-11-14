"""Region 9 · Person and window, batch d (n850 … n881) — proofs of the region scene sma_r09 (docs/sma-evidence.md, «Trace choice»).

Every node of this batch is a screen of the window (or a small part of it: the narrow switch, the theme, the live channel). The tests of the checked-out commit
(tests/sma/four-proofs-r09-d.test.ts and .test.tsx) render each screen for real in jsdom, press what the person presses and write down what the window SENT or DREW
as one JSON line per node (tests/sma/r09-world-d.ts, observe()). This scene runs those tests once, reads the lines and compares every value with what the card
says — the call that went out, the row text, the colour the bar took — so a node is proved by the value, not by «the tests pass». No model, no hub write.
Run: scripts/lp-drill.sh --scenario sma_r09 (this module adds its nodes to that scene).
"""
from __future__ import annotations

import json
import os
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

TEST_FILES_D = ["tests/sma/four-proofs-r09-d.test.ts", "tests/sma/four-proofs-r09-d.test.tsx"]
NODES_D = ["n850", "n851", "n852", "n853", "n854", "n855", "n856", "n857", "n858", "n859", "n860", "n861", "n862", "n863", "n864", "n866", "n867", "n868", "n869", "n870",
           "n871", "n872", "n873", "n874", "n876", "n877", "n878", "n879", "n880", "n881"]

ROWS_FOUR = [{"providerId": "codex", "model": "gpt-6-luna", "day": "2026-11-12", "done": 2, "notDone": 1}, {"providerId": "codex", "model": "gpt-6-luna", "day": "2026-11-13", "done": 0, "notDone": 1},
             {"providerId": "unknown", "model": "unknown", "day": "2026-11-13", "done": 0, "notDone": 1}]


def _checks(v: dict) -> dict[str, tuple[bool, str]]:
    """node -> (the observed value is the card's, what was observed). `v` is node -> the value its test wrote down."""
    def get(node: str) -> dict:
        return v.get(node) or {}

    out: dict[str, tuple[bool, str]] = {}
    a = get("n850")
    out["n850"] = (a.get("question", "").startswith("Wave 2 is done. Accept or hold?") and "✗ w2: header missing" in a.get("question", "") and a.get("review") == "codex: reads fine"
                   and a.get("sent") == {"phaseId": "ph1", "action": "word", "turn": "wave", "wave": 2, "decision": "no", "note": "the header is missing"},
                   f"wave question {a.get('question')!r}; hold sent {a.get('sent')}")
    a = get("n851")
    out["n851"] = (a.get("question") == "Run the migration now?" and a.get("sent") == [{"choice": "later"}, {"choice": "yes_now", "text": "after the release"}, {"text": "after the release"}],
                   f"question {a.get('question')!r}; answers sent {a.get('sent')}")
    a = get("n852")
    out["n852"] = (a.get("note") == "Цель: a calm hero Что мешает: the box is loud Вопрос: keep the box?" and a.get("shortGoal") is True and a.get("tooLong") is True,
                   f"note {a.get('note')!r}; a short goal refused {a.get('shortGoal')}, a 301-letter obstacle refused {a.get('tooLong')}")
    a = get("n853")
    out["n853"] = (a.get("models") == ["opus", "gpt-6-luna", "gpt-6-mini"] and a.get("onWhat") == "holds 2 (t1, t2)" and a.get("free") is True and a.get("never") is True,
                   f"cards {a.get('models')}; busy worker says {a.get('onWhat')!r}; free worker shows only its last time {a.get('free')}; never-seen worker has no line {a.get('never')}")
    a = get("n854")
    out["n854"] = (a.get("header") == "claude-code · 1,200 tokens in 30 days" and a.get("windows") == "5 часов 85% · 7 дней 8%" and a.get("codexWindows") is False,
                   f"header {a.get('header')!r}; windows {a.get('windows')!r}; windows on a codex card {a.get('codexWindows')}")
    out["n855"] = (v.get("n855") == ROWS_FOUR, f"outcomes per worker and day {v.get('n855')}")
    a = get("n856")
    out["n856"] = (a.get("month") == "Spent this month: $12.50 / $50" and a.get("providers") == ["codex: $10.25", "claude-code: $2.25"] and "$2.25" in a.get("estimated", ""),
                   f"month {a.get('month')!r}; providers {a.get('providers')}; estimated {a.get('estimated')!r}")
    a = get("n857")
    sent = a.get("sent") or []
    out["n857"] = (len(sent) == 2 and all(s.get("key") == "money.monthly_cap_usd" and s.get("expectedVersion") == 0 and s.get("projectId") for s in sent) and [s.get("value") for s in sent] == [62.5, "unlimited"],
                   f"saves sent {sent}")
    a = get("n858")
    out["n858"] = (a.get("head", [None] * 4)[1:3] == ["codex", "opencode"] and a.get("rows") == [["2026-11-12", "$3.50", "·", "$3.50"], ["2026-11-13", "$1.25", "$2.75", "$4.00"]], f"table {a.get('head')} {a.get('rows')}")
    lines = get("n859").get("lines") or ["", ""]
    out["n859"] = (len(lines) == 2 and "Mac mini" in lines[0] and "5 часов 62%, 7 дней 8%" in lines[0] and "h2" in lines[1] and "%" not in lines[1], f"account lines {lines}")
    a = get("n860")
    out["n860"] = (a.get("five") == "42%" and a.get("colours") == ["bg-primary", "bg-amber-500", "bg-destructive"] and "%" not in a.get("empty", "%"), f"first bar {a.get('five')}, colours {a.get('colours')}, no windows says {a.get('empty')!r}")
    a = get("n861")
    out["n861"] = (a.get("planCritiqueTicked") is False and a.get("ownerWordsTicked") is True and a.get("allDisabled") is True and a.get("until") is True and a.get("writes") == 0, f"rules drawn {a}")
    out["n862"] = (v.get("n862") == [["claude-code", "·", "·", "·", "✓", "·", "·", "·", "·", "✓"], ["codex", "✓", "·", "·", "·", "·", "✗", "·", "·", "·"]], f"lane rows {v.get('n862')}")
    a = get("n863")
    out["n863"] = (len(a.get("lanes") or []) == 4 and all(x.endswith("(1)") for x in a["lanes"]) and a.get("issued") == [{"projectId": "p1", "todoId": "t-01"}] and a.get("calls") == ["backlog_board", "backlog_issue", "backlog_board"],
                   f"lanes {a.get('lanes')}; issued {a.get('issued')}; calls {a.get('calls')}")
    a = get("n864")
    out["n864"] = (a.get("shown") == "t-1  src/a.ts  claimed 12:01\nt-2  src/a.ts  claimed 12:09  OVERLAP" and a.get("noRunClear") is False and a.get("noRunReads") == 0, f"coordination shows {a.get('shown')!r}; without a run clear offered {a.get('noRunClear')}")
    a = get("n866")
    out["n866"] = (a.get("started") == ["validate-phase", "pr-branch", "ship"] and a.get("phase") == "ph_7" and a.get("offBeforePhase") == [True, True, True], f"workflows started {a.get('started')} for phase {a.get('phase')}; off before a phase id {a.get('offBeforePhase')}")
    a = get("n867")
    out["n867"] = (a.get("running") == "writing · Writer · composer-2.5 · 12 min" and a.get("done") == "done" and a.get("blocked") is True, f"row line at work {a.get('running')!r}, done {a.get('done')!r}, blocked reason shown {a.get('blocked')}")
    out["n868"] = (v.get("n868") == {"0": False, "1": True, "320": True, "448": True, "449": False, "768": False}, f"narrow by width {v.get('n868')}")
    a = get("n869")
    out["n869"] = (a.get("compactRailHidden") is True and a.get("wideRailHidden") is False, f"rail hidden on a compact chrome {a.get('compactRailHidden')}, on a wide one {a.get('wideRailHidden')}")
    out["n870"] = (v.get("n870") == {"project": "Beta", "page": "Tasks", "section": "Api", "service": "LP sandbox"}, f"the menu names {v.get('n870')}")
    a = get("n871")
    out["n871"] = (a.get("narrowList") is True and a.get("narrowColumns") is False and a.get("wideColumns") is True and a.get("wideRunning") is True, f"phone {a}")
    a = get("n872")
    out["n872"] = (a.get("openedWide") is True and a.get("afterSwitch") is True and a.get("backLayoutNarrow") is True and a.get("openedOnPhone") is True, f"open task across the frame switch {a}")
    a = get("n873")
    out["n873"] = (a.get("coordNarrow") == "This screen needs a wide window (1024 px and more)." and a.get("coordWideShown") is False and a.get("phasesNarrowShown") is False, f"narrow window says {a.get('coordNarrow')!r}")
    a = get("n874")
    out["n874"] = (a.get("emptyPathNeedsSetup") == ["ck-first-run"] and a.get("realPathKept") == ["ck-money", "ck-first-run-banner"] and a.get("setUpProject") == ["ck-home"], f"window root drew {a}")
    a = get("n876")
    out["n876"] = (a.get("heard") == [{"kind": "rules"}, {"kind": "helpers", "threadId": "thr_1"}, None] and a.get("liveInterval") == 30000 and a.get("offlineInterval") == 4000, f"channel passed on {a.get('heard')}; poll live {a.get('liveInterval')} ms, offline {a.get('offlineInterval')} ms")
    a = get("n877")
    out["n877"] = (a.get("signedOut") == "Signed out of the owner door: run «bb owner login» on your machine." and a.get("withPass") is None and a.get("doorOff") is None, f"signed out says {a.get('signedOut')!r}; with the pass {a.get('withPass')}, door off {a.get('doorOff')}")
    a = get("n878")
    out["n878"] = (a.get("atStart") is None and a.get("atOneSecond") is None and a.get("atTwoSeconds") == "Waiting for an answer for 2 s" and a.get("atFive") == "Waiting for an answer for 5 s" and a.get("gone") is True,
                   f"wait line at 1 s {a.get('atOneSecond')}, 2 s {a.get('atTwoSeconds')!r}, 5 s {a.get('atFive')!r}")
    a = get("n879")
    out["n879"] = (a.get("ringWhileWaiting") is True and a.get("ringAfter") is False, f"ring while waiting {a.get('ringWhileWaiting')}, after the answer {a.get('ringAfter')}")
    a = get("n880")
    out["n880"] = (a == {"light": {"--lp-card": "#ffffff", "--lp-hairline": "#e5e5e5", "--lp-outline": "#d4d4d4"}, "dark": {"--lp-card": "#1a1a1a", "--lp-hairline": "#333333", "--lp-outline": "#444444"},
                         "pokecut": {"--lp-card": "#fff7fb", "--lp-hairline": "#f3c6dd", "--lp-outline": "#e29bc4"}}, f"theme tokens resolved {a}")
    a = get("n881")
    out["n881"] = (a.get("opensOn") == "proj_b" and a.get("firstRead") == {"projectId": "proj_b", "runsLimit": 5}, f"window opens on {a.get('opensOn')}, first screen read {a.get('firstRead')}")
    return out


def prove_d(proofs: Proofs, tmp) -> None:
    obs = os.path.join(str(tmp), "r09-d-observations.jsonl")
    open(obs, "w").close()
    run = subprocess.run(["npx", "--yes", "vitest", "run", *TEST_FILES_D, "--maxWorkers=2", "--reporter=json"], cwd=ROOT, capture_output=True, text=True, timeout=1200, env={**os.environ, "SMA_R09D_OBS": obs})
    try:
        report = json.loads(run.stdout[run.stdout.index("{"):])
        cases = [case for file in report["testResults"] for case in file["assertionResults"]]
        error = ""
    except (ValueError, KeyError):
        cases, error = [], f"no vitest report (exit {run.returncode}): {(run.stderr or run.stdout).strip()[-200:]}"
    values: dict[str, dict] = {}
    for line in open(obs, encoding="utf-8").read().splitlines():
        if line.strip():
            row = json.loads(line)
            values[row["node"]] = row["value"]
    failed = [case["title"][:60] for case in cases if case["status"] != "passed"]
    checks = _checks(values)
    for node in NODES_D:
        if node not in values:
            proofs.prove(node, False, error or f"the tests wrote no observation for {node}")
            continue
        ok, detail = checks[node]
        proofs.prove(node, ok and not failed, detail + (f"; tests failed: {failed}" if failed else ""))
