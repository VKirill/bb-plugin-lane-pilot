"""Project settings a scene sets for its own run and puts back on every exit path (owner_words / restore_owner_words, for any key)."""
from __future__ import annotations

import json

from lp_drill.hub import hubsql, setting_rpc


def read_setting(ctx: "Context", key: str) -> tuple[object | None, int, bool]:
    """(value, version, present) of a project-level setting row; (None, 0, False) when the project has no row for it."""
    rows = hubsql(f"select value, version from lane_pilot_project_settings where project_id='{ctx.project}' and binding_id='' and key='{key}';")
    return (json.loads(rows[0]["value"]), int(rows[0]["version"]), True) if rows else (None, 0, False)


def save_setting_once(ctx: "Context", key: str, value: object, version: int) -> dict:
    """save_setting with the version expected; one retry with the version a conflict names."""
    payload = {"projectId": ctx.project, "key": key, "value": value}
    saved = setting_rpc("save_setting", {**payload, "expectedVersion": version})
    if not saved.get("ok") and saved.get("conflict"):
        saved = setting_rpc("save_setting", {**payload, "expectedVersion": int(saved.get("version") or 0)})
    return saved


def apply_settings(ctx: "Context", values: dict[str, object], saved: dict[str, dict]) -> None:
    """Saves each value and notes the earlier row in `saved` before the save is tried, so a failure half way leaves what to put back."""
    for key, value in values.items():
        original, version, present = read_setting(ctx, key)
        entry = saved[key] = {"original": original, "present": present, "version": version, "applied": False}
        done = save_setting_once(ctx, key, value, version)
        if not done.get("ok"):
            raise RuntimeError(f"could not set {key}={value!r}: {done}")
        entry["version"], entry["applied"] = int(done["version"]), True


def restore_settings(ctx: "Context", saved: dict[str, dict]) -> list[str]:
    """Puts every applied key back and says so when one could not be. A key the project had no row for is reset (owner.words is not a
    catalog key, reset refuses it: it goes to off, as restore_owner_words does; a stale «on» of an earlier drill is a leftover, not a choice)."""
    problems: list[str] = []
    for key, entry in saved.items():
        if not entry["applied"]:
            continue
        try:
            if key == "owner.words":
                original = entry["original"]
                done = save_setting_once(ctx, key, original if isinstance(original, str) and original != "on" else "off", entry["version"])
            elif entry["present"]:
                done = save_setting_once(ctx, key, entry["original"], entry["version"])
            else:
                done = setting_rpc("reset_project_settings", {"projectId": ctx.project, "keys": [key], "expectedVersions": {key: entry["version"]}})
                if not done.get("ok") and done.get("conflict"):
                    done = setting_rpc("reset_project_settings", {"projectId": ctx.project, "keys": [key], "expectedVersions": {key: int((done.get("versions") or {}).get(key) or done.get("version") or 0)}})
            if not done.get("ok"):
                problems.append(f"could not put {key} back: {done}")
        except Exception as cause:  # one key that cannot be put back must not keep the others from it
            problems.append(f"could not put {key} back: {cause}")
    return problems


class scoped_settings:
    """The settings hold for the body and are put back after it, whatever the body does (an exception included); a failed restore is a problem.
    A class, not @contextmanager: the door rebinds functions' globals (_rehome), which a generator wrapper's helper does not survive."""

    def __init__(self, ctx: "Context", values: dict[str, object], problems: list[str]):
        self.ctx, self.values, self.problems, self.saved = ctx, values, problems, {}

    def __enter__(self) -> dict[str, dict]:
        try:
            apply_settings(self.ctx, self.values, self.saved)
        except BaseException:
            self.problems.extend(restore_settings(self.ctx, self.saved))
            raise
        return self.saved

    def __exit__(self, *exc) -> bool:
        self.problems.extend(restore_settings(self.ctx, self.saved))
        return False
