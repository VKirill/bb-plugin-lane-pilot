#!/usr/bin/env python3
"""Build UI catalog, applicability table, and i18n field strings from matrix + settings.json."""
from __future__ import annotations

import json
import ast
import sys
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parents[1]
SETTINGS = PROJECT / ".agency/jobs/AG-179/settings.json"
MATRIX = PROJECT / ".agency/jobs/AG-186/adoc-coverage-matrix.md"
UPSTREAM = ROOT / ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack"
TASK_SCHEMA = ROOT / "lane-stack/schemas/task-v2.schema.json"

BINARIES_LANE_PILOT_INVOKES = {
    "run-controller",
    "lane-ctl",
    "lane-session",
    "install.sh",
    "night-shift",
    "browser-qa-codex",
    "browser-qa-jev",
    "check-owns-paths",
    "gate-report",
    "gate-triage",
    "run-init",
}

TUI_ONLY_FILES = {"bin/agents_doctor_tui.py"}

# Canonical runtime keys from src/channels.ts SETTING_CATALOG.
# Aliased UI rows share a key so save_setting feeds cliSettingsFor / argv-builder.
RUNTIME_KEY_BY_TUPLE: dict[tuple[str, str], str] = {
    # The old CLI options were excluded because their upstream parser was
    # incomplete; Lane Pilot now exposes equivalent typed stage settings.
    ("adoc CLI top-level", "--plan-critique-provider"): "plan_critique.provider",
    ("adoc CLI top-level", "--browser-qa-effort"): "browser_qa.reasoning_effort",
    ("adoc CLI top-level", "--writer-agent"): "writer.agent",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.agent"): "plan_critique.agent",
    ("pipeline_stages.py stage: write", "write.agent"): "writer.agent",
    ("pipeline_stages.py stage: specialist", "specialist.agent"): "specialist.agent",
    ("pipeline_stages.py stage: memory", "memory.agent"): "memory.agent",
    ("pipeline_stages.py stage: docs", "docs.agent"): "docs.agent",
    ("pipeline_stages.py stage: onboard", "onboard.provider"): "onboarding.provider",
    ("pipeline_stages.py stage: onboard", "onboard.depth"): "onboarding.depth",
    ("TUI Coder tab", "agent (OpenCode write agent)"): "writer.agent",
    ("adoc CLI top-level", "--night-review"): "night_review.enabled",
    ("adoc CLI top-level", "--max-fix-tasks"): "night_review.max_fix_tasks",
    ("adoc CLI top-level", "--auto-merge/--no-auto-merge"): "night_review.auto_merge",
    ("adoc CLI top-level", "--browser-qa"): "browser_qa.enabled",
    ("adoc CLI top-level", "--browser-qa-provider"): "browser_qa.provider",
    ("adoc CLI top-level", "--browser-qa-model"): "browser_qa.model",
    ("adoc CLI top-level", "--browser-qa-backend"): "browser_qa.backend",
    ("adoc CLI setup", "--night-review"): "night_review.enabled",
    ("adoc CLI setup", "--max-fix-tasks"): "night_review.max_fix_tasks",
    ("adoc CLI setup", "--auto-merge/--no-auto-merge"): "night_review.auto_merge",
    ("adoc capabilities/profile write", "night-shift.yaml enabled"): "night_review.enabled",
    ("adoc capabilities/profile write", "night-shift.yaml provider"): "night_review.provider",
    ("adoc capabilities/profile write", "night-shift.yaml auto_merge"): "night_review.auto_merge",
    ("routing_profile.py", "DEFAULT_WORKSPACE_MODE"): "adoc.040",
    ("routing_profile.py", "DEFAULT_WORKTREE_MIN_SCORE"): "adoc.041",
    ("routing_profile.py", "DEFAULT_SESSION_MAX_TASKS"): "ops.max_tasks",
    ("adoc capabilities/profile write", "workspace.worktree_min_score"): "adoc.041",
    ("adoc capabilities/profile write", "workspace.worktree_on_multi_write"): "adoc.042",
    ("TUI Night tab", "night_review (enabled)"): "night_review.enabled",
    ("TUI Night tab", "night_provider"): "night_review.provider",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.provider"): "plan_critique.provider",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.model"): "plan_critique.model",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.reasoning_effort"): "plan_critique.reasoning_effort",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.service_tier"): "plan_critique.service_tier",
    ("pipeline_stages.py stage: browser_qa", "browser_qa.enabled"): "browser_qa.enabled",
    ("pipeline_stages.py stage: browser_qa", "browser_qa.provider"): "browser_qa.provider",
    ("pipeline_stages.py stage: browser_qa", "browser_qa.model"): "browser_qa.model",
    ("pipeline_stages.py stage: browser_qa", "browser_qa.reasoning_effort"): "browser_qa.reasoning_effort",
    ("pipeline_stages.py stage: browser_qa", "browser_qa.backend"): "browser_qa.backend",
    ("pipeline_stages.py stage: browser_qa", "browser_qa.approve"): "browser_qa.approve",
    ("pipeline_stages.py stage: browser_qa", "browser_qa.service_tier"): "adoc.126",
    ("TUI Stages tab (browser_qa)", "browser_qa.backend"): "browser_qa.backend",
    ("TUI Stages tab (browser_qa)", "browser_qa.approve"): "browser_qa.approve",
    ("pipeline_stages.py stage: specialist", "specialist.enabled"): "specialist.enabled",
    ("pipeline_stages.py stage: specialist", "specialist.when"): "specialist.when",
    ("pipeline_stages.py stage: specialist", "specialist.provider"): "specialist.provider",
    ("pipeline_stages.py stage: specialist", "specialist.model"): "specialist.model",
    ("pipeline_stages.py stage: specialist", "specialist.reasoning_effort"): "specialist.reasoning_effort",
    ("pipeline_stages.py stage: night_review", "night_review.enabled"): "night_review.enabled",
    ("pipeline_stages.py stage: night_review", "night_review.provider"): "night_review.provider",
    ("pipeline_stages.py stage: night_review", "night_review.agent"): "night_review.agent",
    ("gate scripts", "gate-triage --auto-merge"): "night_review.auto_merge",
    ("gate scripts", "gate-triage --repair-provider"): "night_review.provider",
    ("TUI Night tab", "auto_merge"): "night_review.auto_merge",
    ("pipeline_stages.py stage: docs", "docs.enabled"): "docs.enabled",
    ("pipeline_stages.py stage: docs", "docs.maintain"): "docs.maintain",
    ("pipeline_stages.py stage: docs", "docs.page_cap"): "docs.page_cap",
    ("pipeline_stages.py stage: docs", "docs.since"): "docs.since",
    ("pipeline_stages.py stage: docs", "docs.hour"): "docs.hour",
    ("pipeline_stages.py stage: memory", "memory.enabled"): "memory.enabled",
    ("pipeline_stages.py stage: memory", "memory.provider/.model/.reasoning_effort/.service_tier"): "memory.provider",
    ("pipeline_stages.py stage: memory", "memory.maintain"): "memory.maintain",
    ("pipeline_stages.py stage: memory", "memory.inject"): "memory.inject",
    ("pipeline_stages.py stage: memory", "memory.audience"): "memory.audience",
    ("pipeline_stages.py stage: memory", "memory.personal_bot"): "memory.personal_bot",
    ("pipeline_stages.py stage: memory", "memory.search_engine"): "memory.search_engine",
    ("pipeline_stages.py stage: memory", "memory.core_budget"): "memory.core_budget",
    ("pipeline_stages.py stage: memory", "memory.note_budget"): "memory.note_budget",
    ("pipeline_stages.py stage: memory", "memory.index_budget"): "memory.index_budget",
    ("pipeline_stages.py stage: memory", "memory.context_budget"): "memory.context_budget",
    ("adoc CLI top-level", "--writer-provider"): "writer.provider",
    ("adoc CLI setup", "--writer-provider"): "writer.provider",
    ("TUI Coder tab", "writer (provider)"): "writer.provider",
    ("pipeline_stages.py stage: write", "write.provider"): "writer.provider",
    ("adoc capabilities/profile write", "writer.provider/model/reasoning_effort/service_tier/agent"): "writer.provider",
    ("hooks pm_read", "pm_read.enabled"): "pm_read.enabled",
    ("hooks pm_read", "pm_read.min_lines"): "pm_read.min_lines",
    ("hooks pm_read", "pm_read.provider"): "pm_read.provider",
    ("hooks pm_read", "pm_read.model"): "pm_read.model",
    ("hooks pm_read", "pm_read.reasoning_effort / effort"): "pm_read.reasoning_effort",
    ("hooks pm_read", "pm_read.service_tier"): "pm_read.service_tier",
    ("lane-ctl CLI (start)", "--provider"): "writer.provider",
    ("run-controller CLI", "--provider"): "writer.provider",
    ("adoc CLI top-level", "--writer-model"): "writer.model",
    ("pipeline_stages.py stage: write", "write.model"): "writer.model",
    ("TUI Coder tab", "model"): "writer.model",
    ("lane-ctl CLI (start)", "--model"): "writer.model",
    ("run-controller CLI", "--model"): "writer.model",
    ("adoc CLI top-level", "--writer-effort / --reasoning-effort"): "writer.reasoning_effort",
    ("pipeline_stages.py stage: write", "write.reasoning_effort"): "writer.reasoning_effort",
    ("TUI Coder tab", "effort"): "writer.reasoning_effort",
    ("lane-ctl CLI (start)", "--reasoning-effort"): "writer.reasoning_effort",
    ("run-controller CLI", "--reasoning-effort"): "writer.reasoning_effort",
    ("adoc CLI top-level", "--service-tier"): "writer.service_tier",
    ("routing_profile.py", "DEFAULT_SERVICE_TIER"): "writer.service_tier",
    ("lane-ctl CLI (start)", "--service-tier"): "writer.service_tier",
    ("run-controller CLI", "--service-tier"): "writer.service_tier",
    ("TUI Coder tab", "fast (service_tier)"): "writer.service_tier",
    ("adoc CLI top-level", "--fast-mode/--no-fast-mode"): "writer.fast_mode",
    ("lane-ctl CLI (start)", "--fast-mode"): "writer.fast_mode",
    ("run-controller CLI", "--fast-mode"): "writer.fast_mode",
    ("opencode-lane jev", "LANE_JEV_EFFORT"): "jev.LANE_JEV_EFFORT",
    ("opencode-lane jev", "LANE_OPENCODE_JEV"): "jev.LANE_OPENCODE_JEV",
    ("retry gate", "LANE_JEV_EFFORT"): "jev.LANE_JEV_EFFORT",
    ("run.yaml (schema)", "gate"): "run.gate",
    ("adoc CLI top-level", "--session-max-tasks"): "ops.max_tasks",
    ("lane-ctl CLI (start)", "--max-tasks"): "ops.max_tasks",
    ("TUI Work tab", "session_max_tasks"): "ops.max_tasks",
    ("adoc capabilities/profile write", "workspace.session_max_tasks"): "ops.max_tasks",
    ("routing_profile.py", "LANE_SESSION_MAX_TASKS"): "ops.max_tasks",
    ("run-controller CLI", "--poll-interval"): "ops.poll_interval",
    ("run-controller CLI", "--poll-interval (watch)"): "ops.poll_interval",
    ("run-controller CLI", "--heartbeat-interval"): "ops.heartbeat_interval",
    ("run-controller CLI", "--retry-backoff"): "ops.retry_backoff",
    ("run-controller CLI", "--run-dir"): "ops.run_dir",
    ("lane-ctl CLI (start)", "--run-dir"): "ops.run_dir",
    ("run-controller CLI", "--project-cwd"): "ops.project_cwd",
    ("lane-ctl CLI (start)", "--task-id"): "ops.task_id",
    ("lane-ctl CLI (start)", "--task-file"): "ops.task_file",
    ("lane-ctl CLI (start)", "--idle"): "ops.idle",
    ("lane-ctl CLI (start)", "--max-runtime / --max"): "ops.max_runtime",
    ("lane-ctl CLI (start)", "--pool-size"): "ops.pool_size",
    ("lane-ctl env", "LANE_SESSION_POOL_SIZE"): "ops.pool_size",
    ("lane-ctl CLI (verify)", "--verify-pool-size / --pool-size"): "ops.verify_pool_size",
    ("lane-ctl env", "LANE_VERIFY_POOL_SIZE"): "ops.verify_pool_size",
    ("run.yaml (schema)", "pools.provider"): "ops.pool_size",
    ("run.yaml (schema)", "pools.verification"): "ops.verify_pool_size",
    ("lane-ctl CLI (verify)", "--command-timeout (legacy v1 only)"): "ops.command_timeout",
    ("run-controller CLI", "--timeout (watch)"): "ops.watch_timeout",
    ("lane-ctl CLI (other)", "--source (tail)"): "ops.tail_source",
    ("lane-ctl CLI (other)", "--lines (tail)"): "ops.tail_lines",
    ("lane-ctl CLI (other)", "--limit (events)"): "ops.events_limit",
    ("install.sh", "LANE_INSTALL_LOCAL_MARKETPLACE"): "install.LANE_INSTALL_LOCAL_MARKETPLACE",
    ("install.sh", "LANE_INSTALL_CLAUDE_PLUGIN"): "install.LANE_INSTALL_CLAUDE_PLUGIN",
    ("install.sh", "CLAUDE_CONFIG_DIR"): "install.CLAUDE_CONFIG_DIR",
    ("install.sh", "CODEX_HOME"): "install.CODEX_HOME",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.mode"): "plan_critique.mode",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.enabled"): "plan_critique.enabled",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.min_score"): "plan_critique.min_score",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.min_write_tasks"): "plan_critique.min_write_tasks",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.on_high_risk"): "plan_critique.on_high_risk",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.provider"): "plan_critique.provider",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.model"): "plan_critique.model",
    ("pipeline_stages.py stage: night_review", "night_review.model / .reasoning_effort"): "night_review.model",
    ("adoc capabilities/profile write", "night-shift.yaml max_fix_tasks"): "night_review.max_fix_tasks",
    ("TUI Night tab", "max_fix_tasks"): "night_review.max_fix_tasks",
    ("TUI UI tab", "language"): "ui.language",
    ("adoc capabilities/profile write", "ui.language"): "ui.language",
}

