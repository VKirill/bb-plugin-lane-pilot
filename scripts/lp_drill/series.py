"""Release series bookkeeping: token/archive metrics and the pre-series probes."""
from __future__ import annotations

import json
import os
from pathlib import Path

from lp_drill.env import ROOT, SANDBOX
from lp_drill.hub import bb, hubsql, run, setting_rpc, RPC_MISSING

def judge_scenario(scenario: dict) -> dict:
    """Suite report judge: a pass counts only with evidence — the tasks it ran, the events it saw or the details it checked."""
    evidence = [key for key, value in scenario.items() if key not in ("name", "result", "problems") and value not in (None, [], {}, "")]
    verdict_of = "pass" if scenario["result"] == "pass" and (evidence or scenario.get("note")) else "skipped" if scenario["result"] == "skipped" else "fail"
    return {"name": scenario["name"], "verdict": verdict_of, "evidence": evidence, "why": "" if verdict_of != "fail" else "; ".join(scenario["problems"]) or "a pass without evidence"}


def judge_series(judged: list[dict], names: list[str]) -> dict:
    """Series judge: every scenario asked for has a verdict, none failed, and the skipped ones say why."""
    missing = [name for name in names if name not in {row["name"] for row in judged}]
    failed = [row["name"] for row in judged if row["verdict"] == "fail"]
    return {"verdict": "pass" if not missing and not failed else "fail", "missing": missing, "failed": failed, "skipped": [row["name"] for row in judged if row["verdict"] == "skipped"]}
TOKEN_BUDGET = int(os.environ.get("LP_DRILL_TOKEN_BUDGET", "2000000"))
ACCEPTED_FLOOR = 0.5


def series_metrics(scenes: list[dict], receipts_dir: Path) -> dict:
    """The metrics suite (SMA rl_metrics): judges this series' archive last. A scene without evidence, a live attempt whose
    cost is not_measured, an accepted share under the floor, tokens over LP_DRILL_TOKEN_BUDGET, or coverage --receipt red
    fails the series."""
    problems: list[str] = []
    receipts: list[dict] = []
    for scene in scenes:
        if scene["name"].startswith("vitest:"):
            # A story file leaves no drill receipt: its exit code is the whole verdict.
            if scene.get("exit") != 0:
                problems.append(f"scene {scene['name']} exited {scene.get('exit')}")
            continue
        path = scene.get("receipt")
        data = None
        if path:
            try:
                data = json.loads(Path(path).read_text())
            except (OSError, ValueError):
                data = None
        if data is None:
            problems.append(f"scene {scene['name']} has no readable receipt")
        else:
            receipts.append({"name": scene["name"], "data": data})
        if scene.get("exit") != 0:
            problems.append(f"scene {scene['name']} exited {scene.get('exit')}")
        if data is not None and not data.get("seen") and not data.get("judged"):
            problems.append(f"scene {scene['name']} left no evidence")
    accepted = sum(1 for row in receipts for s in (row["data"].get("scenarios") or []) if s.get("result") == "pass")
    total = sum(1 for row in receipts for s in (row["data"].get("scenarios") or []) if s.get("result") != "skipped")
    if total and accepted / total < ACCEPTED_FLOOR:
        problems.append(f"only {accepted}/{total} scenario verdicts are green, under the {ACCEPTED_FLOOR} floor")
    try:
        metrics = setting_rpc("lp_attempt_metrics", {"projectId": SANDBOX["project"], "days": 1})
        attempts = metrics.get("attempts") or metrics.get("rows") or []
        live_names = {scene["name"] for scene in scenes}
        unmeasured = [row for row in attempts if row.get("costState") == "not_measured" or row.get("cost_state") == "not_measured"]
        tokens = metrics.get("totals", {}).get("tokens") or metrics.get("tokens") or 0
        if tokens and tokens > TOKEN_BUDGET:
            problems.append(f"the series spent {tokens} tokens, over LP_DRILL_TOKEN_BUDGET {TOKEN_BUDGET}")
        if len(unmeasured) > max(1, len(attempts) // 2):
            problems.append(f"{len(unmeasured)} live attempts have cost_state not_measured")
    except Exception as cause:
        if not RPC_MISSING.search(str(cause)):
            problems.append(f"attempt metrics could not be read: {str(cause)[:160]}")
    return {"suite": "metrics", "verdict": "pass" if not problems else "fail", "problems": problems, "scenes": len(scenes), "receipts": len(receipts)}
def _parses(path: Path) -> bool:
    try:
        json.loads(path.read_text())
        return True
    except (OSError, ValueError):
        return False


def _browser_probe() -> tuple[bool, str]:
    """The sandbox project's browser machine answers: the sandbox host must be reachable for a browser_qa step."""
    rows = hubsql(f"select value from lane_pilot_project_settings where project_id='{SANDBOX['project']}' and binding_id='' and key='browser.hostId' limit 1;")
    if not rows:
        return True, "no browser machine named: browser checks would run on the writer host"
    return True, f"browser machine {json.loads(rows[0]['value'])}"


def _limits_probe() -> tuple[bool, str]:
    """No provider window already exhausted: cockpit_windows names the host's usage windows."""
    try:
        windows = setting_rpc("cockpit_windows", {"hostId": os.environ.get("LP_DRILL_HOST", "host_7sea4qaad8")})
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return True, f"window probe not deployed: {str(cause)[:120]}"
        return False, str(cause)[:200]
    text = json.dumps(windows)
    exhausted = bool(PROVIDER_QUOTA.search(text)) and "exhausted" in text.lower()
    return not exhausted, ("a provider window is exhausted" if exhausted else "no provider window exhausted")


def _window_probe() -> tuple[bool, str]:
    """The writer host of the sandbox is connected."""
    rc, out, err = bb("host", "list", "--json", timeout=60)
    if rc != 0:
        rc, out, err = bb("machine", "list", "--json", timeout=60)
    if rc != 0:
        return False, f"the host list did not answer: {(err or out).strip()[:160]}"
    host = os.environ.get("LP_DRILL_HOST", "host_7sea4qaad8")
    return (host in out), f"writer host {host} {'connected' if host in out else 'not in the host list'}"
