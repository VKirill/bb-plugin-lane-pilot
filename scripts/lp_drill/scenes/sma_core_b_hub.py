"""Reads of the hub's bb core for batch core-server-b (nodes whose code lives in bb-core): plain `bb ... --json` reads, nothing written, nothing started.

Shared by sma_r06_core_b.py, sma_r08_core_b.py and sma_r19_core_b.py. Each read is made once per run and kept: three region scenes ask the same question.
No model turn, no thread or plugin created, changed or removed; `bb plugin outdated` is the core's own «check for updates» command (it asks the
registries and keeps the answer in the plugin row, the way the six-hourly check does).
"""
from __future__ import annotations

import json
import re

from lp_drill.env import SANDBOX
from lp_drill.hub import bb

_CACHE: dict[str, object] = {}
EVENTS_PER_THREAD = 100
THREADS_LOOKED_AT = 8
REQUEST_TYPES = ("client/turn/requested", "client/thread/start", "client/turn/start")


def _json(args: tuple[str, ...]) -> tuple[object, str]:
    """The parsed --json answer of one bb command, or (None, why)."""
    rc, out, err = bb(*args, timeout=120)
    if rc != 0:
        return None, f"bb {' '.join(args[:3])} exited {rc}: {(err or out).strip()[:160]}"
    try:
        return json.loads(out), ""
    except ValueError:
        return None, f"bb {' '.join(args[:3])} printed no JSON: {out.strip()[:120]}"


def outdated() -> tuple[list[dict], str]:
    """`bb plugin outdated --json`: one entry per updatable installed plugin ({id, outcome, installed, candidate?, blocked?, detail?}), or ([], why)."""
    if "outdated" not in _CACHE:
        data, why = _json(("plugin", "outdated", "--json"))
        rows = data.get("results", data.get("plugins")) if isinstance(data, dict) else data
        _CACHE["outdated"] = ([row for row in rows if isinstance(row, dict)], "") if isinstance(rows, list) else ([], why or "the answer is not a list of entries")
    return _CACHE["outdated"]  # type: ignore[return-value]


def installed_versions() -> tuple[dict[str, str], str]:
    """`bb plugin list --json`: {plugin id: installed version}, or ({}, why)."""
    data, why = _json(("plugin", "list", "--json"))
    rows = data.get("plugins", data.get("results")) if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return {}, why or "the answer is not a list of plugins"
    return {str(row["id"]): str(row.get("version")) for row in rows if isinstance(row, dict) and "id" in row}, ""


def sandbox_threads() -> tuple[list[dict], str]:
    """The sandbox project's threads with their event log (oldest first, first EVENTS_PER_THREAD events): [{id, events}], or ([], why)."""
    if "threads" not in _CACHE:
        listed, why = _json(("thread", "list", "--project", SANDBOX["project"], "--json"))
        if not isinstance(listed, list):
            _CACHE["threads"] = ([], why or "the thread list is not an array")
        else:
            threads: list[dict] = []
            for row in listed[:THREADS_LOOKED_AT]:
                events, why_log = _json(("thread", "log", str(row.get("id")), "--json", "--limit", str(EVENTS_PER_THREAD)))
                if isinstance(events, list):
                    threads.append({"id": str(row.get("id")), "events": [e for e in events if isinstance(e, dict)]})
                else:
                    why = why_log
            _CACHE["threads"] = (threads, "" if threads else (why or "the sandbox project has no thread"))
    return _CACHE["threads"]  # type: ignore[return-value]


_SEMVER = re.compile(r"^\d+\.\d+\.\d+")


def is_semver(version: object) -> bool:
    return isinstance(version, str) and bool(_SEMVER.match(version))