CONSUMER_KEYS = {
    "plan_critique.provider",
    "plan_critique.model",
    "plan_critique.min_score",
    "plan_critique.min_write_tasks",
    "plan_critique.on_high_risk",
    "plan_critique.reasoning_effort",
    "plan_critique.service_tier",
    "plan_critique.agent",
    "writer.agent",
    "pm_read.enabled",
    "pm_read.min_lines",
    "pm_read.provider",
    "pm_read.model",
    "pm_read.reasoning_effort",
    "pm_read.service_tier",
    "adoc.041",
    "adoc.042",
    "specialist.agent",
    "memory.agent",
    "docs.agent",
    "onboarding.provider",
    "onboarding.model",
    "onboarding.reasoning_effort",
    "onboarding.service_tier",
    "onboarding.agent",
    "onboarding.depth",
    "browser_qa.enabled",
    "browser_qa.provider",
    "browser_qa.model",
    "browser_qa.reasoning_effort",
    "browser_qa.backend",
    "browser_qa.approve",
    "writer.provider",
    "writer.model",
    "writer.reasoning_effort",
    "writer.service_tier",
    "jev.LANE_JEV_EFFORT",
    "jev.LANE_OPENCODE_JEV",
    "ops.max_tasks",
    "ops.poll_interval",
    "ops.heartbeat_interval",
    "ops.retry_backoff",
    "ops.run_dir",
    "ops.project_cwd",
    "ops.task_id",
    "ops.task_file",
    "ops.idle",
    "ops.max_runtime",
    "ops.pool_size",
    "ops.verify_pool_size",
    "ops.command_timeout",
    "ops.watch_timeout",
    "ops.tail_source",
    "ops.tail_lines",
    "ops.events_limit",
    "run.gate",
    "install.LANE_INSTALL_LOCAL_MARKETPLACE",
    "install.LANE_INSTALL_CLAUDE_PLUGIN",
    "install.CLAUDE_CONFIG_DIR",
    "install.CODEX_HOME",
    "ui.language",
    "docs.enabled",
    "docs.maintain",
    "docs.page_cap",
    "docs.since",
    "docs.hour",
    "docs.provider",
    "docs.model",
    "docs.reasoning_effort",
    "docs.service_tier",
    "memory.enabled",
    "memory.provider",
    "memory.maintain",
    "memory.inject",
    "memory.audience",
    "memory.personal_bot",
    "memory.search_engine",
    "memory.core_budget",
    "memory.note_budget",
    "memory.index_budget",
    "memory.context_budget",
}

LEGACY_READONLY_KEYS = {"writer.fast_mode", "adoc.098", "adoc.099", "adoc.100", "adoc.102", "adoc.117", "adoc.276", "adoc.277", "adoc.278", "adoc.279", "adoc.281", "adoc.282"}

SETTING_CATALOG_KEYS = CONSUMER_KEYS | LEGACY_READONLY_KEYS | {
    "plan_critique.mode",
    "plan_critique.enabled",
    "plan_critique.provider",
    "plan_critique.model",
    "night_review.model",
    "night_review.enabled",
    "night_review.max_fix_tasks",
    "night_review.auto_merge",
    "night_review.provider",
    "night_review.agent",
    "specialist.enabled",
    "specialist.when",
    "specialist.provider",
    "specialist.model",
    "specialist.reasoning_effort",
    "adoc.040",
    "adoc.041",
    "adoc.042",
    "docs.enabled",
    "docs.maintain",
    "docs.page_cap",
    "docs.since",
    "docs.hour",
}

EDITABLE_RATIONALE = {
    "writer.provider": "W-DIRECT --provider on run-controller/lane-ctl start (bin/run-controller:1681, bin/lane-ctl:3403)",
    "writer.model": "W-DIRECT --model on run-controller/lane-ctl start (bin/run-controller:1686, bin/lane-ctl:3405)",
    "writer.reasoning_effort": "W-DIRECT --reasoning-effort on run-controller/lane-ctl start (bin/run-controller:1688, bin/lane-ctl:3407)",
    "writer.service_tier": "W-DIRECT --service-tier on run-controller/lane-ctl start (bin/run-controller:1694, bin/lane-ctl:3413)",
    "jev.LANE_JEV_EFFORT": "ENV-PASSTHROUGH LANE_JEV_EFFORT; controls pre-dispatch classification and retry effort escalation (profiles/opencode/opencode-lane/index.ts:111; server.ts:824)",
    "jev.LANE_OPENCODE_JEV": "ENV-PASSTHROUGH LANE_OPENCODE_JEV into writer subprocess (profiles/opencode/opencode-lane/jev.ts:37)",
    "ops.max_tasks": "OPS-DIRECT --max-tasks on lane-ctl start (bin/lane-ctl:3449)",
    "ops.poll_interval": "OPS-DIRECT --poll-interval on run-controller run/start/watch (bin/run-controller:1677)",
    "ops.heartbeat_interval": "OPS-DIRECT --heartbeat-interval on run-controller run/start (bin/run-controller:1678)",
    "ops.retry_backoff": "OPS-DIRECT --retry-backoff on run-controller run/start (bin/run-controller:1679)",
    "ops.run_dir": "OPS-DIRECT --run-dir on run-controller/lane-ctl (bin/run-controller:1672, bin/lane-ctl:3389)",
    "ops.project_cwd": "OPS-DIRECT --project-cwd on run-controller run/start (bin/run-controller:1673)",
    "ops.task_id": "OPS-DIRECT --task-id on lane-ctl (bin/lane-ctl:3390)",
    "ops.task_file": "OPS-DIRECT --task-file on lane-ctl start/verify/accept (bin/lane-ctl:3401)",
    "ops.idle": "OPS-DIRECT --idle on lane-ctl start (bin/lane-ctl:3424)",
    "ops.max_runtime": "OPS-DIRECT --max-runtime on lane-ctl start (bin/lane-ctl:3431)",
    "ops.pool_size": "OPS-DIRECT --pool-size on lane-ctl start (bin/lane-ctl:3440)",
    "ops.verify_pool_size": "OPS-DIRECT --verify-pool-size on lane-ctl verify (bin/lane-ctl:3510)",
    "ops.command_timeout": "OPS-DIRECT --command-timeout on lane-ctl verify (bin/lane-ctl:3521)",
    "ops.watch_timeout": "OPS-DIRECT --timeout on run-controller watch (bin/run-controller:1743)",
    "ops.tail_source": "OPS-DIRECT --source on lane-ctl tail (bin/lane-ctl:3465)",
    "ops.tail_lines": "OPS-DIRECT --lines on lane-ctl tail (bin/lane-ctl:3466)",
    "ops.events_limit": "OPS-DIRECT --limit on lane-ctl events (bin/lane-ctl:3478)",
    "install.LANE_INSTALL_LOCAL_MARKETPLACE": "INSTALL-ENV LANE_INSTALL_LOCAL_MARKETPLACE read by install.sh (install.sh:216)",
    "install.LANE_INSTALL_CLAUDE_PLUGIN": "INSTALL-ENV LANE_INSTALL_CLAUDE_PLUGIN read by install.sh (install.sh:354)",
    "install.CLAUDE_CONFIG_DIR": "INSTALL-ENV CLAUDE_CONFIG_DIR read by install.sh (install.sh:362)",
    "install.CODEX_HOME": "INSTALL-ENV CODEX_HOME read by install.sh (install.sh:8)",
    "ui.language": "OWN Lane Pilot UI locale; not an upstream flag",
}

LEGACY_READONLY_RATIONALE = {
    "writer.fast_mode": "Legacy fast-mode values migrate to writer.service_tier: true selects fast and false selects standard; shown in Diagnostics only (bin/run-controller:1703-1707, bin/lane-ctl:3196-3200)",
    "adoc.098": "The native onboarding preview exposes this provider/model-stage behavior as the independently editable onboarding.model control; this legacy upstream key is diagnostic only (server.ts:1846)",
    "adoc.099": "The native onboarding preview exposes this effort-stage behavior as the independently editable onboarding.reasoning_effort control; this legacy upstream key is diagnostic only (server.ts:1906)",
    "adoc.100": "The native onboarding preview exposes this tier-stage behavior as the independently editable onboarding.service_tier control; this legacy upstream key is diagnostic only (server.ts:1909)",
    "adoc.102": "The native onboarding preview exposes this role-stage behavior as the independently editable onboarding.agent control; this legacy upstream key is diagnostic only (server.ts:1884)",
    "adoc.117": "The grouped upstream docs provider/model/effort/tier controls are independently editable as native docs.* settings s355-s358; this aggregate legacy key is diagnostic only (server.ts:1810)",
    "adoc.276": "The native writer stage receives a typed task-v2 object rather than a filesystem task_file positional argument; required task fields are validated before dispatch (src/task-v2.ts:33)",
    "adoc.277": "The native task project_cwd is resolved into the immutable attempt workspace before execution and verification (server.ts:911)",
    "adoc.278": "Writer dispatch accepts an optional invocation-time baseRef, freezes its resolved commit per task, and applies the committed merge-base path diff through the same run ownership gate; no project setting or task-v2 field is added (server.ts:1441; src/verification/git-ownership.ts)",
    "adoc.279": "Every writer attempt compares an initial workspace snapshot with post-run changes and validates ownership; the legacy opt-out flag is not exposed (server.ts:1085)",
    "adoc.281": "The attempt baseline is stored as path/hash snapshots in the Lane Pilot database rather than a caller-selected JSON file path (src/database.ts:574)",
    "adoc.282": "The writer stage records the baseline before dispatch and uses it for the ownership gate; no external write-dirt-baseline path is exposed (server.ts:910)",
}

