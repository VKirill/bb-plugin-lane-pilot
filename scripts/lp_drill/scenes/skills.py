"""Skill scenarios: the skills screen access count and the skill file deploy."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from lp_drill.env import ROOT, STAMP
from lp_drill.hub import run, setting_rpc, RPC_MISSING
from lp_drill.report import summarize, verdict
from lp_drill.scenes.guard import sha256_of
from lp_drill.scenes.memory import thread_text
from lp_drill.scenes.owner import window_url
from lp_drill.tasks import note_task

def skills_screen_problems(report: dict) -> list[str]:
    """Window, door and disk (SMA m_sd_skills): the door lists the skill catalog, the window lists skills or explains the empty
    list, every skill file on disk survives the press, and the press narrows what a role may load."""
    problems: list[str] = []
    door = report.get("door") or {}
    if not door.get("catalog"):
        problems.append("the door (agent-access view) listed no skills")
    window = report.get("window") or {}
    if not window.get("listed") and not window.get("emptyExplained"):
        problems.append("the window showed neither skills nor the empty-list explanation")
    before, after = report.get("diskBefore") or {}, report.get("diskAfter") or {}
    changed = [path for path in set(before) | set(after) if before.get(path) != after.get(path)]
    if changed:
        problems.append(f"skill files changed after the press: {', '.join(changed[:5])}")
    if door.get("catalog") and not door.get("narrowed"):
        problems.append("the door view showed no change after a skill was removed")
    return problems


def access_skill_count(view: object) -> tuple[int, int]:
    """(skills in the catalog, skills the roles load together): a role whose skill list is open (names null) loads the whole catalog."""
    view = view if isinstance(view, dict) else {}
    catalog = len((view.get("catalog") or {}).get("skills") or [])
    loaded = 0
    for role in view.get("roles") or []:
        names = (((role or {}).get("groups") or {}).get("skills") or {}).get("names")
        loaded += catalog if names is None else len(names)
    return catalog, loaded


def access_page_url(project: str) -> str | None:
    """The window's access page of one project: LP_DRILL_UI_ACCESS_URL with `{project}` when it is set, else the team's access
    tab of the Lane Pilot page on the named window (`<LP_DRILL_UI_URL>/plugins/lane-pilot/lane-pilot/<project>/access`); None when
    no window is named. The project is always in the address: a press on the window root could change a real project."""
    template = os.environ.get("LP_DRILL_UI_ACCESS_URL", "")
    if "{project}" in template:
        return template.replace("{project}", project)
    window = window_url()
    return f"{window}plugins/lane-pilot/lane-pilot/{project}/access" if window else None


def restore_access_roles(project: str, before: list[dict]) -> list[str]:
    """Put every role's access row back to what it was (a row that did not exist is removed): the press must leave no trace."""
    problems: list[str] = []
    try:
        now = {r.get("key"): r for r in (setting_rpc("helper_access_view", {"projectId": project}).get("roles") or [])}
    except Exception as cause:
        return [f"could not read the access roles to restore them: {str(cause)[:160]}"]
    for role in before:
        current = now.get(role.get("key"))
        if current is None or (current.get("value") == role.get("value") and current.get("version") == role.get("version")):
            continue
        try:
            # A row that did not exist is removed (a stored null would hide the level below).
            if role.get("value") is None:
                saved = setting_rpc("reset_project_settings", {"projectId": project, "keys": [role["key"]], "expectedVersions": {role["key"]: current.get("version", 0)}})
            else:
                saved = setting_rpc("save_setting", {"projectId": project, "key": role["key"], "value": role.get("value"), "expectedVersion": current.get("version", 0)})
            if not saved.get("ok"):
                problems.append(f"could not restore {role['key']}: {saved}")
        except Exception as cause:
            problems.append(f"could not restore {role['key']}: {str(cause)[:160]}")
    return problems


