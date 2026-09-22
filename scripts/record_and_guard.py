#!/usr/bin/env python3
"""Record the real Claude hook payload, then delegate to the Lane Pilot guard.

The project-scoped settings environment is an isolation marker for the stage-0
variant-A PM workspace. The raw payload is logged before any normalization. If
Claude does not include agent_type, this wrapper adds lane-pilot-pm only for the
guard subprocess and records that fact separately; stage0.md must not claim the
raw payload contained the marker in that case.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: record_and_guard.py <log.jsonl> <guard.py>", file=sys.stderr)
        return 2
    log_path = Path(sys.argv[1])
    guard_path = Path(sys.argv[2])
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {}
    raw_agent = payload.get("agent_type") if isinstance(payload, dict) else None
    env_marker = os.environ.get("LANE_PILOT_PM") == "1"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "raw_payload": payload,
            "raw_agent_type": raw_agent,
            "project_env_marker": env_marker,
            "normalized_agent_type": raw_agent or ("lane-pilot-pm" if env_marker else None),
        }, ensure_ascii=False) + "\n")
    if isinstance(payload, dict) and not raw_agent and env_marker:
        payload["agent_type"] = "lane-pilot-pm"
    completed = subprocess.run(
        [sys.executable, str(guard_path)],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        env={**os.environ, "AGENT_HOOK_CLIENT": "claude"},
        check=False,
    )
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
