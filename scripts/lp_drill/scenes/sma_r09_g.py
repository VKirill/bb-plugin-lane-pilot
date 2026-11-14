"""Region 9 · Person and window, batch g (n934 … n959 without n944) — proofs of the region scene sma_r09 (docs/sma-evidence.md, «Trace choice»).

The nodes of this batch are the work screens of the window (the «Waiting for you» card, the new task and batch forms, the task card with its clarification,
drawing, approach note, steps, timeline, spend and acceptance, the batch graph, the phase card with its discussion, acceptance, folder and pause, Today and its
live feed, Memory) and three server halves (the conveyor switch, the window's commands of the phase door, the chat that is the PM thread). The tests of the
checked-out commit (tests/sma/four-proofs-r09-g.test.tsx and .test.ts) render each screen for real in jsdom, press what the person presses, and write down what the
screen DREW or SENT as one JSON line per node (tests/sma/r09-world-g.ts, observe()). This scene runs those tests once, reads the lines and compares every value with
what the card says, so a node is proved by the value, not by «the tests pass». No model, no hub write. Run: scripts/lp-drill.sh --scenario sma_r09.
"""
from __future__ import annotations

import json
import os
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

TEST_FILES_G = ["tests/sma/four-proofs-r09-g.test.ts", "tests/sma/four-proofs-r09-g.test.tsx"]
NODES_G = ["n934", "n935", "n936", "n937", "n938", "n939", "n940", "n941", "n942", "n943", "n945", "n946", "n947", "n948", "n949", "n950", "n951", "n952", "n953", "n954",
           "n955", "n956", "n957", "n958", "n959"]

DECIDE = {"projectId": "proj_1", "id": "r1", "action": "accept"}


