"""Release series bookkeeping: token/archive metrics and the pre-series probes."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from lp_drill.env import ROOT, SANDBOX
from lp_drill.hub import bb, hubsql, run, setting_rpc, RPC_MISSING
from lp_drill.scenes.providers import PROVIDER_QUOTA, providers_in_use

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


# Scenes that open a window: skills_screen presses the access page whenever an address is named (LP_DRILL_UI_URL or an
# LP_DRILL_UI_ACCESS_URL with {project}); live_word presses Approve only where a window is named or LP_DRILL_LIVE_PRESS=1 asks for it.
BROWSER_SCENES = {"skills_screen"}


def _browser_probe(names: list[str] | None = None) -> tuple[bool, str]:
    """The sandbox project's browser machine answers: the sandbox host must be reachable for a browser_qa step. A series that runs a
    window scene and has neither a browser machine (browser.hostId) nor a window named (LP_DRILL_UI_URL / LP_DRILL_UI_ACCESS_URL) is
    refused: the scene would be skipped or press a window that is not there."""
    rows = hubsql(f"select value from lane_pilot_project_settings where project_id='{SANDBOX['project']}' and binding_id='' and key='browser.hostId' limit 1;")
    if rows:
        return True, f"browser machine {json.loads(rows[0]['value'])}"
    if os.environ.get("LP_DRILL_UI_URL", "").strip() or "{project}" in os.environ.get("LP_DRILL_UI_ACCESS_URL", ""):
        return True, "a window is named (LP_DRILL_UI_URL / LP_DRILL_UI_ACCESS_URL)"
    asked = set(names or []) & BROWSER_SCENES
    if names and "live_word" in names and os.environ.get("LP_DRILL_LIVE_PRESS") == "1":
        asked.add("live_word")
    if asked:
        scene = sorted(asked)[0]
        return False, (f"the series runs {', '.join(sorted(asked))}, which opens a window, and no browser machine is named "
                       f"(browser.hostId unset, no LP_DRILL_UI_URL): name one, or drop {scene} from the series")
    return True, "no browser machine named: browser checks would run on the writer host"


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


# A probe reason that means the account itself is out (over its plan, or signed out), not the probe's setup.
ACCOUNT_OUT = re.compile(r"unauthorized|\b401\b|sign.?in|log.?in|not authenticated|invalid (api|access) key", re.I)


def _capability_table() -> dict[str, dict]:
    """`bb lane-pilot capabilities` as providerId -> row. Exit 1 still prints the table: it means a red cell exists."""
    rc, out, err = bb("lane-pilot", "capabilities", timeout=60)
    if rc not in (0, 1):
        raise RuntimeError((err or out).strip()[:200] or f"exit {rc}")
    answer = json.loads(out)
    # An answer that is not the table (an older hub, another verb's output) is unreadable, not «every provider is fine».
    if not isinstance(answer, dict):
        raise RuntimeError("`bb lane-pilot capabilities` did not print its table")
    return {row.get("providerId"): row for row in (answer.get("table") or []) if isinstance(row, dict)}


def _accounts_probe() -> tuple[bool, str]:
    """Accounts (SMA rl_prep): every provider the series will use (the providers_in_use list the helper-providers scene probes)
    answers — a supported `answers` capability receipt of the installed adapter, or one cheap probe through
    `capabilities --probe` (the probe call the provider scene already makes; bounded at one pass, 60 s a provider). A provider whose
    receipt is red, or whose probe says it is over its plan or signed out, refuses the series and is named; one that could not be
    probed now (no sandbox run yet) is noted, not refused."""
    pairs = providers_in_use(SANDBOX["project"])
    try:
        table = _capability_table()
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return True, f"the capability table is not deployed: {str(cause)[:120]}"
        return False, str(cause)[:200]
    answers = lambda provider: ((table.get(provider) or {}).get("capabilities") or {}).get("answers")
    unproven = [provider for provider in pairs if answers(provider) in (None, "unproven")]
    out_of_plan: list[str] = []
    if unproven:
        rc, out, err = bb("lane-pilot", "capabilities", "--probe", timeout=max(60, 60 * len(unproven)))
        if rc not in (0, 1):
            return False, f"capabilities --probe did not answer: {(err or out).strip()[:160] or f'exit {rc}'}"
        try:
            probed = json.loads(out).get("probed") or []
        except ValueError:
            probed = []
        for row in probed:
            provider, reason = row.get("providerId"), str(row.get("reason") or "")
            if provider in pairs:
                if PROVIDER_QUOTA.search(reason):
                    out_of_plan.append(f"{provider} is over its plan ({reason[:120]})")
                elif ACCOUNT_OUT.search(reason):
                    out_of_plan.append(f"{provider} is signed out ({reason[:120]})")
        table = _capability_table()
    red = [provider for provider in pairs if answers(provider) == "not_supported"]
    refused = [f"{provider} (the answers receipt is red: `bb lane-pilot capabilities --probe` re-probes it)" for provider in red] + out_of_plan
    if refused:
        return False, "; ".join(refused) + " — sign the provider back in or take it out of the project's providers"
    still = sorted(provider for provider in pairs if answers(provider) not in ("supported", "not_supported"))
    note = f"; {', '.join(still)} could not be probed now" if still else ""
    return True, f"every provider in use answers ({', '.join(sorted(pairs))}){note}"


def _person_probe() -> tuple[bool, str]:
    """Person (SMA rl_prep): the owner is reachable — the hub has seen him in a thread of his own (the presence marks or the
    90-day journal of `bb lane-pilot owner-presence`), or the «waiting for the owner» push answers. A hub that has never seen
    the owner and cannot reach him refuses the series."""
    marks, journal = [], []
    rc, out, err = bb("lane-pilot", "owner-presence", "--journal", timeout=60)
    if rc == 0:
        try:
            journal = json.loads(out)
        except ValueError:
            journal = []
    elif not RPC_MISSING.search(err or out):
        return False, f"owner-presence did not answer: {(err or out).strip()[:160]}"
    rc2, out2, _ = bb("lane-pilot", "owner-presence", timeout=60)
    if rc2 == 0:
        try:
            marks = json.loads(out2)
        except ValueError:
            marks = []
    if marks:
        return True, f"the owner is in a session of his own now ({len(marks)} mark(s))"
    if journal:
        days = sorted(str(row.get("day", "")) for row in journal if isinstance(row, dict) and row.get("day"))
        return True, f"the hub last saw the owner in a thread of his own on {days[-1] if days else 'an earlier day'}"
    try:
        digest = setting_rpc("owner_waiting_digest", {})
        return True, f"the «waiting for the owner» push answers ({'a send pending' if digest.get('send') else 'nothing pending'})"
    except Exception as cause:
        return False, (f"the hub has never seen the owner in a thread of his own and the owner-waiting push does not answer "
                       f"({str(cause)[:120]}): type in any thread once so the series can reach him")
