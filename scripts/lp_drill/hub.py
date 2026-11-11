"""The drills plumbing: logging, bb/ssh/sql calls, thread rows, the plugin RPC."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time

from lp_drill.env import BB, HUB, HUB_DB, KEY

def log(message: str) -> None:
    print(f"{time.strftime('%T')} drill: {message}", file=sys.stderr, flush=True)


def run(args: list[str], stdin: str | None = None, timeout: int = 180, env: dict[str, str] | None = None) -> tuple[int, str, str]:
    try:
        done = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout, env=env)
        return done.returncode, done.stdout, done.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s: {' '.join(args[:3])}"


def bb(*args: str, timeout: int = 180) -> tuple[int, str, str]:
    return run([BB, *args], timeout=timeout)


def hubsql(sql: str) -> list[dict]:
    rc, out, err = run(["ssh", "-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HUB, f"sqlite3 -readonly -json '{HUB_DB}'"], stdin=sql, timeout=60)
    if rc != 0:
        raise RuntimeError(f"hub query failed: {err.strip()[:200]}")
    return json.loads(out) if out.strip() else []


def git(cwd: str, *args: str) -> str:
    rc, out, err = run(["git", "-C", cwd, *args], timeout=60)
    if rc != 0:
        raise RuntimeError(f"git {' '.join(args)}: {err.strip()[:200]}")
    return out.strip()


def thread_field(raw: str, name: str) -> str:
    try:
        data = json.loads(raw)
    except ValueError:
        return ""
    data = data.get("thread", data) if isinstance(data, dict) else {}
    return str(data.get(name) or "")


def thread_status(thread: str) -> str:
    rc, out, _ = bb("thread", "get", thread, "--json", timeout=60)
    return thread_field(out, "status") or "?" if rc == 0 else "?"
def setting_rpc(method: str, payload: dict) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(payload, handle)
    try:
        # A read that meets the hub in a long pause gets «HTTP 502» for a few seconds (live phase 2026-11-11: the run was
        # lost on one phase_get); it is asked again. A write is not: it may have landed.
        for attempt in range(3):
            rc, out, err = run([BB, "plugin", "rpc", "call", "lane-pilot", method, "--input-file", handle.name, "--json"], timeout=60)
            if rc == 0 or attempt == 2 or not (re.search(r"HTTP 50[234]", err or out) and re.search(r"_(get|list|status|view)$", method)):
                break
            time.sleep(10)
    finally:
        os.unlink(handle.name)
    if rc != 0:
        raise RuntimeError(f"{method} failed: {(err or out).strip()[:200]}")
    data = json.loads(out)
    return data.get("result", data) if isinstance(data, dict) else {}


def put_setting(project: str, key: str, value) -> dict:
    """Save one project setting, retrying once with the version a conflict names; value None resets the row."""
    rows = hubsql(f"select version from lane_pilot_project_settings where project_id='{project}' and binding_id='' and key='{key}';")
    version = int(rows[0]["version"]) if rows else 0
    for _ in range(2):
        out = (setting_rpc("reset_project_settings", {"projectId": project, "keys": [key], "expectedVersions": {key: version}}) if value is None
               else setting_rpc("save_setting", {"projectId": project, "key": key, "value": value, "expectedVersion": version}))
        if out.get("ok") or not out.get("conflict"):
            return out
        version = int(out.get("version") or (out.get("versions") or {}).get(key) or 0)
    return out
# Words a BB core answers with when the plugin does not (yet) register an RPC method: the register is not deployed, which is not a failure.
RPC_MISSING = re.compile(r"unknown (rpc )?method|method not found|no such (rpc )?method|not registered|unsupported", re.I)