def scenario_skills_screen(ctx: "Context") -> dict:
    """Skills screen drill (SMA m_sd_skills): the skills screen at the window, the door and on disk — an empty list is
    explained, and pressing the panel does not touch the files. The window is opened on the access page of the drill's own project
    (access_page_url: LP_DRILL_UI_ACCESS_URL, else the page's own address on the window named in LP_DRILL_UI_URL); with no
    window named nothing is clicked and the scene is reported «not run». The access rows are read first and put back in a `finally`."""
    url = access_page_url(ctx.project)
    if url is None:
        return {"name": "skills_screen", "result": "skipped", "problems": [],
                "note": f"not run: no window is named (LP_DRILL_UI_URL, or LP_DRILL_UI_ACCESS_URL with {{project}}), so no press was made on {ctx.project}"}
    report: dict = {"door": {}, "window": {}, "diskBefore": {}, "diskAfter": {}}
    problems: list[str] = []
    skills_dir = Path(ctx.cwd) / ".agents" / "skills"

    def hashes() -> dict:
        return {str(p.relative_to(skills_dir)): sha256_of(p.read_bytes()) for p in sorted(skills_dir.rglob("*")) if p.is_file()} if skills_dir.is_dir() else {}

    report["diskBefore"] = hashes()
    try:
        view = setting_rpc("helper_access_view", {"projectId": ctx.project})
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return {"name": "skills_screen", "result": "skipped", "problems": [], "note": f"not run: the access view is not deployed: {str(cause)[:160]}"}
        return verdict("skills_screen", [f"the door view could not be read: {str(cause)[:200]}"])
    catalog, loaded = access_skill_count(view)
    report["door"] = {"catalog": catalog, "loaded": loaded}
    roles_before = [dict(role) for role in (view.get("roles") or [])]
    try:
        if catalog:
            scene = ctx.tmp / f"skills-{STAMP}.json"
            scene.write_text(json.dumps({"url": url, "widths": [1280],
                                         "steps": [{"wait": 1500}, {"click": '[data-testid*="skill"] >> nth=0'}, {"wait": 500}, {"click": "text=Сохранить"}],
                                         "asserts": [], "judge": "The skills list is shown or the empty-list explanation is."}))
            rc, out, err = run(["node", str(ROOT / "scripts" / "lp-ui-drive.mjs"), str(scene)], timeout=300)
            report["window"] = {"listed": rc == 0, "emptyExplained": "empty" in (out + err).lower() or "пуст" in (out + err).lower()}
            if rc == 2:
                report["window"]["error"] = (err or out).strip()[:200]
            try:
                _, again = access_skill_count(setting_rpc("helper_access_view", {"projectId": ctx.project}))
                report["door"]["loadedAfter"] = again
                report["door"]["narrowed"] = again < loaded
            except Exception as cause:
                problems.append(f"the door view could not be read after the press: {str(cause)[:160]}")
    finally:
        problems += restore_access_roles(ctx.project, roles_before)
    report["diskAfter"] = hashes()
    problems += skills_screen_problems(report)
    return verdict("skills_screen", problems, door=report["door"], window=report["window"], diskChanged=[p for p in set(report["diskBefore"]) | set(report["diskAfter"]) if report["diskBefore"].get(p) != report["diskAfter"].get(p)])


def scenario_skills(ctx: "Context") -> dict:
    """Skills drill (SMA): a skill the PM names on a task reaches the writer's brief."""
    spec = note_task(f"drill-skill-{STAMP}", f"drills/skill-{STAMP}.md", "skill check", ctx.cwd)
    spec["skills"] = ["ru-text"]
    problems = [] if ctx.dispatch(spec) else ["dispatch-bb exited with an error"]
    rows = ctx.wait_ended([spec["id"]])
    row = summarize(rows, spec["id"], ctx.cwd, spec["expected_outputs"][0])
    writer = next((r.get("thread_id") for r in rows if r.get("thread_id")), None)
    if not writer or "ru-text" not in thread_text(writer):
        problems.append("the named skill ru-text is not in the writer's thread")
    if row["state"] != "accepted":
        problems.append(f"the task was not accepted: {row['states']} {row['reason']}")
    return verdict("skills", problems, tasks=[row])