def _checks(v: dict) -> dict[str, tuple[bool, str]]:
    """node -> (the observed value is the card's, what was observed). `v` is node -> the value its test wrote down."""
    def get(node: str) -> dict:
        return v.get(node) or {}

    out: dict[str, tuple[bool, str]] = {}
    a = get("n934")
    out["n934"] = (a.get("what") == "Never edit lockfiles by hand (Shop)" and a.get("buttons") == ["Accept the rule", "Reject"] and a.get("commandOnlyCardButtons") == 0
                   and a.get("doLine") is True and a.get("sent") == [DECIDE], f"card {a.get('what')!r}; buttons {a.get('buttons')}; a card with no rpc has {a.get('commandOnlyCardButtons')} button(s) and a «do» line {a.get('doLine')}; pressed -> {a.get('sent')}")
    a = get("n935")
    out["n935"] = (a.get("fields") == {"title": "Show the date on the card", "what": "Keep the old layout", "promise": "When the owner opens a card, then the date is visible"}
                   and a.get("sent") == {"projectId": "p1", "kind": "task", "text": "Show the date on the card\n\nKeep the old layout\n\nОбещание:\nWhen the owner opens a card, then the date is visible"}
                   and a.get("hint") == "Suggested: без путей и id: что увидит человек" and a.get("sendOffWithPath") is True,
                   f"proposed {a.get('fields')}; sent {a.get('sent')}; a path in the title says {a.get('hint')!r}")
    a = get("n936")
    rail = a.get("rail") or [""] * 9
    out["n936"] = (a.get("title") == "The form saves" and rail[2].endswith("orders") and rail[3].endswith("Alpha") and rail[4].endswith("Coordinator") and rail[5].endswith("2")
                   and rail[7].endswith("Fix the form") and rail[8] == "ID w1" and "attempt 2" in (a.get("thread") or "") and a.get("cancel") == {"attemptId": "a-w1-2", "note": "wrong plan"} and a.get("stopOffered") is True,
                   f"title {a.get('title')!r}; rail {rail}; thread {a.get('thread')!r}; cancel {a.get('cancel')}")
    a = get("n937")
    out["n937"] = (a.get("promise") == "Promise: it answers" and a.get("reproduce") == "How to repeat: a project · the owner asks" and a.get("blocker") == "dep — blocked (no provider)"
                   and [section[1] for section in a.get("sections") or []] == [["a/**", "→ a/out.ts"], ["no docs"], ["? Which file?", "✓ Which tone? → calm (owner)"], ["docs/d.md"]]
                   and a.get("correction") == {"runId": "run1", "taskId": "t1", "text": "use the other file"},
                   f"{a.get('promise')!r}; {a.get('reproduce')!r}; blocker {a.get('blocker')!r}; sections {[s[1] for s in a.get('sections') or []]}; correction {a.get('correction')}")
    a = get("n938")
    out["n938"] = (a.get("files") == "docs/d.md" and a.get("fresh") == "You said «drawing ok»." and a.get("okSent") == {"runId": "run1", "taskId": "t1"} and a.get("staleIsNamed") is True and a.get("noOkNoLine") is True,
                   f"files {a.get('files')!r}; after the ok {a.get('fresh')!r}; ok sent {a.get('okSent')}; a changed drawing named stale {a.get('staleIsNamed')}")
    a = get("n939")
    steps = a.get("steps") or ["", ""]
    out["n939"] = (len(steps) == 2 and steps[0] == "Plan critiquepassedreviewer · opus-5 · turns 2 · 2m · $0.500↗" and steps[1].startswith("Writerrunningwriter · composer-2.5 · turns 4 · 10m · not measured")
                   and a.get("off") == "Off in the project settings: Code critique" and a.get("tail") == "reading the formediting a.ts" and a.get("tailUnder") == "step-writer-agent",
                   f"steps {steps}; off {a.get('off')!r}; live tail {a.get('tail')!r} under {a.get('tailUnder')}")
    a = get("n940")
    out["n940"] = (a.get("summary") == "Lane Pilotat work 1 · done 2 of 4" and a.get("atWork") == "Task w1 before the week's list" and "composer-2.5 · 12 min" in (a.get("line") or ""),
                   f"summary {a.get('summary')!r}; row {a.get('line')!r}")
    a = get("n941")
    out["n941"] = (a.get("attempts") == [["#1", "checks failed", "verify_passes_exhausted"], ["#2", "running", None]] and a.get("singleHasTimeline") is False, f"attempts {a.get('attempts')}; a task with one attempt has a timeline: {a.get('singleHasTimeline')}")
    a = get("n942")
    out["n942"] = (a.get("turns") == "Turns: 4 of 5" and a.get("month") == "Month: $45.00 of $50.00" and a.get("hot") is True and a.get("openMonth") == "Month: $10.00" and a.get("openHot") is False,
                   f"{a.get('turns')!r}; {a.get('month')!r} hot {a.get('hot')}; no cap: {a.get('openMonth')!r} hot {a.get('openHot')}")
    a = get("n943")
    out["n943"] = (a.get("lines") == [["proven", "the form saves"], ["unproven", "errors are shown"]]
                   and a.get("decisions") == [{"runId": "run", "taskId": "t1", "decision": "no", "text": "not yet"}, {"runId": "run", "taskId": "t1", "decision": "yes", "text": "да"}]
                   and a.get("emptyWhyIgnored") is True and a.get("returned") == {"ref": "t1", "to": "writer", "note": "the writer missed the header", "by": "owner"} and a.get("stops") == ["t1"],
                   f"lines {a.get('lines')}; decisions sent {a.get('decisions')}; return {a.get('returned')}; stop {a.get('stops')}")
    a = get("n945")
    out["n945"] = (a.get("line") == "Approach: Patch the form first · tests first" and a.get("withoutLesson") == "Approach: Patch the form first" and a.get("none") is True, f"journal line {a.get('line')!r}")
    a = get("n946")
    out["n946"] = (a.get("composition") == "Suggested composition: 2 group(s) by area: ui, api"
                   and a.get("sent") == {"projectId": "p1", "kind": "batch", "text": "ui:\nui: Fix header\nui: Fix footer\n\napi:\napi: Add route"}, f"composition {a.get('composition')!r}; sent {a.get('sent')}")
    a = get("n947")
    out["n947"] = (a.get("scope") == "Цель: port the batch" and a.get("composition") == "feature:a: 2 · page:b: 1" and a.get("blocked") == "t2: verify_passes_exhaustedПовторитьОстановить"
                   and a.get("decisions") == {"retried": ["a2"], "canceled": ["a2"]} and a.get("blockedPieces") == 1, f"scope {a.get('scope')!r}; composition {a.get('composition')!r}; blocked {a.get('blocked')!r}; decisions {a.get('decisions')}")
    a = get("n948")
    out["n948"] = (a.get("steps") == [["Сейчас · параллельно", ["t1", "t2"]], ["Шаг 2 · параллельно", ["t3", "t4"]]] and a.get("stepOf") == {"t1": 0, "t2": 0, "t3": 1, "t4": 1}
                   and a.get("chain") == 2 and a.get("legend") == "после неё (depends_on)те же файлы", f"steps {a.get('steps')}; legend {a.get('legend')!r}")
    a = get("n949")
    drawing = a.get("drawing") or ["", "", ""]
    out["n949"] = (len(drawing) == 3 and drawing[0] == "ui.md, api.md" and "des" in drawing[1] and "rev" in drawing[1] and drawing[2].startswith("✓ · ") and "abcd1234 " in drawing[2] + " " and "abcd12345" not in drawing[2]
                   and a.get("lessons") == "went well" and a.get("observationNamesReverted") is True and a.get("bare") == [None, None, None], f"drawing {drawing}; lessons {a.get('lessons')!r}")
    a = get("n950")
    out["n950"] = (a.get("lines") == [{"label": "Проблема", "text": "Ship the footer"}, {"label": "Аппетит", "text": "a week"}, {"label": "Решение", "text": "Footer piece; Header piece"},
                                      {"label": "Подводные камни", "text": "the wall may fall"}, {"label": "Не делаем", "text": "no auth; no payments"}, {"label": "Риски", "text": "v; u; s"}]
                   and a.get("empty") == ["не названо"] * 6 and a.get("drawn") == ["Проблема: Ship the footer", "Аппетит: a week", "Решение: Footer piece", "Подводные камни: the wall may fall", "Не делаем: no auth", "Риски: не названо"],
                   f"six lines {[line['label'] + ': ' + line['text'] for line in a.get('lines') or []]}")
    a = get("n951")
    out["n951"] = (a.get("lines") == ["✓ w1: checks green", "✗ w2: header missing"] and a.get("packageKey") == "package pkg-7" and a.get("yesDisabledWithOneBasis") is True and a.get("noNeedsWords") is True
                   and a.get("sent") == {"phaseId": "ph1", "action": "word", "turn": "acceptance", "decision": "yes", "note": "да", "useful": True, "limits": True, "key": "pkg-7"},
                   f"lines {a.get('lines')}; {a.get('packageKey')!r}; yes sent {a.get('sent')}")
    a = get("n952")
    out["n952"] = (a.get("where") == ".agents/phases/ph1/ — BOOK.md, UAT.md" and a.get("listed") == ["BOOK.md · 120 B", "UAT.md · 33 B"] and a.get("fileText") == "- [ ] 1. a: given g"
                   and a.get("read") == {"phaseId": "ph1", "path": ".agents/phases/ph1/UAT.md"} and a.get("book") is True, f"folder says {a.get('where')!r}; files {a.get('listed')}; file text {a.get('fileText')!r}")
    a = get("n953")
    out["n953"] = (a.get("running") == {"button": "Pause", "sent": {"phaseId": "ph1", "action": "pause"}} and a.get("paused") == {"button": "Resume", "sent": {"phaseId": "ph1", "action": "resume"}, "interrupt": True},
                   f"running phase: {a.get('running')}; paused phase: {a.get('paused')}")
    a = get("n954")
    out["n954"] = (a.get("kpi") == [["Accepted", "3"], ["Blocked", "1"], ["At work", "2"], ["Tokens today", "12,345"], ["Actions", "7"]]
                   and a.get("feed") == [["accepted", "Task A"], ["blocked", "Task B"], ["running", "Task C"]] and a.get("unfolded") is True, f"numbers {a.get('kpi')}; feed {a.get('feed')}")
    a = get("n955")
    out["n955"] = (a.get("summaries") == ["Facts (1)", "Rules in memory (1)"] and a.get("ruleHasRemove") is False and a.get("deleted") == {"projectId": "p1", "id": "fact-1111111111aa"} and a.get("factsAfter") == 0,
                   f"sections {a.get('summaries')}; delete sent {a.get('deleted')}")
    a = get("n956")
    out["n956"] = (a.get("firstRead") == [] and a.get("afterPoll") == ["New work"] and a.get("fades") is True and a.get("readsWhileHidden") == 0, f"new after the first read {a.get('firstRead')}, after the 8 s poll {a.get('afterPoll')}; reads while hidden {a.get('readsWhileHidden')}")
    a = get("n957")
    out["n957"] = (a.get("placed") == {"state": "queued", "task": "t1", "attempts": ["queued"]} and a.get("otherThread") == "caller is not a Lane Pilot PM thread" and a.get("otherThreadTasks") == 0
                   and a.get("pmWithoutRun") == "PM thread has no lanePilotRunId", f"PM thread placed {a.get('placed')}; another thread -> {a.get('otherThread')!r}; PM without a run -> {a.get('pmWithoutRun')!r}")
    a = get("n958")
    out["n958"] = (a.get("untouched") == {"on": True, "since": None, "reason": None} and a.get("off") == {"on": False, "since": "2026-11-14T10:00:00.000Z", "reason": "deploy window"}
                   and a.get("secondOffChangesNothing") is True and a.get("on") == {"on": True, "since": None, "reason": None} and a.get("reasonCutAt") == 300 and a.get("blankReason") is None
                   and (a.get("startLine") or "").endswith("Turn it on with: bb lane-pilot conveyor on"), f"untouched {a.get('untouched')}; off {a.get('off')}; a second off keeps the first {a.get('secondOffChangesNothing')}; on {a.get('on')}")
    a = get("n959")
    out["n959"] = (a.get("commands") == [["setState", "pause"], ["setState", "resume"], ["stopWave", None], ["word", None], ["returnTo", None], ["answer", "q1"], ["setState", "close"]]
                   and a.get("answerBy") == "owner via screen" and a.get("closeWithoutWords") == "closing in words carries the words", f"commands reached {a.get('commands')}; answer is by {a.get('answerBy')!r}; close without words -> {a.get('closeWithoutWords')!r}")
    return out


def prove_g(proofs: Proofs, tmp) -> None:
    obs = os.path.join(str(tmp), "r09-g-observations.jsonl")
    open(obs, "w").close()
    run = subprocess.run(["npx", "--yes", "vitest", "run", *TEST_FILES_G, "--maxWorkers=2", "--reporter=json"], cwd=ROOT, capture_output=True, text=True, timeout=1200, env={**os.environ, "SMA_R09G_OBS": obs})
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
    for node in NODES_G:
        if node not in values:
            proofs.prove(node, False, error or f"the tests wrote no observation for {node}")
            continue
        ok, detail = checks[node]
        proofs.prove(node, ok and not failed, detail + (f"; tests failed: {failed}" if failed else ""))
