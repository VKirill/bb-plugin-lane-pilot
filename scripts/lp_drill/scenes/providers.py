"""Provider probes: providers in use, a helper on each, the bad-model rejection, the limit."""
from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor

from lp_drill.env import BAD_MODEL, POLL_SEC
from lp_drill.hub import bb, hubsql, log, put_setting, run, setting_rpc
from lp_drill.report import provider_problems, summarize, verdict
from lp_drill.tasks import task_limit, task_provider

def providers_in_use(project: str) -> dict[str, str]:
    """provider id -> a model it runs in this project: the pairs of the project's settings (`<stage>.provider` with `<stage>.model`,
    the PM model, the writer), then a fallback model for the three providers every install has. acp-cursor only when a setting names it."""
    override = os.environ.get("LP_DRILL_PROVIDERS", "").strip()
    if override:
        return dict(pair.split("=", 1) for pair in override.split(",") if "=" in pair)
    rows = hubsql(f"select key, value from lane_pilot_project_settings where project_id='{project}' and binding_id='' and (key like '%.provider' or key like '%.model' or key in ('pmModel', 'writerProviderId', 'writerModel', 'pmProviderId'));")
    values = {}
    for row in rows:
        try:
            values[row["key"]] = json.loads(row["value"])
        except ValueError:
            continue
    found: dict[str, str] = {}

    def add(provider: object, model: object) -> None:
        if isinstance(provider, str) and provider and isinstance(model, str) and model:
            found.setdefault(provider, model)

    for key, value in values.items():
        if key.endswith(".provider"):
            add(value, values.get(key[: -len(".provider")] + ".model"))
    add(values.get("pmProviderId", "claude-code"), values.get("pmModel"))
    add(values.get("writerProviderId"), values.get("writerModel"))
    for provider, model in PROVIDER_FALLBACK_MODEL.items():
        found.setdefault(provider, model)
    return found


HOST_START_FAILURE = re.compile(r"thread_command_failed|exited unexpectedly")


def scenario_helper_providers(ctx: Context) -> dict:
    """A helper on each provider in use starts and answers (audit 2026-10-08 round 3, P0-7)."""
    pairs = providers_in_use(ctx.project)

    def probe(item: tuple[str, str]) -> dict:
        provider, model = item
        rc, out, err = bb("lane-pilot", "helper-probe", ctx.project, ctx.run_id, provider, model, timeout=240)
        try:
            answer = json.loads(out)
        except ValueError:
            answer = {}
        if not isinstance(answer, dict) or "ok" not in answer:
            answer = {"ok": False, "started": False, "answered": False, "reason": (err or out).strip()[:300] or f"exit {rc}"}
        return {"provider": provider, "model": model, **{k: answer.get(k) for k in ("ok", "started", "answered", "threadId", "output", "reason", "ms")}}

    def probe_twice(item: tuple[str, str]) -> dict:
        # One more probe when only the host's thread start broke: a provider process killed once (SIGTERM on the hub, 2026-10-31,
        # deploy of 0.1.406) is not a broken provider; a broken one fails the second probe too.
        first = probe(item)
        if first["ok"] or not HOST_START_FAILURE.search(first["reason"] or ""):
            return first
        log(f"helper on {item[0]} ({item[1]}): the host's thread start failed ({first['reason']}), probing once more")
        return {**probe(item), "firstReason": first["reason"]}

    with ThreadPoolExecutor(max(1, len(pairs))) as pool:
        results = list(pool.map(probe_twice, pairs.items()))
    for item in results:
        log(f"helper on {item['provider']} ({item['model']}): started={item['started']} answered={item['answered']} {item['reason'] or ''}")
    problems, quota = helper_problems(results)
    return verdict("helper_providers", problems, providers=results, quotaExhausted=quota)


# A provider's plan ran out (opencode2 zai-coding-plan on 2026-11-01: «Weekly/Monthly Limit Exhausted. Your limit will reset at …»).
PROVIDER_QUOTA = re.compile(r"limit exhausted|insufficient_quota|usage limit|quota|rate.?limit", re.I)


