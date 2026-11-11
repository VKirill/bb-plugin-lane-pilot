"""Phase and phase-route checks: the run passes each stage, the book holds its marks."""
from __future__ import annotations

import os
import re
import time

from lp_drill.env import PHASE_TIMEOUT_MIN, POLL_SEC, STAMP, TIMEOUT_MIN
from lp_drill.hub import setting_rpc
from lp_drill.report import verdict

def scenario_phase(ctx: "Context") -> dict:
    """A phase carried to its verification by the machine's own stages: opened with a goal of two notes and nothing reported by hand —
    lp.analyze signs the context, lp.plan plans and its critic approves, the driver issues the pieces, and the phase reaches
    verification. (The plan gate asks for an independent lp.plan run, an objective and a pre-mortem, so a plan reported by the drill
    under its own name is refused: the scene that did so could no longer pass.) LP_DRILL_PHASE_UNTIL=acceptance waits one stage
    further, so the verification stage itself runs."""
    problems: list[str] = []
    act = lambda action, phase_id=None, **payload: setting_rpc("phase_act", {"action": action, "projectId": ctx.project, "pmThreadId": ctx.pm, **({"phaseId": phase_id} if phase_id else {}), "payload": payload})
    stages = ("verification", "acceptance", "lessons", "closed")
    reached = stages[stages.index(os.environ.get("LP_DRILL_PHASE_UNTIL", "verification")):] if os.environ.get("LP_DRILL_PHASE_UNTIL", "verification") in stages else stages
    opened = act("open", title=f"Drill phase {STAMP}",
                 goal=f"Two new files exist in the repository: drills/phase-{STAMP}-1.md whose first line is '# phase {STAMP} 1', and drills/phase-{STAMP}-2.md whose first line is '# phase {STAMP} 2'.")
    phase_id = opened["phase"]["id"]
    snap: dict = {}
    try:
        # Analysis, plan, the writers and an lp.review per wave: the phase gets its own limit (live 2026-10-27: 20 minutes left it 7 s short).
        deadline, snap = time.time() + max(TIMEOUT_MIN, PHASE_TIMEOUT_MIN) * 60, route_snapshot(phase_id)
        while time.time() < deadline and snap["stage"] not in reached:
            time.sleep(POLL_SEC)
            snap = route_snapshot(phase_id)
        problems += route_problems(snap["book"], snap["stage"])
        if snap["stage"] not in reached:
            problems.append(f"the phase did not reach {reached[0]}: it is at {snap['stage']} ({snap['state']})")
        if not any(kind == "admitted" for kind, _ in book_parts(snap["book"])):
            problems.append("the book has no admitted plan")
    finally:
        setting_rpc("phase_control", {"phaseId": phase_id, "action": "close", "note": "drill done"})
    return verdict("phase", problems, phaseId=phase_id, stage=snap.get("stage"), autoStarted=snap.get("auto_started"), issued=snap.get("issued"))
ROUTE_REACHED = ("execution", "verification", "acceptance", "lessons", "closed")
ROUTE_HOLD_SEC = int(os.environ.get("LP_DRILL_ROUTE_HOLD_SEC", "150"))
BOOK_LINE = re.compile(r"^- \S+ \S+ \*\*([^*]+)\*\* — (.*)$")


def book_parts(book: str) -> list[tuple[str, str]]:
    """(kind, text) of every part line of a rendered phase book."""
    return [(m.group(1), m.group(2)) for m in (BOOK_LINE.match(line) for line in book.splitlines()) if m]


def route_problems(book: str, reached: str) -> list[str]:
    """What the phase route owes: no stage of the machine failed for editing its own files or reading the drawing, and the phase got to execution."""
    problems = [f"a stage failed on what it writes or reads: {text[:240]}" for kind, text in book_parts(book)
                if kind == "auto_failed" and ("repo_edited" in text or "lane_pilot_read_binary_rejected" in text)]
    if reached not in ROUTE_REACHED:
        problems.append(f"the machine's stages did not carry the phase to execution: it is at {reached}")
    return problems