GAP_NO_CONSUMER = (
    "Lane Pilot Mode 2 does not invoke this binary/file; no typed run-controller/lane-ctl/"
    "install.sh/env channel (E1)"
)

PATH_LINE_RE = re.compile(r"[A-Za-z0-9_./{}*-]+:\d+")


def parse_matrix():
    text = MATRIX.read_text()
    rows = []
    for line in text.splitlines():
        if not line.startswith("|") or line.startswith("|---") or "Область" in line:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 7:
            continue
        area, setting, location, category, decision, channel, status = cells[:7]
        if area.startswith("#"):
            continue
        rows.append(
            {
                "area": area,
                "setting": setting,
                "location": location,
                "category": category,
                "matrix_decision": decision,
                "matrix_channel": channel,
                "matrix_status": status,
            }
        )
    return rows


def status_bucket(status: str) -> str:
    s = status.lower()
    if s.startswith("редактируется"):
        return "editable"
    if s.startswith("только чтение"):
        return "readonly"
    if s.startswith("исключено"):
        return "excluded"
    return "unknown"


def channel_kind(channel: str, status: str) -> str:
    c = channel
    if "ENV-PASSTHROUGH" in c:
        return "ENV-PASSTHROUGH"
    if "W-DIRECT" in c and status_bucket(status) == "editable":
        return "W-DIRECT"
    if "OPS-DIRECT" in c and status_bucket(status) == "editable":
        return "OPS-DIRECT"
    if "INSTALL-ENV" in c and status_bucket(status) == "editable":
        return "INSTALL-ENV"
    if status_bucket(status) == "editable" and "собственн" in c.lower():
        return "OWN"
    if status_bucket(status) == "excluded":
        return "N/A"
    return "NONE"


def parse_int_range(values: str) -> tuple[int | None, int | None]:
    m = re.search(r"(\d+)\s*[-–]\s*(\d+)", values or "")
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None


def control_type(inv_type: str, values: str) -> str:
    t = (inv_type or "").lower()
    if t in {"flag", "bool"} or values.lower() in {"on/off", "true/false"}:
        return "switch"
    if t.startswith("enum"):
        return "select"
    if t == "int":
        lo, hi = parse_int_range(values)
        if lo is not None:
            return "slider"
        return "number"
    if t == "path":
        return "path"
    return "input"


def enum_options(values: str) -> list[str]:
    if not values:
        return []
    raw = values.split("(")[0]
    parts = re.split(r"[,/]", raw)
    out = []
    for p in parts:
        p = p.strip()
        if not p or p.lower() in {"any", "n/a", "see", "fixed"}:
            continue
        if " " in p and len(p) > 24:
            continue
        out.append(p)
    return out[:24]


def upstream_writer_choices(storage_key: str) -> list[str] | None:
    """Read UI enum choices from the pinned upstream source, never inventory prose."""
    controller = read_upstream("bin/run-controller") or ""
    lane_ctl = read_upstream("bin/lane-ctl") or ""
    if storage_key == "writer.provider":
        match = re.search(r"^PRIMARY_MODELS\s*=\s*(\{.*?^\})", controller, re.M | re.S)
        if not match:
            return None
        try:
            return list(ast.literal_eval(match.group(1)).keys())
        except (SyntaxError, ValueError):
            return None
    if storage_key == "writer.reasoning_effort":
        match = re.search(r"^REASONING_EFFORTS\s*=\s*(\([^\n]+\))", controller, re.M)
        if not match:
            return None
        try:
            return list(ast.literal_eval(match.group(1)))
        except (SyntaxError, ValueError):
            return None
    if storage_key == "writer.service_tier":
        return ["standard", "fast"] if 'choices=("standard", "fast")' in controller else None
    if storage_key == "ops.tail_source":
        match = re.search(r"^TAIL_SOURCES\s*=\s*(\{.*?^\})", lane_ctl, re.M | re.S)
        if not match:
            return None
        try:
            return list(ast.literal_eval(match.group(1)).keys())
        except (SyntaxError, ValueError):
            return None
    return None


def upstream_effort_pairs() -> dict[str, str] | None:
    controller = read_upstream("bin/run-controller") or ""
    match = re.search(r"^PRIMARY_EFFORTS\s*=\s*(\{.*?^\})", controller, re.M | re.S)
    if not match:
        return None
    try:
        pairs = ast.literal_eval(match.group(1))
    except (SyntaxError, ValueError):
        return None
    choices = upstream_writer_choices("writer.reasoning_effort") or []
    if not isinstance(pairs, dict) or any(v not in choices for v in pairs.values()):
        return None
    return pairs


def upstream_provider_effort_choices() -> dict[str, list[str]] | None:
    tui = read_upstream("bin/agents_doctor_tui.py") or ""
    match = re.search(r"^WRITER_EFFORTS:\s*dict\[str,\s*list\[str\]\]\s*=\s*(\{.*?^\})", tui, re.M | re.S)
    if not match:
        return None
    try:
        mapping = ast.literal_eval(match.group(1))
    except (SyntaxError, ValueError):
        return None
    providers = upstream_writer_choices("writer.provider") or []
    generic = upstream_writer_choices("writer.reasoning_effort") or []
    result = {provider: mapping[provider] for provider in providers if provider in mapping}
    if set(result) != set(providers) or any(not values or not set(values).issubset(generic) for values in result.values()):
        return None
    return result


def check_upstream_enum_catalog() -> None:
    source = (ROOT / "src/ui-catalog.ts").read_text()
    checked = 0
    for line in source.splitlines():
        if 'uiStatus:"editable"' not in line or 'control:"select"' not in line:
            continue
        key_match = re.search(r'storageKey:"([^"]+)"', line)
        options_match = re.search(r'options:(\[.*?\]),min:', line)
        if not key_match or not options_match:
            raise SystemExit(f"cannot inspect editable enum row: {line[:120]}")
        if 'channel:"OWN"' in line:
            continue
        key = key_match.group(1)
        try:
            options = json.loads(options_match.group(1))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"invalid options for {key}: {exc}") from exc
        if key == "ui.language":
            expected = ["en", "ru"]
        else:
            expected = upstream_writer_choices(key)
            if expected is None:
                raise SystemExit(f"editable enum {key} has no choices extracted from pinned upstream")
        if options != expected:
            raise SystemExit(f"{key}: UI options {options!r} differ from upstream choices {expected!r}")
        if any(value in {"auto", "WRITER_CHOICES", "WRITE_STAGE_PROVIDERS", "WRITER_EFFORTS[writer]", "doctor.available_writers"} for value in options):
            raise SystemExit(f"placeholder choice found for {key}: {options!r}")
        checked += 1
    pairs = upstream_effort_pairs()
    providers = upstream_writer_choices("writer.provider")
    provider_efforts = upstream_provider_effort_choices()
    if not pairs or not providers or not set(pairs).issubset(providers) or not provider_efforts:
        raise SystemExit("cannot extract valid provider-to-effort pairs from upstream PRIMARY_EFFORTS")
    table_match = re.search(r"export const WRITER_EFFORT_CHOICES_BY_PROVIDER(?::[^=]+)? = (\{.*?\});", source)
    if not table_match:
        raise SystemExit("generated provider-to-effort UI choices table is missing")
    generated_table = json.loads(table_match.group(1))
    if generated_table != provider_efforts:
        raise SystemExit(f"provider-to-effort UI choices differ from upstream TUI choices: {generated_table!r} != {provider_efforts!r}")
    print(f"editable_enum_rows={checked}; provider_choices={len(providers)}; effort_choices={len(upstream_writer_choices('writer.reasoning_effort') or [])}; provider_effort_pairs={len(provider_efforts)}")


def locations(location: str) -> list[tuple[str, str]]:
    found = []
    for m in re.finditer(r"([\w./-]+\.\w+):([\d,.-]+)", location):
        found.append((m.group(1), m.group(2)))
    return found


def read_upstream(rel: str) -> str | None:
    path = UPSTREAM / rel
    if path.is_file():
        return path.read_text(errors="replace")
    return None


def grep_line(rel: str, needles: list[str]) -> int | None:
    text = read_upstream(rel)
    if not text:
        return None
    lowered = [(n, n.lower()) for n in needles if n]
    for i, line in enumerate(text.splitlines(), 1):
        low = line.lower()
        for raw, needle in lowered:
            if raw in line or needle in low:
                return i
    return None


def first_existing(relatives: list[str]) -> str | None:
    for rel in relatives:
        if read_upstream(rel) is not None:
            return rel
    return None


def path_line_evidence(raw: str, location: str, setting: str) -> str:
    for candidate in (raw, location):
        if candidate and PATH_LINE_RE.search(candidate):
            match = PATH_LINE_RE.search(candidate)
            return match.group(0) if match else candidate
    text = f"{raw} {location}"
    line_word = re.search(r"([\w./{}*-]+\.\w+)\s+line\s+(\d+)", text, re.I)
    if line_word:
        return f"{line_word.group(1)}:{line_word.group(2)}"
    brace = re.search(r"([\w./-]+/)\{([^}]+)\}(\.\w+)", text)
    if brace:
        first = brace.group(2).split(",")[0].strip()
        rel = f"{brace.group(1)}{first}{brace.group(3)}"
        n = grep_line(rel, [setting.split()[0], "mode:", "temperature"]) or 1
        return f"{rel}:{n}"
    if "*.md" in text:
        rel = first_existing([
            "profiles/opencode/agents/lane-writer.md",
            "profiles/opencode/agents/lane-reviewer.md",
        ]) or "profiles/opencode/agents/lane-writer.md"
        n = grep_line(rel, [setting.split()[0], "temperature", "permission"]) or 1
        return f"{rel}:{n}"
    named = re.search(r"([\w./-]+\.\w+)(?:\s+\([^)]*\))?", text)
    if named:
        rel = named.group(1)
        if rel.startswith("n/a"):
            rel = "install.sh"
        if "winnow" in text and "config" in text:
            rel = first_existing([
                "plugins/lane-stack/winnow/sidecar/src/winnow/config.py",
                "plugins/lane-stack/winnow/sidecar/src/winnow/cli.py",
            ]) or rel
        if rel.endswith("pipeline_stages.py") and not rel.startswith("bin/"):
            rel = "bin/pipeline_stages.py"
        token = setting.split()[0].split("/")[0].replace("`", "")
        n = grep_line(rel, [token, setting[:24], '"pools"', '"gate"', '"score"', '"risk"', "pm_read"]) or 1
        return f"{rel}:{n}"
    if "install.sh" in text.lower() or text.lower().startswith("n/a"):
        n = grep_line("install.sh", ["uninstall", "DRY_RUN", "FORCE", ".bak"]) or 1
        return f"install.sh:{n}"
    return f"{location}:1"