def helper_problems(results: list[dict]) -> tuple[list[str], list[str]]:
    """What makes helper_providers red, and which providers only ran out of plan. A helper that started and was refused by its
    provider's quota is not a broken spawn path: it is a note on the receipt, and red only when no provider answered at all."""
    problems, quota = [], []
    for item in results:
        if item["ok"]:
            continue
        reason = item["reason"] or ""
        if item["started"] and PROVIDER_QUOTA.search(reason):
            quota.append(f"{item['provider']} ({item['model']}): {reason}")
            continue
        what = "did not start" if not item["started"] else "started but did not answer"
        problems.append(f"{item['provider']} ({item['model']}): a helper {what}: {reason or 'no reason given'}")
    if quota and not any(item["ok"] for item in results):
        problems.append("no provider answered, every one is out of plan: " + "; ".join(quota))
    return problems, quota
def scenario_provider(ctx: Context) -> dict:
    spec = task_provider(ctx.cwd)
    problems = [] if ctx.dispatch(spec) else ["dispatch-bb exited with an error"]
    rows = ctx.wait_ended([spec["id"]])
    row = summarize(rows, spec["id"], ctx.cwd, spec["expected_outputs"][0])
    if row["state"] != "accepted":
        problems.append(f"the task did not end accepted: {row['states']} {row['reason']}")
    elif not row["fileInSandbox"]:
        problems.append("the accepted task's file is not on main")
    if row["workspace"] == ctx.cwd:
        problems.append("the attempt ran in the sandbox folder, not in a worktree")
    problems += provider_problems([row])
    return verdict("provider", problems, tasks=[row])
def scenario_provider_limit(ctx: Context) -> dict:
    key = "writer.model"
    saved = hubsql(f"select value, version from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='{key}';")
    original, version = (json.loads(saved[0]["value"]), int(saved[0]["version"])) if saved else (None, 0)
    problems: list[str] = []
    row: dict = {}
    try:
        changed = setting_rpc("save_setting", {"projectId": ctx.project, "key": key, "value": BAD_MODEL, "expectedVersion": version})
        if not changed.get("ok") and changed.get("conflict"):
            # A reset row keeps its version generation (the settings table has no row, the RPC still knows version N): take the version
            # the refusal names and save once more (live 2026-10-27: version 28, value null).
            version = int(changed.get("version") or 0)
            changed = setting_rpc("save_setting", {"projectId": ctx.project, "key": key, "value": BAD_MODEL, "expectedVersion": version})
        if not changed.get("ok"):
            return verdict("provider_limit", [f"could not set {key}: {json.dumps(changed)[:200]}"])
        version = int(changed["version"])
        # Jev picks a writer per task and would never try the project's writer.model (live 2026-10-27: «the bad model was never tried»).
        pick_off = put_setting(ctx.project, "writer.pick", "off")
        if not pick_off.get("ok"):
            problems.append(f"could not turn writer.pick off: {json.dumps(pick_off)[:200]}")
        spec = task_limit(ctx.cwd)
        if not ctx.dispatch(spec):
            problems.append("dispatch-bb exited with an error")
        rows = ctx.wait_ended([spec["id"]])
        row = summarize(rows, spec["id"], ctx.cwd, spec["expected_outputs"][0])
        if row["state"] != "accepted":
            problems.append(f"the task did not end accepted through the next writer: {row['states']} {row['reason']}")
        elif row["attempts"] < 2:
            problems.append("the bad model was never tried (one attempt only): the drill did not exercise the chain")
        if row["state"] == "accepted" and not row["fileInSandbox"]:
            problems.append("the accepted task's file is not on main")
    finally:
        put_setting(ctx.project, "writer.pick", "on")  # reset refuses a non-catalog key; "on" is the default
        back = put_setting(ctx.project, key, original)
        now = hubsql(f"select value from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='{key}';")
        restored = (json.loads(now[0]["value"]) if now else None) == original
        if not restored:
            problems.append(f"{key} was NOT restored to {original!r}: {json.dumps(back)[:200]}")
    return verdict("provider_limit", problems, tasks=[row] if row else [], badModel=BAD_MODEL, restored=original)
