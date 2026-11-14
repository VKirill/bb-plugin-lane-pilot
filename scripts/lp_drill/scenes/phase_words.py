"""phase_words_sensitive: with owner.words=sensitive a phase waits for the owner's word only where its evidence touches money, data or deploy."""
from __future__ import annotations

import json
import os
import re
import time

from lp_drill.env import PHASE_TIMEOUT_MIN, STAMP, TIMEOUT_MIN
from lp_drill.hub import setting_rpc
from lp_drill.report import verdict
from lp_drill.scenes.phase import ROUTE_REACHED, route_snapshot
from lp_drill.scoped_settings import scoped_settings

WORDS_SETTINGS = {"owner.words": "sensitive"}
WORDS_HOLD_SEC = int(os.environ.get("LP_DRILL_WORDS_HOLD_SEC", "60"))
WORDS_POLL_SEC = int(os.environ.get("LP_DRILL_WORDS_POLL_SEC", "10"))
# What the sensitive classes are made of, for the scene's own goal texts (the real decision is the plugin's: record.wordTurns).
SENSITIVE_PATH = re.compile(r"migrations?/|\.sql\b|billing|payment|invoice|deploy|release|\.github/workflows|Dockerfile|\.env", re.I)
GOAL_PATH = re.compile(r"\b[\w./-]+\.(?:md|sql|txt)\b")
GAP = "awaits the owner's word"


def neutral_phase_goal(stamp: str = STAMP) -> str:
    return f"A new file drills/words-{stamp}.md exists in the repository and its first line is '# words {stamp}'. It is a plain text note: no other file is touched."


def migration_phase_goal(stamp: str = STAMP) -> str:
    """The phase runs on the machine's own stages (under phase.rails the PM's plan report is refused), so the scene steers only through the goal:
    the goal makes the plan create a file under migrations/, whose pieces then own `migrations/...sql`. The goal's own words stay outside the
    data class (no «database migration», no «migrate the table»): the context turn is weighed by the title and goal, and a goal that said so
    would stop the phase at discussion, not at planning, where the scene looks for the wait."""
    table = "drill_" + re.sub(r"\W", "_", stamp)
    return (f"A new file migrations/0001_{table}.sql exists in the repository whose only line is "
            f"`CREATE TABLE {table} (id INTEGER PRIMARY KEY);`. The plan creates that one file under migrations/ and nothing else.")


def plan_decided(record: dict, stage: str) -> bool:
    """The planning turn has been weighed on a plan: the record holds plan pieces, or the phase is past planning. wordTurns.planning alone
    is no sign: the phase writes it at opening already, from an empty plan (asks false)."""
    return stage not in ("discussion", "planning") or bool((record.get("plan") or {}).get("items"))


def goal_paths(goal: str) -> list[str]:
    return GOAL_PATH.findall(goal)


def gap_text(got: dict) -> str:
    """Everything phase_get says outside the record (the next action, the gate's gaps): where the wait names its class."""
    phase = {k: v for k, v in (got.get("phase") or {}).items() if k != "record"}
    return json.dumps({**{k: v for k, v in got.items() if k not in ("phase", "book")}, "phase": phase}, ensure_ascii=False)


def neutral_problems(record: dict, stage: str) -> list[str]:
    """(a): no word was asked or given, the phase went on to execution."""
    problems: list[str] = []
    planning = (record.get("wordTurns") or {}).get("planning")
    if planning is None:
        problems.append("record.wordTurns.planning is missing: the plan's turn was not decided")
    elif planning.get("asks") is not False:
        problems.append(f"wordTurns.planning.asks is {planning.get('asks')} for a neutral goal: {planning}")
    if record.get("words"):
        problems.append(f"an owner word is recorded on a neutral phase: {record['words']}")
    if stage not in ROUTE_REACHED:
        problems.append(f"the neutral phase did not reach execution: it is at {stage}")
    return problems


def migration_problems(record: dict, stage: str, gap: str) -> list[str]:
    """(b): the plan asks the word, with data among its classes, and the phase stays at planning."""
    problems: list[str] = []
    planning = (record.get("wordTurns") or {}).get("planning")
    if not planning or planning.get("asks") is not True:
        problems.append(f"wordTurns.planning.asks is not true for a plan that touches migrations/: {planning}")
    elif "data" not in (planning.get("classes") or []):
        problems.append(f"wordTurns.planning.classes lacks data: {planning}")
    if stage != "planning":
        problems.append(f"the phase did not stay at planning while the word was asked: it is at {stage}")
    if GAP in gap and "data" not in gap.lower():
        problems.append(f"the wait for the word does not name the class (data): {gap[:300]}")
    return problems


def open_words_phase(ctx: "Context", title: str, goal: str) -> str:
    opened = setting_rpc("phase_act", {"action": "open", "projectId": ctx.project, "pmThreadId": ctx.pm, "payload": {"title": title, "goal": goal}})
    return opened["phase"]["id"]


def wait_phase(phase_id: str, done, minutes: int) -> dict:
    deadline, snap = time.time() + minutes * 60, route_snapshot(phase_id)
    while time.time() < deadline and not done(snap):
        time.sleep(WORDS_POLL_SEC)
        snap = route_snapshot(phase_id)
    return snap


def phase_record(phase_id: str) -> tuple[dict, dict]:
    got = setting_rpc("phase_get", {"phaseId": phase_id})
    return got["phase"].get("record") or {}, got


def scenario_phase_words_sensitive(ctx: "Context") -> dict:
    """Two phases with owner.words=sensitive (set for this scene, put back after): (a) a neutral note reaches execution with no owner word and
    wordTurns.planning.asks false; (b) a phase whose plan must create migrations/...sql stops at planning with wordTurns.planning.asks true and
    data in its classes. Both phases are closed at the end."""
    problems: list[str] = []
    details: dict = {}
    minutes = max(TIMEOUT_MIN, PHASE_TIMEOUT_MIN)
    with scoped_settings(ctx, WORDS_SETTINGS, problems):
        neutral = open_words_phase(ctx, f"Drill words neutral {STAMP}", neutral_phase_goal())
        try:
            snap = wait_phase(neutral, lambda s: s["stage"] in ROUTE_REACHED, minutes)
            record, _ = phase_record(neutral)
            problems += [f"neutral: {p}" for p in neutral_problems(record, snap["stage"])]
            details["neutral"] = {"phaseId": neutral, "stage": snap["stage"], "wordTurns": record.get("wordTurns")}
        finally:
            setting_rpc("phase_control", {"phaseId": neutral, "action": "close", "note": "drill done"})
        migration = open_words_phase(ctx, f"Drill words migration {STAMP}", migration_phase_goal())
        try:
            # The turn is decided from the plan's pieces: wait for a plan (or for a phase that ran past planning), then hold to see it stay.
            wait_phase(migration, lambda s: plan_decided(phase_record(migration)[0], s["stage"]), minutes)
            time.sleep(WORDS_HOLD_SEC)
            record, got = phase_record(migration)
            stage = got["phase"]["stage"]
            problems += [f"migration: {p}" for p in migration_problems(record, stage, gap_text(got))]
            details["migration"] = {"phaseId": migration, "stage": stage, "wordTurns": record.get("wordTurns")}
        finally:
            setting_rpc("phase_control", {"phaseId": migration, "action": "close", "note": "drill done"})
    return verdict("phase_words_sensitive", problems, **details)
