"""Owner-word scenes: writing/restoring the owners word, the live approval wait."""
from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

from lp_drill.env import POLL_SEC, ROOT, STAMP
from lp_drill.hub import bb, hubsql, log, run, setting_rpc
from lp_drill.report import latest_states, summarize, verdict
from lp_drill.scenes.memory import thread_text
from lp_drill.tasks import note_task

def owner_words(ctx: "Context", value: str) -> tuple[object, int]:
    saved = hubsql(f"select value, version from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='owner.words';")
    original, version = (json.loads(saved[0]["value"]), int(saved[0]["version"])) if saved else (None, 0)
    changed = setting_rpc("save_setting", {"projectId": ctx.project, "key": "owner.words", "value": value, "expectedVersion": version})
    if not changed.get("ok") and changed.get("conflict"):
        version = int(changed.get("version") or 0)
        changed = setting_rpc("save_setting", {"projectId": ctx.project, "key": "owner.words", "value": value, "expectedVersion": version})
    return original, int(changed["version"])


def restore_owner_words(ctx: "Context", original: object, version: int) -> list[str]:
    """Puts owner.words back after the live word drill and says so when it could not. The key is not a catalog setting, so
    reset_project_settings refuses it (silently, as ok:false): live 2026-10-27 the drill left it «on» and every later task, phase and the
    reload task waited six hours for the owner's word. The sandbox project's own value is «off»; a stale «on» is a leftover of an earlier drill, not a choice."""
    value = original if isinstance(original, str) and original != "on" else "off"
    saved = setting_rpc("save_setting", {"projectId": ctx.project, "key": "owner.words", "value": value, "expectedVersion": version})
    if not saved.get("ok") and saved.get("conflict"):
        saved = setting_rpc("save_setting", {"projectId": ctx.project, "key": "owner.words", "value": value, "expectedVersion": int(saved.get("version") or 0)})
    return [] if saved.get("ok") else [f"could not put owner.words back to {value}: {saved}"]


def clear_stale_owner_words(ctx: "Context") -> list[str]:
    """Before the scenarios: the sandbox project runs the machine path without the owner, so its owner.words is «off» in so many words.
    Unset means on since 2026-10-29 (src/rooms/tasks/words.ts), and a leftover «on» of an earlier drill made every task wait for the owner."""
    saved = hubsql(f"select value, version from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='owner.words';")
    if saved and json.loads(saved[0]["value"]) == "off":
        return []
    log("owner.words of the sandbox project is not off: setting it to off")
    return restore_owner_words(ctx, "off", int(saved[0]["version"]) if saved else 0)


def window_url() -> str | None:
    """The window the scenes open: the address named in LP_DRILL_UI_URL, None when no window is named. The hub's own port
    (BB_SERVER_URL) is not a window: BB answers 403 to a browser's navigation there (checked on the hub on 2026-11-11), so a
    press needs an address a signed-in browser may open."""
    base = os.environ.get("LP_DRILL_UI_URL", "").strip()
    return base.rstrip("/") + "/" if base else None


def live_word_scene(run_id: str) -> dict:
    """The scene lp-ui-drive plays for the approve press (SMA m_sd_approve): open the owner-waiting board (scope-nav-waiting) and
    click the yes button of this drill's own task. The button's test id carries the item key `task-word:<run>:<family>:...`, so
    tying the selector to the run id keeps the press off a real project's task on the same board."""
    return {"url": window_url() or "http://127.0.0.1:4173/", "widths": [1280],
            "steps": [{"wait": 1500}, {"click": '[data-testid="scope-nav-waiting"]'}, {"wait": 1000},
                      {"click": f'[data-testid^="owner-run-task-word:{run_id}:"][data-testid$="-yes"]'}],
            "asserts": [], "judge": "The owner's word landed the task."}


def live_press() -> bool:
    """The approve press through the window runs wherever a window is named (LP_DRILL_UI_URL), with no second switch;
    LP_DRILL_LIVE_PRESS=1 asks for it on the dev-window default, =0 opts out and leaves the RPC word path."""
    asked = os.environ.get("LP_DRILL_LIVE_PRESS", "")
    return asked != "0" and (asked == "1" or window_url() is not None)


