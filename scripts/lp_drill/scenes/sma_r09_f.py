"""Region 9 · Person and window, batch f (n917 … n933) — proofs of the region scene sma_r09 (docs/sma-evidence.md, «Trace choice»).

Every node of this batch is a part of the window's frame (the phase header, the contract summary, the live timer, the sidebar and project selector, the hub
strip, the placeholder, the registry's palette and event paths, the work board and the open task) or the browser bell's notice. The tests of the checked-out
commit (tests/sma/four-proofs-r09-f.test.ts(x) and four-proofs-r09-f2.test.ts(x)) render each screen for real in jsdom, press what the person presses and write
down what the window DREW or SENT as one JSON line per node (tests/sma/r09-world-f.ts, observe()). This scene runs those tests once, reads the lines and compares
every value with what the card says, so a node is proved by the value, not by «the tests pass». No model, no hub write.
Run: scripts/lp-drill.sh --scenario sma_r09 (this module adds its nodes to that scene).
"""
from __future__ import annotations

import json
import os
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

TEST_FILES_F = ["tests/sma/four-proofs-r09-f.test.ts", "tests/sma/four-proofs-r09-f.test.tsx", "tests/sma/four-proofs-r09-f2.test.ts", "tests/sma/four-proofs-r09-f2.test.tsx"]
NODES_F = ["n917", "n918", "n919", "n920", "n921", "n923", "n924", "n925", "n926", "n927", "n928", "n929", "n930", "n931", "n932", "n933"]

ATTEMPT_TAIL = ["пишет ответ"] * 4 + ["правит файл…"] * 4


