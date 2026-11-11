"""The drill's settings: the repository root, the hub and sandbox coordinates, every LP_DRILL_* knob."""
from __future__ import annotations

import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BB = os.environ.get("BB_CLI", "bb")
HUB = os.environ.get("BB_HUB_HOST", "ubuntu@10.8.0.1")
KEY = os.environ.get("BB_HUB_KEY", str(Path.home() / ".ssh/oracle_bb"))
HUB_DB = os.environ.get("LP_DRILL_HUB_DB", "/home/ubuntu/.bb/plugins/lane-pilot/data.db")
TIMEOUT_MIN = int(os.environ.get("LP_DRILL_TIMEOUT_MIN", "20"))
# parallel3 ends in 2-4 minutes: a stall (2026-10-29: three finished tasks waiting on a dirty base) is told in ten, not twenty.
PARALLEL3_TIMEOUT_MIN = int(os.environ.get("LP_DRILL_PARALLEL3_TIMEOUT_MIN", str(min(TIMEOUT_MIN, 10))))
PHASE_TIMEOUT_MIN = int(os.environ.get("LP_DRILL_PHASE_TIMEOUT_MIN", "35"))
POLL_SEC = int(os.environ.get("LP_DRILL_POLL_SEC", "20"))
BAD_MODEL = os.environ.get("LP_DRILL_BAD_MODEL", "lp-drill-model-that-does-not-exist")
SANDBOX = dict(project=os.environ.get("LP_DRILL_PROJECT", "proj_3tb652jpsi"),
               environment=os.environ.get("LP_DRILL_ENVIRONMENT", "env_mybrzmx7nz"),
               cwd=os.environ.get("LP_DRILL_CWD", "/Users/vechkasov/lp-sandbox-rules"))
NOGIT = dict(project=os.environ.get("LP_DRILL_NOGIT_PROJECT", "proj_cpxzk7r2vs"),
             environment=os.environ.get("LP_DRILL_NOGIT_ENVIRONMENT", "env_6adk43aq2y"),
             cwd=os.environ.get("LP_DRILL_NOGIT_CWD", "/Users/vechkasov/lp-sandbox-layouts/n-nogit"))
SANDBOX_PROJECTS = {SANDBOX["project"], NOGIT["project"]}
OPEN_STATES = ("queued", "spawn_requested", "spawn_unknown", "running")
TERMINAL = ("accepted", "blocked", "canceled")
STAMP = time.strftime("%Y%m%d-%H%M%S")
DATE = time.strftime("%Y-%m-%d")
