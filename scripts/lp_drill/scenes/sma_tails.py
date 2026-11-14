"""The tails scene of the SMA-parity proof (docs/sma-evidence.md, «Trace choice»): the map nodes that no region batch owns any more, from regions 5, 6, 8, 9, 12, 16, 22 and 24.

The probe (sma_tails_probe.ts, run by vite-node) runs the REAL code of the checkout — the conveyor switch, the intake rules, the guard hook on a writer's shell commands and the phase's word
gate, the live-correction path of the task update on a fake host, the phase's memory door, the QA verdict parser, the parity report, the ship and project-start graphs on the real engine —
and prints what each returned: no model, no hub write, nothing outside the machine. Each prove() below compares one value with the result the node's card expects (n480 and n557 are
deviation candidates: the value proved is what the code does ON PURPOSE, named in the detail). n835 is a window node: its jsdom cases run here, as in the region 9 scene.
n993 is proved up to the delivery: the word reaches the worker's own thread as a steer and no attempt is spent; whether a live model then acts on it needs a live model turn and is NOT proved here.

Run: scripts/lp-drill.sh --scenario sma_tails   (add --dry-run to list the nodes). Part of `--suite sma`; not in --quick.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs
from lp_drill.scenes.sma_tails_last import NODES_LAST, prove_last
from lp_drill.scenes.sma_tail_traces import NODES as NODES_TRACES, prove_tail_traces

NODES_BASE = ["n480", "n557", "n564", "n751", "n835", "n993", "n1224", "n1604", "n1615", "n1675"]
NODES = NODES_BASE + NODES_LAST + NODES_TRACES
PROBE = ROOT / "scripts/lp_drill/scenes/sma_tails_probe.ts"
UI_TEST = "tests/sma/four-proofs-tails.test.tsx"


def _section(seen: dict, name: str) -> dict:
    value = seen.get(name)
    return value if isinstance(value, dict) and "error" not in value else {}


def _ui_cases() -> tuple[list[dict], str]:
    """The jsdom cases of the window node, run on the checked-out commit; ([], why) when no report came back."""
    run = subprocess.run(["npx", "--yes", "vitest", "run", UI_TEST, "--maxWorkers=2", "--reporter=json"], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        report = json.loads(run.stdout[run.stdout.index("{"):])
    except (ValueError, IndexError):
        return [], f"no vitest report (exit {run.returncode}): {(run.stderr or run.stdout).strip()[-200:]}"
    return [case for file in report.get("testResults", []) for case in file.get("assertionResults", [])], ""


def scenario_sma_tails(tmp: Path) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_BASE:
            if node != "n835":
                proofs.prove(node, False, f"the tails probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        seen = {}

    if seen:
        d = _section(seen, "n480")
        proofs.prove("n480", d.get("fresh") == {"on": True, "since": None, "reason": None} and d.get("off", {}).get("on") is False and d.get("off", {}).get("reason") == "night maintenance" and d.get("sameSinceAndReason") is True and d.get("back", {}).get("on") is True and d.get("longReason") == 300,
                      f"conveyor: a fresh store is ON (the card says off from the factory: a deviation on purpose, the default stays), off keeps its reason «{d.get('off', {}).get('reason')}» and first time, on clears it, a long reason is cut to {d.get('longReason')}")
        d = _section(seen, "n557")
        proofs.prove("n557", d.get("bare") == {"kind": "small", "confident": False} and d.get("ru") == {"kind": "small", "confident": False} and d.get("kinds") == ["small", "small", "small"],
                      f"«make a batch» by the rules: {d.get('bare')}, in Russian {d.get('ru')}; no phrase is read as a batch by the rules (the judge reads one, on purpose)")
        d = _section(seen, "n564")
        proofs.prove("n564", d.get("writerDenied") == [["git push origin main", True], ["git tag v1.0", True], ["gh release create v1.0", True]] and d.get("writerAllowed") is False and d.get("phaseWaits") == {"key": "execution:word:issue", "mentionsOwner": True} and d.get("pmText") == [True, True, True],
                      f"hard calls: a writer is refused {d.get('writerDenied')}, git status refused: {d.get('writerAllowed')}; the phase waits at {d.get('phaseWaits')}")
        d = _section(seen, "n751")
        proofs.prove("n751", d.get("held", {}).get("ran") == ["gate", "held_gate"] and d.get("held", {}).get("openPrCalls") == 0 and d.get("held", {}).get("out", {}).get("status") == "held" and d.get("shipped", {}).get("openPrCalls") == 1 and d.get("shipped", {}).get("out") == {"status": "shipped", "pr_url": "https://x/pr/1", "held_by": [], "hooks_failed": []},
                      f"publish: failing gate marker -> {d.get('held', {}).get('ran')} with no PR step; clean run -> {d.get('shipped', {}).get('out')}")
        d = _section(seen, "n993")
        proofs.prove("n993", d.get("control") == {"ok": True, "delivered": False, "sent": 0} and d.get("live") == {"ok": True, "delivered": True, "attemptId": "a1"} and d.get("sent") == [{"threadId": "thr_w", "mode": "steer-if-active", "hasWord": True, "hasControlWord": False}] and d.get("attempts") == 1 and d.get("state") == "running",
                      f"a word to a running worker: sent {d.get('sent')}, attempts {d.get('attempts')}, state {d.get('state')}; control run sent {d.get('control', {}).get('sent')} (delivery only: a live model turn is not part of this proof)")
        d = _section(seen, "n1224")
        proofs.prove("n1224", d.get("writes") == 1 and d.get("origin") == "phase-lessons" and d.get("audience") == "subagent" and d.get("sourceIsPhaseAndText") is True and d.get("entries") == [{"kind": "note", "content": "decisions: one road; pattern: gate before wave; surprise: a stale lock", "concepts": ["phase", "lessons"]}] and d.get("refused") == "memory budget is full",
                      f"learnings: {d.get('writes')} note written to the hub memory door, origin {d.get('origin')}; a refused write returns «{d.get('refused')}»")
        d = _section(seen, "n1604")
        proofs.prove("n1604", d.get("failed", {}).get("verdict") == "failed" and d.get("failed", {}).get("status") == "rework" and d.get("silent") == {"verdict": "blocked", "status": "block"} and d.get("bare") == "blocked" and d.get("passed", {}).get("verdict") == "passed" and d.get("none", {}).get("summary") == "browser_qa_thread_returned_no_verdict",
                      f"live check report: failed -> {d.get('failed', {}).get('status')}, a pass with a case not passed -> {d.get('silent')}, all passed -> {d.get('passed', {}).get('verdict')}")
        d = _section(seen, "n1615")
        proofs.prove("n1615", d.get("before") == ["research"] and d.get("after") == ["requirements"] and d.get("thenRecap") == ["recap"] and d.get("folder") is True and d.get("files") == ["STACK.md", "FEATURES.md", "ARCHITECTURE.md", "PITFALLS.md"] and d.get("neverOverwrites") is True and d.get("skipWhen") == "tree.enabled != 'on'",
                      f"research step: answers -> {d.get('before')} -> requirements -> recap; files {d.get('files')}; never overwrites {d.get('neverOverwrites')} (the agent writes the files: the prompt is what is proved)")
        d = _section(seen, "n1675")
        proofs.prove("n1675", d.get("order") == ["hooks", "memory", "rules", "skills", "permissions", "model"] and d.get("allSame") is True and d.get("memory", {}).get("detail") == "only in the session: m3; only in the terminal: m2" and d.get("missing", {}).get("same") is None,
                      f"parity: six lines {d.get('order')}, a difference reads «{d.get('memory', {}).get('detail')}», a missing layer is {d.get('missing', {}).get('same')}")

    cases, why = _ui_cases()
    mine = [case for case in cases if "sma:m_sw_check_run" in case.get("fullName", "") or "sma:m_sw_check_run" in case.get("title", "")]
    proofs.prove("n835", bool(mine) and all(case.get("status") == "passed" for case in mine),
                 f"{len(mine)} case(s) tagged [sma:m_sw_check_run] rendered in jsdom on this commit (the check's stage steps, Cancel on a checking task, none on a done one): {[case.get('status') for case in mine]}" if mine else (why or "no case tagged [sma:m_sw_check_run] was reported"))
    prove_last(proofs, tmp)
    prove_tail_traces(proofs, tmp)
    return proofs.verdict("sma_tails")