def _checks(v: dict) -> dict[str, tuple[bool, str]]:
    """node -> (the observed value is the card's, what was observed). `v` is node -> the value its test wrote down."""
    def get(node: str) -> dict:
        return v.get(node) or {}

    out: dict[str, tuple[bool, str]] = {}
    a = get("n917")
    out["n917"] = (a.get("headers") == ["executionFooteractive", "planningCartstopped"] and a.get("next") == "Next: Next step of ph1", f"phase headers {a.get('headers')}; opened card says {a.get('next')!r}")
    a = get("n918")
    out["n918"] = (a.get("promise") == ["Promise: the form keeps what was typed", "How to repeat: a filled form · Save is pressed"] and a.get("confirmed") == "Confirmed."
                   and a.get("sent") == {"runId": "run1", "taskId": "t-7", "text": "it must also keep the date"} and a.get("queueCalls") == 0,
                   f"summary {a.get('promise')}; correction sent {a.get('sent')}; confirm touched the queue {a.get('queueCalls')} times")
    a = get("n919")
    out["n919"] = (a.get("tail") == ATTEMPT_TAIL and a.get("five") == ["пишет ответ"] + ["правит файл…"] * 4 and a.get("once") == ["читает файл…", "правит файл…"],
                   f"tail of twelve events {a.get('tail')}; a call counted once {a.get('once')}")
    a = get("n920")
    tick = get("n920tick")
    out["n920"] = (a.get("0 en") == "writing · 0 min" and a.get("59 en") == "writing · 59 min" and a.get("60 en") == "writing · 1h 0m" and a.get("135 en") == "writing · 2h 15m"
                   and a.get("135 ru") == "writing · 2 ч 15 мин" and a.get("noStart") == "writing" and tick == {"before": "writing · 10 min", "after": "writing · 13 min"},
                   f"timer {a}; after three minutes {tick}")
    a = get("n921")
    out["n921"] = ([s.split(":")[1] for s in a.get("running", [])] == ["passed", "passed", "passed", "running", "pending", "pending", "pending", "pending"]
                   and [s.split(":")[1] for s in a.get("stopped", [])] == ["passed", "passed", "failed", "pending", "pending", "pending", "pending", "pending"]
                   and [s.split(":")[1] for s in a.get("closed", [])] == ["passed"] * 8 and [s.split(":")[0] for s in a.get("running", [])][0] == "discussion",
                   f"stage squares {a}")
    a = get("n923")
    out["n923"] = (len(a.get("lines", [])) == 14 and a.get("marked") == ["Money"] and a.get("bell") == "Awaits a decision: 3" and a.get("opened") == 14, f"sidebar {a.get('lines')}; open one marked {a.get('marked')}; bell {a.get('bell')!r}")
    a = get("n924")
    out["n924"] = (a.get("options") == ["Alpha", "Beta", "Broken"] and a.get("reread") == {"screen": {"projectId": "proj_b", "runsLimit": 5}, "firstRun": {"projectId": "proj_b"}, "phases": {"projectId": "proj_b"}}
                   and a.get("refused") == "Could not open the project" and a.get("stored") == "proj_b", f"switch to Beta reread {a.get('reread')}; refused project says {a.get('refused')!r}, stored stays {a.get('stored')}")
    a = get("n925")
    out["n925"] = (a.get("first") == {"title": "Lane Pilot: ждёт решения — 2", "text": "2 — на экране «Ждут владельца».", "keys": ["bell:k1", "bell:k2"]} and a.get("again") == {"send": False, "reason": "nothing_new"}
                   and a.get("next") == {"title": "Lane Pilot: ждёт решения — 1", "keys": ["bell:k3"]}, f"bell notice {a.get('first')}; after the ack {a.get('again')}; a new item {a.get('next')}")
    a = get("n926")
    out["n926"] = (a.get("cart") == ["phase:ph1", "task:t-9"] and a.get("byEvent") == ["screen:phases"] and a.get("byName") == ["screen:money"] and a.get("nothing") == 0 and a.get("all") == 14, f"palette {a}")
    a = get("n927")
    out["n927"] = (a.get("whileUp") is None and a.get("said") == "The hub does not answer — the screens show what they saw last." and a.get("afterAnswer") == "gone", f"hub strip {a}")
    a = get("n928")
    out["n928"] = (a.get("aboveNav") is True and a.get("aboveScreen") is True and a.get("screenKept") == "executionFooteractive", f"strip above nav {a.get('aboveNav')}, above the screen {a.get('aboveScreen')}; the screen below kept {a.get('screenKept')!r}")
    a = get("n929")
    out["n929"] = (a.get("cardRead") == {"runId": "run", "taskId": "w1"} and a.get("words") == ["○form saves", "○date is kept"] and a.get("fileRead") == {"runId": "run", "relativePath": "src/form.ts", "offset": 0} and a.get("back") is True,
                   f"panel read {a.get('cardRead')}, words {a.get('words')}, file read {a.get('fileRead')}, back closes {a.get('back')}")
    a = get("n930")
    ui = get("n930ui")
    out["n930"] = (a.get("uat") == {"id": "phases", "param": None} and a.get("nobody") == {"id": "building", "param": "nobody"} and a.get("plain") == {"id": "phases", "param": "ph_7"} and a.get("home") == {"id": "home", "param": None}
                   and ui.get("opened") == {"event/uat": "ck-phases", "event/queue": "ck-task-lookup", "event/day": "ck-today", "phases": "ck-phases"} and ui.get("nobody") == "ck-building",
                   f"event/uat -> {a.get('uat')}; unknown event -> {a.get('nobody')}; window opened {ui.get('opened')}")
    a = get("n931")
    out["n931"] = (a.get("afterFirst") == ["Next: Next step of ph1"] and a.get("afterSecond") == ["Next: Next step of ph2"] and a.get("afterSecondPress") == [], f"open cards after the first press {a.get('afterFirst')}, after the second phase {a.get('afterSecond')}, after pressing it again {a.get('afterSecondPress')}")
    a = get("n932")
    out["n932"] = (a.get("unknown") == "This screen is being built.This screen is being built." and a.get("screensWithoutPlaceholder") == 14, f"unknown path says {a.get('unknown')!r}; screens that never show it {a.get('screensWithoutPlaceholder')}")
    a = get("n933")
    out["n933"] = (a.get("counts") == {"queued": "2", "running": "1", "checking": "1", "blocked": "1", "done": "1"} and "waits for ck-24, t-2" in a.get("waits", "")
                   and a.get("held") is True and a.get("heldElsewhere") is False and a.get("stuck") is True, f"board {a}")
    return out


def prove_f(proofs: Proofs, tmp) -> None:
    obs = os.path.join(str(tmp), "r09-f-observations.jsonl")
    open(obs, "w").close()
    run = subprocess.run(["npx", "--yes", "vitest", "run", *TEST_FILES_F, "--maxWorkers=2", "--reporter=json"], cwd=ROOT, capture_output=True, text=True, timeout=1500, env={**os.environ, "SMA_R09F_OBS": obs})
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
    for node in NODES_F:
        if node not in values:
            proofs.prove(node, False, error or f"the tests wrote no observation for {node}")
            continue
        ok, detail = checks[node]
        proofs.prove(node, ok and not failed, detail + (f"; tests failed: {failed}" if failed else ""))
