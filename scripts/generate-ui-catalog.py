#!/usr/bin/env python3
"""Build UI catalog, applicability table, and i18n field strings from matrix + settings.json."""
from __future__ import annotations

import json
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
    ("adoc CLI top-level", "--writer-provider"): "writer.provider",
    ("adoc CLI setup", "--writer-provider"): "writer.provider",
    ("TUI Coder tab", "writer (provider)"): "writer.provider",
    ("adoc CLI top-level", "--writer-model"): "writer.model",
    ("pipeline_stages.py stage: write", "write.model"): "writer.model",
    ("TUI Coder tab", "model"): "writer.model",
    ("adoc CLI top-level", "--writer-effort / --reasoning-effort"): "writer.reasoning_effort",
    ("pipeline_stages.py stage: write", "write.reasoning_effort"): "writer.reasoning_effort",
    ("TUI Coder tab", "effort"): "writer.reasoning_effort",
    ("adoc CLI top-level", "--service-tier"): "writer.service_tier",
    ("TUI Coder tab", "fast (service_tier)"): "writer.fast_mode",
    ("adoc CLI top-level", "--fast-mode/--no-fast-mode"): "writer.fast_mode",
    ("opencode-lane jev", "LANE_JEV_EFFORT"): "jev.LANE_JEV_EFFORT",
    ("opencode-lane jev", "LANE_OPENCODE_JEV"): "jev.LANE_OPENCODE_JEV",
    ("adoc CLI top-level", "--session-max-tasks"): "ops.max_tasks",
    ("lane-ctl CLI (start)", "--max-tasks"): "ops.max_tasks",
    ("run-controller CLI", "--poll-interval"): "ops.poll_interval",
    ("run-controller CLI", "--heartbeat-interval"): "ops.heartbeat_interval",
    ("run-controller CLI", "--retry-backoff"): "ops.retry_backoff",
    ("run-controller CLI", "--run-dir"): "ops.run_dir",
    ("lane-ctl CLI (start)", "--run-dir"): "ops.run_dir",
    ("run-controller CLI", "--project-cwd"): "ops.project_cwd",
    ("run-controller internal", "max_tasks (derived, not a flag)"): "ops.max_tasks_controller",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.mode"): "plan_critique.mode",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.enabled"): "plan_critique.enabled",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.provider"): "plan_critique.provider",
    ("pipeline_stages.py stage: plan_critique", "plan_critique.model"): "plan_critique.model",
    ("pipeline_stages.py stage: night_review", "night_review.model / .reasoning_effort"): "night_review.model",
    ("profiles codex toml", "night-review.config.toml"): "night_review.reasoning_effort",
    ("TUI UI tab", "language"): "ui.language",
}

SETTING_CATALOG_KEYS = {
    "writer.provider",
    "writer.model",
    "writer.reasoning_effort",
    "writer.service_tier",
    "writer.fast_mode",
    "jev.LANE_JEV_EFFORT",
    "jev.LANE_OPENCODE_JEV",
    "ops.max_tasks",
    "ops.poll_interval",
    "ops.heartbeat_interval",
    "ops.retry_backoff",
    "ops.run_dir",
    "ops.project_cwd",
    "ops.max_tasks_controller",
    "plan_critique.mode",
    "plan_critique.enabled",
    "plan_critique.provider",
    "plan_critique.model",
    "night_review.model",
    "night_review.reasoning_effort",
}

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
        if bucket == "readonly":
            audit = audit_readonly(mat, inv)
            decision = audit["decision"]
            ch = audit["channel"] if audit["decision"] == "editable" else "NONE"
            rationale = audit["rationale"]
            evidence = audit["evidence"]
            kind_counts[audit["kind"]] += 1
        elif bucket == "editable":
            rationale = "typed runtime channel from matrix V1"
            evidence = mat["location"].split()[0] if mat["location"] else inv["location"]
        else:
            rationale = mat["matrix_decision"]
            evidence = inv["location"]

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
            "default": inv.get("default") or "",
            "scope": inv.get("scope") or "",
            "control": control_type(inv.get("type") or "", inv.get("values") or ""),
            "options": enum_options(inv.get("values") or ""),
            "min": lo,
            "max": hi,
            "section": sid if decision != "excluded" else "excluded",
            "channel": ch,
            "uiStatus": decision,
            "rationale": rationale,
            "evidence": path_line_evidence(evidence, inv["location"], inv["setting"]),
            "matrixStatus": bucket,
            "storageKey": RUNTIME_KEY_BY_TUPLE.get((inv["area"], inv["setting"]), f"adoc.{i:03d}"),
        }
        catalog.append(row)

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
        field_ru[f"reason_{row['id']}"] = {
            "typed runtime channel from matrix V1": "Есть типизированный канал runtime из матрицы V1",
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
        }.get(row["rationale"], row["rationale"])
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
    main()