def scenario_live_word(ctx: "Context") -> dict:
    """Live word drill (SMA: Live word drill, Approval drill): with owner.words on, a verified task waits for the owner's word, and lands once
    the word is given (here through the task_word RPC, the path of the screen and the CLI). Where a window is named
    (LP_DRILL_UI_URL) the word is a real press of the Approve button (LP_DRILL_LIVE_PRESS=0 opts out), and a task whose check
    fails ends blocked, offers no owner item, and an RPC yes does not land it. A window that does not open (no browser, a
    refused page) skips the press, says why in the note, and the word goes through the RPC, as without the press."""
    live = live_press()
    original, version = owner_words(ctx, "on")
    problems: list[str] = []
    press_note = ""
    row: dict = {}
    red_row: dict = {}
    try:
        spec = note_task(f"drill-word-{STAMP}", f"drills/word-{STAMP}.md", "owner word", ctx.cwd)
        specs = [spec]
        red: dict = {}
        if live:
            red = note_task(f"drill-word-red-{STAMP}", f"drills/word-red-{STAMP}.md", "owner word red", ctx.cwd)
            red["verification"] = [{"command": "exit 1", "cwd": ctx.cwd}]
            specs.append(red)
        if live:
            with ThreadPoolExecutor(2) as pool:
                sent = list(pool.map(ctx.dispatch, specs))
            if not all(sent):
                problems.append("a dispatch-bb call exited with an error")
        elif not ctx.dispatch(spec):
            problems.append("dispatch-bb exited with an error")
        deadline, waiting = time.time() + 15 * 60, False
        while time.time() < deadline and not waiting:
            waiting = "waits for the owner's word before it lands" in thread_text(ctx.pm)
            if not waiting:
                time.sleep(POLL_SEC)
        if not waiting:
            problems.append("the verified task never said it waits for the owner's word")
        elif live:
            scene = ctx.tmp / f"approve-{STAMP}.json"
            scene.write_text(json.dumps(live_word_scene(ctx.run_id)))
            rc, out, err = run(["node", str(ROOT / "scripts" / "lp-ui-drive.mjs"), str(scene)], timeout=300)
            if rc == 2:
                press_note = f"press skipped, the window did not open: {(err or out).strip()[:160]}"
                setting_rpc("task_word", {"runId": ctx.run_id, "taskId": spec["id"], "decision": "yes", "text": "да"})
            elif rc != 0:
                problems.append(f"the approve press through the window failed (exit {rc}): {(err or out).strip()[:300]}")
        else:
            setting_rpc("task_word", {"runId": ctx.run_id, "taskId": spec["id"], "decision": "yes", "text": "да"})
        rows = ctx.wait_ended([spec["id"]])
        row = summarize(rows, spec["id"], ctx.cwd, spec["expected_outputs"][0])
        if row["state"] != "accepted":
            problems.append(f"the task did not land after the word: {row['states']} {row['reason']}")
        if live:
            rows = ctx.wait_ended([red["id"]])
            red_row = summarize(rows, red["id"], ctx.cwd, red["expected_outputs"][0])
            if red_row["state"] == "accepted":
                problems.append("a task whose check failed was accepted without a word")
            red_items = hubsql(f"select count(*) as n from lane_pilot_owner_item where state='open' and key like '%{red['id']}%';")
            if red_items and red_items[0]["n"]:
                problems.append("the red task offered an owner item anyway")
            try:
                setting_rpc("task_word", {"runId": ctx.run_id, "taskId": red["id"], "decision": "yes", "text": "да"})
            except Exception:
                pass
            time.sleep(POLL_SEC)
            if latest_states(ctx.rows([red["id"]])).get(red["id"]) == "accepted":
                problems.append("an RPC yes landed the red task")
    finally:
        problems.extend(restore_owner_words(ctx, original, version))
    return verdict("live_word", problems, tasks=[t for t in (row, red_row) if t], **({"note": press_note} if press_note else {}))
