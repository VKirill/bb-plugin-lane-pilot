#!/usr/bin/env python3
"""Session-local: fill agent_type, adapt hook output to native Claude PreToolUse."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def _tool_name(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    for key in ("tool_name", "toolName", "tool"):
        value = payload.get(key)
        if value:
            return str(value)
    return ""


def _event_name(payload: object) -> str:
    if not isinstance(payload, dict):
        return "PreToolUse"
    for key in ("hook_event_name", "hookEventName"):
        value = payload.get(key)
        if value:
            return str(value)
    return "PreToolUse"


def _trace(payload: object, exit_code: int) -> None:
    agent = os.environ.get("LANE_PILOT_AGENT_TYPE", "").strip()
    if isinstance(payload, dict) and payload.get("agent_type"):
        agent = str(payload.get("agent_type") or agent)
    line = json.dumps({
        "event": _event_name(payload),
        "tool_name": _tool_name(payload),
        "agent_type": agent,
        "exit": exit_code,
    }, ensure_ascii=False)
    path = os.environ.get("LANE_PILOT_HOOK_TRACE", "").strip()
    if not path:
        return
    try:
        with Path(path).open("a", encoding="utf8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def adapt_pretool_output(stdout: str, returncode: int) -> tuple[str, int]:
    text = stdout.strip()
    if not text:
        return stdout, returncode
    try:
        body = json.loads(text)
    except json.JSONDecodeError:
        return stdout, returncode
    if not isinstance(body, dict):
        return stdout, returncode
    specific = body.get("hookSpecificOutput")
    if isinstance(specific, dict) and specific.get("permissionDecision"):
        return stdout if stdout.endswith("\n") else text + "\n", returncode
    decision = str(body.get("decision") or "").lower()
    if decision not in {"deny", "block"}:
        return stdout, returncode
    reason = str(body.get("reason") or body.get("permissionDecisionReason") or "blocked")
    adapted = {
        "decision": "block",
        "reason": reason,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        },
    }
    return json.dumps(adapted, ensure_ascii=False) + "\n", 0


def main() -> int:
    if "--" not in sys.argv:
        print("usage: inject_agent_type.py -- <original command...>", file=sys.stderr)
        return 2
    cmd = sys.argv[sys.argv.index("--") + 1 :]
    if not cmd:
        print("inject_agent_type.py: missing original command", file=sys.stderr)
        return 2
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {}
    agent = os.environ.get("LANE_PILOT_AGENT_TYPE", "").strip()
    if isinstance(payload, dict) and agent and not payload.get("agent_type"):
        payload["agent_type"] = agent
    completed = subprocess.run(
        cmd,
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        check=False,
        capture_output=True,
    )
    stdout, exit_code = adapt_pretool_output(completed.stdout, completed.returncode)
    _trace(payload, exit_code)
    if stdout:
        sys.stdout.write(stdout)
        if not stdout.endswith("\n"):
            sys.stdout.write("\n")
    if completed.stderr:
        sys.stderr.write(completed.stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