def md_cell(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def snippet_evidence(rel: str, linespec: str) -> str:
    text = read_upstream(rel)
    if text is None:
        return f"{rel}:{linespec} (file missing in upstream copy)"
    lines = text.splitlines()
    first = re.split(r"[-–,]", linespec)[0]
    try:
        n = int(first)
    except ValueError:
        return f"{rel}:{linespec}"
    lo = max(1, n - 2)
    hi = min(len(lines), n + 2)
    return f"{rel}:{n}"


def candidate_flags(setting: str) -> list[str]:
    raw = setting.strip()
    raw = re.sub(r"\([^)]*\)", "", raw).strip()
    flags = []
    if raw.startswith("--"):
        flags.append(raw.split()[0].split("/")[0])
    else:
        name = raw.split()[0].rstrip(",")
        if name and not name.startswith("--"):
            flags.append("--" + name.replace("_", "-").replace(".", "-"))
            if "." in name:
                flags.append("--" + name.split(".")[-1].replace("_", "-"))
    return [f.lower() for f in flags if len(f) > 3]


GENERIC_FLAGS = {"--provider", "--model", "--mode", "--enabled", "--score", "--agent", "--fast"}


def has_argparse_for(setting: str, rel: str) -> tuple[bool, str | None]:
    text = read_upstream(rel)
    if not text:
        return False, None
    flags = [f for f in candidate_flags(setting) if f not in GENERIC_FLAGS]
    if not flags:
        return False, None
    for i, line in enumerate(text.splitlines(), 1):
        if "add_argument" not in line:
            continue
        low = line.lower()
        for flag in flags:
            if f'"{flag}"' in low or f"'{flag}'" in low or f"{flag} " in low or f"{flag}\"" in low:
                return True, f"{rel}:{i}"
    return False, None


def has_env_read(setting: str, rel: str) -> tuple[bool, str | None]:
    text = read_upstream(rel)
    if not text:
        return False, None
    names = []
    token = setting.split()[0]
    if token.isupper() or token.startswith(("LANE_", "AGENT_", "CLAUDE_", "CODEX_")):
        names.append(token)
    for i, line in enumerate(text.splitlines(), 1):
        if "environ" not in line and "getenv" not in line:
            continue
        for name in names:
            if name and name in line:
                return True, f"{rel}:{i}"
    return False, None


def binary_name(rel: str) -> str:
    return Path(rel).name


def audit_readonly(row: dict, inv: dict) -> dict:
    """Classify a V1 read-only row against upstream v1.38.0."""
    locs = locations(row["location"]) or locations(inv.get("location", ""))
    files = [rel for rel, _ in locs] or []
    evidence = [snippet_evidence(rel, spec) for rel, spec in locs] or [row["location"]]

    # task-v2 cannot accept extra adoc keys
    task_hit = False

    argparse_hits = []
    env_hits = []
    invoked = []
    tui_only = True
    for rel, spec in locs:
        name = binary_name(rel)
        if rel not in TUI_ONLY_FILES and name not in {"agents_doctor_tui.py"}:
            tui_only = False
        if name in BINARIES_LANE_PILOT_INVOKES or rel.startswith("install.sh") or rel.endswith("install.sh"):
            invoked.append(rel)
        ok, ev = has_argparse_for(row["setting"], rel)
        if ok:
            argparse_hits.append(ev)
        ok, ev = has_env_read(row["setting"], rel)
        if ok:
            env_hits.append(ev)

    # Also search likely consumer binaries for the setting name
    extra_search = []
    setting_l = row["setting"].lower()
    if "night" in setting_l:
        extra_search.append("bin/night-shift")
    if "plan_critique" in setting_l or "plan-critique" in setting_l:
        extra_search.append("bin/plan-critique")
    if "browser_qa" in setting_l or "browser-qa" in setting_l:
        extra_search += ["bin/browser-qa-codex", "bin/browser-qa-jev"]
    if "pm_read" in setting_l:
        extra_search.append("bin/pm_read.py")
    if any(k in setting_l for k in ("workspace", "worktree", "session_max")):
        extra_search += ["bin/routing_profile.py", "bin/run-init"]
    if row["setting"].startswith("LANE_") or row["setting"].startswith("AGENT_"):
        extra_search += ["bin/lane-session", "hooks/guard_shell.py"]

    for rel in extra_search:
        ok, ev = has_argparse_for(row["setting"], rel)
        if ok:
            argparse_hits.append(ev)
            if binary_name(rel) in BINARIES_LANE_PILOT_INVOKES:
                invoked.append(rel)
        ok, ev = has_env_read(row["setting"], rel)
        if ok:
            env_hits.append(ev)

    area = row["area"]
    setting = row["setting"]

    # Hook env vars: child hook process, not invoked by Lane Pilot
    if area.startswith("hooks") and "pm_read" not in area:
        return {
            "decision": "readonly",
            "channel": "NONE",
            "rationale": "read by a child hook process Lane Pilot does not invoke",
            "evidence": evidence[0],
            "kind": "b",
        }

    # TUI-only widgets: Lane Pilot never starts agents_doctor TUI
    if area.startswith("TUI "):
        return {
            "decision": "readonly",
            "channel": "NONE",
            "rationale": "TUI-only control; Lane Pilot does not launch agents-doctor TUI",
            "evidence": evidence[0],
            "kind": "b",
        }

    if "merge_claude_settings" in area:
        return {
            "decision": "readonly",
            "channel": "NONE",
            "rationale": "Claude settings merge runs only during install, not Mode 2 dispatch",
            "evidence": evidence[0],
            "kind": "b",
        }

    if area.startswith("adoc CLI"):
        return {
            "decision": "readonly",
            "channel": "NONE",
            "rationale": "Mode 2 does not invoke agents-doctor; --apply/setup are forbidden",
            "evidence": evidence[0],
            "kind": "b",
        }

    # Lane Pilot's own sandbox control applies the host policy directly; it does not
    # write or inherit the upstream global environment variable.
    if setting == "LANE_SANDBOX_BACKEND":
        return {
            "decision": "readonly",
            "channel": "NONE",
            "rationale": "Mapped to the native project sandbox.backend selector; Lane Pilot applies a verified host adapter without writing the upstream global variable",
            "evidence": "src/verification/sandbox.ts:22",
            "kind": "b",
        }

    # (a) typed channel on a binary Lane Pilot actually invokes
    if argparse_hits and invoked:
        return {
            "decision": "editable",
            "channel": "W-DIRECT",
            "rationale": "typed argv on a binary Lane Pilot invokes",
            "evidence": argparse_hits[0],
            "kind": "a",
        }
    if env_hits and invoked:
        return {
            "decision": "editable",
            "channel": "ENV-PASSTHROUGH",
            "rationale": "env var read by a binary Lane Pilot invokes",
            "evidence": env_hits[0],
            "kind": "a",
        }

    # Real on-disk / pipeline settings without a typed consumer in BB mode
    return {
        "decision": "gap",
        "channel": "NONE",
        "rationale": "no typed argv/env/temp-file in upstream v1.38.0; applying it needs an upstream or SDK contract (E1)",
        "evidence": evidence[0],
        "kind": "c",
    }


def section_id(decision: str, area: str) -> str:
    d = decision
    mapping = [
        ("Writer/Coder", "writer"),
        ("Jev", "jev"),
        ("Night Review", "night-review"),
        ("Browser QA", "browser-qa"),
        ("Docs", "docs"),
        ("Memory", "memory"),
        ("Specialist", "specialist"),
        ("Onboard", "onboard"),
        ("Stages", "stages"),
        ("Workspace", "workspace"),
        ("PM Read", "pm-read"),
        ("Language", "language"),
        ("Setup", "setup"),
        ("Run Monitor", "ops"),
        ("Guard", "guard"),
        ("Install", "setup"),
    ]
    for needle, sid in mapping:
        if needle in d:
            return sid
    # fallback from area
    area_l = area.lower()
    if "coder" in area_l or "writer" in area_l:
        return "writer"
    if "night" in area_l:
        return "night-review"
    if "browser" in area_l:
        return "browser-qa"
    if "memory" in area_l:
        return "memory"
    if "docs" in area_l:
        return "docs"
    if "work" in area_l:
        return "workspace"
    if "install" in area_l or "setup" in area_l:
        return "setup"
    if "guard" in area_l or "hook" in area_l:
        return "guard"
    if "run-controller" in area_l or "lane-ctl" in area_l or "gate-" in area_l:
        return "ops"
    if "opencode" in area_l or "jev" in area_l:
        return "jev"
    return "other"


SECTIONS_EN = {
    "writer": "Writer",
    "jev": "Jev (OpenCode)",
    "night-review": "Night review",
    "browser-qa": "Browser QA",
    "docs": "Docs stage",
    "memory": "Memory stage",
    "specialist": "Specialist stage",
    "onboard": "Onboard stage",
    "stages": "Stages",
    "workspace": "Workspace and session",
    "pm-read": "PM read guard",
    "language": "UI language",
    "setup": "Setup and installation",
    "ops": "Run operations",
    "guard": "Guard hooks",
    "other": "Other",
}
SECTIONS_RU = {
    "writer": "Писатель",
    "jev": "Jev (OpenCode)",
    "night-review": "Ночное ревью",
    "browser-qa": "Browser QA",
    "docs": "Стадия Docs",
    "memory": "Стадия Memory",
    "specialist": "Стадия Specialist",
    "onboard": "Стадия Onboard",
    "stages": "Стадии",
    "workspace": "Рабочая копия и сессия",
    "pm-read": "Ограничение чтения PM",
    "language": "Язык интерфейса",
    "setup": "Установка",
    "ops": "Операции запуска",
    "guard": "Хуки защиты",
    "other": "Прочее",
}


def redact_machine_paths(text: str) -> str:
    hub = "/".join(("", "home", "ubuntu"))
    users = "/" + "Users"
    text = re.sub(re.escape(hub) + r"(?:/[A-Za-z0-9._~+/-]*)?", "~", text)
    text = re.sub(re.escape(users) + r"/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._~+/-]*)?", "~", text)
    return text


def js_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def js_key(s: str) -> str:
    if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", s):
        return s
    return js_str(s)


def main() -> None:
    inventory = json.loads(SETTINGS.read_text())["settings"]
    matrix = parse_matrix()
    assert len(inventory) == 355, len(inventory)
    assert len(matrix) == 355, len(matrix)

    inv_keys = [(r["area"], r["setting"], r["location"], r["category"]) for r in inventory]
    mat_map = {(r["area"], r["setting"], r["location"], r["category"]): r for r in matrix}
    assert set(inv_keys) == set(mat_map), "tuple mismatch settings.json vs matrix"
    matrix_ordered = [mat_map[k] for k in inv_keys]

    schema = json.loads(TASK_SCHEMA.read_text())
    assert schema.get("additionalProperties") is False

    catalog = []
    counts = Counter()
    kind_counts = Counter()

    for i, (inv, mat) in enumerate(zip(inventory, matrix_ordered)):
        bucket = status_bucket(mat["matrix_status"])
        ch = channel_kind(mat["matrix_channel"], mat["matrix_status"])
        lo, hi = parse_int_range(inv.get("values") or "")
        sid = section_id(mat["matrix_decision"], inv["area"])
        audit = None
        decision = bucket
        rationale = mat["matrix_status"]
        evidence = mat["location"]
        storage_key = RUNTIME_KEY_BY_TUPLE.get((inv["area"], inv["setting"]), f"adoc.{i:03d}")
        if storage_key in LEGACY_READONLY_KEYS:
            decision = "readonly"
            ch = "NONE"
            rationale = LEGACY_READONLY_RATIONALE[storage_key]
            evidence = path_line_evidence(rationale, inv["location"], inv["setting"])
        elif bucket == "readonly":
            audit = audit_readonly(mat, inv)
            decision = audit["decision"]
            ch = audit["channel"] if audit["decision"] == "editable" else "NONE"
            rationale = audit["rationale"]
            evidence = audit["evidence"]
            kind_counts[audit["kind"]] += 1
            if decision == "editable" and storage_key not in CONSUMER_KEYS:
                decision = "gap"
                ch = "NONE"
                rationale = GAP_NO_CONSUMER
                kind_counts["a"] -= 1
                kind_counts["c"] += 1
        elif bucket == "editable":
            if storage_key in CONSUMER_KEYS:
                rationale = EDITABLE_RATIONALE.get(storage_key, "typed runtime channel from matrix V1")
                evidence = path_line_evidence(rationale, inv["location"], inv["setting"])
                if storage_key.startswith("install."):
                    ch = "INSTALL-ENV"
                elif storage_key.startswith("jev."):
                    ch = "ENV-PASSTHROUGH"
                elif storage_key.startswith("ops."):
                    ch = "OPS-DIRECT"
                elif storage_key == "ui.language" or storage_key.endswith(".agent"):
                    ch = "OWN"
                else:
                    ch = "W-DIRECT"
            elif inv["setting"].startswith("--apply-project"):
                decision = "readonly"
                ch = "NONE"
                rationale = "Mode 2 forbids agents-doctor --apply; install.sh --apply-project is not used (install.sh:491, E2)"
                evidence = "install.sh:491"
            else:
                decision = "gap"
                ch = "NONE"
                rationale = GAP_NO_CONSUMER
                evidence = path_line_evidence(mat["location"], inv["location"], inv["setting"])
        else:
            rationale = mat["matrix_decision"]
            evidence = inv["location"]

        if (inv["area"], inv["setting"]) in {
            ("routing_profile.py", "DEFAULT_WORKTREE_MIN_SCORE"),
            ("routing_profile.py", "DEFAULT_SESSION_MAX_TASKS"),
        }:
            if storage_key == "adoc.041":
                decision = "editable"
                ch = "OWN"
                rationale = "Native Lane Pilot workspace router consumes the project risk threshold from CAS settings"
                evidence = "server.ts:758-761"
            else:
                decision = "editable"
                ch = "OPS-DIRECT"
                rationale = "Native CLI run settings carry this project-scoped task cap to lane-ctl --max-tasks"
                evidence = "server.ts:641; src/channels.ts:52"

        if (inv["area"], inv["setting"]) == ("retry gate", "LANE_JEV_EFFORT"):
            decision = "readonly"
            ch = "NONE"
            rationale = "Native writer retry escalation uses the same project LANE_JEV_EFFORT switch already editable at row 200; this alias is diagnostic, not a second UI control"
            evidence = "server.ts:825"

        native_gate_adapters = {
            156: ("The native Lane Pilot critique controls at rows 78-80 execute the hidden upstream settings through a versioned task-risk policy; the upstream TUI is not invoked", "server.ts:332; src/stages/critique.ts:18"),
            272: ("BB stage and gate telemetry is stored in an append-only project ledger and exposed through lane_pilot_gate_report; the legacy global file-path/off switch is intentionally not written or honored", "src/database.ts:155; server.ts:3154; src/stages/gate-report.ts:58"),
            280: ("The writer ownership gate loads all validated task contracts in the run and evaluates attempt changes against the union of owns_paths while preserving the union of never_touch", "server.ts:1116; src/verification/ownership.ts:52; tests/verification/ownership.test.ts"),
            283: ("Native PM gate-report tool accepts this invocation-time 1-365 day window; it reads the append-only project stage-event ledger", "server.ts:3041; src/stages/gate-report.ts:8"),
            284: ("Native PM gate-report exposes the exact upstream owns-paths, validate, accept, and verification categories over a project-scoped append-only gate-evaluation ledger", "server.ts:3050; src/database.ts:178; src/stages/gate-report.ts:8"),
            285: ("Lane Pilot replaces arbitrary --log path selection with its project-scoped append-only stage-event ledger; no user path is read or written", "src/database.ts:154; src/stages/gate-report.ts:44"),
            286: ("Native gate-triage tool accepts this invocation-time 1-365 day window and persists its model analysis as a stage receipt", "server.ts:3049; src/stages/gate-triage.ts:1"),
            287: ("Native gate-triage accepts a BB model ID and validates it against the live host provider/model catalog", "server.ts:3049; server.ts:2114"),
            288: ("Native gate-triage accepts reasoning effort and rejects levels the selected BB model does not support", "server.ts:3049; server.ts:2119"),
            289: ("The BB adapter spawns a native provider thread instead of invoking an arbitrary Codex executable path", "server.ts:2114; server.ts:2122"),
            290: ("Gate-triage repair uses the configured night_review BB provider/model/effort/tier; the native night-fix stage validates that selection against the live host catalog", "server.ts:2293; server.ts:2313; server.ts:2321"),
            291: ("Gate-triage auto-merge uses the existing night_review.auto_merge control; actual merges remain behind the managed-worktree, approved-PR, passing-checks, and mergeability gates in runNightFix", "server.ts:2325; server.ts:2347; src/stages/night-fix.ts:39"),
            292: ("Gate triage is read-only by construction; it has no repair or merge action, so dry-run/no-repair is always enforced", "src/stages/gate-triage.ts:13; server.ts:3052"),
            293: ("GATE_TRIAGE_CODEX_BIN is intentionally not consumed; Lane Pilot uses the BB provider/model API and never launches this executable", "server.ts:2114; server.ts:2122"),
            331: ("Run-v2 provider pool is a read-only run snapshot of the native ops.pool_size control; writer dispatch acquires a bounded per-run provider slot", "server.ts:1277; src/stages/run-policy.ts:10"),
            332: ("Run-v2 verification pool is a read-only run snapshot of ops.verify_pool_size; sandbox verification executes with that bounded concurrency", "server.ts:1025; src/stages/run-policy.ts:10"),
            334: ("Run-v2 score is derived from validated TaskV2 risk by the versioned task-risk adapter and is persisted in the stage/acceptance receipt", "server.ts:1174; src/stages/run-policy.ts:29"),
            335: ("Run-v2 risk is derived from validated TaskV2 risk; critical is represented as high while the source risk remains in the plugin receipt; upstream schemas stay unchanged", "server.ts:1174; src/stages/run-policy.ts:29"),
            336: ("The aggregate run workspace fields map to project settings adoc.040/.041/.042 plus per-attempt resolved workspace decision persisted with CAS", "server.ts:788; server.ts:887; server.ts:910; src/workspace/routing.ts:27"),
        }
        if i in native_gate_adapters:
            decision, ch = "readonly", "NONE"
            rationale, evidence = native_gate_adapters[i]

        # These upstream inventory rows are aggregate/legacy aliases.  Their
        # behavior is implemented by Lane Pilot's native controls below; keep
        # the source row visible as read-only instead of claiming it is outside
        # the executable catalog.
        if i == 45:  # adoc capabilities/profile write: pm_read.*
            decision, ch = "readonly", "NONE"
            rationale = "Aggregate upstream pm_read.* row; Lane Pilot exposes and executes the individual project settings at rows 258-263 through the native PM-read stage"
            evidence = "server.ts:300-315; src/stages/pm-read.ts"
        elif i == 65:  # routing_profile.py: LANE_SANDBOX_BACKEND
            decision, ch = "readonly", "NONE"
            rationale = "Legacy global backend alias; Lane Pilot executes the project-scoped verified sandbox.backend selector at row 365 and does not write the upstream global environment variable"
            evidence = "src/verification/sandbox.ts:22; server.ts:299"

        options = enum_options(inv.get("values") or "")
        default_value = redact_machine_paths(inv.get("default") or "")
        choices = upstream_writer_choices(storage_key) if decision == "editable" and storage_key not in {"ui.language", "writer.model"} else None
        if decision == "editable" and control_type(inv.get("type") or "", inv.get("values") or "") == "select" and storage_key not in {"ui.language", "writer.model"}:
            if not choices:
                decision = "gap"
                ch = "NONE"
                rationale = "enum choices are not extractable from the pinned upstream consumer; typed choices contract required (E1)"
                evidence = inv["location"]
            else:
                options = choices
                if storage_key == "writer.provider" and default_value not in choices:
                    default_value = "kimi" if "kimi" in choices else choices[0]
        elif choices:
            options = choices
            if default_value not in choices:
                default_value = choices[0]

        # These are Lane Pilot native settings, consumed by its stage runner;
        # they are not forwarded to the upstream CLI.
        if storage_key in {"plan_critique.provider", "plan_critique.model", "plan_critique.reasoning_effort", "plan_critique.service_tier", "plan_critique.agent", "plan_critique.min_score", "plan_critique.min_write_tasks", "plan_critique.on_high_risk"}:
            decision, ch = "editable", "OWN"
            rationale = "Native Lane Pilot plan-critique stage consumes this project setting and validates provider/model/effort/tier against the live BB catalog"
            evidence = "server.ts:runPlanCritique"
            if storage_key == "plan_critique.provider":
                options, default_value = [], ""
            elif storage_key == "plan_critique.model":
                options, default_value = [], ""
            elif storage_key == "plan_critique.reasoning_effort":
                options, default_value = [], "medium"
            elif storage_key == "plan_critique.service_tier":
                options, default_value = ["standard", "fast"], "standard"
            elif storage_key == "plan_critique.min_score":
                rationale = "Native Lane Pilot critique policy applies the pinned score threshold to the versioned task-risk adapter"
                options, default_value = [">=0"], "7"
            elif storage_key == "plan_critique.min_write_tasks":
                rationale = "Native Lane Pilot critique policy counts non-review TaskV2 lanes in the run before dispatch"
                options, default_value = [">=1"], "3"
            elif storage_key == "plan_critique.on_high_risk":
                rationale = "Native Lane Pilot critique policy runs for high or critical TaskV2 risk when enabled"
                options, default_value = ["true", "false"], "true"
            else:
                options, default_value = [], "plan-critic"
        elif storage_key.startswith("browser_qa."):
            decision, ch = "editable", "OWN"
            rationale = "Native Browser QA stage consumes this setting and records the selected backend and runner verdict in its receipt"
            evidence = "server.ts:runBrowserQa"
            if storage_key == "browser_qa.enabled":
                options, default_value = ["true", "false"], "false"
            elif storage_key == "browser_qa.provider":
                options, default_value = ["jev", "codex"], "jev"
            elif storage_key == "browser_qa.model":
                options, default_value = [], ""
            elif storage_key == "browser_qa.reasoning_effort":
                options, default_value = [], "medium"
            elif storage_key == "browser_qa.backend":
                options, default_value = ["chrome-qa", "headless", "live-chrome"], "chrome-qa"
            elif storage_key == "browser_qa.approve":
                options, default_value = ["auto", "never"], "auto"
        elif storage_key == "plan_critique.enabled":
            decision, ch = "editable", "OWN"
            rationale = "Native Lane Pilot setting consumed by the plan-critique stage runner"
            evidence = "server.ts:runPlanCritique"
            options, default_value = ["true", "false"], "true"
        elif storage_key == "plan_critique.mode":
            decision, ch = "editable", "OWN"
            rationale = "Native Lane Pilot setting selects advisory or gate behavior for plan critique"
            evidence = "server.ts:runPlanCritique"
            options, default_value = ["advisory", "gate"], "gate"
        elif storage_key == "run.gate":
            decision, ch = "editable", "OWN"
            rationale = "Native Lane Pilot snapshots this run policy at activation and blocks before automated stage or writer dispatch when operator review is required"
            evidence = "server.ts:719; server.ts:1428; src/database.ts:312"
            options, default_value = ["none", "pre-merge"], "none"
        elif storage_key.startswith("specialist."):
            decision, ch = "editable", "OWN"
            rationale = "Native Lane Pilot specialist-review stage setting; provider and model selections are checked against the BB provider catalog before dispatch"
            evidence = "server.ts:297"
            if storage_key == "specialist.enabled":
                options, default_value = ["true", "false"], "false"
            elif storage_key == "specialist.when":
                options, default_value = ["high_risk", "always"], "high_risk"
            elif storage_key == "specialist.provider":
                options, default_value = ["agy", "grok", "qwen", "kimi", "codex", "cursor", "opencode"], "codex"
            elif storage_key == "specialist.model":
                default_value = ""
            elif storage_key == "specialist.reasoning_effort":
                default_value = "high"
            elif storage_key == "specialist.agent":
                default_value = "specialist-reviewer"
        elif storage_key.startswith("night_review."):
            decision, ch = "editable", "OWN"
            rationale = "Native Lane Pilot night-review stage setting; selection is validated against the live BB provider catalog before dispatch"
            evidence = "server.ts:runNightReview"
            if storage_key == "night_review.enabled":
                options, default_value = ["true", "false"], "false"
            elif storage_key == "night_review.provider":
                rationale = "Native Lane Pilot stage uses the BB ProviderModelPicker to configure night-review provider/model/reasoning/tier"
                evidence = "server.ts:save_night_review_selection,runNightReview"
                options, default_value = [], ""
            elif storage_key in {"night_review.model", "night_review.reasoning_effort", "night_review.service_tier"}:
                rationale = "Native Lane Pilot stage uses the BB ProviderModelPicker to configure night-review provider/model/reasoning/tier"
                evidence = "server.ts:save_night_review_selection,runNightReview"
            elif storage_key == "night_review.agent":
                default_value = "lane-reviewer"
            elif storage_key == "night_review.max_fix_tasks":
                options, default_value = ["clamp 1-10"], "5"
        elif storage_key == "adoc.040":
            decision, ch = "editable", "OWN"
            rationale = "Native workspace routing: in_place uses the configured path; worktree provisions a managed BB worktree; auto selects managed isolation"
            evidence = "server.ts:596"
            options, default_value = ["in_place", "worktree", "auto"], "auto"
        elif storage_key in {"adoc.041", "adoc.042"}:
            decision, ch = "editable", "OWN"
            rationale = "Native task-level workspace router applies this setting before writer spawn and persists the decision with attempt CAS"
            evidence = "server.ts:spawnWriterAttempt"
            if storage_key == "adoc.041":
                options, default_value = ["0-10"], "4"
            else:
                options, default_value = ["true", "false"], "true"
        elif storage_key.startswith("docs."):
            decision, ch = "editable", "OWN"
            rationale = "Native Lane Pilot docs-maintenance stage consumes this project setting; inputs are limited to docs/ and apps/ Markdown with hash-CAS writes"
            evidence = "server.ts:runDocsMaintenance"
            if storage_key in {"docs.enabled", "docs.maintain"}:
                options, default_value = ["true", "false"], "false" if storage_key == "docs.enabled" else "true"
            elif storage_key == "docs.since":
                options, default_value = ["yesterday", "24 hours ago", "7 days ago"], "yesterday"
            elif storage_key == "docs.page_cap":
                options, default_value = [], "0"
            elif storage_key == "docs.hour":
                options, default_value = [], "5"
            elif storage_key == "docs.agent":
                default_value = "docs-maintainer"
        elif storage_key.startswith("memory."):
            decision, ch = "editable", "OWN"
            rationale = "Native Lane Pilot memory stage consumes this isolated project setting; durable records stay in the plugin database and are never written to user .agents files"
            evidence = "server.ts:runMemoryMaintenance,spawnWriterAttempt"
            if storage_key == "memory.provider":
                rationale = "Native Lane Pilot stage uses the BB ProviderModelPicker to configure its memory provider/model/reasoning/tier"
                evidence = "server.ts:save_memory_selection,runMemoryMaintenance"
            elif storage_key in {"memory.enabled","memory.maintain","memory.inject"}:
                options, default_value = ["true", "false"], {"memory.enabled":"false","memory.maintain":"true","memory.inject":"true"}[storage_key]
            elif storage_key == "memory.audience":
                options, default_value = ["owner","subagent","export"], "subagent"
            elif storage_key == "memory.personal_bot":
                rationale = "Native Lane Pilot memory retrieval and maintenance use this per-project bot partition; blank selects shared project memory without reading user bot files"
                evidence = "server.ts:runMemoryMaintenance,runMemoryContext,spawnWriterAttempt"
                options, default_value = ["", "claude", "codex", "grok", "qwen", "kimi", "agy", "cursor"], ""
            elif storage_key == "memory.search_engine":
                options, default_value = ["auto","fts5","bm25"], "auto"
            elif storage_key == "memory.core_budget":
                options, default_value = [], "3072"
            elif storage_key == "memory.note_budget":
                options, default_value = [], "8000"
            elif storage_key == "memory.index_budget":
                options, default_value = [], "65536"
            elif storage_key == "memory.context_budget":
                options, default_value = [], "2500"
            elif storage_key == "memory.agent":
                default_value = "memory-maintainer"
        elif storage_key == "writer.agent":
            decision, ch = "editable", "OWN"
            rationale = "Native Lane Pilot writer stage consumes this bounded role label in the BB prompt"
            evidence = "server.ts:writerPrompt"
            default_value = "lane-writer"
        elif storage_key.startswith("pm_read."):
            decision, ch = "editable", "OWN"
            rationale = "Native Lane Pilot PM-read stage consumes this per-project setting before critique and writing"
            evidence = "server.ts:runPmRead"
            if storage_key == "pm_read.enabled":
                options, default_value = ["true", "false"], "false"
            elif storage_key == "pm_read.min_lines":
                options, default_value = ["clamp 50-5000"], "350"
            elif storage_key in {"pm_read.provider", "pm_read.model"}:
                default_value = ""
            elif storage_key == "pm_read.reasoning_effort":
                options, default_value = ["low", "medium", "high", "xhigh", "max"], "low"
            elif storage_key == "pm_read.service_tier":
                options, default_value = ["standard", "fast"], "standard"

        # Keep the upstream gate-triage auto-merge row as a diagnostic alias;
        # the sole editable control is night_review.auto_merge, consumed by runNightFix.
        if (inv["area"], inv["setting"]) == ("gate scripts", "gate-triage --auto-merge"):
            decision, ch = "readonly", "NONE"
            rationale = "Gate-triage auto-merge uses the existing night_review.auto_merge control; actual merges remain behind the managed-worktree, approved-PR, passing-checks, and mergeability gates in runNightFix"
            evidence = "server.ts:2325; server.ts:2347; src/stages/night-fix.ts:39"
        if (inv["area"], inv["setting"]) == ("gate scripts", "gate-triage --repair-provider"):
            decision, ch = "readonly", "NONE"
            rationale = "Gate-triage repair uses the configured night_review BB provider/model/effort/tier; the native night-fix stage validates that selection against the live host catalog"
            evidence = "server.ts:2293; server.ts:2313; server.ts:2321"
        if i == 14:  # legacy adoc CLI plan-critique provider flag
            decision, ch = "readonly", "NONE"
            rationale = "Legacy plan-critique provider flag maps to the native project control at row 75; the BB stage validates the chosen provider/model against the live host catalog"
            evidence = "server.ts:335; server.ts:733"
        elif i == 18:  # legacy adoc CLI browser-QA effort flag
            decision, ch = "readonly", "NONE"
            rationale = "Legacy browser-QA effort flag maps to the native typed project control at row 125; the stage validates configured effort against the selected provider/model"
            evidence = "server.ts:1869; src/stages/browser-qa.ts:127"
        elif i == 97:  # upstream onboard provider is equivalent to the native preview selection
            decision, ch = "readonly", "NONE"
            rationale = "Upstream onboarding provider maps to the sole native onboarding.provider control at row 359; the BB preview validates provider/model against the live host catalog"
            evidence = "server.ts:2084-2114; server.ts:2946-2960"
        elif i == 101:  # upstream onboarding depth shares the native preview's fast/deep scope
            decision, ch = "readonly", "NONE"
            rationale = "Upstream onboarding depth maps to the sole native onboarding.depth control at row 364; fast/deep scopes the bounded BB onboarding preview"
            evidence = "server.ts:2084; src/stages/onboarding.ts:18-23"
        elif i == 304:  # run-controller status receipt format is machine-only and mandatory
            decision, ch = "excluded", "N/A"
            rationale = "Required machine-readable output for run-controller status (--json is argparse-required); Lane Pilot consumes structured receipts and has no user-selectable status format"
            evidence = "bin/run-controller:1738-1742; server.ts:1739"
        elif i == 44:  # upstream project-profile UI language is not the plugin locale
            decision, ch = "excluded", "N/A"
            rationale = "Upstream ui.language is written into the project capabilities/routing profile for agents-doctor TUI; Lane Pilot locale is a plugin-wide BB preference with BB document-language auto-detection, so mapping the project field would change its scope"
            evidence = "bin/agents-doctor:709-711; bin/agents_doctor_tui.py:17,3314; server.ts:704"
        elif i == 71:  # fixed gate-triage heuristic, not an input setting
            decision, ch = "excluded", "N/A"
            rationale = "Fixed internal path normalizer, not a user setting. The native critique stage implements bounded PLAN/SPEC path ownership, sibling/text references, direct GitNexus caller impact, and TaskV2 structural checks; stale index and scan-budget exhaustion are reported as truncated partial coverage. This helper itself has no independent user control"
            evidence = "bin/pipeline_stages.py:68,883-885,925,942; src/stages/gate-triage.ts:18-23"
        elif i == 126:  # service tier in the upstream CLI is writer-only
            decision, ch = "excluded", "N/A"
            rationale = "The upstream CLI exposes one top-level --service-tier for writer dispatch; Browser QA has no stage-specific tier argument or consumer, and Lane Pilot's typed browser runner does not accept a tier"
            evidence = "bin/agents-doctor:1484-1498; bin/pipeline_stages.py:641; src/stages/browser-qa.ts:127"
        elif i == 251:  # installer flags do not exist in the pinned source
            decision, ch = "excluded", "N/A"
            rationale = "The pinned dd77 installer has no DRY_RUN or FORCE environment contract; Lane Pilot installation is driven by explicit typed operations with ownership, snapshot and hash-CAS checks"
            evidence = "install.sh:1-EOF (no DRY_RUN/FORCE references); src/coexistence/contracts.ts:operation"
        elif i == 235:  # OpenCode command argument hint is fixed markdown metadata
            decision, ch = "excluded", "N/A"
            rationale = "Static OpenCode slash-command argument-hint metadata, not a Lane Pilot setting; the command body delegates help/diagnosis/code-scope behavior to an external upstream skill and no native Lane Pilot operation consumes this hint"
            evidence = "profiles/opencode/commands/opencode-lane.md:3-16; server.ts:3110-3125"
        elif i == 330:  # lane-ctl constant is unused; lane-session has a separate consumer
            decision, ch = "excluded", "N/A"
            rationale = "The bin/lane-ctl DEFAULT_MAX_TASKS constant has only its declaration; lane-ctl --max-tasks defaults to None and resolves the routing profile. A separate lane-session DEFAULT_MAX_TASKS is consumed from LANE_SESSION_MAX_TASKS and is already represented by editable row s064"
            evidence = "bin/lane-ctl:58,3448-3455; bin/lane-session:4371-4383; server.ts:641"

        counts[decision] += 1
        row = {
            "id": f"s{i:03d}",
            "index": i,
            "area": inv["area"],
            "setting": inv["setting"],
            "location": inv["location"],
            "category": inv["category"],
            "invType": inv.get("type") or "str",
            "values": inv.get("values") or "",
            "default": default_value,
            "scope": inv.get("scope") or "",
            # Model IDs are validated by the upstream value validator and the
            # native BB ProviderModelPicker; they are free-form strings, not CLI enums.
            "control": "input" if storage_key.endswith(".agent") or storage_key in {"writer.model", "specialist.model", "specialist.reasoning_effort", "docs.page_cap", "docs.hour", "memory.provider", "memory.core_budget", "memory.note_budget", "memory.index_budget", "memory.context_budget"} else "select" if choices or storage_key.startswith("specialist.") or storage_key == "adoc.040" or storage_key in {"docs.enabled", "docs.maintain", "docs.since", "memory.enabled", "memory.maintain", "memory.inject", "memory.audience", "memory.personal_bot", "memory.search_engine", "night_review.enabled"} else control_type(inv.get("type") or "", inv.get("values") or ""),
            "options": [] if storage_key.endswith(".agent") else options,
            "min": lo,
            "max": hi,
            "section": sid if decision != "excluded" else "excluded",
            "channel": ch,
            "uiStatus": decision,
            "rationale": rationale,
            "evidence": path_line_evidence(evidence, inv["location"], inv["setting"]),
            "matrixStatus": bucket,
            "storageKey": storage_key,
        }
        catalog.append(row)

    # Four executable BB-native docs-stage settings supplement the grouped upstream row.
    docs_selection_rows = [
        ("docs.provider", "BB provider ID", "server.ts:1778"),
        ("docs.model", "BB model ID", "server.ts:1779"),
        ("docs.reasoning_effort", "Model-supported reasoning level", "server.ts:1780"),
        ("docs.service_tier", "Provider-supported service tier", "server.ts:1781"),
    ]
    for offset, (key, label, evidence) in enumerate(docs_selection_rows):
        catalog.append({
            "id": f"s{355 + offset:03d}", "index": 355 + offset,
            "area": "Lane Pilot native docs stage", "setting": key, "location": evidence,
            "category": "user", "invType": "native BB provider selection", "values": label,
            "default": "inherit writer selection", "scope": "project", "control": "input",
            "options": [], "min": None, "max": None, "section": "docs", "channel": "OWN",
            "uiStatus": "editable", "rationale": "Native docs stage selection is validated against the live BB provider/model catalog and consumed by manual and scheduled maintenance",
            "evidence": evidence, "matrixStatus": "readonly", "storageKey": key,
        })
        counts["editable"] += 1

    onboarding_rows = [
        ("onboarding.provider", "BB provider ID", "server.ts:1845", "input", []),
        ("onboarding.model", "BB model ID", "server.ts:1846", "input", []),
        ("onboarding.reasoning_effort", "Model-supported reasoning level", "server.ts:1847", "input", []),
        ("onboarding.service_tier", "Provider-supported service tier", "server.ts:1848", "input", []),
        ("onboarding.agent", "Project onboarder role name", "server.ts:1849", "input", []),
        ("onboarding.depth", "Preview depth", "server.ts:1850", "select", ["fast", "deep"]),
    ]
    for offset, (key, label, evidence, control, options) in enumerate(onboarding_rows):
        catalog.append({
            "id": f"s{359 + offset:03d}", "index": 359 + offset,
            "area": "Lane Pilot native onboarding stage", "setting": key, "location": evidence,
            "category": "user", "invType": "native BB provider selection" if key.startswith("onboarding.") and key != "onboarding.agent" and key != "onboarding.depth" else "str" if key == "onboarding.agent" else "enum",
            "values": label, "default": "inherit writer selection" if key.startswith("onboarding.") and key not in {"onboarding.agent", "onboarding.depth"} else "project-onboarder" if key == "onboarding.agent" else "fast",
            "scope": "project", "control": control, "options": options, "min": None, "max": None,
            "section": "onboard", "channel": "OWN", "uiStatus": "editable",
            "rationale": "Native onboarding preview uses live BB provider/model capabilities, bounded role/depth controls, exact preview hashes, explicit confirmation, and host compare-and-swap for writes",
            "evidence": evidence, "matrixStatus": "readonly", "storageKey": key,
        })
        counts["editable"] += 1

    catalog.append({
        "id": "s365", "index": 365,
        "area": "Lane Pilot host verification sandbox", "setting": "sandbox.backend",
        "location": "src/verification/sandbox.ts:22",
        "category": "user", "invType": "verified host backend selector",
        "values": "auto, macos-seatbelt, linux-bubblewrap", "default": "auto", "scope": "project",
        "control": "select", "options": ["auto", "macos-seatbelt", "linux-bubblewrap"], "min": None, "max": None,
        "section": "stages", "channel": "OWN", "uiStatus": "editable",
        "rationale": "Native verification stage selects Seatbelt on macOS or bubblewrap on Linux; absent backend and unprotectable workspace guard paths fail closed",
        "evidence": "src/verification/sandbox.ts:22; server.ts:998",
        "matrixStatus": "readonly", "storageKey": "sandbox.backend",
    })
    counts["editable"] += 1

    # Write TypeScript catalog
    ts_path = ROOT / "src/ui-catalog.ts"
    lines = [
        "export type UiStatus = \"editable\" | \"readonly\" | \"gap\" | \"excluded\";",
        "export type ControlKind = \"switch\" | \"select\" | \"slider\" | \"number\" | \"path\" | \"input\";",
        "export type ChannelKind = \"W-DIRECT\" | \"OPS-DIRECT\" | \"INSTALL-ENV\" | \"ENV-PASSTHROUGH\" | \"OWN\" | \"NONE\" | \"N/A\";",
        "",
        "export type CatalogRow = {",
        "  id: string;",
        "  index: number;",
        "  area: string;",
        "  setting: string;",
        "  location: string;",
        "  category: string;",
        "  invType: string;",
        "  values: string;",
        "  defaultValue: string;",
        "  scope: string;",
        "  control: ControlKind;",
        "  options: string[];",
        "  min: number | null;",
        "  max: number | null;",
        "  section: string;",
        "  channel: ChannelKind;",
        "  uiStatus: UiStatus;",
        "  rationale: string;",
        "  evidence: string;",
        "  matrixStatus: \"editable\" | \"readonly\" | \"excluded\" | \"unknown\";",
        "  storageKey: string;",
        "};",
        "",
        "export const UI_CATALOG: CatalogRow[] = [",
    ]
    for row in catalog:
        lines.append(
            "  {"
            + f"id:{js_str(row['id'])},index:{row['index']},"
            + f"area:{js_str(row['area'])},setting:{js_str(row['setting'])},"
            + f"location:{js_str(row['location'])},category:{js_str(row['category'])},"
            + f"invType:{js_str(row['invType'])},values:{js_str(row['values'])},"
            + f"defaultValue:{js_str(row['default'])},scope:{js_str(row['scope'])},"
            + f"control:{js_str(row['control'])},options:{json.dumps(row['options'])},"
            + f"min:{'null' if row['min'] is None else row['min']},max:{'null' if row['max'] is None else row['max']},"
            + f"section:{js_str(row['section'])},channel:{js_str(row['channel'])},"
            + f"uiStatus:{js_str(row['uiStatus'])},rationale:{js_str(row['rationale'])},"
            + f"evidence:{js_str(row['evidence'])},matrixStatus:{js_str(row['matrixStatus'])},"
            + f"storageKey:{js_str(row['storageKey'])}"
            + "},"
        )
    lines.append("];")
    provider_efforts = upstream_provider_effort_choices()
    if provider_efforts is None:
        raise SystemExit("cannot extract provider-dependent writer effort choices from pinned upstream")
    lines.append("export const WRITER_EFFORT_CHOICES_BY_PROVIDER: Record<string, string[]> = " + json.dumps(provider_efforts) + ";")
    lines.append("")
    lines.append("export const VISIBLE_CATALOG = UI_CATALOG.filter((row) => row.uiStatus === \"editable\" || row.uiStatus === \"readonly\" || row.uiStatus === \"gap\");")
    lines.append("export const EDITABLE_IDS = VISIBLE_CATALOG.filter((row) => row.uiStatus === \"editable\").map((row) => row.id);")
    lines.append("export const READONLY_IDS = VISIBLE_CATALOG.filter((row) => row.uiStatus === \"readonly\").map((row) => row.id);")
    lines.append("export const GAP_IDS = VISIBLE_CATALOG.filter((row) => row.uiStatus === \"gap\").map((row) => row.id);")
    lines.append("export const DISABLED_IDS = VISIBLE_CATALOG.filter((row) => row.uiStatus !== \"editable\").map((row) => row.id);")
    lines.append(
        "export const SECTION_ORDER = ["
        + ", ".join(js_str(s) for s in SECTIONS_EN)
        + "] as const;"
    )
    ts_path.write_text("\n".join(lines) + "\n")

    # Field i18n
    field_en = {}
    field_ru = {}
    for row in catalog:
        field_en[f"field_{row['id']}"] = row["setting"]
        field_ru[f"field_{row['id']}"] = row["setting"]
        field_en[f"reason_{row['id']}"] = row["rationale"]
        ru_text = {
            "typed runtime channel from matrix V1": "Есть типизированный канал runtime из матрицы V1",
            "Lane Pilot Mode 2 does not invoke this binary/file; no typed run-controller/lane-ctl/install.sh/env channel (E1)": "Mode 2 не вызывает этот бинарник/файл; нет типизированного канала run-controller/lane-ctl/install.sh/env (E1)",
            "Mode 2 forbids agents-doctor --apply; install.sh --apply-project is not used (install.sh:491, E2)": "Mode 2 запрещает agents-doctor --apply; install.sh --apply-project не используется (install.sh:491, E2)",
            "typed argv on a binary Lane Pilot invokes": "Найден типизированный argv у бинарника, который вызывает Lane Pilot",
            "env var read by a binary Lane Pilot invokes": "Переменная окружения читается бинарником, который вызывает Lane Pilot",
            "read by a child hook process Lane Pilot does not invoke": "Читает дочерний hook-процесс, который Lane Pilot не вызывает",
            "TUI-only control; Lane Pilot does not launch agents-doctor TUI": "Только TUI; Lane Pilot не запускает TUI agents-doctor",
            "PM Read Guard has no proven Mode 2 channel after stage 0": "У PM Read Guard нет доказанного канала Mode 2 после этапа 0",
            "resolve_workspace / run-init accept no override flag": "resolve_workspace и run-init не принимают override-флаг",
            "upstream argparse exists on a binary Lane Pilot does not invoke; needs dispatch contract": "У upstream есть argparse, но Lane Pilot этот бинарник не вызывает — нужен контракт диспатча",
            "no typed argv/env/temp-file; PM prompt is not a channel (E1); task-v2 additionalProperties:false": "Нет типизированного argv/env/файла; промпт PM не канал (E1); task-v2 с additionalProperties:false",
            "no typed runtime channel in upstream v1.38.0 for BB mode": "В upstream v1.38.0 нет типизированного канала для режима BB",
            "Claude settings merge runs only during install, not Mode 2 dispatch": "Слияние Claude settings только при установке, не в Mode 2",
            "Mode 2 does not invoke agents-doctor; --apply/setup are forbidden": "Mode 2 не вызывает agents-doctor; --apply/setup запрещены",
            "no typed argv/env/temp-file in upstream v1.38.0; applying it needs an upstream or SDK contract (E1)": "Нет типизированного argv/env/файла в upstream v1.38.0; применение требует контракта upstream или SDK (E1)",
            "Mapped to the native project sandbox.backend selector; Lane Pilot applies a verified host adapter without writing the upstream global variable": "Соответствует нативной настройке проекта sandbox.backend; Lane Pilot использует проверенную изоляцию хоста, не записывая глобальную переменную upstream",
            "Gate-triage auto-merge uses the existing night_review.auto_merge control; actual merges remain behind the managed-worktree, approved-PR, passing-checks, and mergeability gates in runNightFix": "Авто-слияние gate-triage использует общую настройку night_review.auto_merge; runNightFix дополнительно требует managed worktree, одобренный PR, успешные проверки и разрешимость слияния",
            "BB stage and gate telemetry is stored in an append-only project ledger and exposed through lane_pilot_gate_report; the legacy global file-path/off switch is intentionally not written or honored": "Телеметрия этапов и gate записывается в добавляемый журнал проекта BB и доступна через lane_pilot_gate_report; старый глобальный путь файла и переключатель off намеренно не записываются и не применяются",
            "Gate-triage repair uses the configured night_review BB provider/model/effort/tier; the native night-fix stage validates that selection against the live host catalog": "Исправление gate-triage использует общую настройку night_review для BB-провайдера, модели, effort и tier; native night-fix проверяет выбор по актуальному каталогу хоста",
            "OWN Lane Pilot UI locale; not an upstream flag": "Собственная локаль интерфейса Lane Pilot, не флаг upstream",
            "Native Lane Pilot snapshots this run policy at activation and blocks before automated stage or writer dispatch when operator review is required": "Lane Pilot сохраняет политику в записи запуска и останавливает автоматические этапы до старта writer, если требуется решение оператора",
        }.get(row["rationale"])
        if ru_text is None:
            key = row["storageKey"]
            ru_text = f"Типизированный канал {key}" if key in CONSUMER_KEYS else row["rationale"]
        field_ru[f"reason_{row['id']}"] = ru_text
        if row["storageKey"] == "plan_critique.enabled":
            field_en[f"field_{row['id']}"] = "Run plan critique before writing"
            field_ru[f"field_{row['id']}"] = "Запускать критику плана перед записью"
            field_ru[f"reason_{row['id']}"] = "Собственная настройка Lane Pilot, которую читает исполняемый этап критики плана"
        elif row["storageKey"] == "plan_critique.mode":
            field_en[f"field_{row['id']}"] = "Plan critique behavior"
            field_ru[f"field_{row['id']}"] = "Режим критики плана"
            field_ru[f"reason_{row['id']}"] = "Собственная настройка Lane Pilot: advisory продолжает запись, gate блокирует её при запрошенных исправлениях"
        elif row["storageKey"] == "plan_critique.min_score":
            field_en[f"field_{row['id']}"] = "Minimum critique score"
            field_ru[f"field_{row['id']}"] = "Минимальный балл для критики"
            field_en[f"reason_{row['id']}"] = "Run critique when the task-risk score reaches this threshold; risk scores use the documented task-risk-v1 adapter"
            field_ru[f"reason_{row['id']}"] = "Запускать критику при достижении порога; оценка риска использует документированный адаптер task-risk-v1"
        elif row["storageKey"] == "plan_critique.min_write_tasks":
            field_en[f"field_{row['id']}"] = "Minimum write tasks"
            field_ru[f"field_{row['id']}"] = "Минимум задач записи"
            field_en[f"reason_{row['id']}"] = "Run critique when the persisted run contains this many non-review TaskV2 lanes"
            field_ru[f"reason_{row['id']}"] = "Запускать критику, когда в сохранённом запуске столько задач TaskV2 вне этапов проверки и ревью"
        elif row["storageKey"] == "plan_critique.on_high_risk":
            field_en[f"field_{row['id']}"] = "Critique high-risk tasks"
            field_ru[f"field_{row['id']}"] = "Критиковать задачи высокого риска"
            field_en[f"reason_{row['id']}"] = "When enabled, run critique for high or critical TaskV2 risk even below the score and task-count thresholds"
            field_ru[f"reason_{row['id']}"] = "При включении критика запускается для высокого и критического риска даже ниже порогов балла и числа задач"
        elif row["storageKey"] == "sandbox.backend":
            field_en[f"field_{row['id']}"] = "Host sandbox backend"
            field_ru[f"field_{row['id']}"] = "Изолированное исполнение на хосте"
            field_en[f"reason_{row['id']}"] = "Select auto, macOS Seatbelt, or Linux bubblewrap; missing backend or protected workspace paths fail closed"
            field_ru[f"reason_{row['id']}"] = "Выберите auto, macOS Seatbelt или Linux bubblewrap; при отсутствии backend или защищаемых путей запуск блокируется"
        elif row["index"] in {283,285,286,287,288,289,292,293,336}:
            labels={283:("gate-report lookback days","Период отчёта gate-report, дни"),285:("gate-report event source","Источник событий gate-report"),286:("gate-triage lookback days","Период анализа gate-triage, дни"),287:("gate-triage BB model","Модель BB для gate-triage"),288:("gate-triage reasoning effort","Уровень рассуждений gate-triage"),289:("Codex binary path","Путь к бинарнику Codex"),292:("Read-only / dry-run policy","Политика только чтения / dry-run"),293:("GATE_TRIAGE_CODEX_BIN","GATE_TRIAGE_CODEX_BIN"),336:("Run workspace settings and effective decision","Настройки рабочей копии запуска и применённое решение")}
            field_en[f"field_{row['id']}"]=labels[row["index"]][0]
            field_ru[f"field_{row['id']}"]=labels[row["index"]][1]
            russian_reasons={
                283:"Штатный инструмент PM принимает период от 1 до 365 дней и читает append-only журнал стадий проекта",
                285:"Путь к произвольному файлу заменён проектным append-only журналом; сторонние пути не читаются и не записываются",
                286:"Штатный инструмент gate-triage принимает период анализа от 1 до 365 дней и сохраняет результат как stage receipt",
                287:"Инструмент принимает ID модели BB и сверяет его с доступным каталогом моделей на хосте",
                288:"Инструмент принимает уровень рассуждений и отклоняет уровни, не поддерживаемые выбранной моделью BB",
                289:"BB адаптер запускает штатный поток провайдера вместо произвольного бинарника Codex",
                292:"Gate triage всегда работает только для чтения и не имеет действий исправления или слияния",
                293:"Переменная GATE_TRIAGE_CODEX_BIN не используется: Lane Pilot вызывает API провайдера BB",
                336:"Поля рабочей копии сопоставлены настройкам проекта и фактическому решению на попытку, которое записывается через CAS",
            }
            field_ru[f"reason_{row['id']}"]=russian_reasons[row["index"]]
        elif row["storageKey"] == "adoc.040":
            field_en[f"field_{row['id']}"] = "Workspace isolation"
            field_ru[f"field_{row['id']}"] = "Изоляция рабочей копии"
            field_ru[f"reason_{row['id']}"] = "Настройка Lane Pilot: in_place использует выбранный путь, worktree создаёт управляемую BB рабочую копию, auto выбирает изоляцию"
        elif row["storageKey"] == "run.gate":
            field_en[f"field_{row['id']}"] = "Run gate"
            field_ru[f"field_{row['id']}"] = "Ограничение запуска"
            field_ru[f"reason_{row['id']}"] = "Политика фиксируется при запуске; pre-merge блокирует автоматические этапы и writer до решения оператора"
        elif row["storageKey"] == "adoc.041":
            field_en[f"field_{row['id']}"] = "Worktree risk threshold"
            field_ru[f"field_{row['id']}"] = "Порог риска для worktree"
            field_ru[f"reason_{row['id']}"] = "Порог управляет созданием task-level managed worktree до запуска писателя"
        elif row["storageKey"] == "adoc.042":
            field_en[f"field_{row['id']}"] = "Isolate multi-output tasks"
            field_ru[f"field_{row['id']}"] = "Изолировать задачи с несколькими файлами"
            field_ru[f"reason_{row['id']}"] = "Включает managed worktree для задач, создающих несколько ожидаемых файлов"
        elif row["storageKey"].startswith("pm_read."):
            names = {
                "pm_read.enabled": ("Run PM read before critique", "Запускать чтение PM перед критикой"),
                "pm_read.min_lines": ("Minimum read_first lines", "Минимум строк read_first"),
                "pm_read.provider": ("PM read provider ID", "ID провайдера PM read"),
                "pm_read.model": ("PM read model ID", "ID модели PM read"),
                "pm_read.reasoning_effort": ("PM read reasoning effort", "Уровень рассуждения PM read"),
                "pm_read.service_tier": ("PM read service tier", "Тариф PM read"),
            }
            field_en[f"field_{row['id']}"], field_ru[f"field_{row['id']}"] = names[row["storageKey"]]
            field_ru[f"reason_{row['id']}"] = "Настройка Lane Pilot для исполняемой стадии чтения PM; значения хранятся отдельно для проекта"
    for sid, title in SECTIONS_EN.items():
        field_en[f"section_{sid}"] = title
        field_ru[f"section_{sid}"] = SECTIONS_RU[sid]

    fields_path = ROOT / "src/i18n-fields.ts"
    fields_path.write_text(
        "export const fieldEn = {\n"
        + ",\n".join(f"  {js_key(k)}: {js_str(v)}" for k, v in field_en.items())
        + ",\n} as const;\n\n"
        + "export const fieldRu: { [K in keyof typeof fieldEn]: string } = {\n"
        + ",\n".join(f"  {js_key(k)}: {js_str(field_ru[k])}" for k in field_en)
        + ",\n};\n"
    )

    # Applicability markdown
    docs = ROOT / "docs"
    docs.mkdir(exist_ok=True)
    md = []
    md.append("---")
    md.append("title: Lane Pilot adoc applicability")
    md.append("schema_version: agency-artifact/1.0")
    md.append("artifact_id: art_lane_pilot_adoc_applicability")
    md.append("artifact_type: inventory")
    md.append("status: in_review")
    md.append("language: ru")
    md.append("---")
    md.append("")
    md.append("# Применимость настроек adoc к режиму BB")
    md.append("")
    md.append(f"Источник: `settings.json` AG-179 @2 и матрица AG-186 @2, 355 строк. Upstream v1.38.0 `{UPSTREAM.name}` SHA `747a9ff9b2fa4ffdcf5c65c8d07eff2b9386a821`.")
    md.append("")
    md.append("88 строк «только чтение» — промежуточное ограничение прототипа, не сокращение заказа полной интеграции. Каждая строка получила решение (a)/(b)/(c). «PM пишет в prompt» каналом не считается (E1). task-v2: `additionalProperties:false`.")
    md.append("")
    md.append("| Решение | Число |")
    md.append("|---|---:|")
    md.append(f"| editable | {counts['editable']} |")
    md.append(f"| read-only | {counts['readonly']} |")
    md.append(f"| gap | {counts['gap']} |")
    md.append(f"| excluded | {counts['excluded']} |")
    md.append(f"| **сумма** | **{sum(counts.values())}** |")
    md.append("")
    md.append(f"Из бывших 88 read-only: (a) канал найден и поле стало editable — {kind_counts['a']}; (b) неприменимо в BB — {kind_counts['b']}; (c) gap без контракта upstream/SDK — {kind_counts['c']}.")
    md.append("")
    md.append("| # | area | setting | location | category | канал | решение | обоснование |")
    md.append("|---:|---|---|---|---|---|---|---|")
    for row in catalog:
        md.append(
            "| "
            + " | ".join([
                str(row["index"]),
                md_cell(row["area"]),
                md_cell(row["setting"]),
                md_cell(row["location"]),
                md_cell(row["category"]),
                md_cell(row["channel"]),
                md_cell(row["uiStatus"]),
                f"{md_cell(row['rationale'])} (`{row['evidence']}`)",
            ])
            + " |"
        )
    (docs / "adoc-applicability.md").write_text("\n".join(md) + "\n")

    summary = {
        "rows": len(catalog),
        "editable": counts["editable"],
        "readonly": counts["readonly"],
        "gap": counts["gap"],
        "excluded": counts["excluded"],
        "from88": dict(kind_counts),
        "tuple_equal": True,
        "blank": 0,
    }
    missing_line = [row for row in catalog if not PATH_LINE_RE.search(row["evidence"])]
    if missing_line:
        raise SystemExit(f"evidence without path:line: {[r['index'] for r in missing_line[:8]]}")
    mapped = {row["storageKey"] for row in catalog}
    missing_runtime = sorted(SETTING_CATALOG_KEYS - mapped)
    if missing_runtime:
        raise SystemExit(f"SETTING_CATALOG keys missing from UI storageKey: {missing_runtime}")
    summary["runtime_keys"] = sorted(SETTING_CATALOG_KEYS & mapped)
    (ROOT / "src/ui-catalog.summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    if sys.argv[1:] == ["--check-upstream-enums"]:
        check_upstream_enum_catalog()
    else:
        main()