def hold_problems(label: str, before: dict, after: dict) -> list[str]:
    """A pause or a stopped wave holds when the phase stays paused and starts no stage and issues no piece. Snapshot: state, auto_started, issued."""
    problems = []
    if after["state"] not in ("paused", "pause_requested"):
        problems.append(f"{label}: the phase did not stay paused ({after['state']})")
    if after["auto_started"] > before["auto_started"]:
        problems.append(f"{label}: a stage was started while the phase was held")
    if after["issued"] > before["issued"]:
        problems.append(f"{label}: a piece was issued while the phase was held")
    return problems


def route_snapshot(phase_id: str) -> dict:
    got = setting_rpc("phase_get", {"phaseId": phase_id})
    phase = got["phase"]
    return {"stage": phase["stage"], "state": phase["state"], "book": got.get("book", ""),
            "auto_started": sum(1 for kind, _ in book_parts(got.get("book", "")) if kind == "auto_started"),
            "issued": len((phase.get("record", {}).get("execution") or {}).get("issued") or {})}


def scenario_phase_route(ctx: "Context") -> dict:
    """The phase route on the machine's own stages (fable review 2026-10-27 §2.1: the train never reached its end on a real project): a small
    phase is opened and no one reports its stages. Its analysis and plan run as workflows whose helpers write the phase's folder and the plans
    folder; the book must hold no auto_failed for repo_edited or a refused binary read. A pause at the first boundary, and stop_wave at
    execution, hold: no stage starts and no piece is issued while the phase is held."""
    problems: list[str] = []
    act = lambda action, phase_id=None, **payload: setting_rpc("phase_act", {"action": action, "projectId": ctx.project, "pmThreadId": ctx.pm, **({"phaseId": phase_id} if phase_id else {}), "payload": payload})
    control = lambda phase_id, action, **extra: setting_rpc("phase_control", {"phaseId": phase_id, "action": action, **extra})

    def wait_stage(phase_id: str, stages: tuple[str, ...]) -> dict:
        deadline, snap = time.time() + TIMEOUT_MIN * 60, route_snapshot(phase_id)
        while time.time() < deadline and snap["stage"] not in stages:
            time.sleep(5)
            snap = route_snapshot(phase_id)
        return snap

    opened = act("open", title=f"Drill route {STAMP}", goal=f"A new file drills/route-{STAMP}.md exists in the repository and its first line is '# route {STAMP}'.")
    phase_id = opened["phase"]["id"]
    snap: dict = {}
    try:
        # Boundary 1: the analysis is done and signed, the plan is next. Pause here.
        snap = wait_stage(phase_id, ("planning", "design", *ROUTE_REACHED))
        if snap["stage"] == "discussion":
            problems.append("lp.analyze did not carry the phase out of discussion")
        else:
            control(phase_id, "pause")
            held = route_snapshot(phase_id)
            time.sleep(ROUTE_HOLD_SEC)
            problems += hold_problems("pause at the first boundary", held, route_snapshot(phase_id))
            control(phase_id, "resume")
            snap = wait_stage(phase_id, ROUTE_REACHED)
            if snap["stage"] == "execution":
                control(phase_id, "stop_wave")
                held = route_snapshot(phase_id)
                time.sleep(ROUTE_HOLD_SEC)
                problems += hold_problems("stop_wave at execution", held, route_snapshot(phase_id))
        snap = route_snapshot(phase_id)
        problems += route_problems(snap["book"], snap["stage"])
    finally:
        setting_rpc("phase_control", {"phaseId": phase_id, "action": "close", "note": "drill done"})
    return verdict("phase_route", problems, phaseId=phase_id, stage=snap.get("stage"), autoStarted=snap.get("auto_started"))
